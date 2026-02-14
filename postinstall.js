/**
 * postinstall.js — Sets up agent-orchestrator for Cursor and/or Claude Code.
 *
 * Runs automatically after `npm install`. Creates:
 *   - ~/.config/agent-orchestrator/memory/           (shared memory directory)
 *   - ~/.config/agent-orchestrator/memory/sessions/
 *   - ~/.config/agent-orchestrator/agents/dynamic/   (shared dynamic agents)
 *
 * For each detected platform (Cursor, Claude Code):
 *   - Concatenates core orchestrator + harness-specific appendix
 *   - Installs the combined file to the platform's command/skill location
 *   - Copies agent files with platform-appropriate model names
 *   - Creates symlink for dynamic agents directory
 *
 * Finally runs `memory-search index` to download the embedding model (~0.6GB)
 * and build the initial search index.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const HOME = os.homedir();

// Shared directories (tool-agnostic)
const CONFIG_DIR = path.join(HOME, ".config", "agent-orchestrator");
const SHARED_MEMORY_DIR = path.join(CONFIG_DIR, "memory");
const SHARED_SESSIONS_DIR = path.join(SHARED_MEMORY_DIR, "sessions");
const SHARED_AGENTS_DIR = path.join(CONFIG_DIR, "agents");
const SHARED_DYNAMIC_AGENTS_DIR = path.join(SHARED_AGENTS_DIR, "dynamic");

// Platform-specific directories
const CURSOR_DIR = path.join(HOME, ".cursor");
const CURSOR_COMMANDS_DIR = path.join(CURSOR_DIR, "commands");
const CURSOR_AGENTS_DIR = path.join(CURSOR_DIR, "agents");
const CURSOR_DYNAMIC_AGENTS_DIR = path.join(CURSOR_AGENTS_DIR, "dynamic");

const CLAUDE_DIR = path.join(HOME, ".claude");
const CLAUDE_SKILLS_DIR = path.join(CLAUDE_DIR, "skills");
const CLAUDE_ORCHESTRATOR_SKILL_DIR = path.join(CLAUDE_SKILLS_DIR, "orchestrator");
const CLAUDE_AGENTS_DIR = path.join(CLAUDE_DIR, "agents");
const CLAUDE_DYNAMIC_AGENTS_DIR = path.join(CLAUDE_AGENTS_DIR, "dynamic");

// Model name mappings for each platform
const MODEL_MAPPINGS = {
  cursor: {
    budget: "claude-4.5-haiku",
    standard: "claude-4.5-sonnet",
    fast: "fast",
  },
  claudeCode: {
    budget: "haiku",
    standard: "sonnet",
    fast: "haiku",
  },
};

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
    return true;
  } catch (err) {
    console.warn(`  Warning: could not copy ${src} -> ${dest}: ${err.message}`);
    return false;
  }
}

function writeFile(dest, content) {
  try {
    fs.writeFileSync(dest, content, "utf-8");
    console.log(`  Installed: ${dest}`);
    return true;
  } catch (err) {
    console.warn(`  Warning: could not write ${dest}: ${err.message}`);
    return false;
  }
}

function createSymlink(target, linkPath) {
  try {
    // Check if link already exists
    if (fs.existsSync(linkPath)) {
      const stats = fs.lstatSync(linkPath);
      if (stats.isSymbolicLink()) {
        const existingTarget = fs.readlinkSync(linkPath);
        if (existingTarget === target) {
          console.log(`  Symlink OK: ${linkPath} -> ${target}`);
          return true;
        }
        // Remove incorrect symlink
        fs.unlinkSync(linkPath);
      } else if (stats.isDirectory()) {
        // Directory exists - check if empty
        const contents = fs.readdirSync(linkPath);
        if (contents.length === 0) {
          fs.rmdirSync(linkPath);
        } else {
          console.warn(`  Warning: ${linkPath} exists and is not empty, skipping symlink`);
          return false;
        }
      }
    }
    
    // Ensure parent directory exists
    ensureDir(path.dirname(linkPath));
    
    // Create symlink
    fs.symlinkSync(target, linkPath, "dir");
    console.log(`  Symlink:   ${linkPath} -> ${target}`);
    return true;
  } catch (err) {
    console.warn(`  Warning: could not create symlink ${linkPath} -> ${target}: ${err.message}`);
    return false;
  }
}

function platformExists(dir) {
  return fs.existsSync(dir);
}

function readFile(filePath) {
  return fs.readFileSync(filePath, "utf-8");
}

function replaceModelNames(content, platform) {
  const mappings = MODEL_MAPPINGS[platform];
  // Replace model references in agent files
  let result = content;
  if (platform === "claudeCode") {
    // Replace Cursor-style model names with Claude Code equivalents
    result = result.replace(/model:\s*claude-4\.5-haiku/g, "model: haiku");
    result = result.replace(/model:\s*claude-4\.5-sonnet/g, "model: sonnet");
    result = result.replace(/model:\s*claude-4\.6-opus/g, "model: opus");
    result = result.replace(/model:\s*fast/g, "model: haiku");
  }
  return result;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log("Setting up agent-orchestrator...\n");

// ---------------------------------------------------------------------------
// Step 1: Create shared directories (always)
// ---------------------------------------------------------------------------

console.log("Creating shared directories...");
ensureDir(CONFIG_DIR);
ensureDir(SHARED_MEMORY_DIR);
ensureDir(SHARED_SESSIONS_DIR);
ensureDir(SHARED_AGENTS_DIR);
ensureDir(SHARED_DYNAMIC_AGENTS_DIR);
console.log(`  Created: ${CONFIG_DIR}/`);

// ---------------------------------------------------------------------------
// Step 2: Detect available platforms
// ---------------------------------------------------------------------------

const platforms = [];

if (platformExists(CURSOR_DIR)) {
  platforms.push("cursor");
  console.log("  Detected: Cursor");
}

if (platformExists(CLAUDE_DIR)) {
  platforms.push("claudeCode");
  console.log("  Detected: Claude Code");
}

if (platforms.length === 0) {
  console.log("  No platforms detected. Creating directories for Cursor (default)...");
  ensureDir(CURSOR_DIR);
  platforms.push("cursor");
}

// ---------------------------------------------------------------------------
// Step 3: Read core orchestrator and harness files
// ---------------------------------------------------------------------------

const coreContent = readFile(path.join(__dirname, "commands", "orchestrator.md"));
const cursorHarness = readFile(path.join(__dirname, "harness", "cursor.md"));
const claudeCodeHarness = readFile(path.join(__dirname, "harness", "claude-code.md"));

// ---------------------------------------------------------------------------
// Step 4: Install to each platform
// ---------------------------------------------------------------------------

const installedPaths = {
  commands: [],
  agents: [],
};

for (const platform of platforms) {
  console.log(`\nInstalling for ${platform === "cursor" ? "Cursor" : "Claude Code"}...`);
  
  if (platform === "cursor") {
    // Ensure directories exist
    ensureDir(CURSOR_COMMANDS_DIR);
    ensureDir(CURSOR_AGENTS_DIR);
    
    // Concatenate core + harness and write command file
    const combinedContent = coreContent + "\n" + cursorHarness;
    writeFile(path.join(CURSOR_COMMANDS_DIR, "orchestrator.md"), combinedContent);
    installedPaths.commands.push(path.join(CURSOR_COMMANDS_DIR, "orchestrator.md"));
    
    // Copy agent files (with Cursor model names - no changes needed)
    copyFile(
      path.join(__dirname, "agents", "memory-agent.md"),
      path.join(CURSOR_AGENTS_DIR, "memory-agent.md")
    );
    copyFile(
      path.join(__dirname, "agents", "memory-recall-agent.md"),
      path.join(CURSOR_AGENTS_DIR, "memory-recall-agent.md")
    );
    installedPaths.agents.push(CURSOR_AGENTS_DIR);
    
    // Create symlink for dynamic agents
    createSymlink(SHARED_DYNAMIC_AGENTS_DIR, CURSOR_DYNAMIC_AGENTS_DIR);
    
  } else if (platform === "claudeCode") {
    // Ensure directories exist
    ensureDir(CLAUDE_SKILLS_DIR);
    ensureDir(CLAUDE_ORCHESTRATOR_SKILL_DIR);
    ensureDir(CLAUDE_AGENTS_DIR);
    
    // Concatenate core + harness with skill frontmatter
    const skillFrontmatter = `---
name: orchestrator
description: Technical project manager that orchestrates sub-agents to complete complex tasks. Use when you need to coordinate multiple agents for implementation, research, and QA.
disable-model-invocation: true
---

`;
    const combinedContent = skillFrontmatter + coreContent + "\n" + claudeCodeHarness;
    writeFile(path.join(CLAUDE_ORCHESTRATOR_SKILL_DIR, "SKILL.md"), combinedContent);
    installedPaths.commands.push(path.join(CLAUDE_ORCHESTRATOR_SKILL_DIR, "SKILL.md"));
    
    // Copy agent files with Claude Code model names
    const memoryAgentContent = readFile(path.join(__dirname, "agents", "memory-agent.md"));
    const memoryRecallAgentContent = readFile(path.join(__dirname, "agents", "memory-recall-agent.md"));
    
    writeFile(
      path.join(CLAUDE_AGENTS_DIR, "memory-agent.md"),
      replaceModelNames(memoryAgentContent, "claudeCode")
    );
    writeFile(
      path.join(CLAUDE_AGENTS_DIR, "memory-recall-agent.md"),
      replaceModelNames(memoryRecallAgentContent, "claudeCode")
    );
    installedPaths.agents.push(CLAUDE_AGENTS_DIR);
    
    // Create symlink for dynamic agents
    createSymlink(SHARED_DYNAMIC_AGENTS_DIR, CLAUDE_DYNAMIC_AGENTS_DIR);
  }
}

// ---------------------------------------------------------------------------
// Step 5: Create initial MEMORY.md if it doesn't exist
// ---------------------------------------------------------------------------

const memoryFile = path.join(SHARED_MEMORY_DIR, "MEMORY.md");
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
  console.log(`\n  Created: ${memoryFile}`);
}

// ---------------------------------------------------------------------------
// Step 6: Build initial search index (downloads embedding model on first run)
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

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`
Setup complete!

Shared data:
  Memory:   ${SHARED_MEMORY_DIR}/
  Agents:   ${SHARED_DYNAMIC_AGENTS_DIR}/

Installed to:`);

for (const cmdPath of installedPaths.commands) {
  console.log(`  Command:  ${cmdPath}`);
}
for (const agentPath of installedPaths.agents) {
  console.log(`  Agents:   ${agentPath}/`);
}

console.log(`
Usage:
  memory-search index          Re-index memory files
  memory-search query "text"   Search your memories
  memory-search status         Show index statistics
`);

if (platforms.includes("cursor")) {
  console.log("Cursor: Type /orchestrator in any Cursor chat to use it.");
}
if (platforms.includes("claudeCode")) {
  console.log("Claude Code: Type /orchestrator in Claude Code to use it.");
}
console.log("");
