/**
 * postinstall.js — Sets up Cursor directories and installs orchestrator files.
 *
 * Runs automatically after `npm install`. Creates:
 *   - ~/.cursor/commands/orchestrator.md
 *   - ~/.cursor/agents/memory-agent.md
 *   - ~/.cursor/agents/memory-recall-agent.md
 *   - ~/.cursor/agents/dynamic/           (empty, for runtime agents)
 *   - ~/.cursor/memory/                   (with initial MEMORY.md if missing)
 *   - ~/.cursor/memory/sessions/
 *   6. Runs `memory-search index` to download the embedding model (~0.6GB)
 *      and build the initial search index.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const HOME = os.homedir();
const CURSOR_DIR = path.join(HOME, ".cursor");
const COMMANDS_DIR = path.join(CURSOR_DIR, "commands");
const AGENTS_DIR = path.join(CURSOR_DIR, "agents");
const DYNAMIC_AGENTS_DIR = path.join(AGENTS_DIR, "dynamic");
const MEMORY_DIR = path.join(CURSOR_DIR, "memory");
const SESSIONS_DIR = path.join(MEMORY_DIR, "sessions");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function copyFile(src, dest) {
  try {
    fs.copyFileSync(src, dest);
    console.log(`  Installed: ${dest}`);
  } catch (err) {
    console.warn(`  Warning: could not copy ${src} -> ${dest}: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log("Setting up agent-orchestrator...\n");

// Create directories
ensureDir(COMMANDS_DIR);
ensureDir(AGENTS_DIR);
ensureDir(DYNAMIC_AGENTS_DIR);
ensureDir(MEMORY_DIR);
ensureDir(SESSIONS_DIR);

// Copy command files
copyFile(
  path.join(__dirname, "commands", "orchestrator.md"),
  path.join(COMMANDS_DIR, "orchestrator.md"),
);

// Copy agent files
copyFile(
  path.join(__dirname, "agents", "memory-agent.md"),
  path.join(AGENTS_DIR, "memory-agent.md"),
);

copyFile(
  path.join(__dirname, "agents", "memory-recall-agent.md"),
  path.join(AGENTS_DIR, "memory-recall-agent.md"),
);


// Create initial MEMORY.md if it doesn't exist
const memoryFile = path.join(MEMORY_DIR, "MEMORY.md");
if (!fs.existsSync(memoryFile)) {
  fs.writeFileSync(
    memoryFile,
    `# Orchestrator Memory

## User Preferences

## Sub-Agent Patterns

## Decisions Log

## Lessons Learned

## Anti-Patterns
`,
    "utf-8",
  );
  console.log(`  Created:   ${memoryFile}`);
}

// ---------------------------------------------------------------------------
// Build initial search index (downloads embedding model on first run)
// ---------------------------------------------------------------------------

const MEMORY_SEARCH_BIN = path.join(__dirname, "bin", "memory-search.js");

console.log("\nBuilding initial search index...");
console.log("(This will download the embedding model on first run — ~0.6GB)\n");

try {
  execFileSync(process.execPath, [MEMORY_SEARCH_BIN, "index", "--verbose"], {
    stdio: "inherit",
  });
} catch {
  console.warn(
    "\n  Warning: Initial indexing failed. This is OK — you can run" +
    "\n  'memory-search index' manually later.\n",
  );
}

console.log(`
Setup complete!

Installed files:
  Command:  ${path.join(COMMANDS_DIR, "orchestrator.md")}
  Agents:   ${path.join(AGENTS_DIR, "memory-agent.md")}
            ${path.join(AGENTS_DIR, "memory-recall-agent.md")}
  Memory:   ${MEMORY_DIR}/

Usage:
  memory-search index          Re-index memory files
  memory-search query "text"   Search your memories
  memory-search status         Show index statistics

The orchestrator slash command is now available in Cursor.
Type /orchestrator in any Cursor chat to use it.
`);
