/**
 * db.ts — CozoDB schema setup for the memory search index.
 *
 * Relations: meta, files, chunks, embedding_cache.
 * Uses CozoDB's built-in FTS, HNSW vector search, and indexing.
 */

import { CozoDb } from "cozo-node";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

// Re-export CozoDb type so other modules don't need to import cozo-node directly
export type { CozoDb } from "cozo-node";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

// Shared, tool-agnostic memory directory (XDG-style)
const CONFIG_DIR = path.join(os.homedir(), ".config", "agent-orchestrator");
const MEMORY_DIR = path.join(CONFIG_DIR, "memory");
const DB_PATH = path.join(MEMORY_DIR, ".search-index.cozo");

export function getMemoryDir(): string {
  return MEMORY_DIR;
}

export function getDbPath(): string {
  return DB_PATH;
}

export function getConfigDir(): string {
  return CONFIG_DIR;
}

// ---------------------------------------------------------------------------
// Schema types
// ---------------------------------------------------------------------------

export interface DbState {
  db: CozoDb;
  embeddingDimensions: number | null; // null until first embedding; needed for HNSW index creation
}

// ---------------------------------------------------------------------------
// Query helper
// ---------------------------------------------------------------------------

export async function runQuery(
  db: CozoDb,
  query: string,
  params?: Record<string, unknown>,
): Promise<{ headers: string[]; rows: unknown[][] }> {
  try {
    return await db.run(query, params ?? {});
  } catch (err: unknown) {
    const message =
      (err as { display?: string }).display ??
      (err as Error).message ??
      String(err);
    throw new Error(`CozoDB query failed: ${message}\nQuery: ${query}`);
  }
}

// ---------------------------------------------------------------------------
// Schema helpers
// ---------------------------------------------------------------------------

/** Return the set of existing relation names in the database. */
async function existingRelations(db: CozoDb): Promise<Set<string>> {
  const result = await runQuery(db, "::relations");
  return new Set(result.rows.map((r) => String(r[0])));
}

/** Return the set of existing index names for a given relation. */
async function existingIndices(db: CozoDb, relation: string): Promise<Set<string>> {
  try {
    const result = await runQuery(db, `::indices ${relation}`);
    return new Set(result.rows.map((r) => String(r[0])));
  } catch {
    // Relation may not exist yet
    return new Set();
  }
}

/**
 * Create base relations (meta, files) that don't depend on embedding
 * dimensions. Each relation is only created if it doesn't already exist.
 */
async function initBaseSchema(db: CozoDb): Promise<void> {
  const names = await existingRelations(db);

  if (!names.has("meta")) {
    await runQuery(db, ":create meta { key: String => value: String }");
  }

  if (!names.has("files")) {
    await runQuery(
      db,
      ":create files { path: String => source: String, hash: String, mtime: Int, size: Int }",
    );
  }
}

// ---------------------------------------------------------------------------
// openDatabase
// ---------------------------------------------------------------------------

export async function openDatabase(): Promise<DbState> {
  // Ensure the directory exists
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

  const db = new CozoDb("sqlite", DB_PATH);

  await initBaseSchema(db);

  // Initialize graph schema (node and edge relations)
  // Lazy import to avoid circular dependency
  const { initGraphSchema } = await import("./graph.js");
  await initGraphSchema(db);

  // Recover persisted embedding dimensions (if any)
  let embeddingDimensions: number | null = null;
  try {
    const result = await runQuery(
      db,
      "?[value] := *meta{ key: 'embedding_dimensions', value }",
    );
    if (result.rows.length > 0) {
      const parsed = parseInt(String(result.rows[0][0]), 10);
      if (!Number.isNaN(parsed) && parsed > 0) {
        embeddingDimensions = parsed;
      }
    }
  } catch {
    // meta may be empty — that's fine
  }

  return { db, embeddingDimensions };
}

// ---------------------------------------------------------------------------
// Lazy embedding schema creation (replaces ensureVectorTable)
// ---------------------------------------------------------------------------

export async function ensureEmbeddingSchema(
  state: DbState,
  dimensions: number,
): Promise<void> {
  if (state.embeddingDimensions === dimensions) return; // already set up

  const { db } = state;
  const names = await existingRelations(db);

  // If chunks exists but dimensions changed, drop everything and recreate
  if (names.has("chunks") && state.embeddingDimensions !== null && state.embeddingDimensions !== dimensions) {
    await runQuery(db, "::remove chunks");
    await runQuery(db, "::remove embedding_cache");
    // Refresh names after drop
    names.delete("chunks");
    names.delete("embedding_cache");
  }

  // --- Create chunks relation ---
  if (!names.has("chunks")) {
    await runQuery(
      db,
      `:create chunks {
        id: String
        =>
        path: String,
        source: String,
        start_line: Int,
        end_line: Int,
        hash: String,
        model: String,
        content: String,
        embedding: <F32; ${dimensions}>,
        updated_at: Int
      }`,
    );
  }

  // --- Create embedding_cache relation ---
  if (!names.has("embedding_cache")) {
    await runQuery(
      db,
      `:create embedding_cache {
        hash: String,
        model: String
        =>
        embedding: <F32; ${dimensions}>,
        dims: Int,
        updated_at: Int
      }`,
    );
  }

  // --- Create indices (idempotent: check before creating) ---
  const chunkIndices = await existingIndices(db, "chunks");

  if (!chunkIndices.has("idx_path")) {
    await runQuery(db, "::index create chunks:idx_path { path, id }");
  }

  if (!chunkIndices.has("idx_source")) {
    await runQuery(db, "::index create chunks:idx_source { source, id }");
  }

  if (!chunkIndices.has("fts_content")) {
    await runQuery(
      db,
      `::fts create chunks:fts_content {
        extractor: content,
        tokenizer: Simple,
        filters: [Lowercase, Stemmer('english'), Stopwords('en')]
      }`,
    );
  }

  if (!chunkIndices.has("hnsw_embedding")) {
    await runQuery(
      db,
      `::hnsw create chunks:hnsw_embedding {
        dim: ${dimensions},
        m: 32,
        dtype: F32,
        fields: [embedding],
        distance: Cosine,
        ef_construction: 200
      }`,
    );
  }

  // --- Persist dimensions in meta ---
  await runQuery(
    db,
    `?[key, value] <- [['embedding_dimensions', '${dimensions}']]
     :put meta { key => value }`,
  );

  state.embeddingDimensions = dimensions;
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

export function closeDatabase(state: DbState): void {
  state.db.close();
}
