/**
 * postinstall.js — Sets up agent-orchestrator hooks for Cursor and/or Claude Code.
 *
 * Runs automatically after `npm install`. Creates:
 *   - ~/.config/agent-orchestrator/memory/                (shared memory directory)
 *   - ~/.config/agent-orchestrator/memory/sessions/       (legacy session logs)
 *   - ~/.config/agent-orchestrator/memory/conversations/  (conversation files)
 *
 * For each detected platform:
 *   - Cursor: installs hooks.json with sessionStart/stop/sessionEnd hooks
 *   - Claude Code: merges hook config into ~/.claude/settings.json
 *
 * Downloads the embedding model (~0.6GB) and text-generation model (~2GB)
 * then builds the initial search index.
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
const SHARED_CONVERSATIONS_DIR = path.join(SHARED_MEMORY_DIR, "conversations");

// Platform-specific directories
const CURSOR_DIR = path.join(HOME, ".cursor");
const CLAUDE_DIR = path.join(HOME, ".claude");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function platformExists(dir) {
  return fs.existsSync(dir);
}

/**
 * Merge hook configuration into an existing JSON file, preserving other keys.
 */
function mergeJsonConfig(filePath, newConfig) {
  let existing = {};
  try {
    if (fs.existsSync(filePath)) {
      existing = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    }
  } catch {
    // File corrupt or empty — overwrite
  }

  // Deep merge: for hooks, merge each event's array
  if (newConfig.hooks && existing.hooks) {
    for (const [event, hooks] of Object.entries(newConfig.hooks)) {
      if (!existing.hooks[event]) {
        existing.hooks[event] = hooks;
      } else {
        // Check if our hook command already exists
        const existingCommands = existing.hooks[event].flatMap(
          (h) => h.hooks?.map((hh) => hh.command) ?? [h.command]
        ).filter(Boolean);

        for (const hookEntry of hooks) {
          const newCommands = hookEntry.hooks?.map((hh) => hh.command) ?? [hookEntry.command];
          const alreadyInstalled = newCommands.some((cmd) =>
            existingCommands.some((ec) => ec.includes("memory-search"))
          );
          if (!alreadyInstalled) {
            existing.hooks[event].push(hookEntry);
          }
        }
      }
    }
    // Merge other top-level keys from newConfig
    for (const [key, value] of Object.entries(newConfig)) {
      if (key !== "hooks") {
        existing[key] = value;
      }
    }
  } else {
    // Simple merge
    Object.assign(existing, newConfig);
  }

  fs.writeFileSync(filePath, JSON.stringify(existing, null, 2) + "\n", "utf-8");
  return filePath;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log("Setting up agent-orchestrator...\n");

// ---------------------------------------------------------------------------
// Step 1: Create shared directories
// ---------------------------------------------------------------------------

console.log("Creating shared directories...");
ensureDir(CONFIG_DIR);
ensureDir(SHARED_MEMORY_DIR);
ensureDir(SHARED_SESSIONS_DIR);
ensureDir(SHARED_CONVERSATIONS_DIR);
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
// Step 3: Install hook configurations
// ---------------------------------------------------------------------------

for (const platform of platforms) {
  console.log(
    `\nInstalling hooks for ${platform === "cursor" ? "Cursor" : "Claude Code"}...`,
  );

  if (platform === "cursor") {
    // Cursor hooks.json
    const hooksConfig = {
      version: 1,
      hooks: {
        sessionStart: [
          {
            command:
              "memory-search hook-start --platform cursor --cwd $WORKSPACE_ROOT",
          },
        ],
        stop: [
          {
            command:
              "memory-search hook-stop --transcript-path $TRANSCRIPT_PATH",
          },
        ],
        sessionEnd: [
          {
            command: "memory-search hook-end",
          },
        ],
      },
    };

    const hooksPath = path.join(CURSOR_DIR, "hooks.json");
    mergeJsonConfig(hooksPath, hooksConfig);
    console.log(`  Installed: ${hooksPath}`);
  } else if (platform === "claudeCode") {
    // Claude Code settings.json
    const hooksConfig = {
      hooks: {
        SessionStart: [
          {
            hooks: [
              {
                type: "command",
                command:
                  "memory-search hook-start --platform claude-code --cwd $PWD",
              },
            ],
          },
        ],
        Stop: [
          {
            hooks: [
              {
                type: "command",
                command: "memory-search hook-stop",
                async: true,
              },
            ],
          },
        ],
        UserPromptSubmit: [
          {
            hooks: [
              {
                type: "command",
                command:
                  "memory-search hook-start --platform claude-code --cwd $PWD --no-inference",
              },
            ],
          },
        ],
        SessionEnd: [
          {
            hooks: [
              {
                type: "command",
                command: "memory-search hook-end",
              },
            ],
          },
        ],
      },
    };

    const settingsPath = path.join(CLAUDE_DIR, "settings.json");
    mergeJsonConfig(settingsPath, hooksConfig);
    console.log(`  Installed: ${settingsPath}`);
  }
}

// ---------------------------------------------------------------------------
// Step 4: Download models via node-llama-cpp CLI
// ---------------------------------------------------------------------------

const NODE_LLAMA_CLI = path.join(__dirname, "node_modules", ".bin", "node-llama-cpp");
const MEMORY_SEARCH_BIN = path.join(__dirname, "bin", "memory-search.js");

// Model URLs and the filenames that node-llama-cpp's resolveModelFile() expects.
// resolveModelFile("hf:org/repo/file.gguf") looks for "hf_{org}_{file}.gguf",
// so we pass --filename to `pull` to match that convention.
const MODELS = [
  {
    url: "https://huggingface.co/ggml-org/embeddinggemma-300M-GGUF/resolve/main/embeddinggemma-300M-Q8_0.gguf",
    filename: "hf_ggml-org_embeddinggemma-300M-Q8_0.gguf",
    label: "Embedding:       embeddinggemma-300M-Q8_0 (~0.3GB)",
  },
  {
    url: "https://huggingface.co/unsloth/Phi-4-mini-instruct-GGUF/resolve/main/Phi-4-mini-instruct-Q4_K_M.gguf",
    filename: "hf_unsloth_Phi-4-mini-instruct-Q4_K_M.gguf",
    label: "Text generation: Phi-4-mini-instruct-Q4_K_M (~2.4GB)",
  },
];

console.log("\nDownloading models...");
for (const model of MODELS) {
  console.log(`  ${model.label}`);
}
console.log("  (already-downloaded models are skipped automatically)\n");

for (const model of MODELS) {
  try {
    execFileSync(
      process.execPath,
      [
        NODE_LLAMA_CLI, "pull",
        "--url", model.url,
        "--filename", model.filename,
      ],
      { stdio: "inherit" },
    );
  } catch (err) {
    console.warn(
      `\n  Warning: Failed to download ${model.filename}. It will be downloaded on first use.` +
        `\n  Error: ${err.message ?? err}\n`,
    );
  }
}

// ---------------------------------------------------------------------------
// Step 5: Build initial search index
// ---------------------------------------------------------------------------

console.log("\nBuilding initial search index...\n");

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
// Step 6: Run migration if old data exists
// ---------------------------------------------------------------------------

try {
  const hasOldData = fs.existsSync(path.join(SHARED_MEMORY_DIR, "MEMORY.md"));
  if (hasOldData) {
    console.log("\nMigrating existing data to belief graph...");
    try {
      execFileSync(
        process.execPath,
        [MEMORY_SEARCH_BIN, "migrate"],
        { stdio: "inherit" },
      );
    } catch {
      console.warn(
        "\n  Warning: Migration failed. Run 'memory-search migrate' manually.\n",
      );
    }
  }
} catch {
  // Not critical
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`
Setup complete!

Shared data:
  Memory:         ${SHARED_MEMORY_DIR}/
  Conversations:  ${SHARED_CONVERSATIONS_DIR}/
`);

if (platforms.includes("cursor")) {
  console.log(`Cursor hooks:     ${path.join(CURSOR_DIR, "hooks.json")}`);
}
if (platforms.includes("claudeCode")) {
  console.log(`Claude Code hooks: ${path.join(CLAUDE_DIR, "settings.json")}`);
}

console.log(`
Usage:
  memory-search index          Re-index memory files
  memory-search query "text"   Search your memories
  memory-search status         Show index statistics
  memory-search migrate        Migrate old data to belief graph
  memory-search hook-start     (called by hooks automatically)
  memory-search hook-stop      (called by hooks automatically)
  memory-search hook-end       (called by hooks automatically)
`);
