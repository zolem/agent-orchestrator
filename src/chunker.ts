/**
 * chunker.ts — Line-based markdown chunking.
 *
 * Splits markdown content into chunks of ~400 tokens (~1600 chars) with
 * ~80 token (~320 char) overlap. Preserves 1-indexed line numbers and
 * computes SHA-256 hash per chunk.
 *
 * Modeled after OpenClaw's chunkMarkdown() in internal.ts.
 */

import crypto from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Chunk {
  startLine: number; // 1-indexed
  endLine: number;   // 1-indexed
  text: string;
  hash: string;      // SHA-256 of text
}

// ---------------------------------------------------------------------------
// Config defaults
// ---------------------------------------------------------------------------

const DEFAULT_CHUNK_TOKENS = 400;
const DEFAULT_OVERLAP_TOKENS = 80;
const CHARS_PER_TOKEN = 4; // rough approximation

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

export function hashText(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

export function chunkMarkdown(
  content: string,
  options?: { tokens?: number; overlap?: number },
): Chunk[] {
  const tokens = options?.tokens ?? DEFAULT_CHUNK_TOKENS;
  const overlap = options?.overlap ?? DEFAULT_OVERLAP_TOKENS;

  const lines = content.split("\n");
  if (lines.length === 0) return [];

  const maxChars = Math.max(32, tokens * CHARS_PER_TOKEN);
  const overlapChars = Math.max(0, overlap * CHARS_PER_TOKEN);
  const chunks: Chunk[] = [];

  let current: Array<{ line: string; lineNo: number }> = [];
  let currentChars = 0;

  const flush = () => {
    if (current.length === 0) return;
    const first = current[0];
    const last = current[current.length - 1];
    if (!first || !last) return;
    const text = current.map((e) => e.line).join("\n");
    chunks.push({
      startLine: first.lineNo,
      endLine: last.lineNo,
      text,
      hash: hashText(text),
    });
  };

  const carryOverlap = () => {
    if (overlapChars <= 0 || current.length === 0) {
      current = [];
      currentChars = 0;
      return;
    }
    let acc = 0;
    const kept: Array<{ line: string; lineNo: number }> = [];
    for (let i = current.length - 1; i >= 0; i--) {
      const entry = current[i];
      if (!entry) continue;
      acc += entry.line.length + 1;
      kept.unshift(entry);
      if (acc >= overlapChars) break;
    }
    current = kept;
    currentChars = kept.reduce((sum, e) => sum + e.line.length + 1, 0);
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const lineNo = i + 1; // 1-indexed

    // Handle very long lines by splitting into segments
    const segments: string[] = [];
    if (line.length === 0) {
      segments.push("");
    } else {
      for (let start = 0; start < line.length; start += maxChars) {
        segments.push(line.slice(start, start + maxChars));
      }
    }

    for (const segment of segments) {
      const lineSize = segment.length + 1; // +1 for newline
      if (currentChars + lineSize > maxChars && current.length > 0) {
        flush();
        carryOverlap();
      }
      current.push({ line: segment, lineNo });
      currentChars += lineSize;
    }
  }

  flush();
  return chunks;
}
