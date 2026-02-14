/**
 * extractor.ts — Rule-based entity extraction from structured session markdown.
 *
 * Parses session logs with YAML frontmatter and standardized sections to
 * extract errors, solutions, libraries, preferences, patterns, and lessons
 * without requiring an LLM.
 *
 * Expected session format:
 * ---
 * date: YYYY-MM-DD
 * project: <project-name>
 * tags: [tag1, tag2]
 * tools: [tool1, tool2]
 * outcome: success | partial | failed
 * ---
 *
 * # Session: <title>
 *
 * ## Errors Encountered
 * - <error name>: <description> [solved/unsolved]
 *   - Solution: <solution description>
 *
 * ## Tools & Libraries Used
 * - <tool/library name> (<version>): <context>
 *
 * ## Preferences Learned
 * - [global] <preference>
 * - [project] <preference>
 *
 * ## Patterns Learned
 * - <pattern/lesson>
 */

import { parseFrontmatter, hashText } from "./chunker.js";
import type {
  SessionExtraction,
  ErrorEntity,
  SolutionEntity,
  LibraryEntity,
  PreferenceEntity,
  LessonEntity,
  PatternEntity,
} from "./graph.js";

// ---------------------------------------------------------------------------
// Section extraction
// ---------------------------------------------------------------------------

interface SectionContent {
  heading: string;
  content: string;
}

/**
 * Extract all sections from markdown content.
 */
function extractSections(body: string): Map<string, SectionContent> {
  const sections = new Map<string, SectionContent>();
  const lines = body.split("\n");

  let currentHeading = "";
  let currentContent: string[] = [];

  const flush = () => {
    if (currentHeading) {
      sections.set(currentHeading.toLowerCase(), {
        heading: currentHeading,
        content: currentContent.join("\n").trim(),
      });
    }
  };

  for (const line of lines) {
    const headingMatch = line.match(/^##\s+(.+)$/);
    if (headingMatch) {
      flush();
      currentHeading = headingMatch[1]?.trim() ?? "";
      currentContent = [];
    } else {
      currentContent.push(line);
    }
  }
  flush();

  return sections;
}

// ---------------------------------------------------------------------------
// Error extraction
// ---------------------------------------------------------------------------

interface ParsedError {
  name: string;
  description: string;
  solved: boolean;
  solution?: string;
}

/**
 * Parse errors from "## Errors Encountered" section.
 * Format: - <error name>: <description> [solved/unsolved]
 *           - Solution: <solution description>
 */
function parseErrors(content: string): ParsedError[] {
  const errors: ParsedError[] = [];
  const lines = content.split("\n");

  let currentError: ParsedError | null = null;

  for (const line of lines) {
    const trimmed = line.trim();

    // Check for main error line: - ErrorName: description [solved/unsolved]
    const errorMatch = trimmed.match(/^-\s+(.+?):\s*(.+?)(?:\s+\[(solved|unsolved)\])?$/i);
    if (errorMatch && !trimmed.toLowerCase().includes("solution:")) {
      // Save previous error
      if (currentError) {
        errors.push(currentError);
      }

      const name = errorMatch[1]?.trim() ?? "";
      const description = errorMatch[2]?.trim() ?? "";
      const solvedStr = errorMatch[3]?.toLowerCase();

      currentError = {
        name,
        description,
        solved: solvedStr === "solved",
      };
      continue;
    }

    // Check for solution line: - Solution: <description>
    const solutionMatch = trimmed.match(/^-\s+Solution:\s*(.+)$/i);
    if (solutionMatch && currentError) {
      currentError.solution = solutionMatch[1]?.trim();
      currentError.solved = true;
      continue;
    }
  }

  // Don't forget the last error
  if (currentError) {
    errors.push(currentError);
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Library/Tool extraction
// ---------------------------------------------------------------------------

interface ParsedLibrary {
  name: string;
  version?: string;
  context?: string;
}

/**
 * Parse libraries from "## Tools & Libraries Used" section.
 * Format: - <tool/library name> (<version>): <context>
 *    or:  - <tool/library name>: <context>
 */
function parseLibraries(content: string): ParsedLibrary[] {
  const libraries: ParsedLibrary[] = [];
  const lines = content.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("-")) continue;

    // Try format with version: - Name (version): context
    const withVersion = trimmed.match(/^-\s+(.+?)\s+\(([^)]+)\):\s*(.+)$/);
    if (withVersion) {
      libraries.push({
        name: withVersion[1]?.trim() ?? "",
        version: withVersion[2]?.trim(),
        context: withVersion[3]?.trim(),
      });
      continue;
    }

    // Try format without version: - Name: context
    const withoutVersion = trimmed.match(/^-\s+(.+?):\s*(.+)$/);
    if (withoutVersion) {
      libraries.push({
        name: withoutVersion[1]?.trim() ?? "",
        context: withoutVersion[2]?.trim(),
      });
      continue;
    }

    // Just a name: - Name
    const justName = trimmed.match(/^-\s+(.+)$/);
    if (justName) {
      libraries.push({
        name: justName[1]?.trim() ?? "",
      });
    }
  }

  return libraries;
}

// ---------------------------------------------------------------------------
// Preference extraction
// ---------------------------------------------------------------------------

interface ParsedPreference {
  name: string;
  scope: "global" | "project";
}

/**
 * Parse preferences from "## Preferences Learned" section.
 * Format: - [global] <preference>
 *    or:  - [project] <preference>
 */
function parsePreferences(content: string, projectName?: string): ParsedPreference[] {
  const preferences: ParsedPreference[] = [];
  const lines = content.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("-")) continue;

    // Parse scope tag
    const globalMatch = trimmed.match(/^-\s+\[global\]\s*(.+)$/i);
    if (globalMatch) {
      preferences.push({
        name: globalMatch[1]?.trim() ?? "",
        scope: "global",
      });
      continue;
    }

    const projectMatch = trimmed.match(/^-\s+\[project(?::\s*[^\]]+)?\]\s*(.+)$/i);
    if (projectMatch) {
      preferences.push({
        name: projectMatch[1]?.trim() ?? "",
        scope: "project",
      });
      continue;
    }

    // No scope tag - default to project if we have a project name, else global
    const noScope = trimmed.match(/^-\s+(.+)$/);
    if (noScope) {
      preferences.push({
        name: noScope[1]?.trim() ?? "",
        scope: projectName ? "project" : "global",
      });
    }
  }

  return preferences;
}

// ---------------------------------------------------------------------------
// Pattern/Lesson extraction
// ---------------------------------------------------------------------------

/**
 * Parse patterns/lessons from "## Patterns Learned" or "## What Worked" sections.
 * Format: - <pattern/lesson>
 */
function parseLessons(content: string): string[] {
  const lessons: string[] = [];
  const lines = content.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("-")) continue;

    const match = trimmed.match(/^-\s+(.+)$/);
    if (match) {
      lessons.push(match[1]?.trim() ?? "");
    }
  }

  return lessons;
}

// ---------------------------------------------------------------------------
// Main extraction function
// ---------------------------------------------------------------------------

/**
 * Extract entities from a structured session markdown file.
 *
 * @param content - The full session markdown content
 * @param userId - The user ID to associate with this session
 * @returns A SessionExtraction object ready for graph insertion
 */
export function extractSessionEntities(
  content: string,
  userId: string = "default",
): SessionExtraction {
  const { frontmatter, body } = parseFrontmatter(content);
  const sections = extractSections(body);

  // Extract metadata from frontmatter
  const projectName = (frontmatter?.project as string) ?? "";
  const dateStr = (frontmatter?.date as string) ?? new Date().toISOString().split("T")[0];
  const outcome = (frontmatter?.outcome as string) ?? "partial";
  const toolsFromFrontmatter = (frontmatter?.tools as string[]) ?? [];

  // Generate session ID from date and content hash
  const sessionId = hashText(`session:${dateStr}:${hashText(content).slice(0, 16)}`);
  const sessionTimestamp = new Date(dateStr ?? Date.now()).getTime();
  const overallSuccess = outcome === "success";

  // Initialize entities
  const entities: GraphEntities = {
    errors: [],
    solutions: [],
    patterns: [],
    libraries: [],
    preferences: [],
    lessons: [],
    relationships: [],
  };

  // Extract errors and solutions
  const errorsSection = sections.get("errors encountered");
  if (errorsSection) {
    const parsedErrors = parseErrors(errorsSection.content);
    for (const error of parsedErrors) {
      const errorEntity: ErrorEntity = {
        name: error.name,
        description: error.description,
        solved: error.solved,
      };
      entities.errors.push(errorEntity);

      if (error.solution) {
        const solutionEntity: SolutionEntity = {
          name: error.solution,
          description: `Solution for: ${error.name}`,
          worked: true,
          complexity: "moderate",
        };
        entities.solutions.push(solutionEntity);

        // Create solved_by relationship
        entities.relationships.push({
          from: error.name,
          relationship: "solved_by",
          to: error.solution,
          success: true,
          confidence: 0.9,
        });
      }

      // Create encountered relationship
      entities.relationships.push({
        from: userId,
        relationship: "encountered",
        to: error.name,
      });
    }
  }

  // Extract libraries from both frontmatter and section
  const librariesSection = sections.get("tools & libraries used");
  const parsedLibraries = librariesSection
    ? parseLibraries(librariesSection.content)
    : [];

  // Add libraries from frontmatter tools
  for (const tool of toolsFromFrontmatter) {
    if (!parsedLibraries.some(l => l.name.toLowerCase() === tool.toLowerCase())) {
      parsedLibraries.push({ name: tool });
    }
  }

  for (const lib of parsedLibraries) {
    const libraryEntity: LibraryEntity = {
      name: lib.name,
      version: lib.version,
      context: lib.context,
    };
    entities.libraries.push(libraryEntity);

    // Create uses_lib relationship
    entities.relationships.push({
      from: userId,
      relationship: "uses_lib",
      to: lib.name,
    });
  }

  // Extract preferences
  const preferencesSection = sections.get("preferences learned");
  if (preferencesSection) {
    const parsedPreferences = parsePreferences(preferencesSection.content, projectName);
    for (const pref of parsedPreferences) {
      const preferenceEntity: PreferenceEntity = {
        name: pref.name,
        scope: pref.scope,
        projectName: pref.scope === "project" ? projectName : undefined,
        strength: 0.8,
      };
      entities.preferences.push(preferenceEntity);

      // Create prefers relationship
      entities.relationships.push({
        from: userId,
        relationship: "prefers",
        to: pref.name,
        confidence: 0.8,
      });
    }
  }

  // Extract patterns/lessons
  const patternsSection = sections.get("patterns learned");
  const whatWorkedSection = sections.get("what worked");

  const allLessons: string[] = [];
  if (patternsSection) {
    allLessons.push(...parseLessons(patternsSection.content));
  }
  if (whatWorkedSection) {
    allLessons.push(...parseLessons(whatWorkedSection.content));
  }

  for (const lesson of allLessons) {
    // Add as both pattern and lesson
    const patternEntity: PatternEntity = {
      name: lesson,
      applied: true,
      successful: overallSuccess,
    };
    entities.patterns.push(patternEntity);

    const lessonEntity: LessonEntity = {
      name: lesson,
      projectName: projectName || undefined,
    };
    entities.lessons.push(lessonEntity);
  }

  // Extract title from first h1
  let sessionNotes = "";
  const titleMatch = body.match(/^#\s+(?:Session:\s*)?(.+)$/m);
  if (titleMatch) {
    sessionNotes = titleMatch[1]?.trim() ?? "";
  }

  // Get task summary
  const taskSection = sections.get("task");
  if (taskSection) {
    sessionNotes += sessionNotes ? ": " : "";
    sessionNotes += taskSection.content.split("\n")[0]?.trim() ?? "";
  }

  return {
    sessionId,
    userId,
    projectName,
    sessionTimestamp,
    overallSuccess,
    entities,
    notes: sessionNotes || undefined,
  };
}

// ---------------------------------------------------------------------------
// Project detection utility
// ---------------------------------------------------------------------------

/**
 * Detect the current project name from git.
 * Falls back to directory name if git is not available.
 */
export function detectProjectFromGit(cwd?: string): string | null {
  try {
    const { execSync } = require("node:child_process");
    const options = cwd ? { cwd, encoding: "utf-8" as const } : { encoding: "utf-8" as const };

    // Try to get the repo name from git remote
    try {
      const remote = execSync("git remote get-url origin", options).toString().trim();
      // Extract repo name from URL: github.com/user/repo.git -> repo
      const match = remote.match(/\/([^/]+?)(?:\.git)?$/);
      if (match) {
        return match[1] ?? null;
      }
    } catch {
      // No remote, try to get repo root directory name
    }

    // Fall back to git repo root directory name
    const root = execSync("git rev-parse --show-toplevel", options).toString().trim();
    const path = require("node:path");
    return path.basename(root);
  } catch {
    // Not in a git repo, use cwd directory name
    const path = require("node:path");
    const dir = cwd ?? process.cwd();
    return path.basename(dir);
  }
}
