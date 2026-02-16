/**
 * conversation.ts — Conversation file management for hook-based memory.
 *
 * Manages conversation files stored at:
 *   ~/.config/agent-orchestrator/memory/conversations/{session-id}.md
 *
 * Each file is a markdown document with YAML frontmatter and turn-based
 * conversation content. The `stop` hook appends each turn. The indexer
 * treats these like any other markdown file.
 *
 * Format:
 * ---
 * session_id: abc123
 * project: agent-orchestrator
 * started: 2026-02-15T10:30:00Z
 * cwd: /Users/rgarcia/projects/agent-orchestrator
 * platform: cursor
 * ---
 *
 * ## Turn 1
 * ### User
 * Fix the auth middleware
 *
 * ### Assistant
 * [full response text]
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { getMemoryDir } from "./db.js";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function getConversationsDir(): string {
  return path.join(getMemoryDir(), "conversations");
}

function getConversationPath(sessionId: string): string {
  return path.join(getConversationsDir(), `${sessionId}.md`);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConversationMeta {
  session_id: string;
  project: string;
  started: string;     // ISO-8601
  cwd: string;
  platform: "cursor" | "claude-code";
  ended?: string;      // ISO-8601
  turn_count?: number;
}

export interface ConversationTurn {
  user?: string;
  assistant?: string;
}

// ---------------------------------------------------------------------------
// Session ID generation
// ---------------------------------------------------------------------------

/**
 * Generate a session ID from current timestamp + random suffix.
 */
export function generateSessionId(): string {
  const now = new Date();
  const iso = now.toISOString();
  const date = (iso.split("T")[0] ?? "00000000").replace(/-/g, "");
  const time = (iso.split("T")[1] ?? "000000").slice(0, 8).replace(/:/g, "");
  const random = crypto.randomBytes(4).toString("hex");
  return `${date}-${time}-${random}`;
}

// ---------------------------------------------------------------------------
// Conversation file management
// ---------------------------------------------------------------------------

/**
 * Initialize a new conversation file with frontmatter.
 * Returns the session ID and file path.
 */
export function initConversation(opts: {
  sessionId?: string;
  project: string;
  cwd: string;
  platform: "cursor" | "claude-code";
}): { sessionId: string; filePath: string } {
  const sessionId = opts.sessionId ?? generateSessionId();
  const filePath = getConversationPath(sessionId);

  // Ensure conversations directory exists
  fs.mkdirSync(getConversationsDir(), { recursive: true });

  const frontmatter = [
    "---",
    `session_id: ${sessionId}`,
    `project: ${opts.project}`,
    `started: ${new Date().toISOString()}`,
    `cwd: ${opts.cwd}`,
    `platform: ${opts.platform}`,
    "---",
    "",
  ].join("\n");

  fs.writeFileSync(filePath, frontmatter, "utf-8");

  return { sessionId, filePath };
}

/**
 * Append a turn to an existing conversation file.
 * Creates the file with frontmatter if it doesn't exist.
 */
export function appendTurn(
  sessionId: string,
  turn: ConversationTurn,
  opts?: { project?: string; cwd?: string; platform?: "cursor" | "claude-code" },
): string {
  const filePath = getConversationPath(sessionId);

  // Create file if it doesn't exist
  if (!fs.existsSync(filePath)) {
    initConversation({
      sessionId,
      project: opts?.project ?? "unknown",
      cwd: opts?.cwd ?? process.cwd(),
      platform: opts?.platform ?? "cursor",
    });
  }

  // Count existing turns to determine the turn number
  const existing = fs.readFileSync(filePath, "utf-8");
  const turnMatches = existing.match(/^## Turn \d+/gm);
  const turnNumber = (turnMatches?.length ?? 0) + 1;

  // Build turn content
  const turnLines: string[] = [];
  turnLines.push(`## Turn ${turnNumber}`);

  if (turn.user) {
    turnLines.push("### User");
    turnLines.push(turn.user.trim());
    turnLines.push("");
  }

  if (turn.assistant) {
    turnLines.push("### Assistant");
    turnLines.push(turn.assistant.trim());
    turnLines.push("");
  }

  turnLines.push("");

  fs.appendFileSync(filePath, turnLines.join("\n"), "utf-8");

  return filePath;
}

/**
 * Finalize a conversation file with closing metadata.
 */
export function finalizeConversation(sessionId: string): void {
  const filePath = getConversationPath(sessionId);
  if (!fs.existsSync(filePath)) return;

  const content = fs.readFileSync(filePath, "utf-8");
  const turnMatches = content.match(/^## Turn \d+/gm);
  const turnCount = turnMatches?.length ?? 0;

  // Append closing metadata
  const closing = [
    "",
    "---",
    `ended: ${new Date().toISOString()}`,
    `turn_count: ${turnCount}`,
    "---",
    "",
  ].join("\n");

  fs.appendFileSync(filePath, closing, "utf-8");
}

/**
 * Check if a conversation file exists for the given session ID.
 */
export function conversationExists(sessionId: string): boolean {
  return fs.existsSync(getConversationPath(sessionId));
}

/**
 * Read the full conversation file content.
 */
export function readConversation(sessionId: string): string | null {
  const filePath = getConversationPath(sessionId);
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, "utf-8");
}

/**
 * Get the file path for a conversation (for indexing purposes).
 */
export function getConversationFilePath(sessionId: string): string {
  return getConversationPath(sessionId);
}

// ---------------------------------------------------------------------------
// Transcript reading (Cursor format)
// ---------------------------------------------------------------------------

/**
 * Read the latest turn from a Cursor transcript file.
 * Cursor transcripts are JSON with message arrays.
 *
 * Returns the latest user/assistant pair.
 */
export function readLatestTurnFromTranscript(
  transcriptPath: string,
): ConversationTurn | null {
  try {
    if (!fs.existsSync(transcriptPath)) return null;
    const content = fs.readFileSync(transcriptPath, "utf-8");

    // Cursor transcript format: array of messages with role and content
    const messages = JSON.parse(content) as Array<{
      role: string;
      content: string;
    }>;

    if (!Array.isArray(messages) || messages.length === 0) return null;

    // Find the last user/assistant pair
    let lastUser: string | undefined;
    let lastAssistant: string | undefined;

    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (!msg) continue;

      if (msg.role === "assistant" && !lastAssistant) {
        lastAssistant = msg.content;
      } else if (msg.role === "user" && !lastUser) {
        lastUser = msg.content;
      }

      if (lastUser && lastAssistant) break;
    }

    if (!lastUser && !lastAssistant) return null;

    return { user: lastUser, assistant: lastAssistant };
  } catch {
    return null;
  }
}

/**
 * Read the full transcript and return all turns as pairs.
 */
export function readAllTurnsFromTranscript(
  transcriptPath: string,
): ConversationTurn[] {
  try {
    if (!fs.existsSync(transcriptPath)) return [];
    const content = fs.readFileSync(transcriptPath, "utf-8");

    const messages = JSON.parse(content) as Array<{
      role: string;
      content: string;
    }>;

    if (!Array.isArray(messages)) return [];

    const turns: ConversationTurn[] = [];
    let currentUser: string | undefined;

    for (const msg of messages) {
      if (msg.role === "user") {
        // If we already had a user message without assistant response, flush it
        if (currentUser) {
          turns.push({ user: currentUser });
        }
        currentUser = msg.content;
      } else if (msg.role === "assistant") {
        turns.push({ user: currentUser, assistant: msg.content });
        currentUser = undefined;
      }
    }

    // Flush any trailing user message
    if (currentUser) {
      turns.push({ user: currentUser });
    }

    return turns;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Turn content extraction from stdin (Claude Code format)
// ---------------------------------------------------------------------------

/**
 * Parse a turn from Claude Code hook input (JSON from stdin).
 * The stop hook receives the conversation context.
 */
export function parseTurnFromStdin(
  input: string,
): ConversationTurn | null {
  try {
    const data = JSON.parse(input) as Record<string, unknown>;

    // Claude Code stop hook provides conversation context
    if (data.conversation && Array.isArray(data.conversation)) {
      const messages = data.conversation as Array<{
        role: string;
        content: string;
      }>;

      // Get the last user/assistant pair
      let lastUser: string | undefined;
      let lastAssistant: string | undefined;

      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (!msg) continue;

        if (msg.role === "assistant" && !lastAssistant) {
          lastAssistant = msg.content;
        } else if (msg.role === "user" && !lastUser) {
          lastUser = msg.content;
        }

        if (lastUser && lastAssistant) break;
      }

      if (lastUser || lastAssistant) {
        return { user: lastUser, assistant: lastAssistant };
      }
    }

    // Fallback: check for direct user/assistant fields
    if (data.user_message || data.assistant_message) {
      return {
        user: data.user_message as string | undefined,
        assistant: data.assistant_message as string | undefined,
      };
    }

    return null;
  } catch {
    return null;
  }
}
