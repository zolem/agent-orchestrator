/**
 * indexer.ts — Delta-based file indexing.
 *
 * Discovers markdown files in ~/.cursor/memory/, compares against stored
 * file hashes, and only re-chunks/re-embeds files that changed. Uses the
 * embedding_cache table to avoid re-embedding identical text.
 *
 * All storage uses CozoDB Datalog queries via runQuery().
 */

import fs from "node:fs";
import path from "node:path";
import { type DbState, ensureEmbeddingSchema, runQuery } from "./db.js";
import { chunkMarkdown, hashText } from "./chunker.js";
import type { EmbeddingProvider } from "./embeddings.js";

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

function walkDir(dir: string, files: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      walkDir(full, files);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(full);
    }
  }
}

export function listMemoryFiles(memoryDir: string): string[] {
  const result: string[] = [];

  // MEMORY.md at root (check both casings, but only add one)
  const memoryFile = path.join(memoryDir, "MEMORY.md");
  const altMemoryFile = path.join(memoryDir, "memory.md");

  if (fs.existsSync(memoryFile)) {
    result.push(memoryFile);
  } else if (fs.existsSync(altMemoryFile)) {
    // Only add lowercase version if uppercase doesn't exist
    // This handles case-sensitive filesystems where both might exist separately
    result.push(altMemoryFile);
  }

  // sessions/ directory
  const sessionsDir = path.join(memoryDir, "sessions");
  walkDir(sessionsDir, result);

  // Deduplicate by lowercase resolved path (handles case-insensitive filesystems)
  const seen = new Set<string>();
  return result.filter((f) => {
    const resolved = fs.realpathSync(f).toLowerCase();
    if (seen.has(resolved)) return false;
    seen.add(resolved);
    return true;
  });
}

// ---------------------------------------------------------------------------
// File entry building
// ---------------------------------------------------------------------------

interface FileEntry {
  relPath: string;
  absPath: string;
  hash: string;
  mtimeMs: number;
  size: number;
  content: string;
}

function buildFileEntry(absPath: string, memoryDir: string): FileEntry {
  const stat = fs.statSync(absPath);
  const content = fs.readFileSync(absPath, "utf-8");
  const hash = hashText(content);
  const relPath = path.relative(memoryDir, absPath).replace(/\\/g, "/");
  return { relPath, absPath, hash, mtimeMs: stat.mtimeMs, size: stat.size, content };
}

// ---------------------------------------------------------------------------
// Chunk ID generation
// ---------------------------------------------------------------------------

function chunkId(relPath: string, startLine: number, endLine: number): string {
  return `${relPath}:${startLine}-${endLine}`;
}

// ---------------------------------------------------------------------------
// Embedding cache helpers
// ---------------------------------------------------------------------------

/**
 * Look up a cached embedding vector by text hash + model.
 * Returns null if no cache entry exists.
 */
async function getCachedEmbedding(
  db: DbState["db"],
  textHash: string,
  model: string,
): Promise<number[] | null> {
  const result = await runQuery(
    db,
    "?[embedding] := *embedding_cache{ hash: $hash, model: $model, embedding }",
    { hash: textHash, model },
  );
  const firstRow = result.rows[0];
  if (!firstRow) return null;
  const embedding = firstRow[0];
  // CozoDB returns vectors as number arrays natively — no JSON parsing needed
  return Array.isArray(embedding) ? (embedding as number[]) : null;
}

/**
 * Store an embedding vector in the cache, keyed by text hash + model.
 */
async function setCachedEmbedding(
  db: DbState["db"],
  textHash: string,
  model: string,
  embedding: number[],
  dims: number,
): Promise<void> {
  await runQuery(
    db,
    `?[hash, model, embedding, dims, updated_at] <- [[
      $hash, $model, vec($embedding), $dims, $now
    ]]
    :put embedding_cache { hash, model => embedding, dims, updated_at }`,
    { hash: textHash, model, embedding, dims, now: Date.now() },
  );
}

// ---------------------------------------------------------------------------
// Main indexing function
// ---------------------------------------------------------------------------

export interface IndexResult {
  filesScanned: number;
  filesChanged: number;
  chunksIndexed: number;
  embeddingsGenerated: number;
  embeddingsCached: number;
}

export async function indexMemoryFiles(
  state: DbState,
  provider: EmbeddingProvider,
  memoryDir: string,
  verbose = false,
): Promise<IndexResult> {
  const result: IndexResult = {
    filesScanned: 0,
    filesChanged: 0,
    chunksIndexed: 0,
    embeddingsGenerated: 0,
    embeddingsCached: 0,
  };

  const files = listMemoryFiles(memoryDir);
  result.filesScanned = files.length;

  if (verbose) {
    console.log(`Found ${files.length} memory file(s)`);
  }

  // Track all current file paths to detect deletions
  const currentPaths = new Set<string>();

  for (const absPath of files) {
    const entry = buildFileEntry(absPath, memoryDir);
    currentPaths.add(entry.relPath);

    // Check if file changed
    const existingResult = await runQuery(
      state.db,
      "?[hash] := *files{ path: $path, hash }",
      { path: entry.relPath },
    );
    const firstRow = existingResult.rows[0];
    const existingHash =
      firstRow !== undefined ? (firstRow[0] as string) : null;

    if (existingHash !== null && existingHash === entry.hash) {
      if (verbose) console.log(`  Unchanged: ${entry.relPath}`);
      continue;
    }

    result.filesChanged++;
    if (verbose) console.log(`  Indexing: ${entry.relPath}`);

    // Update file record
    await runQuery(
      state.db,
      `?[path, source, hash, mtime, size] <- [[$path, 'memory', $hash, $mtime, $size]]
       :put files { path => source, hash, mtime, size }`,
      {
        path: entry.relPath,
        hash: entry.hash,
        mtime: Math.floor(entry.mtimeMs),
        size: entry.size,
      },
    );

    // Remove old chunks for this file (only if chunks relation exists)
    if (state.embeddingDimensions !== null) {
      try {
        await runQuery(
          state.db,
          `?[id] := *chunks{ id, path: $path }
           :rm chunks { id }`,
          { path: entry.relPath },
        );
      } catch {
        // chunks relation may not exist yet — that's OK
      }
    }

    // Chunk the content
    const chunks = chunkMarkdown(entry.content);
    if (chunks.length === 0) continue;

    // Embed all chunks (using cache where possible)
    // Note: embedding_cache may not exist yet on the very first run.
    // We embed the first chunk to learn dimensions, create the schema,
    // then use the cache for subsequent chunks.
    const embeddings: number[][] = [];
    for (const chunk of chunks) {
      // Try cache only if embedding schema is ready
      if (state.embeddingDimensions !== null) {
        const cached = await getCachedEmbedding(
          state.db,
          chunk.hash,
          provider.modelId,
        );
        if (cached) {
          embeddings.push(cached);
          result.embeddingsCached++;
          continue;
        }
      }

      // Cache miss or schema not ready — generate embedding
      const vec = await provider.embed(chunk.text);

      // Ensure embedding schema exists with correct dimensions (lazy init)
      if (state.embeddingDimensions === null && vec.length > 0) {
        await ensureEmbeddingSchema(state, vec.length);
      }

      // Now cache the embedding
      await setCachedEmbedding(
        state.db,
        chunk.hash,
        provider.modelId,
        vec,
        vec.length,
      );
      embeddings.push(vec);
      result.embeddingsGenerated++;
    }

    // Insert all chunks in a batch via :put
    // CozoDB automatically updates FTS and HNSW indices on :put
    const rows = chunks.map((chunk, i) => [
      chunkId(entry.relPath, chunk.startLine, chunk.endLine),
      entry.relPath,
      "memory",
      chunk.startLine,
      chunk.endLine,
      chunk.hash,
      provider.modelId,
      chunk.text,
      embeddings[i],
      Date.now(),
    ]);

    await runQuery(
      state.db,
      `?[id, path, source, start_line, end_line, hash, model, content, embedding, updated_at] <- $rows
       :put chunks { id => path, source, start_line, end_line, hash, model, content, embedding, updated_at }`,
      { rows },
    );

    result.chunksIndexed += chunks.length;
  }

  // Remove stale files (files in DB but no longer on disk)
  const allDbFiles = await runQuery(state.db, "?[path] := *files{ path }");
  for (const row of allDbFiles.rows) {
    const dbPath = row[0] as string;
    if (!currentPaths.has(dbPath)) {
      if (verbose) console.log(`  Removing stale: ${dbPath}`);

      // Delete chunks for this path (only if chunks relation exists)
      if (state.embeddingDimensions !== null) {
        try {
          await runQuery(
            state.db,
            `?[id] := *chunks{ id, path: $path }
             :rm chunks { id }`,
            { path: dbPath },
          );
        } catch {
          // chunks relation may not exist yet
        }
      }

      // Delete file record
      await runQuery(
        state.db,
        `?[path] <- [[$path]]
         :rm files { path }`,
        { path: dbPath },
      );
    }
  }

  // Store provider fingerprint
  await runQuery(
    state.db,
    `?[key, value] <- [['provider_model', $model]]
     :put meta { key => value }`,
    { model: provider.modelId },
  );

  return result;
}
