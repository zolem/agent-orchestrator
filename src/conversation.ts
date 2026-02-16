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

function getSessionMapDir(): string {
  return path.join(getMemoryDir(), ".session-map");
}

/**
 * Save a mapping from a platform's session ID to our memory session ID.
 * Used for Claude Code where env vars may not persist across hooks.
 */
export function saveSessionMapping(platformSessionId: string, memorySessionId: string): void {
  const dir = getSessionMapDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, platformSessionId), memorySessionId, "utf-8");
}

/**
 * Look up a memory session ID from a platform session ID.
 */
export function lookupSessionMapping(platformSessionId: string): string | null {
  try {
    const filePath = path.join(getSessionMapDir(), platformSessionId);
    if (!fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath, "utf-8").trim();
  } catch {
    return null;
  }
}

/**
 * Clean up a session mapping file.
 */
export function removeSessionMapping(platformSessionId: string): void {
  try {
    const filePath = path.join(getSessionMapDir(), platformSessionId);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // Non-blocking
  }
}

// ---------------------------------------------------------------------------
// Pending prompt buffer (Cursor-specific)
// ---------------------------------------------------------------------------

/**
 * Directory for storing pending user prompts between beforeSubmitPrompt
 * and afterAgentResponse hooks in Cursor (which doesn't provide
 * transcript_path).
 */
function getPendingPromptDir(): string {
  return path.join(getMemoryDir(), ".pending-prompts");
}

/**
 * Store a user prompt for later pairing with the agent response.
 * Key is the Cursor conversation_id.
 */
export function savePendingPrompt(conversationId: string, prompt: string): void {
  const dir = getPendingPromptDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, conversationId), prompt, "utf-8");
}

/**
 * Retrieve and remove a pending user prompt.
 * Returns null if no pending prompt exists.
 */
export function consumePendingPrompt(conversationId: string): string | null {
  try {
    const filePath = path.join(getPendingPromptDir(), conversationId);
    if (!fs.existsSync(filePath)) return null;
    const prompt = fs.readFileSync(filePath, "utf-8");
    fs.unlinkSync(filePath);
    return prompt;
  } catch {
    return null;
  }
}

/**
 * Clean up any leftover pending prompts for a conversation.
 */
export function removePendingPrompt(conversationId: string): void {
  try {
    const filePath = path.join(getPendingPromptDir(), conversationId);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // Non-blocking
  }
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
 * Metadata extracted from hook stdin JSON.
 * Works for both Cursor and Claude Code hook events.
 *
 * Cursor uses `conversation_id`; Claude Code uses `session_id`.
 * Claude Code provides `transcript_path`; Cursor's afterAgentResponse
 * provides `text` (assistant response), and beforeSubmitPrompt provides
 * `prompt` (user message).
 */
export interface HookInput {
  /** Claude Code's session_id or Cursor's conversation_id (normalized) */
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  /** Cursor afterAgentResponse: the agent's response text */
  text?: string;
  /** Cursor beforeSubmitPrompt: the user's prompt text */
  prompt?: string;
  /** Cursor stop: task status (completed/aborted/error) */
  status?: string;
}

/**
 * Parse hook stdin JSON to extract metadata.
 * Handles both Cursor and Claude Code field names.
 */
export function parseStopHookInput(input: string): HookInput | null {
  try {
    const data = JSON.parse(input) as Record<string, unknown>;
    // Normalize: Claude Code uses session_id, Cursor uses conversation_id
    const sessionId =
      (typeof data.session_id === "string" ? data.session_id : undefined) ??
      (typeof data.conversation_id === "string" ? data.conversation_id : undefined);
    return {
      session_id: sessionId,
      transcript_path: typeof data.transcript_path === "string" ? data.transcript_path : undefined,
      cwd: typeof data.cwd === "string" ? data.cwd : undefined,
      hook_event_name: typeof data.hook_event_name === "string" ? data.hook_event_name : undefined,
      text: typeof data.text === "string" ? data.text : undefined,
      prompt: typeof data.prompt === "string" ? data.prompt : undefined,
      status: typeof data.status === "string" ? data.status : undefined,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Claude Code JSONL transcript reading
// ---------------------------------------------------------------------------

/**
 * Extract text content from a Claude Code message content field.
 * Content can be a string or an array of content blocks.
 */
function extractTextContent(
  content: unknown,
): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const parts: string[] = [];
  for (const block of content) {
    if (
      typeof block === "object" &&
      block !== null &&
      "type" in block &&
      (block as Record<string, unknown>).type === "text" &&
      "text" in block
    ) {
      parts.push((block as Record<string, unknown>).text as string);
    }
  }
  return parts.join("\n");
}

/**
 * Read a Claude Code JSONL transcript file and extract the latest
 * user/assistant turn pair.
 *
 * Transcript lines have a `type` field: "user" messages contain
 * `.message.content` (string), while "assistant" messages contain
 * `.message.content` (array of {type:"text", text:string} blocks).
 */
export function readLatestTurnFromClaudeTranscript(
  transcriptPath: string,
): ConversationTurn | null {
  try {
    if (!fs.existsSync(transcriptPath)) return null;
    const raw = fs.readFileSync(transcriptPath, "utf-8");
    const lines = raw.split("\n").filter(Boolean);

    // Walk backwards to find the last user/assistant pair
    let lastUser: string | undefined;
    let lastAssistant: string | undefined;

    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i] ?? "") as Record<string, unknown>;
        const entryType = entry.type as string | undefined;

        if (entryType === "assistant" && !lastAssistant) {
          const msg = entry.message as Record<string, unknown> | undefined;
          if (msg?.content) {
            const text = extractTextContent(msg.content);
            if (text.trim()) lastAssistant = text;
          }
        } else if (entryType === "user" && !lastUser) {
          const msg = entry.message as Record<string, unknown> | undefined;
          if (msg?.content) {
            const text = extractTextContent(msg.content);
            if (text.trim()) lastUser = text;
          }
        }

        if (lastUser && lastAssistant) break;
      } catch {
        // Skip malformed lines
      }
    }

    if (!lastUser && !lastAssistant) return null;
    return { user: lastUser, assistant: lastAssistant };
  } catch {
    return null;
  }
}

/**
 * Read all user/assistant turns from a Claude Code JSONL transcript file.
 */
export function readAllTurnsFromClaudeTranscript(
  transcriptPath: string,
): ConversationTurn[] {
  try {
    if (!fs.existsSync(transcriptPath)) return [];
    const raw = fs.readFileSync(transcriptPath, "utf-8");
    const lines = raw.split("\n").filter(Boolean);

    const turns: ConversationTurn[] = [];
    let currentUser: string | undefined;

    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        const entryType = entry.type as string | undefined;

        if (entryType === "user") {
          const msg = entry.message as Record<string, unknown> | undefined;
          const text = msg?.content ? extractTextContent(msg.content) : "";
          if (currentUser) {
            turns.push({ user: currentUser });
          }
          currentUser = text.trim() || undefined;
        } else if (entryType === "assistant") {
          const msg = entry.message as Record<string, unknown> | undefined;
          const text = msg?.content ? extractTextContent(msg.content) : "";
          if (text.trim()) {
            turns.push({ user: currentUser, assistant: text });
            currentUser = undefined;
          }
        }
      } catch {
        // Skip malformed lines
      }
    }

    if (currentUser) {
      turns.push({ user: currentUser });
    }

    return turns;
  } catch {
    return [];
  }
}

/**
 * Parse a turn from Claude Code hook input (JSON from stdin).
 *
 * The Stop hook receives { session_id, transcript_path, cwd, ... } — NOT a
 * conversation array.  We parse the metadata here; the actual transcript is
 * read separately via readLatestTurnFromClaudeTranscript().
 *
 * This function is kept for backward-compatibility with any callers that
 * might pipe a conversation array directly.
 */
export function parseTurnFromStdin(
  input: string,
): ConversationTurn | null {
  try {
    const data = JSON.parse(input) as Record<string, unknown>;

    // Legacy path: if a conversation array is provided directly
    if (data.conversation && Array.isArray(data.conversation)) {
      const messages = data.conversation as Array<{
        role: string;
        content: string;
      }>;

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

    // If the hook provides a transcript_path, read from the JSONL file
    if (data.transcript_path && typeof data.transcript_path === "string") {
      return readLatestTurnFromClaudeTranscript(data.transcript_path);
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
