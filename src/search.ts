/**
 * search.ts — Hybrid vector + FTS search using CozoDB Datalog queries.
 *
 * Performs hybrid search by combining:
 * - HNSW cosine-distance vector search (via CozoDB's built-in index)
 * - Full-text search with TF-IDF scoring (via CozoDB's built-in FTS)
 *
 * Results are merged with weighted score fusion (70% vector, 30% FTS)
 * inside a single Datalog query, then returned as ranked SearchResult[].
 */

import type { DbState } from "./db.js";
import { runQuery } from "./db.js";

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
// CozoDB Datalog query templates
// ---------------------------------------------------------------------------

/**
 * Full hybrid query: HNSW vector search + FTS, merged with weighted fusion.
 *
 * Produces rows: [path, start_line, end_line, score, content, source]
 */
const HYBRID_QUERY = `
vec[id, vs] :=
  ~chunks:hnsw_embedding{ id |
    query: vec($query_vec),
    k: $candidate_limit,
    ef: 100,
    bind_distance: dist
  },
  vs = 1.0 - dist

fts[id, fs] :=
  ~chunks:fts_content{ id |
    query: $query_text,
    k: $candidate_limit,
    score_kind: 'tf_idf',
    bind_score: fs
  }

fts_max[max(fs)] := fts[_, fs]
fts_max[m] := m = 1.0, not fts[_, _]

?[path, start_line, end_line, score, content, source] :=
  vec[id, vs],
  fts[id, fs],
  fts_max[fm],
  nfs = if(fm > 0.0, fs / fm, 0.0),
  score = ${VECTOR_WEIGHT} * vs + ${TEXT_WEIGHT} * nfs,
  *chunks{ id, path, start_line, end_line, content, source }

?[path, start_line, end_line, score, content, source] :=
  vec[id, vs],
  not fts[id, _],
  score = ${VECTOR_WEIGHT} * vs,
  *chunks{ id, path, start_line, end_line, content, source }

?[path, start_line, end_line, score, content, source] :=
  fts[id, fs],
  not vec[id, _],
  fts_max[fm],
  nfs = if(fm > 0.0, fs / fm, 0.0),
  score = ${TEXT_WEIGHT} * nfs,
  *chunks{ id, path, start_line, end_line, content, source }

:order -score
:limit $max_results
`;

/**
 * Vector-only query: HNSW search without FTS (fallback when FTS fails).
 *
 * Produces rows: [path, start_line, end_line, score, content, source]
 */
const VECTOR_ONLY_QUERY = `
vec[id, vs] :=
  ~chunks:hnsw_embedding{ id |
    query: vec($query_vec),
    k: $candidate_limit,
    ef: 100,
    bind_distance: dist
  },
  vs = 1.0 - dist

?[path, start_line, end_line, score, content, source] :=
  vec[id, vs],
  score = ${VECTOR_WEIGHT} * vs,
  *chunks{ id, path, start_line, end_line, content, source }

:order -score
:limit $max_results
`;

/**
 * FTS-only query: full-text search without vector search (when queryVec is empty).
 *
 * Produces rows: [path, start_line, end_line, score, content, source]
 */
const FTS_ONLY_QUERY = `
fts[id, fs] :=
  ~chunks:fts_content{ id |
    query: $query_text,
    k: $max_results,
    score_kind: 'tf_idf',
    bind_score: fs
  }

?[path, start_line, end_line, score, content, source] :=
  fts[id, fs],
  score = fs,
  *chunks{ id, path, start_line, end_line, content, source }

:order -score
:limit $max_results
`;

// ---------------------------------------------------------------------------
// Main search function
// ---------------------------------------------------------------------------

/**
 * Performs hybrid search by combining vector similarity and FTS keyword search
 * within a single CozoDB Datalog query.
 *
 * Uses weighted score fusion: fetches 4× the requested results as candidates
 * from each method (HNSW vector, FTS TF-IDF), merges by chunk ID with weighted
 * scores (70% vector, 30% FTS), then returns the top results.
 *
 * If queryVec is empty, only FTS search runs. If FTS fails (e.g. bad syntax),
 * falls back to vector-only results.
 *
 * @param state - Database state (db, embeddingDimensions)
 * @param queryVec - Embedding vector for semantic search (empty array skips vector search)
 * @param queryText - Raw query string for FTS keyword search
 * @param options - Optional config; maxResults defaults to 10
 * @returns Sorted array of SearchResult (path, startLine, endLine, snippet, score, source)
 *
 * @example
 * const results = await hybridSearch(state, embedding, "foo bar", { maxResults: 10 });
 */
export async function hybridSearch(
  state: DbState,
  queryVec: number[],
  queryText: string,
  options?: { maxResults?: number },
): Promise<SearchResult[]> {
  const maxResults = options?.maxResults ?? DEFAULT_MAX_RESULTS;
  const candidateLimit = maxResults * CANDIDATE_MULTIPLIER;

  // If no embedding schema yet (chunks table doesn't exist), no results
  if (state.embeddingDimensions === null) return [];

  let results: unknown[][];

  if (queryVec.length > 0) {
    // Full hybrid search (vector + FTS)
    try {
      const queryResult = await runQuery(state.db, HYBRID_QUERY, {
        query_vec: queryVec,
        query_text: queryText,
        candidate_limit: candidateLimit,
        max_results: maxResults,
      });
      results = queryResult.rows;
    } catch {
      // If hybrid fails (e.g. FTS parse error), fall back to vector-only
      const queryResult = await runQuery(state.db, VECTOR_ONLY_QUERY, {
        query_vec: queryVec,
        candidate_limit: candidateLimit,
        max_results: maxResults,
      });
      results = queryResult.rows;
    }
  } else {
    // FTS-only search (no embedding vector provided)
    const queryResult = await runQuery(state.db, FTS_ONLY_QUERY, {
      query_text: queryText,
      max_results: maxResults,
    });
    results = queryResult.rows;
  }

  // Map row arrays to SearchResult objects.
  // Column order matches the ?[...] head: path, start_line, end_line, score, content, source
  return results.map((row) => ({
    path: row[0] as string,
    startLine: row[1] as number,
    endLine: row[2] as number,
    score: row[3] as number,
    snippet: truncateSnippet(row[4] as string, MAX_SNIPPET_CHARS),
    source: row[5] as string,
  }));
}
