/**
 * db.ts — SQLite schema setup for the memory search index.
 *
 * Tables: meta, files, chunks, embedding_cache, chunks_fts (FTS5), chunks_vec (sqlite-vec).
 * Modeled after OpenClaw's memory-schema.ts with graceful degradation.
 */

import Database from "better-sqlite3";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const MEMORY_DIR = path.join(os.homedir(), ".cursor", "memory");
const DB_PATH = path.join(MEMORY_DIR, ".search-index.sqlite");

export function getMemoryDir(): string {
  return MEMORY_DIR;
}

export function getDbPath(): string {
  return DB_PATH;
}

// ---------------------------------------------------------------------------
// Schema types
// ---------------------------------------------------------------------------

export interface DbState {
  db: Database.Database;
  ftsAvailable: boolean;
  vecAvailable: boolean;
  vecDimensions: number | null; // null until first embedding stored
}

// ---------------------------------------------------------------------------
// Schema creation
// ---------------------------------------------------------------------------

export function openDatabase(): DbState {
  // Ensure the directory exists
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  // --- meta table ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // --- files table ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      path   TEXT PRIMARY KEY,
      source TEXT NOT NULL DEFAULT 'memory',
      hash   TEXT NOT NULL,
      mtime  INTEGER NOT NULL,
      size   INTEGER NOT NULL
    );
  `);

  // --- chunks table ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS chunks (
      id         TEXT PRIMARY KEY,
      path       TEXT NOT NULL,
      source     TEXT NOT NULL DEFAULT 'memory',
      start_line INTEGER NOT NULL,
      end_line   INTEGER NOT NULL,
      hash       TEXT NOT NULL,
      model      TEXT NOT NULL,
      text       TEXT NOT NULL,
      embedding  TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_chunks_path   ON chunks(path);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source);`);

  // --- embedding_cache table (SHA-256 keyed dedup) ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS embedding_cache (
      hash       TEXT NOT NULL,
      model      TEXT NOT NULL,
      embedding  TEXT NOT NULL,
      dims       INTEGER,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (hash, model)
    );
  `);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_embedding_cache_updated_at ON embedding_cache(updated_at);`,
  );

  // --- FTS5 virtual table (graceful fallback) ---
  let ftsAvailable = false;
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
        text,
        id UNINDEXED,
        path UNINDEXED,
        source UNINDEXED,
        model UNINDEXED,
        start_line UNINDEXED,
        end_line UNINDEXED
      );
    `);
    ftsAvailable = true;
  } catch {
    // FTS5 not available on this platform — keyword search disabled
    ftsAvailable = false;
  }

  // --- sqlite-vec extension loading ---
  let vecAvailable = false;
  try {
    const sqliteVec = require("sqlite-vec");
    sqliteVec.load(db);
    vecAvailable = true;
  } catch {
    // sqlite-vec not available — will fall back to JS cosine similarity
    vecAvailable = false;
  }

  return { db, ftsAvailable, vecAvailable, vecDimensions: null };
}

// ---------------------------------------------------------------------------
// Lazy vector table creation (called when first embedding dimensions known)
// ---------------------------------------------------------------------------

export function ensureVectorTable(state: DbState, dimensions: number): void {
  if (state.vecDimensions === dimensions) return; // already created

  if (!state.vecAvailable) return; // no sqlite-vec

  try {
    // Drop and recreate if dimensions changed
    if (state.vecDimensions !== null && state.vecDimensions !== dimensions) {
      state.db.exec(`DROP TABLE IF EXISTS chunks_vec;`);
    }
    state.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(
        id TEXT PRIMARY KEY,
        embedding float[${dimensions}]
      );
    `);
    state.vecDimensions = dimensions;
  } catch {
    state.vecAvailable = false;
  }
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

export function closeDatabase(state: DbState): void {
  state.db.close();
}
