/**
 * search.ts — Hybrid BM25 + vector search with weighted score fusion.
 *
 * Implements OpenClaw's exact hybrid search algorithm from hybrid.ts:
 * - buildFtsQuery(): tokenize, quote, AND-join
 * - bm25RankToScore(): 1 / (1 + max(0, rank))
 * - mergeHybridResults(): union by chunk ID, weighted score fusion
 * - 4x candidateMultiplier
 * - ~700 char snippet truncation
 */

import type Database from "better-sqlite3";
import type { DbState } from "./db.js";
import { cosineSimilarity } from "./embeddings.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEFAULT_MAX_RESULTS = 10;
const CANDIDATE_MULTIPLIER = 4;
const VECTOR_WEIGHT = 0.7;
const TEXT_WEIGHT = 0.3;
const MAX_SNIPPET_CHARS = 700;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SearchResult {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
  source: string;
}

// ---------------------------------------------------------------------------
// FTS query building (matches OpenClaw's buildFtsQuery)
// ---------------------------------------------------------------------------

export function buildFtsQuery(raw: string): string | null {
  const tokens =
    raw
      .match(/[A-Za-z0-9_]+/g)
      ?.map((t) => t.trim())
      .filter(Boolean) ?? [];
  if (tokens.length === 0) return null;
  const quoted = tokens.map((t) => `"${t.replace(/"/g, "")}"`);
  return quoted.join(" AND ");
}

// ---------------------------------------------------------------------------
// BM25 rank to score (matches OpenClaw's bm25RankToScore)
// ---------------------------------------------------------------------------

export function bm25RankToScore(rank: number): number {
  const normalized = Number.isFinite(rank) ? Math.max(0, rank) : 999;
  return 1 / (1 + normalized);
}

// ---------------------------------------------------------------------------
// Snippet truncation (UTF-16 safe)
// ---------------------------------------------------------------------------

function truncateSnippet(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  // Avoid splitting a surrogate pair
  let end = maxChars;
  if (end > 0 && text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff) {
    end--;
  }
  return text.slice(0, end) + "...";
}

// ---------------------------------------------------------------------------
// Vector to Buffer for sqlite-vec queries
// ---------------------------------------------------------------------------

function vectorToBlob(embedding: number[]): Buffer {
  return Buffer.from(new Float32Array(embedding).buffer);
}

// ---------------------------------------------------------------------------
// Vector search (sqlite-vec or JS fallback)
// ---------------------------------------------------------------------------

interface VectorResult {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  source: string;
  snippet: string;
  vectorScore: number;
}

function searchVectorViaExtension(
  db: Database.Database,
  queryVec: number[],
  model: string,
  limit: number,
): VectorResult[] {
  const rows = db
    .prepare(
      `SELECT c.id, c.path, c.start_line, c.end_line, c.text,
              c.source,
              vec_distance_cosine(v.embedding, ?) AS dist
       FROM chunks_vec v
       JOIN chunks c ON c.id = v.id
       WHERE c.model = ?
       ORDER BY dist ASC
       LIMIT ?`,
    )
    .all(vectorToBlob(queryVec), model, limit) as Array<{
    id: string;
    path: string;
    start_line: number;
    end_line: number;
    text: string;
    source: string;
    dist: number;
  }>;

  return rows.map((row) => ({
    id: row.id,
    path: row.path,
    startLine: row.start_line,
    endLine: row.end_line,
    source: row.source,
    snippet: truncateSnippet(row.text, MAX_SNIPPET_CHARS),
    vectorScore: 1 - row.dist,
  }));
}

function searchVectorViaJs(
  db: Database.Database,
  queryVec: number[],
  model: string,
  limit: number,
): VectorResult[] {
  // Load all chunks and compute cosine similarity in JS
  const rows = db
    .prepare(
      `SELECT id, path, start_line, end_line, text, embedding, source
       FROM chunks
       WHERE model = ?`,
    )
    .all(model) as Array<{
    id: string;
    path: string;
    start_line: number;
    end_line: number;
    text: string;
    embedding: string;
    source: string;
  }>;

  const scored = rows
    .map((row) => {
      let embedding: number[];
      try {
        embedding = JSON.parse(row.embedding) as number[];
      } catch {
        return null;
      }
      const score = cosineSimilarity(queryVec, embedding);
      return {
        id: row.id,
        path: row.path,
        startLine: row.start_line,
        endLine: row.end_line,
        source: row.source,
        snippet: truncateSnippet(row.text, MAX_SNIPPET_CHARS),
        vectorScore: score,
      };
    })
    .filter((r): r is VectorResult => r !== null && Number.isFinite(r.vectorScore));

  return scored
    .sort((a, b) => b.vectorScore - a.vectorScore)
    .slice(0, limit);
}

// ---------------------------------------------------------------------------
// Keyword search (FTS5 BM25)
// ---------------------------------------------------------------------------

interface KeywordResult {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  source: string;
  snippet: string;
  textScore: number;
}

function searchKeyword(
  db: Database.Database,
  query: string,
  model: string,
  limit: number,
): KeywordResult[] {
  const ftsQuery = buildFtsQuery(query);
  if (!ftsQuery) return [];

  const rows = db
    .prepare(
      `SELECT id, path, source, start_line, end_line, text,
              bm25(chunks_fts) AS rank
       FROM chunks_fts
       WHERE chunks_fts MATCH ? AND model = ?
       ORDER BY rank ASC
       LIMIT ?`,
    )
    .all(ftsQuery, model, limit) as Array<{
    id: string;
    path: string;
    source: string;
    start_line: number;
    end_line: number;
    text: string;
    rank: number;
  }>;

  return rows.map((row) => ({
    id: row.id,
    path: row.path,
    startLine: row.start_line,
    endLine: row.end_line,
    source: row.source,
    snippet: truncateSnippet(row.text, MAX_SNIPPET_CHARS),
    textScore: bm25RankToScore(row.rank),
  }));
}

// ---------------------------------------------------------------------------
// Hybrid merge (matches OpenClaw's mergeHybridResults)
// ---------------------------------------------------------------------------

function mergeHybridResults(
  vector: VectorResult[],
  keyword: KeywordResult[],
  vectorWeight: number,
  textWeight: number,
): SearchResult[] {
  const byId = new Map<
    string,
    {
      id: string;
      path: string;
      startLine: number;
      endLine: number;
      source: string;
      snippet: string;
      vectorScore: number;
      textScore: number;
    }
  >();

  for (const r of vector) {
    byId.set(r.id, {
      id: r.id,
      path: r.path,
      startLine: r.startLine,
      endLine: r.endLine,
      source: r.source,
      snippet: r.snippet,
      vectorScore: r.vectorScore,
      textScore: 0,
    });
  }

  for (const r of keyword) {
    const existing = byId.get(r.id);
    if (existing) {
      existing.textScore = r.textScore;
      // Prefer keyword snippet if available (often more relevant)
      if (r.snippet.length > 0) {
        existing.snippet = r.snippet;
      }
    } else {
      byId.set(r.id, {
        id: r.id,
        path: r.path,
        startLine: r.startLine,
        endLine: r.endLine,
        source: r.source,
        snippet: r.snippet,
        vectorScore: 0,
        textScore: r.textScore,
      });
    }
  }

  const merged = Array.from(byId.values()).map((entry) => ({
    path: entry.path,
    startLine: entry.startLine,
    endLine: entry.endLine,
    score: vectorWeight * entry.vectorScore + textWeight * entry.textScore,
    snippet: entry.snippet,
    source: entry.source,
  }));

  return merged.sort((a, b) => b.score - a.score);
}

// ---------------------------------------------------------------------------
// Main search function
// ---------------------------------------------------------------------------

export async function hybridSearch(
  state: DbState,
  queryVec: number[],
  queryText: string,
  options?: { maxResults?: number },
): Promise<SearchResult[]> {
  const maxResults = options?.maxResults ?? DEFAULT_MAX_RESULTS;
  const candidateLimit = maxResults * CANDIDATE_MULTIPLIER;

  // Get the provider model from meta
  const meta = state.db
    .prepare(`SELECT value FROM meta WHERE key = 'provider_model'`)
    .get() as { value: string } | undefined;
  const model = meta?.value ?? "";

  // Vector search
  let vectorResults: VectorResult[] = [];
  if (queryVec.length > 0) {
    if (state.vecAvailable && state.vecDimensions) {
      vectorResults = searchVectorViaExtension(
        state.db,
        queryVec,
        model,
        candidateLimit,
      );
    } else {
      vectorResults = searchVectorViaJs(
        state.db,
        queryVec,
        model,
        candidateLimit,
      );
    }
  }

  // Keyword search
  let keywordResults: KeywordResult[] = [];
  if (state.ftsAvailable) {
    keywordResults = searchKeyword(state.db, queryText, model, candidateLimit);
  }

  // Merge
  const merged = mergeHybridResults(
    vectorResults,
    keywordResults,
    VECTOR_WEIGHT,
    TEXT_WEIGHT,
  );

  return merged.slice(0, maxResults);
}
