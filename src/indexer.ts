/**
 * indexer.ts — Delta-based file indexing.
 *
 * Discovers markdown files in ~/.cursor/memory/, compares against stored
 * file hashes, and only re-chunks/re-embeds files that changed. Uses the
 * embedding_cache table to avoid re-embedding identical text.
 */

import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { type DbState, ensureVectorTable } from "./db.js";
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

function getCachedEmbedding(
  db: Database.Database,
  textHash: string,
  model: string,
): number[] | null {
  const row = db
    .prepare(
      `SELECT embedding FROM embedding_cache WHERE hash = ? AND model = ?`,
    )
    .get(textHash, model) as { embedding: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.embedding) as number[];
  } catch {
    return null;
  }
}

function setCachedEmbedding(
  db: Database.Database,
  textHash: string,
  model: string,
  embedding: number[],
): void {
  db.prepare(
    `INSERT OR REPLACE INTO embedding_cache (hash, model, embedding, dims, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(textHash, model, JSON.stringify(embedding), embedding.length, Date.now());
}

// ---------------------------------------------------------------------------
// Vector table helpers
// ---------------------------------------------------------------------------

function vectorToBlob(embedding: number[]): Buffer {
  return Buffer.from(new Float32Array(embedding).buffer);
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

  // Prepared statements
  const getFile = state.db.prepare(
    `SELECT hash FROM files WHERE path = ?`,
  );
  const upsertFile = state.db.prepare(
    `INSERT OR REPLACE INTO files (path, source, hash, mtime, size)
     VALUES (?, 'memory', ?, ?, ?)`,
  );
  const deleteChunksByPath = state.db.prepare(
    `DELETE FROM chunks WHERE path = ?`,
  );
  const insertChunk = state.db.prepare(
    `INSERT OR REPLACE INTO chunks (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
     VALUES (?, ?, 'memory', ?, ?, ?, ?, ?, ?, ?)`,
  );

  // FTS statements (only if available)
  const deleteFtsByPath = state.ftsAvailable
    ? state.db.prepare(`DELETE FROM chunks_fts WHERE path = ?`)
    : null;
  const insertFts = state.ftsAvailable
    ? state.db.prepare(
        `INSERT INTO chunks_fts (text, id, path, source, model, start_line, end_line)
         VALUES (?, ?, ?, 'memory', ?, ?, ?)`,
      )
    : null;

  // Track all current file paths to detect deletions
  const currentPaths = new Set<string>();

  for (const absPath of files) {
    const entry = buildFileEntry(absPath, memoryDir);
    currentPaths.add(entry.relPath);

    // Check if file changed
    const existing = getFile.get(entry.relPath) as { hash: string } | undefined;
    if (existing && existing.hash === entry.hash) {
      if (verbose) console.log(`  Unchanged: ${entry.relPath}`);
      continue;
    }

    result.filesChanged++;
    if (verbose) console.log(`  Indexing: ${entry.relPath}`);

    // Update file record
    upsertFile.run(entry.relPath, entry.hash, Math.floor(entry.mtimeMs), entry.size);

    // Remove old chunks for this file
    deleteChunksByPath.run(entry.relPath);
    deleteFtsByPath?.run(entry.relPath);

    // Chunk the content
    const chunks = chunkMarkdown(entry.content);
    if (chunks.length === 0) continue;

    // Embed all chunks (using cache where possible)
    const embeddings: number[][] = [];
    for (const chunk of chunks) {
      const cached = getCachedEmbedding(state.db, chunk.hash, provider.modelId);
      if (cached) {
        embeddings.push(cached);
        result.embeddingsCached++;
      } else {
        const vec = await provider.embed(chunk.text);
        setCachedEmbedding(state.db, chunk.hash, provider.modelId, vec);
        embeddings.push(vec);
        result.embeddingsGenerated++;
      }
    }

    // Ensure vector table exists with correct dimensions
    const firstEmbedding = embeddings[0];
    if (firstEmbedding && firstEmbedding.length > 0) {
      ensureVectorTable(state, firstEmbedding.length);
    }

    // Prepare vec insert lazily (after table exists)
    const insertVec = state.vecAvailable && state.vecDimensions
      ? state.db.prepare(`INSERT INTO chunks_vec (id, embedding) VALUES (?, ?)`)
      : null;

    // Insert chunks in a transaction
    const insertAll = state.db.transaction(() => {
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const embedding = embeddings[i];
        if (!chunk || !embedding) continue;
        const id = chunkId(entry.relPath, chunk.startLine, chunk.endLine);

        insertChunk.run(
          id,
          entry.relPath,
          chunk.startLine,
          chunk.endLine,
          chunk.hash,
          provider.modelId,
          chunk.text,
          JSON.stringify(embedding),
          Date.now(),
        );

        // FTS insert
        insertFts?.run(
          chunk.text,
          id,
          entry.relPath,
          provider.modelId,
          chunk.startLine,
          chunk.endLine,
        );

        // Vector insert
        insertVec?.run(id, vectorToBlob(embedding));
      }

      result.chunksIndexed += chunks.length;
    });

    insertAll();
  }

  // Remove stale files (files in DB but no longer on disk)
  const allDbFiles = state.db
    .prepare(`SELECT path FROM files`)
    .all() as Array<{ path: string }>;
  for (const row of allDbFiles) {
    if (!currentPaths.has(row.path)) {
      if (verbose) console.log(`  Removing stale: ${row.path}`);
      state.db.prepare(`DELETE FROM files WHERE path = ?`).run(row.path);
      state.db.prepare(`DELETE FROM chunks WHERE path = ?`).run(row.path);
      if (state.ftsAvailable) {
        state.db.prepare(`DELETE FROM chunks_fts WHERE path = ?`).run(row.path);
      }
      // Vec cleanup would require listing chunk IDs first; skip for simplicity
    }
  }

  // Store provider fingerprint
  state.db
    .prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('provider_model', ?)`)
    .run(provider.modelId);

  return result;
}
