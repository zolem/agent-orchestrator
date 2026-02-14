/**
 * graph.ts — Graph database layer for entity/relationship tracking using CozoDB.
 *
 * Tracks errors, solutions, patterns, libraries, sessions, and users as graph
 * nodes, with edges representing relationships (encountered, solved_by, etc.).
 * Enables the orchestrator to navigate past solutions, user preferences, and
 * causal chains with precision.
 *
 * The graph layer complements vector search on the chunks table: vector search
 * finds relevant content by meaning, while the graph navigates structured
 * relationships between entities.
 */

import type { CozoDb } from "cozo-node";
import { runQuery } from "./db.js";
import { hashText } from "./chunker.js";

// ---------------------------------------------------------------------------
// Entity interfaces
// ---------------------------------------------------------------------------

export interface ErrorEntity {
  name: string;
  context?: string;
  description?: string;
  category?: string;
  solved: boolean;
}

export interface SolutionEntity {
  name: string;
  description?: string;
  worked: boolean;
  complexity?: "simple" | "moderate" | "complex";
  timeToImplement?: number; // minutes
}

export interface PatternEntity {
  name: string;
  category?: string;
  applied: boolean;
  successful: boolean;
}

export interface LibraryEntity {
  name: string;
  version?: string;
  context?: string;
}

export interface PreferenceEntity {
  name: string;
  description?: string;
  scope: "global" | "project";
  projectName?: string; // Only set if scope is "project"
  strength?: number; // 0-1, how strongly the user prefers this
}

export interface LessonEntity {
  name: string;
  description?: string;
  projectName?: string; // null for global lessons
}

export interface ProjectEntity {
  name: string;
}

export interface RelationshipEntity {
  from: string;
  relationship:
    | "encountered"
    | "solved_by"
    | "uses_lib"
    | "applies_pattern"
    | "prefers"
    | "avoids"
    | "conflicts_with"
    | "similar_to"
    | "caused_by";
  to: string;
  success?: boolean;
  confidence?: number;
  durationMinutes?: number;
}

export interface GraphEntities {
  errors: ErrorEntity[];
  solutions: SolutionEntity[];
  patterns: PatternEntity[];
  libraries: LibraryEntity[];
  preferences: PreferenceEntity[];
  lessons: LessonEntity[];
  relationships: RelationshipEntity[];
}

export interface SessionExtraction {
  sessionId: string;
  userId: string;
  projectName: string;
  sessionTimestamp: number;
  sessionDurationMinutes?: number;
  overallSuccess: boolean;
  entities: GraphEntities;
  notes?: string;
}

// ---------------------------------------------------------------------------
// Query result interfaces
// ---------------------------------------------------------------------------

export interface UserError {
  errorId: string;
  errorName: string;
  errorDescription: string | null;
  errorCategory: string | null;
  solutionName: string | null;
  solutionDescription: string | null;
  confidence: number | null;
  encounterTime: number;
}

export interface ErrorSolution {
  solutionId: string;
  solutionName: string;
  solutionDescription: string | null;
  complexity: string | null;
  confidence: number | null;
  timesUsed: number;
  timesSuccessful: number;
  successRate: number;
  verified: boolean | null;
  timestamp: number;
}

export interface UserPreference {
  type: "prefers" | "avoids";
  targetId: string;
  strength: number | null;
  reason: string | null;
  context: string | null;
  timestamp: number;
}

export interface SearchedError {
  score: number;
  id: string;
  name: string;
  description: string | null;
  category: string | null;
  context: string | null;
  successRate: number;
}

export interface SearchedSolution {
  score: number;
  id: string;
  name: string;
  description: string | null;
  complexity: string | null;
  successRate: number;
}

export interface CausalChainNode {
  errorId: string;
  errorName: string;
  causeId: string;
  causeName: string;
  confidence: number | null;
  description: string | null;
  depth: number;
}

export interface GraphStats {
  nodes: {
    users: number;
    errors: number;
    solutions: number;
    patterns: number;
    libraries: number;
    sessions: number;
  };
  edges: {
    encountered: number;
    solved_by: number;
    uses_lib: number;
    applies_pattern: number;
    prefers: number;
    avoids: number;
    conflicts_with: number;
    similar_to: number;
    caused_by: number;
  };
}

// ---------------------------------------------------------------------------
// Deterministic ID generation
// ---------------------------------------------------------------------------

function entityId(type: string, name: string, context?: string): string {
  const raw = context ? `${type}:${name}:${context}` : `${type}:${name}`;
  return hashText(raw.toLowerCase().trim());
}

// ---------------------------------------------------------------------------
// Schema initialization
// ---------------------------------------------------------------------------

/** Return the set of existing relation names in the database. */
async function existingRelations(db: CozoDb): Promise<Set<string>> {
  const result = await runQuery(db, "::relations");
  return new Set(result.rows.map((r) => String(r[0])));
}

/** Return the set of existing index names for a given relation. */
async function existingIndices(
  db: CozoDb,
  relation: string,
): Promise<Set<string>> {
  try {
    const result = await runQuery(db, `::indices ${relation}`);
    return new Set(result.rows.map((r) => String(r[0])));
  } catch {
    return new Set();
  }
}

/**
 * Initialize all graph relations (node and edge tables) and FTS indices.
 * Safe to call multiple times — each relation is only created if it doesn't
 * already exist.
 */
export async function initGraphSchema(db: CozoDb): Promise<void> {
  const names = await existingRelations(db);

  // --- Node relations ---

  if (!names.has("user_node")) {
    await runQuery(
      db,
      ":create user_node { id: String => name: String, created_at: Int, metadata: String? }",
    );
  }

  if (!names.has("error_node")) {
    await runQuery(
      db,
      `:create error_node {
        id: String
        =>
        name: String,
        description: String?,
        category: String?,
        context: String?,
        times_encountered: Int,
        times_solved: Int,
        success_rate: Float,
        first_encountered: Int,
        last_encountered: Int,
        metadata: String?
      }`,
    );
  }

  if (!names.has("solution_node")) {
    await runQuery(
      db,
      `:create solution_node {
        id: String
        =>
        name: String,
        description: String?,
        complexity: String?,
        times_used: Int,
        times_successful: Int,
        success_rate: Float,
        first_used: Int,
        last_used: Int,
        markdown_reference: String?,
        metadata: String?
      }`,
    );
  }

  if (!names.has("pattern_node")) {
    await runQuery(
      db,
      `:create pattern_node {
        id: String
        =>
        name: String,
        description: String?,
        category: String?,
        times_applied: Int,
        times_successful: Int,
        success_rate: Float,
        first_applied: Int,
        last_applied: Int,
        metadata: String?
      }`,
    );
  }

  if (!names.has("library_node")) {
    await runQuery(
      db,
      `:create library_node {
        id: String
        =>
        name: String,
        versions_used: String?,
        times_used: Int,
        expertise_level: String?,
        last_used: Int,
        contexts: String?,
        metadata: String?
      }`,
    );
  }

  if (!names.has("session_node")) {
    await runQuery(
      db,
      `:create session_node {
        id: String
        =>
        slug: String?,
        project_id: String?,
        started_at: Int,
        ended_at: Int?,
        summary: String?,
        overall_success: Bool?,
        metadata: String?
      }`,
    );
  }

  // --- New node types for project scoping ---

  if (!names.has("project_node")) {
    await runQuery(
      db,
      `:create project_node {
        id: String
        =>
        name: String,
        first_seen: Int,
        last_seen: Int,
        session_count: Int,
        metadata: String?
      }`,
    );
  }

  if (!names.has("preference_node")) {
    await runQuery(
      db,
      `:create preference_node {
        id: String
        =>
        name: String,
        description: String?,
        scope: String,
        project_id: String?,
        strength: Float,
        times_confirmed: Int,
        first_learned: Int,
        last_confirmed: Int,
        metadata: String?
      }`,
    );
  }

  if (!names.has("lesson_node")) {
    await runQuery(
      db,
      `:create lesson_node {
        id: String
        =>
        name: String,
        description: String?,
        project_id: String?,
        times_relevant: Int,
        first_learned: Int,
        last_referenced: Int,
        metadata: String?
      }`,
    );
  }

  // --- Edge relations ---

  if (!names.has("encountered")) {
    await runQuery(
      db,
      ":create encountered { user_id: String, error_id: String => session_id: String?, timestamp: Int, context: String? }",
    );
  }

  if (!names.has("solved_by")) {
    await runQuery(
      db,
      ":create solved_by { error_id: String, solution_id: String => confidence: Float?, timestamp: Int, verified: Bool? }",
    );
  }

  if (!names.has("uses_lib")) {
    await runQuery(
      db,
      ":create uses_lib { from_id: String, library_id: String => context: String?, timestamp: Int }",
    );
  }

  if (!names.has("applies_pattern")) {
    await runQuery(
      db,
      ":create applies_pattern { pattern_id: String, target_id: String => context: String?, timestamp: Int }",
    );
  }

  if (!names.has("prefers")) {
    await runQuery(
      db,
      ":create prefers { user_id: String, target_id: String => strength: Float?, context: String?, timestamp: Int }",
    );
  }

  if (!names.has("avoids")) {
    await runQuery(
      db,
      ":create avoids { user_id: String, target_id: String => reason: String?, timestamp: Int }",
    );
  }

  if (!names.has("conflicts_with")) {
    await runQuery(
      db,
      ":create conflicts_with { from_id: String, to_id: String => description: String?, timestamp: Int }",
    );
  }

  if (!names.has("similar_to")) {
    await runQuery(
      db,
      ":create similar_to { from_id: String, to_id: String => similarity: Float, method: String?, timestamp: Int }",
    );
  }

  if (!names.has("caused_by")) {
    await runQuery(
      db,
      ":create caused_by { error_id: String, cause_id: String => confidence: Float?, description: String?, timestamp: Int }",
    );
  }

  // --- New edge types for project scoping ---

  if (!names.has("in_project")) {
    await runQuery(
      db,
      ":create in_project { entity_id: String, project_id: String => entity_type: String, timestamp: Int }",
    );
  }

  if (!names.has("learned_from")) {
    await runQuery(
      db,
      ":create learned_from { entity_id: String, session_id: String => entity_type: String, timestamp: Int }",
    );
  }

  // --- FTS indices on node names ---

  const errorIndices = await existingIndices(db, "error_node");
  if (!errorIndices.has("fts_name")) {
    await runQuery(
      db,
      `::fts create error_node:fts_name {
        extractor: name,
        tokenizer: Simple,
        filters: [Lowercase, Stemmer('english')]
      }`,
    );
  }

  const solutionIndices = await existingIndices(db, "solution_node");
  if (!solutionIndices.has("fts_name")) {
    await runQuery(
      db,
      `::fts create solution_node:fts_name {
        extractor: name,
        tokenizer: Simple,
        filters: [Lowercase, Stemmer('english')]
      }`,
    );
  }

  const patternIndices = await existingIndices(db, "pattern_node");
  if (!patternIndices.has("fts_name")) {
    await runQuery(
      db,
      `::fts create pattern_node:fts_name {
        extractor: name,
        tokenizer: Simple,
        filters: [Lowercase, Stemmer('english')]
      }`,
    );
  }

  // FTS indices for new node types

  const preferenceIndices = await existingIndices(db, "preference_node");
  if (!preferenceIndices.has("fts_name")) {
    await runQuery(
      db,
      `::fts create preference_node:fts_name {
        extractor: name,
        tokenizer: Simple,
        filters: [Lowercase, Stemmer('english')]
      }`,
    );
  }

  const lessonIndices = await existingIndices(db, "lesson_node");
  if (!lessonIndices.has("fts_name")) {
    await runQuery(
      db,
      `::fts create lesson_node:fts_name {
        extractor: name,
        tokenizer: Simple,
        filters: [Lowercase, Stemmer('english')]
      }`,
    );
  }
}

// ---------------------------------------------------------------------------
// Node upsert helpers
// ---------------------------------------------------------------------------

async function upsertErrorNode(
  db: CozoDb,
  error: ErrorEntity,
  sessionTimestamp: number,
): Promise<string> {
  const id = entityId("error", error.name, error.context);

  const existing = await runQuery(
    db,
    `?[times_encountered, times_solved, first_encountered] :=
      *error_node{ id: $id, times_encountered, times_solved, first_encountered }`,
    { id },
  );

  let timesEncountered: number;
  let timesSolved: number;
  let firstEncountered: number;

  if (existing.rows.length > 0) {
    const row = existing.rows[0] as [number, number, number];
    timesEncountered = row[0] + 1;
    timesSolved = row[1] + (error.solved ? 1 : 0);
    firstEncountered = row[2];
  } else {
    timesEncountered = 1;
    timesSolved = error.solved ? 1 : 0;
    firstEncountered = sessionTimestamp;
  }

  const successRate =
    timesEncountered > 0 ? timesSolved / timesEncountered : 0;

  await runQuery(
    db,
    `?[id, name, description, category, context, times_encountered, times_solved, success_rate, first_encountered, last_encountered, metadata] <- [[
      $id, $name, $desc, $cat, $ctx, $enc, $sol, $rate, $first, $last, null
    ]]
    :put error_node {
      id
      =>
      name, description, category, context,
      times_encountered, times_solved, success_rate,
      first_encountered, last_encountered, metadata
    }`,
    {
      id,
      name: error.name,
      desc: error.description ?? null,
      cat: error.category ?? null,
      ctx: error.context ?? null,
      enc: timesEncountered,
      sol: timesSolved,
      rate: successRate,
      first: firstEncountered,
      last: sessionTimestamp,
    },
  );

  return id;
}

async function upsertSolutionNode(
  db: CozoDb,
  solution: SolutionEntity,
  sessionTimestamp: number,
): Promise<string> {
  const id = entityId("solution", solution.name);

  const existing = await runQuery(
    db,
    `?[times_used, times_successful, first_used] :=
      *solution_node{ id: $id, times_used, times_successful, first_used }`,
    { id },
  );

  let timesUsed: number;
  let timesSuccessful: number;
  let firstUsed: number;

  if (existing.rows.length > 0) {
    const row = existing.rows[0] as [number, number, number];
    timesUsed = row[0] + 1;
    timesSuccessful = row[1] + (solution.worked ? 1 : 0);
    firstUsed = row[2];
  } else {
    timesUsed = 1;
    timesSuccessful = solution.worked ? 1 : 0;
    firstUsed = sessionTimestamp;
  }

  const successRate = timesUsed > 0 ? timesSuccessful / timesUsed : 0;

  await runQuery(
    db,
    `?[id, name, description, complexity, times_used, times_successful, success_rate, first_used, last_used, markdown_reference, metadata] <- [[
      $id, $name, $desc, $cplx, $used, $succ, $rate, $first, $last, null, null
    ]]
    :put solution_node {
      id
      =>
      name, description, complexity,
      times_used, times_successful, success_rate,
      first_used, last_used, markdown_reference, metadata
    }`,
    {
      id,
      name: solution.name,
      desc: solution.description ?? null,
      cplx: solution.complexity ?? null,
      used: timesUsed,
      succ: timesSuccessful,
      rate: successRate,
      first: firstUsed,
      last: sessionTimestamp,
    },
  );

  return id;
}

async function upsertPatternNode(
  db: CozoDb,
  pattern: PatternEntity,
  sessionTimestamp: number,
): Promise<string> {
  const id = entityId("pattern", pattern.name);

  const existing = await runQuery(
    db,
    `?[times_applied, times_successful, first_applied] :=
      *pattern_node{ id: $id, times_applied, times_successful, first_applied }`,
    { id },
  );

  let timesApplied: number;
  let timesSuccessful: number;
  let firstApplied: number;

  if (existing.rows.length > 0) {
    const row = existing.rows[0] as [number, number, number];
    timesApplied = row[0] + (pattern.applied ? 1 : 0);
    timesSuccessful = row[1] + (pattern.successful ? 1 : 0);
    firstApplied = row[2];
  } else {
    timesApplied = pattern.applied ? 1 : 0;
    timesSuccessful = pattern.successful ? 1 : 0;
    firstApplied = sessionTimestamp;
  }

  const successRate = timesApplied > 0 ? timesSuccessful / timesApplied : 0;

  await runQuery(
    db,
    `?[id, name, description, category, times_applied, times_successful, success_rate, first_applied, last_applied, metadata] <- [[
      $id, $name, null, $cat, $applied, $succ, $rate, $first, $last, null
    ]]
    :put pattern_node {
      id
      =>
      name, description, category,
      times_applied, times_successful, success_rate,
      first_applied, last_applied, metadata
    }`,
    {
      id,
      name: pattern.name,
      cat: pattern.category ?? null,
      applied: timesApplied,
      succ: timesSuccessful,
      rate: successRate,
      first: firstApplied,
      last: sessionTimestamp,
    },
  );

  return id;
}

async function upsertLibraryNode(
  db: CozoDb,
  library: LibraryEntity,
  sessionTimestamp: number,
): Promise<string> {
  const id = entityId("library", library.name);

  const existing = await runQuery(
    db,
    `?[times_used, versions_used, contexts] :=
      *library_node{ id: $id, times_used, versions_used, contexts }`,
    { id },
  );

  let timesUsed: number;
  let versionsUsed: string | null;
  let contexts: string | null;

  if (existing.rows.length > 0) {
    const row = existing.rows[0] as [number, string | null, string | null];
    timesUsed = row[0] + 1;

    // Merge version into comma-separated list
    if (library.version) {
      const prev = row[1] ? row[1].split(",").map((v) => v.trim()) : [];
      if (!prev.includes(library.version)) {
        prev.push(library.version);
      }
      versionsUsed = prev.join(", ");
    } else {
      versionsUsed = row[1];
    }

    // Merge context into comma-separated list
    if (library.context) {
      const prev = row[2] ? row[2].split(",").map((v) => v.trim()) : [];
      if (!prev.includes(library.context)) {
        prev.push(library.context);
      }
      contexts = prev.join(", ");
    } else {
      contexts = row[2];
    }
  } else {
    timesUsed = 1;
    versionsUsed = library.version ?? null;
    contexts = library.context ?? null;
  }

  await runQuery(
    db,
    `?[id, name, versions_used, times_used, expertise_level, last_used, contexts, metadata] <- [[
      $id, $name, $versions, $used, null, $last, $contexts, null
    ]]
    :put library_node {
      id
      =>
      name, versions_used, times_used, expertise_level,
      last_used, contexts, metadata
    }`,
    {
      id,
      name: library.name,
      versions: versionsUsed,
      used: timesUsed,
      last: sessionTimestamp,
      contexts,
    },
  );

  return id;
}

async function upsertUserNode(
  db: CozoDb,
  userId: string,
  sessionTimestamp: number,
): Promise<void> {
  const existing = await runQuery(
    db,
    "?[found] := *user_node{ id: $id }, found = true",
    { id: userId },
  );

  if (existing.rows.length === 0) {
    await runQuery(
      db,
      `?[id, name, created_at, metadata] <- [[$id, $name, $ts, null]]
      :put user_node { id => name, created_at, metadata }`,
      { id: userId, name: userId, ts: sessionTimestamp },
    );
  }
}

async function upsertSessionNode(
  db: CozoDb,
  extraction: SessionExtraction,
): Promise<void> {
  const endedAt = extraction.sessionDurationMinutes
    ? extraction.sessionTimestamp + extraction.sessionDurationMinutes * 60_000
    : null;

  await runQuery(
    db,
    `?[id, slug, project_id, started_at, ended_at, summary, overall_success, metadata] <- [[
      $id, null, $project_id, $started, $ended, $notes, $success, null
    ]]
    :put session_node { id => slug, project_id, started_at, ended_at, summary, overall_success, metadata }`,
    {
      id: extraction.sessionId,
      project_id: extraction.projectName ? entityId("project", extraction.projectName) : null,
      started: extraction.sessionTimestamp,
      ended: endedAt,
      notes: extraction.notes ?? null,
      success: extraction.overallSuccess,
    },
  );
}

async function upsertProjectNode(
  db: CozoDb,
  projectName: string,
  sessionTimestamp: number,
): Promise<string> {
  const id = entityId("project", projectName);

  const existing = await runQuery(
    db,
    "?[session_count, first_seen] := *project_node{ id: $id, session_count, first_seen }",
    { id },
  );

  let sessionCount: number;
  let firstSeen: number;

  if (existing.rows.length > 0) {
    const row = existing.rows[0] as [number, number];
    sessionCount = row[0] + 1;
    firstSeen = row[1];
  } else {
    sessionCount = 1;
    firstSeen = sessionTimestamp;
  }

  await runQuery(
    db,
    `?[id, name, first_seen, last_seen, session_count, metadata] <- [[
      $id, $name, $first, $last, $count, null
    ]]
    :put project_node { id => name, first_seen, last_seen, session_count, metadata }`,
    {
      id,
      name: projectName,
      first: firstSeen,
      last: sessionTimestamp,
      count: sessionCount,
    },
  );

  return id;
}

async function upsertPreferenceNode(
  db: CozoDb,
  preference: PreferenceEntity,
  sessionTimestamp: number,
): Promise<string> {
  // Generate ID based on scope and name
  const idSuffix = preference.scope === "project" && preference.projectName
    ? `${preference.projectName}:${preference.name}`
    : preference.name;
  const id = entityId("preference", idSuffix);

  const projectId = preference.scope === "project" && preference.projectName
    ? entityId("project", preference.projectName)
    : null;

  const existing = await runQuery(
    db,
    "?[times_confirmed, first_learned] := *preference_node{ id: $id, times_confirmed, first_learned }",
    { id },
  );

  let timesConfirmed: number;
  let firstLearned: number;

  if (existing.rows.length > 0) {
    const row = existing.rows[0] as [number, number];
    timesConfirmed = row[0] + 1;
    firstLearned = row[1];
  } else {
    timesConfirmed = 1;
    firstLearned = sessionTimestamp;
  }

  await runQuery(
    db,
    `?[id, name, description, scope, project_id, strength, times_confirmed, first_learned, last_confirmed, metadata] <- [[
      $id, $name, $desc, $scope, $project, $strength, $times, $first, $last, null
    ]]
    :put preference_node { id => name, description, scope, project_id, strength, times_confirmed, first_learned, last_confirmed, metadata }`,
    {
      id,
      name: preference.name,
      desc: preference.description ?? null,
      scope: preference.scope,
      project: projectId,
      strength: preference.strength ?? 0.8,
      times: timesConfirmed,
      first: firstLearned,
      last: sessionTimestamp,
    },
  );

  return id;
}

async function upsertLessonNode(
  db: CozoDb,
  lesson: LessonEntity,
  sessionTimestamp: number,
): Promise<string> {
  // Generate ID based on project scope and name
  const idSuffix = lesson.projectName
    ? `${lesson.projectName}:${lesson.name}`
    : lesson.name;
  const id = entityId("lesson", idSuffix);

  const projectId = lesson.projectName
    ? entityId("project", lesson.projectName)
    : null;

  const existing = await runQuery(
    db,
    "?[times_relevant, first_learned] := *lesson_node{ id: $id, times_relevant, first_learned }",
    { id },
  );

  let timesRelevant: number;
  let firstLearned: number;

  if (existing.rows.length > 0) {
    const row = existing.rows[0] as [number, number];
    timesRelevant = row[0] + 1;
    firstLearned = row[1];
  } else {
    timesRelevant = 1;
    firstLearned = sessionTimestamp;
  }

  await runQuery(
    db,
    `?[id, name, description, project_id, times_relevant, first_learned, last_referenced, metadata] <- [[
      $id, $name, $desc, $project, $times, $first, $last, null
    ]]
    :put lesson_node { id => name, description, project_id, times_relevant, first_learned, last_referenced, metadata }`,
    {
      id,
      name: lesson.name,
      desc: lesson.description ?? null,
      project: projectId,
      times: timesRelevant,
      first: firstLearned,
      last: sessionTimestamp,
    },
  );

  return id;
}

// ---------------------------------------------------------------------------
// Edge upsert helpers
// ---------------------------------------------------------------------------

/**
 * Build a name-to-ID mapping from all entities in the extraction, so that
 * relationship edges can reference nodes by their original name.
 */
function buildNameIndex(
  extraction: SessionExtraction,
  errorIds: Map<string, string>,
  solutionIds: Map<string, string>,
  patternIds: Map<string, string>,
  libraryIds: Map<string, string>,
  preferenceIds?: Map<string, string>,
  lessonIds?: Map<string, string>,
): Map<string, string> {
  const index = new Map<string, string>();

  errorIds.forEach((id, key) => { index.set(key, id); });
  solutionIds.forEach((id, key) => { index.set(key, id); });
  patternIds.forEach((id, key) => { index.set(key, id); });
  libraryIds.forEach((id, key) => { index.set(key, id); });
  preferenceIds?.forEach((id, key) => { index.set(key, id); });
  lessonIds?.forEach((id, key) => { index.set(key, id); });

  // Also allow lookup by user/session/project ID directly
  index.set(extraction.userId, extraction.userId);
  index.set(extraction.sessionId, extraction.sessionId);
  if (extraction.projectName) {
    index.set(extraction.projectName, entityId("project", extraction.projectName));
  }

  return index;
}

// ---------------------------------------------------------------------------
// New edge upsert helpers
// ---------------------------------------------------------------------------

async function upsertInProjectEdge(
  db: CozoDb,
  entityId: string,
  projectId: string,
  entityType: string,
  timestamp: number,
): Promise<void> {
  await runQuery(
    db,
    `?[entity_id, project_id, entity_type, timestamp] <- [[
      $entity, $project, $type, $ts
    ]]
    :put in_project { entity_id, project_id => entity_type, timestamp }`,
    { entity: entityId, project: projectId, type: entityType, ts: timestamp },
  );
}

async function upsertLearnedFromEdge(
  db: CozoDb,
  entityId: string,
  sessionId: string,
  entityType: string,
  timestamp: number,
): Promise<void> {
  await runQuery(
    db,
    `?[entity_id, session_id, entity_type, timestamp] <- [[
      $entity, $session, $type, $ts
    ]]
    :put learned_from { entity_id, session_id => entity_type, timestamp }`,
    { entity: entityId, session: sessionId, type: entityType, ts: timestamp },
  );
}

function resolveId(name: string, nameIndex: Map<string, string>): string {
  return nameIndex.get(name) ?? name;
}

async function upsertRelationship(
  db: CozoDb,
  rel: RelationshipEntity,
  nameIndex: Map<string, string>,
  sessionTimestamp: number,
  sessionId: string,
): Promise<void> {
  const fromId = resolveId(rel.from, nameIndex);
  const toId = resolveId(rel.to, nameIndex);

  switch (rel.relationship) {
    case "encountered":
      await runQuery(
        db,
        `?[user_id, error_id, session_id, timestamp, context] <- [[
          $from, $to, $session, $ts, null
        ]]
        :put encountered { user_id, error_id => session_id, timestamp, context }`,
        { from: fromId, to: toId, session: sessionId, ts: sessionTimestamp },
      );
      break;

    case "solved_by":
      await runQuery(
        db,
        `?[error_id, solution_id, confidence, timestamp, verified] <- [[
          $from, $to, $conf, $ts, $success
        ]]
        :put solved_by { error_id, solution_id => confidence, timestamp, verified }`,
        {
          from: fromId,
          to: toId,
          conf: rel.confidence ?? null,
          ts: sessionTimestamp,
          success: rel.success ?? null,
        },
      );
      break;

    case "uses_lib":
      await runQuery(
        db,
        `?[from_id, library_id, context, timestamp] <- [[
          $from, $to, null, $ts
        ]]
        :put uses_lib { from_id, library_id => context, timestamp }`,
        { from: fromId, to: toId, ts: sessionTimestamp },
      );
      break;

    case "applies_pattern":
      await runQuery(
        db,
        `?[pattern_id, target_id, context, timestamp] <- [[
          $from, $to, null, $ts
        ]]
        :put applies_pattern { pattern_id, target_id => context, timestamp }`,
        { from: fromId, to: toId, ts: sessionTimestamp },
      );
      break;

    case "prefers":
      await runQuery(
        db,
        `?[user_id, target_id, strength, context, timestamp] <- [[
          $from, $to, $strength, null, $ts
        ]]
        :put prefers { user_id, target_id => strength, context, timestamp }`,
        {
          from: fromId,
          to: toId,
          strength: rel.confidence ?? null,
          ts: sessionTimestamp,
        },
      );
      break;

    case "avoids":
      await runQuery(
        db,
        `?[user_id, target_id, reason, timestamp] <- [[
          $from, $to, null, $ts
        ]]
        :put avoids { user_id, target_id => reason, timestamp }`,
        { from: fromId, to: toId, ts: sessionTimestamp },
      );
      break;

    case "conflicts_with":
      await runQuery(
        db,
        `?[from_id, to_id, description, timestamp] <- [[
          $from, $to, null, $ts
        ]]
        :put conflicts_with { from_id, to_id => description, timestamp }`,
        { from: fromId, to: toId, ts: sessionTimestamp },
      );
      break;

    case "similar_to":
      await runQuery(
        db,
        `?[from_id, to_id, similarity, method, timestamp] <- [[
          $from, $to, $sim, null, $ts
        ]]
        :put similar_to { from_id, to_id => similarity, method, timestamp }`,
        {
          from: fromId,
          to: toId,
          sim: rel.confidence ?? 0.0,
          ts: sessionTimestamp,
        },
      );
      break;

    case "caused_by":
      await runQuery(
        db,
        `?[error_id, cause_id, confidence, description, timestamp] <- [[
          $from, $to, $conf, null, $ts
        ]]
        :put caused_by { error_id, cause_id => confidence, description, timestamp }`,
        {
          from: fromId,
          to: toId,
          conf: rel.confidence ?? null,
          ts: sessionTimestamp,
        },
      );
      break;
  }
}

// ---------------------------------------------------------------------------
// Main graph update function
// ---------------------------------------------------------------------------

/**
 * Upsert all entities and relationships from a session extraction into the
 * graph. Creates or updates node records with running counters (times_encountered,
 * success_rate, etc.), then upserts all relationship edges.
 *
 * Returns counts of nodes and edges created/updated.
 */
export async function upsertGraphEntities(
  db: CozoDb,
  extraction: SessionExtraction,
): Promise<{ nodesCreated: number; edgesCreated: number }> {
  const ts = extraction.sessionTimestamp;
  let nodesCreated = 0;
  let edgesCreated = 0;

  // 1. Ensure user node exists
  await upsertUserNode(db, extraction.userId, ts);
  nodesCreated++;

  // 2. Ensure project node exists (if project specified)
  let projectId: string | null = null;
  if (extraction.projectName) {
    projectId = await upsertProjectNode(db, extraction.projectName, ts);
    nodesCreated++;
  }

  // 3. Ensure session node exists
  await upsertSessionNode(db, extraction);
  nodesCreated++;

  // 4. Upsert error nodes
  const errorIds = new Map<string, string>();
  for (const error of extraction.entities.errors) {
    const id = await upsertErrorNode(db, error, ts);
    errorIds.set(error.name, id);
    nodesCreated++;

    // Link error to project
    if (projectId) {
      await upsertInProjectEdge(db, id, projectId, "error", ts);
      edgesCreated++;
    }
    // Link error to session
    await upsertLearnedFromEdge(db, id, extraction.sessionId, "error", ts);
    edgesCreated++;
  }

  // 5. Upsert solution nodes
  const solutionIds = new Map<string, string>();
  for (const solution of extraction.entities.solutions) {
    const id = await upsertSolutionNode(db, solution, ts);
    solutionIds.set(solution.name, id);
    nodesCreated++;

    // Link solution to project
    if (projectId) {
      await upsertInProjectEdge(db, id, projectId, "solution", ts);
      edgesCreated++;
    }
    // Link solution to session
    await upsertLearnedFromEdge(db, id, extraction.sessionId, "solution", ts);
    edgesCreated++;
  }

  // 6. Upsert pattern nodes
  const patternIds = new Map<string, string>();
  for (const pattern of extraction.entities.patterns) {
    const id = await upsertPatternNode(db, pattern, ts);
    patternIds.set(pattern.name, id);
    nodesCreated++;

    // Link pattern to project
    if (projectId) {
      await upsertInProjectEdge(db, id, projectId, "pattern", ts);
      edgesCreated++;
    }
    // Link pattern to session
    await upsertLearnedFromEdge(db, id, extraction.sessionId, "pattern", ts);
    edgesCreated++;
  }

  // 7. Upsert library nodes
  const libraryIds = new Map<string, string>();
  for (const library of extraction.entities.libraries) {
    const id = await upsertLibraryNode(db, library, ts);
    libraryIds.set(library.name, id);
    nodesCreated++;

    // Link library to project
    if (projectId) {
      await upsertInProjectEdge(db, id, projectId, "library", ts);
      edgesCreated++;
    }
  }

  // 8. Upsert preference nodes
  const preferenceIds = new Map<string, string>();
  for (const preference of extraction.entities.preferences ?? []) {
    const id = await upsertPreferenceNode(db, preference, ts);
    preferenceIds.set(preference.name, id);
    nodesCreated++;

    // Link preference to session
    await upsertLearnedFromEdge(db, id, extraction.sessionId, "preference", ts);
    edgesCreated++;
  }

  // 9. Upsert lesson nodes
  const lessonIds = new Map<string, string>();
  for (const lesson of extraction.entities.lessons ?? []) {
    const id = await upsertLessonNode(db, lesson, ts);
    lessonIds.set(lesson.name, id);
    nodesCreated++;

    // Link lesson to session
    await upsertLearnedFromEdge(db, id, extraction.sessionId, "lesson", ts);
    edgesCreated++;
  }

  // 10. Build name→ID index for relationship resolution
  const nameIndex = buildNameIndex(
    extraction,
    errorIds,
    solutionIds,
    patternIds,
    libraryIds,
    preferenceIds,
    lessonIds,
  );

  // 11. Upsert relationship edges
  for (const rel of extraction.entities.relationships) {
    await upsertRelationship(
      db,
      rel,
      nameIndex,
      ts,
      extraction.sessionId,
    );
    edgesCreated++;
  }

  return { nodesCreated, edgesCreated };
}

// ---------------------------------------------------------------------------
// Graph query functions
// ---------------------------------------------------------------------------

/**
 * Find all errors a user has encountered, with their solutions (if any).
 * Results are ordered by most recent encounter first.
 */
export async function queryUserErrors(
  db: CozoDb,
  userId: string,
): Promise<UserError[]> {
  const result = await runQuery(
    db,
    `
    # Errors with solutions
    solved[error_id, error_name, error_desc, error_cat, sol_name, sol_desc, confidence, encounter_time] :=
      *encountered{ user_id: $uid, error_id, timestamp: encounter_time },
      *error_node{ id: error_id, name: error_name, description: error_desc, category: error_cat },
      *solved_by{ error_id, solution_id, confidence },
      *solution_node{ id: solution_id, name: sol_name, description: sol_desc }

    # Errors without solutions
    unsolved[error_id, error_name, error_desc, error_cat, sol_name, sol_desc, confidence, encounter_time] :=
      *encountered{ user_id: $uid, error_id, timestamp: encounter_time },
      *error_node{ id: error_id, name: error_name, description: error_desc, category: error_cat },
      not *solved_by{ error_id, solution_id: _ },
      sol_name = null, sol_desc = null, confidence = null

    ?[error_id, error_name, error_desc, error_cat, sol_name, sol_desc, confidence, encounter_time] :=
      solved[error_id, error_name, error_desc, error_cat, sol_name, sol_desc, confidence, encounter_time]

    ?[error_id, error_name, error_desc, error_cat, sol_name, sol_desc, confidence, encounter_time] :=
      unsolved[error_id, error_name, error_desc, error_cat, sol_name, sol_desc, confidence, encounter_time]

    :order -encounter_time
    `,
    { uid: userId },
  );

  return result.rows.map((row) => ({
    errorId: row[0] as string,
    errorName: row[1] as string,
    errorDescription: row[2] as string | null,
    errorCategory: row[3] as string | null,
    solutionName: row[4] as string | null,
    solutionDescription: row[5] as string | null,
    confidence: row[6] as number | null,
    encounterTime: row[7] as number,
  }));
}

/**
 * Find all solutions for a specific error, ordered by confidence descending.
 */
export async function queryErrorSolutions(
  db: CozoDb,
  errorId: string,
): Promise<ErrorSolution[]> {
  const result = await runQuery(
    db,
    `
    ?[solution_id, sol_name, sol_desc, complexity, confidence, times_used, times_successful, success_rate, verified, timestamp] :=
      *solved_by{ error_id: $eid, solution_id, confidence, timestamp, verified },
      *solution_node{
        id: solution_id, name: sol_name, description: sol_desc,
        complexity, times_used, times_successful, success_rate
      }

    :order -confidence
    `,
    { eid: errorId },
  );

  return result.rows.map((row) => ({
    solutionId: row[0] as string,
    solutionName: row[1] as string,
    solutionDescription: row[2] as string | null,
    complexity: row[3] as string | null,
    confidence: row[4] as number | null,
    timesUsed: row[5] as number,
    timesSuccessful: row[6] as number,
    successRate: row[7] as number,
    verified: row[8] as boolean | null,
    timestamp: row[9] as number,
  }));
}

/**
 * Find user preferences (prefers and avoids relationships).
 */
export async function queryUserPreferences(
  db: CozoDb,
  userId: string,
): Promise<UserPreference[]> {
  const result = await runQuery(
    db,
    `
    ?[type, target_id, strength, reason, context, timestamp] :=
      *prefers{ user_id: $uid, target_id, strength, context, timestamp },
      type = "prefers", reason = null

    ?[type, target_id, strength, reason, context, timestamp] :=
      *avoids{ user_id: $uid, target_id, reason, timestamp },
      type = "avoids", strength = null, context = null

    :order -timestamp
    `,
    { uid: userId },
  );

  return result.rows.map((row) => ({
    type: row[0] as "prefers" | "avoids",
    targetId: row[1] as string,
    strength: row[2] as number | null,
    reason: row[3] as string | null,
    context: row[4] as string | null,
    timestamp: row[5] as number,
  }));
}

/**
 * Full-text search on error node names. Returns errors ranked by TF-IDF score.
 */
export async function searchErrors(
  db: CozoDb,
  query: string,
  limit = 10,
): Promise<SearchedError[]> {
  const result = await runQuery(
    db,
    `
    ?[score, id, name, description, category, context, success_rate] :=
      ~error_node:fts_name{ id |
        query: $query,
        k: $limit,
        score_kind: 'tf_idf',
        bind_score: score
      },
      *error_node{ id, name, description, category, context, success_rate }

    :order -score
    `,
    { query, limit },
  );

  return result.rows.map((row) => ({
    score: row[0] as number,
    id: row[1] as string,
    name: row[2] as string,
    description: row[3] as string | null,
    category: row[4] as string | null,
    context: row[5] as string | null,
    successRate: row[6] as number,
  }));
}

/**
 * Full-text search on solution node names. Returns solutions ranked by TF-IDF score.
 */
export async function searchSolutions(
  db: CozoDb,
  query: string,
  limit = 10,
): Promise<SearchedSolution[]> {
  const result = await runQuery(
    db,
    `
    ?[score, id, name, description, complexity, success_rate] :=
      ~solution_node:fts_name{ id |
        query: $query,
        k: $limit,
        score_kind: 'tf_idf',
        bind_score: score
      },
      *solution_node{ id, name, description, complexity, success_rate }

    :order -score
    `,
    { query, limit },
  );

  return result.rows.map((row) => ({
    score: row[0] as number,
    id: row[1] as string,
    name: row[2] as string,
    description: row[3] as string | null,
    complexity: row[4] as string | null,
    successRate: row[5] as number,
  }));
}

/**
 * Get counts of all graph nodes and edges.
 */
export async function getGraphStats(db: CozoDb): Promise<GraphStats> {
  const stats: GraphStats = {
    nodes: { users: 0, errors: 0, solutions: 0, patterns: 0, libraries: 0, sessions: 0 },
    edges: {
      encountered: 0, solved_by: 0, uses_lib: 0, applies_pattern: 0,
      prefers: 0, avoids: 0, conflicts_with: 0, similar_to: 0, caused_by: 0,
    },
  };

  // Node counts — each node table has `id` as key
  const nodeTables: Array<[keyof GraphStats["nodes"], string]> = [
    ["users", "user_node"],
    ["errors", "error_node"],
    ["solutions", "solution_node"],
    ["patterns", "pattern_node"],
    ["libraries", "library_node"],
    ["sessions", "session_node"],
  ];

  for (const [key, table] of nodeTables) {
    try {
      const result = await runQuery(db, `?[count(id)] := *${table}{ id }`);
      const row = result.rows[0];
      if (row !== undefined) {
        stats.nodes[key] = row[0] as number;
      }
    } catch {
      // Table may not exist yet
    }
  }

  // Edge counts — composite keys, count by creating a list key
  const edgeTables: Array<[keyof GraphStats["edges"], string, string, string]> = [
    ["encountered", "encountered", "user_id", "error_id"],
    ["solved_by", "solved_by", "error_id", "solution_id"],
    ["uses_lib", "uses_lib", "from_id", "library_id"],
    ["applies_pattern", "applies_pattern", "pattern_id", "target_id"],
    ["prefers", "prefers", "user_id", "target_id"],
    ["avoids", "avoids", "user_id", "target_id"],
    ["conflicts_with", "conflicts_with", "from_id", "to_id"],
    ["similar_to", "similar_to", "from_id", "to_id"],
    ["caused_by", "caused_by", "error_id", "cause_id"],
  ];

  for (const [key, table, k1, k2] of edgeTables) {
    try {
      const result = await runQuery(
        db,
        `?[count(k)] := *${table}{ ${k1}: a, ${k2}: b }, k = [a, b]`,
      );
      const row = result.rows[0];
      if (row !== undefined) {
        stats.edges[key] = row[0] as number;
      }
    } catch {
      // Table may not exist yet
    }
  }

  return stats;
}

/**
 * Trace the causal chain for an error by recursively following caused_by edges.
 * Returns a flat list of causal links with depth, up to maxDepth levels.
 */
export async function queryCausalChain(
  db: CozoDb,
  errorId: string,
  maxDepth = 5,
): Promise<CausalChainNode[]> {
  // CozoDB supports fixed-point recursion, but for simplicity and safety
  // we use an iterative BFS approach with depth limit.
  const visited = new Set<string>();
  const chain: CausalChainNode[] = [];
  let frontier = [errorId];

  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
    const nextFrontier: string[] = [];

    for (const eid of frontier) {
      if (visited.has(eid)) continue;
      visited.add(eid);

      const result = await runQuery(
        db,
        `
        ?[error_id, error_name, cause_id, cause_name, confidence, description] :=
          *caused_by{ error_id: $eid, cause_id, confidence, description },
          *error_node{ id: $eid, name: error_name },
          *error_node{ id: cause_id, name: cause_name },
          error_id = $eid
        `,
        { eid },
      );

      for (const row of result.rows) {
        const causeId = row[2] as string;
        chain.push({
          errorId: row[0] as string,
          errorName: row[1] as string,
          causeId,
          causeName: row[3] as string,
          confidence: row[4] as number | null,
          description: row[5] as string | null,
          depth,
        });

        if (!visited.has(causeId)) {
          nextFrontier.push(causeId);
        }
      }
    }

    frontier = nextFrontier;
  }

  return chain;
}

// ---------------------------------------------------------------------------
// Project-scoped query functions
// ---------------------------------------------------------------------------

export interface ProjectPreference {
  name: string;
  description: string | null;
  scope: "global" | "project";
  projectName: string | null;
  strength: number;
  timesConfirmed: number;
  lastConfirmed: number;
}

export interface ProjectLesson {
  name: string;
  description: string | null;
  projectName: string | null;
  timesRelevant: number;
  lastReferenced: number;
}

export interface ProjectInfo {
  id: string;
  name: string;
  firstSeen: number;
  lastSeen: number;
  sessionCount: number;
}

/**
 * Get all projects the user has worked on.
 */
export async function queryProjects(
  db: CozoDb,
): Promise<ProjectInfo[]> {
  const result = await runQuery(
    db,
    `
    ?[id, name, first_seen, last_seen, session_count] :=
      *project_node{ id, name, first_seen, last_seen, session_count }
    :order -last_seen
    `,
  );

  return result.rows.map((row) => ({
    id: row[0] as string,
    name: row[1] as string,
    firstSeen: row[2] as number,
    lastSeen: row[3] as number,
    sessionCount: row[4] as number,
  }));
}

/**
 * Query preferences with human-readable names and project scoping.
 * Returns both global preferences and project-specific preferences.
 */
export async function queryPreferences(
  db: CozoDb,
  projectName?: string,
): Promise<ProjectPreference[]> {
  // Query the new preference_node table directly
  const result = await runQuery(
    db,
    `
    ?[name, description, scope, project_name, strength, times_confirmed, last_confirmed] :=
      *preference_node{
        id, name, description, scope, project_id, strength,
        times_confirmed, last_confirmed
      },
      *project_node{ id: project_id, name: project_name }
      
    ?[name, description, scope, project_name, strength, times_confirmed, last_confirmed] :=
      *preference_node{
        id, name, description, scope, project_id, strength,
        times_confirmed, last_confirmed
      },
      project_id = null,
      project_name = null
      
    :order -last_confirmed
    `,
  );

  let preferences = result.rows.map((row) => ({
    name: row[0] as string,
    description: row[1] as string | null,
    scope: row[2] as "global" | "project",
    projectName: row[3] as string | null,
    strength: row[4] as number,
    timesConfirmed: row[5] as number,
    lastConfirmed: row[6] as number,
  }));

  // Filter by project if specified
  if (projectName) {
    preferences = preferences.filter(
      (p) => p.scope === "global" || p.projectName === projectName
    );
  }

  return preferences;
}

/**
 * Query lessons with project scoping.
 */
export async function queryLessons(
  db: CozoDb,
  projectName?: string,
): Promise<ProjectLesson[]> {
  const result = await runQuery(
    db,
    `
    ?[name, description, project_name, times_relevant, last_referenced] :=
      *lesson_node{
        id, name, description, project_id, times_relevant, last_referenced
      },
      *project_node{ id: project_id, name: project_name }
      
    ?[name, description, project_name, times_relevant, last_referenced] :=
      *lesson_node{
        id, name, description, project_id, times_relevant, last_referenced
      },
      project_id = null,
      project_name = null
      
    :order -last_referenced
    `,
  );

  let lessons = result.rows.map((row) => ({
    name: row[0] as string,
    description: row[1] as string | null,
    projectName: row[2] as string | null,
    timesRelevant: row[3] as number,
    lastReferenced: row[4] as number,
  }));

  // Filter by project if specified (include global lessons too)
  if (projectName) {
    lessons = lessons.filter(
      (l) => l.projectName === null || l.projectName === projectName
    );
  }

  return lessons;
}

/**
 * Get a unified recall context for the memory-recall-agent.
 * Combines preferences, lessons, and recent errors for a given project.
 */
export interface RecallContext {
  project: ProjectInfo | null;
  globalPreferences: ProjectPreference[];
  projectPreferences: ProjectPreference[];
  globalLessons: ProjectLesson[];
  projectLessons: ProjectLesson[];
  recentErrors: UserError[];
  recentSolutions: Array<{ errorName: string; solutionName: string; successRate: number }>;
}

export async function getRecallContext(
  db: CozoDb,
  projectName?: string,
  userId = "default",
): Promise<RecallContext> {
  // Get project info if available
  let project: ProjectInfo | null = null;
  if (projectName) {
    const projects = await queryProjects(db);
    project = projects.find((p) => p.name === projectName) ?? null;
  }

  // Get preferences
  const allPreferences = await queryPreferences(db, projectName);
  const globalPreferences = allPreferences.filter((p) => p.scope === "global");
  const projectPreferences = allPreferences.filter(
    (p) => p.scope === "project" && p.projectName === projectName
  );

  // Get lessons
  const allLessons = await queryLessons(db, projectName);
  const globalLessons = allLessons.filter((l) => l.projectName === null);
  const projectLessons = allLessons.filter((l) => l.projectName === projectName);

  // Get recent errors
  const recentErrors = await queryUserErrors(db, userId);

  // Get solutions for recent errors
  const recentSolutions: Array<{ errorName: string; solutionName: string; successRate: number }> = [];
  for (const error of recentErrors.slice(0, 5)) {
    const solutions = await queryErrorSolutions(db, error.errorId);
    for (const solution of solutions) {
      recentSolutions.push({
        errorName: error.errorName,
        solutionName: solution.solutionName,
        successRate: solution.successRate,
      });
    }
  }

  return {
    project,
    globalPreferences,
    projectPreferences,
    globalLessons,
    projectLessons,
    recentErrors: recentErrors.slice(0, 10),
    recentSolutions,
  };
}

/**
 * Format recall context as human-readable text for the recall agent.
 */
export function formatRecallContext(context: RecallContext): string {
  const lines: string[] = [];

  if (context.project) {
    lines.push(`## Current Project: ${context.project.name}`);
    lines.push(`- Sessions: ${context.project.sessionCount}`);
    lines.push(`- Last worked on: ${new Date(context.project.lastSeen).toLocaleDateString()}`);
    lines.push("");
  }

  if (context.globalPreferences.length > 0) {
    lines.push("## Global Preferences");
    for (const pref of context.globalPreferences) {
      lines.push(`- ${pref.name}${pref.description ? ` — ${pref.description}` : ""}`);
    }
    lines.push("");
  }

  if (context.projectPreferences.length > 0) {
    lines.push(`## Project Preferences (${context.project?.name ?? "current"})`);
    for (const pref of context.projectPreferences) {
      lines.push(`- ${pref.name}${pref.description ? ` — ${pref.description}` : ""}`);
    }
    lines.push("");
  }

  if (context.globalLessons.length > 0) {
    lines.push("## Global Lessons");
    for (const lesson of context.globalLessons.slice(0, 10)) {
      lines.push(`- ${lesson.name}`);
    }
    lines.push("");
  }

  if (context.projectLessons.length > 0) {
    lines.push(`## Project Lessons (${context.project?.name ?? "current"})`);
    for (const lesson of context.projectLessons.slice(0, 10)) {
      lines.push(`- ${lesson.name}`);
    }
    lines.push("");
  }

  if (context.recentSolutions.length > 0) {
    lines.push("## Known Solutions");
    for (const sol of context.recentSolutions.slice(0, 10)) {
      lines.push(`- ${sol.errorName} → ${sol.solutionName} (${Math.round(sol.successRate * 100)}% success)`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
