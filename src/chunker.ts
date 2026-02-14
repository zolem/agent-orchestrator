/**
 * chunker.ts — Markdown-structure-aware chunking.
 *
 * Splits markdown content at heading boundaries (##, ###) to produce
 * semantically coherent chunks. Each section becomes a chunk with its
 * heading hierarchy prepended as breadcrumbs.
 *
 * Falls back to character-based splitting only for sections that exceed
 * the chunk size limit.
 */

import crypto from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Chunk {
  startLine: number; // 1-indexed
  endLine: number; // 1-indexed
  text: string;
  hash: string; // SHA-256 of text
  breadcrumbs?: string; // heading hierarchy, e.g., "Session: X > What Worked"
  sectionName?: string; // immediate section heading
}

export interface ParsedFrontmatter {
  date?: string;
  project?: string;
  tags?: string[];
  tools?: string[];
  outcome?: string;
  [key: string]: unknown;
}

export interface ChunkOptions {
  maxChars?: number; // max chars per chunk (default 1600)
  includeBreadcrumbs?: boolean; // prepend breadcrumbs to chunk text (default true)
}

// ---------------------------------------------------------------------------
// Config defaults
// ---------------------------------------------------------------------------

const DEFAULT_MAX_CHARS = 1600;
const MIN_CHUNK_CHARS = 32;

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

export function hashText(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

// ---------------------------------------------------------------------------
// YAML Frontmatter Parsing
// ---------------------------------------------------------------------------

/**
 * Parse YAML frontmatter from markdown content.
 * Returns the parsed frontmatter and the content after the frontmatter.
 */
export function parseFrontmatter(content: string): {
  frontmatter: ParsedFrontmatter | null;
  body: string;
  frontmatterEndLine: number;
} {
  const lines = content.split("\n");
  if (lines[0]?.trim() !== "---") {
    return { frontmatter: null, body: content, frontmatterEndLine: 0 };
  }

  let endIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === "---") {
      endIndex = i;
      break;
    }
  }

  if (endIndex === -1) {
    return { frontmatter: null, body: content, frontmatterEndLine: 0 };
  }

  const frontmatterLines = lines.slice(1, endIndex);
  const frontmatter: ParsedFrontmatter = {};

  for (const line of frontmatterLines) {
    const match = line.match(/^(\w+):\s*(.*)$/);
    if (match) {
      const [, key, rawValue] = match;
      if (!key) continue;
      let value: unknown = rawValue?.trim();

      // Parse arrays: [item1, item2]
      if (typeof value === "string" && value.startsWith("[") && value.endsWith("]")) {
        value = value
          .slice(1, -1)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
      }

      frontmatter[key] = value;
    }
  }

  const body = lines.slice(endIndex + 1).join("\n");
  return { frontmatter, body, frontmatterEndLine: endIndex + 1 };
}

// ---------------------------------------------------------------------------
// Markdown Section Parsing
// ---------------------------------------------------------------------------

interface MarkdownSection {
  level: number; // 1 for #, 2 for ##, etc.
  heading: string; // heading text without # prefix
  content: string; // content including heading line
  startLine: number; // 1-indexed
  endLine: number; // 1-indexed
  breadcrumbs: string[]; // parent headings
}

/**
 * Parse markdown into a flat list of sections based on headings.
 * Each section includes its content and heading hierarchy.
 */
function parseMarkdownSections(
  content: string,
  lineOffset: number = 0,
): MarkdownSection[] {
  const lines = content.split("\n");
  const sections: MarkdownSection[] = [];
  const headingStack: Array<{ level: number; text: string }> = [];

  let currentSection: {
    level: number;
    heading: string;
    lines: string[];
    startLine: number;
    breadcrumbs: string[];
  } | null = null;

  const flushSection = (endLine: number) => {
    if (currentSection && currentSection.lines.length > 0) {
      const content = currentSection.lines.join("\n");
      if (content.trim()) {
        sections.push({
          level: currentSection.level,
          heading: currentSection.heading,
          content,
          startLine: currentSection.startLine,
          endLine,
          breadcrumbs: currentSection.breadcrumbs,
        });
      }
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const lineNo = i + 1 + lineOffset; // 1-indexed with offset

    // Check if this is a heading
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);

    if (headingMatch) {
      const levelStr = headingMatch[1] ?? "";
      const headingTextRaw = headingMatch[2] ?? "";
      const level = levelStr.length;
      const headingText = headingTextRaw.trim();

      // Flush previous section
      flushSection(lineNo - 1);

      // Update heading stack
      while (headingStack.length > 0) {
        const last = headingStack[headingStack.length - 1];
        if (last && last.level >= level) {
          headingStack.pop();
        } else {
          break;
        }
      }

      const breadcrumbs = headingStack.map((h) => h.text);
      headingStack.push({ level, text: headingText });

      // Start new section
      currentSection = {
        level,
        heading: headingText,
        lines: [line],
        startLine: lineNo,
        breadcrumbs,
      };
    } else if (currentSection) {
      currentSection.lines.push(line);
    } else {
      // Content before any heading (preamble)
      if (!currentSection && line.trim()) {
        currentSection = {
          level: 0,
          heading: "",
          lines: [line],
          startLine: lineNo,
          breadcrumbs: [],
        };
      }
    }
  }

  // Flush final section
  flushSection(lines.length + lineOffset);

  return sections;
}

// ---------------------------------------------------------------------------
// Character-based splitting for oversized sections
// ---------------------------------------------------------------------------

function splitOversizedSection(
  section: MarkdownSection,
  maxChars: number,
): MarkdownSection[] {
  const lines = section.content.split("\n");
  const result: MarkdownSection[] = [];

  let current: string[] = [];
  let currentChars = 0;
  let startLine = section.startLine;

  const flush = (endLine: number) => {
    if (current.length === 0) return;
    const content = current.join("\n");
    if (content.trim()) {
      result.push({
        level: section.level,
        heading: section.heading,
        content,
        startLine,
        endLine,
        breadcrumbs: section.breadcrumbs,
      });
    }
    current = [];
    currentChars = 0;
    startLine = endLine + 1;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const lineSize = line.length + 1;

    if (currentChars + lineSize > maxChars && current.length > 0) {
      flush(section.startLine + i - 1);
    }

    current.push(line);
    currentChars += lineSize;
  }

  flush(section.endLine);
  return result;
}

// ---------------------------------------------------------------------------
// Main Chunking Function
// ---------------------------------------------------------------------------

/**
 * Chunk markdown content by heading structure.
 *
 * Each markdown section (delimited by headings) becomes a chunk.
 * Oversized sections are subdivided by character count.
 * Breadcrumbs (heading hierarchy) are prepended to each chunk.
 *
 * @param content - The full markdown content
 * @param options - Chunking options
 * @returns Array of chunks with line numbers, text, hash, and breadcrumbs
 */
export function chunkMarkdown(
  content: string,
  options?: ChunkOptions,
): Chunk[] {
  const maxChars = Math.max(MIN_CHUNK_CHARS, options?.maxChars ?? DEFAULT_MAX_CHARS);
  const includeBreadcrumbs = options?.includeBreadcrumbs ?? true;

  // Parse frontmatter first
  const { body, frontmatterEndLine } = parseFrontmatter(content);

  // Parse into sections
  const sections = parseMarkdownSections(body, frontmatterEndLine);

  // Split oversized sections
  const processedSections: MarkdownSection[] = [];
  for (const section of sections) {
    if (section.content.length > maxChars) {
      processedSections.push(...splitOversizedSection(section, maxChars));
    } else {
      processedSections.push(section);
    }
  }

  // Convert sections to chunks
  const chunks: Chunk[] = [];
  for (const section of processedSections) {
    // Build breadcrumb string
    const breadcrumbParts = [...section.breadcrumbs];
    if (section.heading) {
      breadcrumbParts.push(section.heading);
    }
    const breadcrumbs = breadcrumbParts.join(" > ");

    // Build chunk text with optional breadcrumb prefix
    let text = section.content;
    if (includeBreadcrumbs && breadcrumbs) {
      text = `[${breadcrumbs}]\n${section.content}`;
    }

    chunks.push({
      startLine: section.startLine,
      endLine: section.endLine,
      text,
      hash: hashText(text),
      breadcrumbs: breadcrumbs || undefined,
      sectionName: section.heading || undefined,
    });
  }

  return chunks;
}

// ---------------------------------------------------------------------------
// Legacy compatibility export (deprecated)
// ---------------------------------------------------------------------------

/**
 * @deprecated Use chunkMarkdown with options instead
 */
export function chunkMarkdownLegacy(
  content: string,
  options?: { tokens?: number; overlap?: number },
): Chunk[] {
  const maxChars = (options?.tokens ?? 400) * 4;
  return chunkMarkdown(content, { maxChars, includeBreadcrumbs: false });
}
