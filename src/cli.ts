/**
 * cli.ts — CLI entry point for memory-search.
 *
 * Core commands:
 *   memory-search index          — Index/re-index memory files
 *   memory-search query          — Hybrid search over indexed memories
 *   memory-search status         — Show index statistics
 *
 * Hook commands (invoked by Cursor/Claude Code hooks):
 *   memory-search hook-start     — Session start: inject context + workflow instructions
 *   memory-search hook-stop      — After agent response: capture turn, extract beliefs
 *   memory-search hook-end       — Session end: finalize conversation file
 *
 * Legacy commands (kept for backward compatibility):
 *   memory-search save-session   — Write a session log file and re-index
 *   memory-search update-memory  — Overwrite MEMORY.md and re-index
 *   memory-search uninstall      — Remove all installed files
 *
 * Migration:
 *   memory-search migrate        — Migrate old node types to belief_node
 */

import { Command } from "commander";
import { openDatabase, closeDatabase, getMemoryDir, getConfigDir, runQuery } from "./db.js";
import { createEmbeddingProvider } from "./embeddings.js";
import { indexMemoryFiles } from "./indexer.js";
import { hybridSearch } from "./search.js";
import { extractSessionEntities, detectProjectFromGit } from "./extractor.js";
import { upsertGraphEntities } from "./graph.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import { execSync } from "node:child_process";

/**
 * Read all of stdin into a string. Returns a promise that resolves with the
 * full contents once the stream ends.
 */
function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

const program = new Command();

program
  .name("memory-search")
  .description(
    "Hybrid vector + BM25 memory search for the agent-orchestrator (Cursor/Claude Code)",
  )
  .version("1.0.0");

// ---------------------------------------------------------------------------
// index command
// ---------------------------------------------------------------------------

program
  .command("index")
  .description("Index or re-index all markdown files in the memory directory")
  .option("-v, --verbose", "Show detailed indexing progress")
  .option("--memory-dir <path>", "Override memory directory path")
  .action(async (opts: { verbose?: boolean; memoryDir?: string }) => {
    const memoryDir = opts.memoryDir ?? getMemoryDir();

    if (!fs.existsSync(memoryDir)) {
      console.error(`Memory directory not found: ${memoryDir}`);
      console.error(
        "Create it with: mkdir -p ~/.config/agent-orchestrator/memory",
      );
      process.exit(1);
    }

    const state = await openDatabase();
    const provider = createEmbeddingProvider();

    try {
      if (opts.verbose) {
        console.log(`Memory dir: ${memoryDir}`);
        console.log(`Database: CozoDB (SQLite engine)`);
        console.log(`Embedding model: ${provider.modelId}`);
        console.log("");
      }

      console.log("Indexing memory files...");
      const result = await indexMemoryFiles(state, provider, memoryDir, opts.verbose);

      console.log("");
      console.log(`Files scanned:        ${result.filesScanned}`);
      console.log(`Files changed:        ${result.filesChanged}`);
      console.log(`Chunks indexed:       ${result.chunksIndexed}`);
      console.log(`Embeddings generated: ${result.embeddingsGenerated}`);
      console.log(`Embeddings cached:    ${result.embeddingsCached}`);
      console.log("");
      console.log("Done.");
    } finally {
      provider.dispose();
      closeDatabase(state);
    }
  });

// ---------------------------------------------------------------------------
// query command
// ---------------------------------------------------------------------------

program
  .command("query <text>")
  .description("Search indexed memories using hybrid vector + keyword search")
  .option("-n, --max-results <n>", "Maximum results to return", "10")
  .option("--json", "Output results as JSON")
  .option("--memory-dir <path>", "Override memory directory path")
  .action(
    async (
      text: string,
      opts: { maxResults?: string; json?: boolean; memoryDir?: string },
    ) => {
      const maxResults = parseInt(opts.maxResults ?? "10", 10);

      const state = await openDatabase();
      const provider = createEmbeddingProvider();

      try {
        // Check if index exists
        const fileCountResult = await runQuery(state.db, "?[count(path)] := *files{ path }");
        const fileCount = (fileCountResult.rows[0]?.[0] as number) ?? 0;

        if (fileCount === 0) {
          console.error("No files indexed yet. Run `memory-search index` first.");
          process.exit(1);
        }

        // Embed the query
        const queryVec = await provider.embed(text);

        // Search
        const results = await hybridSearch(state, queryVec, text, { maxResults });

        if (opts.json) {
          console.log(JSON.stringify(results, null, 2));
        } else {
          if (results.length === 0) {
            console.log("No results found.");
            return;
          }

          for (let i = 0; i < results.length; i++) {
            const r = results[i];
            if (!r) continue;
            console.log(
              `\n--- Result ${i + 1} (score: ${r.score.toFixed(4)}) ---`,
            );
            console.log(`Source: ${r.path}#${r.startLine}-${r.endLine}`);
            console.log("");
            console.log(r.snippet);
          }
        }
      } finally {
        provider.dispose();
        closeDatabase(state);
      }
    },
  );

// ---------------------------------------------------------------------------
// status command (bonus — shows index stats)
// ---------------------------------------------------------------------------

program
  .command("status")
  .description("Show index statistics")
  .action(async () => {
    const state = await openDatabase();
    try {
      // File count
      const filesResult = await runQuery(state.db, "?[count(path)] := *files{ path }");
      const filesCount = (filesResult.rows[0]?.[0] as number) ?? 0;

      // Chunk count (chunks may not exist yet)
      let chunksCount = 0;
      try {
        const chunksResult = await runQuery(state.db, "?[count(id)] := *chunks{ id }");
        chunksCount = (chunksResult.rows[0]?.[0] as number) ?? 0;
      } catch {
        // chunks relation doesn't exist yet
      }

      // Embedding cache count
      let cacheCount = 0;
      try {
        const cacheResult = await runQuery(state.db, "?[count(hash)] := *embedding_cache{ hash }");
        cacheCount = (cacheResult.rows[0]?.[0] as number) ?? 0;
      } catch {
        // embedding_cache relation doesn't exist yet
      }

      // Model from meta
      let model = "(none)";
      try {
        const modelResult = await runQuery(state.db, "?[value] := *meta{ key: 'provider_model', value }");
        if (modelResult.rows.length > 0) {
          model = modelResult.rows[0][0] as string;
        }
      } catch {
        // meta may be empty
      }

      console.log(`Files indexed:    ${filesCount}`);
      console.log(`Chunks stored:    ${chunksCount}`);
      console.log(`Embedding cache:  ${cacheCount} entries`);
      console.log(`Embedding model:  ${model}`);
      console.log(`Database:         CozoDB (SQLite engine)`);
      console.log(`Vector search:    built-in (HNSW)`);
      console.log(`Text search:      built-in (FTS)`);
    } finally {
      closeDatabase(state);
    }
  });

// ---------------------------------------------------------------------------
// save-session command
// ---------------------------------------------------------------------------

program
  .command("save-session")
  .description("Write a session log file, extract entities to graph, and re-index")
  .requiredOption("--slug <slug>", "Slug for the session filename (YYYY-MM-DD-<slug>.md)")
  .option("--content <content>", "Session content (if omitted, reads from stdin)")
  .option("--memory-dir <path>", "Override memory directory path")
  .option("--no-extract", "Skip automatic entity extraction to graph")
  .action(async (opts: { slug: string; content?: string; memoryDir?: string; extract?: boolean }) => {
    const memoryDir = opts.memoryDir ?? getMemoryDir();
    const shouldExtract = opts.extract !== false;

    // Resolve content from --content flag or stdin
    let content: string;
    if (opts.content != null) {
      content = opts.content;
    } else {
      if (process.stdin.isTTY) {
        console.error(
          "Error: No content provided. Use --content <string> or pipe content via stdin.",
        );
        process.exit(1);
      }
      content = await readStdin();
    }

    // Build the filename: YYYY-MM-DD-<slug>.md
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, "0");
    const dd = String(today.getDate()).padStart(2, "0");
    const filename = `${yyyy}-${mm}-${dd}-${opts.slug}.md`;

    const sessionsDir = path.join(memoryDir, "sessions");
    const filePath = path.join(sessionsDir, filename);

    // Ensure sessions directory exists
    fs.mkdirSync(sessionsDir, { recursive: true });

    // Write the session file
    fs.writeFileSync(filePath, content, "utf-8");
    console.log(`Saved session: ${filePath}`);

    // Re-index
    const state = await openDatabase();
    const provider = createEmbeddingProvider();

    try {
      console.log("Indexing memory files...");
      const indexResult = await indexMemoryFiles(state, provider, memoryDir);

      console.log("");
      console.log(`Files scanned:        ${indexResult.filesScanned}`);
      console.log(`Files changed:        ${indexResult.filesChanged}`);
      console.log(`Chunks indexed:       ${indexResult.chunksIndexed}`);
      console.log(`Embeddings generated: ${indexResult.embeddingsGenerated}`);
      console.log(`Embeddings cached:    ${indexResult.embeddingsCached}`);

      // Auto-extract entities from the session
      if (shouldExtract) {
        console.log("");
        console.log("Extracting entities from session...");

        try {
          const extraction = extractSessionEntities(content);

          // If no project was found in frontmatter, try to detect from git
          if (!extraction.projectName) {
            const detected = detectProjectFromGit();
            if (detected) {
              extraction.projectName = detected;
            }
          }

          const graphResult = await upsertGraphEntities(state.db, extraction);
          console.log(`Graph updated: ${graphResult.nodesCreated} nodes, ${graphResult.edgesCreated} edges`);

          if (extraction.projectName) {
            console.log(`Project: ${extraction.projectName}`);
          }
        } catch (err) {
          // Don't fail the whole command if extraction fails
          console.error("Warning: Entity extraction failed:", (err as Error).message);
        }
      }

      console.log("");
      console.log("Done.");
    } finally {
      provider.dispose();
      closeDatabase(state);
    }
  });

// ---------------------------------------------------------------------------
// update-memory command
// ---------------------------------------------------------------------------

program
  .command("update-memory")
  .description("Overwrite MEMORY.md with new curated content and re-index")
  .option("--content <content>", "New MEMORY.md content (if omitted, reads from stdin)")
  .option("--memory-dir <path>", "Override memory directory path")
  .action(async (opts: { content?: string; memoryDir?: string }) => {
    const memoryDir = opts.memoryDir ?? getMemoryDir();

    // Resolve content from --content flag or stdin
    let content: string;
    if (opts.content != null) {
      content = opts.content;
    } else {
      if (process.stdin.isTTY) {
        console.error(
          "Error: No content provided. Use --content <string> or pipe content via stdin.",
        );
        process.exit(1);
      }
      content = await readStdin();
    }

    const filePath = path.join(memoryDir, "MEMORY.md");

    // Ensure memory directory exists
    fs.mkdirSync(memoryDir, { recursive: true });

    // Write MEMORY.md
    fs.writeFileSync(filePath, content, "utf-8");
    console.log(`Updated memory: ${filePath}`);

    // Re-index
    const state = await openDatabase();
    const provider = createEmbeddingProvider();

    try {
      console.log("Indexing memory files...");
      const result = await indexMemoryFiles(state, provider, memoryDir);

      console.log("");
      console.log(`Files scanned:        ${result.filesScanned}`);
      console.log(`Files changed:        ${result.filesChanged}`);
      console.log(`Chunks indexed:       ${result.chunksIndexed}`);
      console.log(`Embeddings generated: ${result.embeddingsGenerated}`);
      console.log(`Embeddings cached:    ${result.embeddingsCached}`);
      console.log("");
      console.log("Done.");
    } finally {
      provider.dispose();
      closeDatabase(state);
    }
  });

// ---------------------------------------------------------------------------
// uninstall command
// ---------------------------------------------------------------------------

program
  .command("uninstall")
  .description("Remove all installed hook configs and uninstall the package")
  .action(async () => {
    const home = os.homedir();
    const configDir = getConfigDir();
    const cursorDir = path.join(home, ".cursor");
    const claudeDir = path.join(home, ".claude");

    console.log("This will remove agent-orchestrator hooks from:\n");

    // Describe what will be cleaned
    const cursorHooksPath = path.join(cursorDir, "hooks.json");
    const claudeSettingsPath = path.join(claudeDir, "settings.json");

    if (fs.existsSync(cursorHooksPath)) {
      console.log(`  ${cursorHooksPath} (remove memory-search hooks)`);
    }
    if (fs.existsSync(claudeSettingsPath)) {
      console.log(`  ${claudeSettingsPath} (remove memory-search hooks)`);
    }

    // Also clean up legacy v1 files if they still exist
    const legacyFiles = [
      path.join(cursorDir, "commands", "orchestrator.md"),
      path.join(cursorDir, "agents", "memory-agent.md"),
      path.join(cursorDir, "agents", "memory-recall-agent.md"),
      path.join(claudeDir, "skills", "orchestrator", "SKILL.md"),
      path.join(claudeDir, "agents", "memory-agent.md"),
      path.join(claudeDir, "agents", "memory-recall-agent.md"),
    ];

    for (const file of legacyFiles) {
      if (fs.existsSync(file)) {
        console.log(`  ${file} (legacy v1 file)`);
      }
    }

    console.log("");

    // Ask about shared data
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const ask = (question: string): Promise<string> =>
      new Promise((resolve) => rl.question(question, resolve));

    const dataAnswer = await ask(
      `Do you want to delete your shared data at ${configDir}?\n` +
      "  This includes conversations, beliefs, session logs, the search\n" +
      "  index, and the downloaded models (~2.6GB).\n\n" +
      "  [k]eep data for later  /  [d]elete everything: ",
    );

    const deleteData = dataAnswer.trim().toLowerCase().startsWith("d");

    rl.close();
    console.log("");

    // Remove memory-search hooks from Cursor hooks.json
    if (fs.existsSync(cursorHooksPath)) {
      try {
        const hooksConfig = JSON.parse(fs.readFileSync(cursorHooksPath, "utf-8"));
        if (hooksConfig.hooks) {
          for (const event of Object.keys(hooksConfig.hooks)) {
            if (Array.isArray(hooksConfig.hooks[event])) {
              hooksConfig.hooks[event] = hooksConfig.hooks[event].filter(
                (h: { command?: string }) =>
                  !h.command?.includes("memory-search"),
              );
              if (hooksConfig.hooks[event].length === 0) {
                delete hooksConfig.hooks[event];
              }
            }
          }
          if (Object.keys(hooksConfig.hooks).length === 0) {
            delete hooksConfig.hooks;
          }
        }
        // If the file is now effectively empty, remove it; otherwise update
        if (Object.keys(hooksConfig).length === 0 || (Object.keys(hooksConfig).length === 1 && hooksConfig.version)) {
          fs.unlinkSync(cursorHooksPath);
          console.log(`  Removed: ${cursorHooksPath}`);
        } else {
          fs.writeFileSync(cursorHooksPath, JSON.stringify(hooksConfig, null, 2) + "\n", "utf-8");
          console.log(`  Updated: ${cursorHooksPath} (removed memory-search hooks)`);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`  Warning: could not update ${cursorHooksPath}: ${msg}`);
      }
    }

    // Remove memory-search hooks from Claude Code settings.json
    if (fs.existsSync(claudeSettingsPath)) {
      try {
        const settings = JSON.parse(fs.readFileSync(claudeSettingsPath, "utf-8"));
        if (settings.hooks) {
          for (const event of Object.keys(settings.hooks)) {
            if (Array.isArray(settings.hooks[event])) {
              settings.hooks[event] = settings.hooks[event].filter(
                (entry: { hooks?: Array<{ command?: string }> }) => {
                  if (entry.hooks) {
                    entry.hooks = entry.hooks.filter(
                      (h) => !h.command?.includes("memory-search"),
                    );
                    return entry.hooks.length > 0;
                  }
                  return true;
                },
              );
              if (settings.hooks[event].length === 0) {
                delete settings.hooks[event];
              }
            }
          }
          if (Object.keys(settings.hooks).length === 0) {
            delete settings.hooks;
          }
        }
        fs.writeFileSync(claudeSettingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
        console.log(`  Updated: ${claudeSettingsPath} (removed memory-search hooks)`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`  Warning: could not update ${claudeSettingsPath}: ${msg}`);
      }
    }

    // Remove legacy v1 files
    for (const file of legacyFiles) {
      try {
        if (fs.existsSync(file)) {
          fs.unlinkSync(file);
          console.log(`  Removed: ${file}`);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`  Warning: could not remove ${file}: ${msg}`);
      }
    }

    // Remove legacy symlinks
    for (const link of [
      path.join(cursorDir, "agents", "dynamic"),
      path.join(claudeDir, "agents", "dynamic"),
    ]) {
      try {
        const stats = fs.lstatSync(link);
        if (stats.isSymbolicLink()) {
          fs.unlinkSync(link);
          console.log(`  Removed: ${link} (symlink)`);
        }
      } catch {
        // doesn't exist
      }
    }

    // Optionally delete shared data
    if (deleteData) {
      try {
        fs.rmSync(configDir, { recursive: true, force: true });
        console.log(`  Removed: ${configDir}/`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`  Warning: could not remove ${configDir}: ${msg}`);
      }
    } else {
      console.log(`  Kept:    ${configDir}/`);
    }

    // Uninstall the npm package
    console.log("\nUninstalling agent-orchestrator...\n");
    try {
      execSync("npm uninstall -g agent-orchestrator", { stdio: "inherit" });
    } catch {
      console.warn(
        "\n  Warning: could not run 'npm uninstall -g agent-orchestrator'." +
        "\n  Run it manually to finish cleanup.\n",
      );
    }

    console.log("\nUninstall complete.");
  });

// ---------------------------------------------------------------------------
// hook-start command — sessionStart hook
// ---------------------------------------------------------------------------

program
  .command("hook-start")
  .description("Session start hook: inject context + workflow instructions via additional_context")
  .option("--project <name>", "Project name (auto-detected from git if omitted)")
  .option("--cwd <path>", "Working directory (defaults to process.cwd())")
  .option("--platform <platform>", "Platform: cursor or claude-code", "cursor")
  .option("--no-inference", "Skip LLM synthesis, use fallback context builder")
  .action(async (opts: {
    project?: string;
    cwd?: string;
    platform?: string;
    inference?: boolean;
  }) => {
    const platform = opts.platform ?? "cursor";
    const useInference = opts.inference !== false;

    // Both Cursor and Claude Code send hook input as JSON on stdin.
    // Read it to get the platform's session/conversation ID for mapping.
    let platformSessionId: string | undefined;
    let stdinCwd: string | undefined;
    if (!process.stdin.isTTY) {
      try {
        const stdinContent = await readStdin();
        if (stdinContent.trim()) {
          const parsed = JSON.parse(stdinContent) as Record<string, unknown>;
          // Claude Code uses "session_id", Cursor uses "conversation_id"
          if (typeof parsed.session_id === "string") {
            platformSessionId = parsed.session_id;
          } else if (typeof parsed.conversation_id === "string") {
            platformSessionId = parsed.conversation_id;
          }
          // Both may provide cwd
          if (typeof parsed.cwd === "string") {
            stdinCwd = parsed.cwd;
          }
        }
      } catch {
        // Non-blocking
      }
    }

    const cwd = opts.cwd || stdinCwd || process.env.CURSOR_PROJECT_DIR || process.cwd();

    // 1. Detect project
    let projectName = opts.project;
    if (!projectName) {
      projectName = detectProjectFromGit(cwd) ?? path.basename(cwd);
    }

    // 2. Generate session ID
    const { generateSessionId, initConversation, saveSessionMapping } = await import("./conversation.js");
    const sessionId = generateSessionId();

    // Save mapping from platform session/conversation ID to our memory session ID.
    // This lets hook-stop and hook-end resolve back to our session ID.
    if (platformSessionId) {
      saveSessionMapping(platformSessionId, sessionId);
    }

    // Init conversation file
    initConversation({
      sessionId,
      project: projectName,
      cwd,
      platform: platform === "claude-code" ? "claude-code" : "cursor",
    });

    // 3. Open database and query beliefs
    const state = await openDatabase();

    try {
      const {
        queryWorkflowBeliefs,
        queryBeliefs,
      } = await import("./graph.js");

      const workflowBeliefs = await queryWorkflowBeliefs(state.db, projectName);
      const allBeliefs = await queryBeliefs(state.db, {
        projectScope: projectName,
        limit: 30,
      });

      // 4. Search for relevant past conversations
      let memories: import("./search.js").SearchResult[] = [];
      try {
        const provider = createEmbeddingProvider();
        try {
          const queryText = `${projectName} recent session context`;
          const queryVec = await provider.embed(queryText);
          memories = await hybridSearch(state, queryVec, queryText, { maxResults: 5 });
        } finally {
          provider.dispose();
        }
      } catch {
        // Vector search may fail if no index exists yet
      }

      // 5. Build context
      const { WORKFLOW_BASELINE } = await import("./workflow-baseline.js");
      let context: string;

      if (useInference) {
        try {
          const { createInferenceProvider } = await import("./inference.js");
          const inference = createInferenceProvider();
          try {
            context = await inference.synthesizeContext(
              memories,
              allBeliefs,
              workflowBeliefs,
              WORKFLOW_BASELINE,
              { name: projectName, cwd },
            );
          } finally {
            await inference.dispose();
          }
        } catch {
          // LLM unavailable, use fallback
          const { buildFallbackContext } = await import("./inference.js");
          context = buildFallbackContext(
            allBeliefs,
            workflowBeliefs,
            WORKFLOW_BASELINE,
            { name: projectName, cwd },
          );
        }
      } else {
        const { buildFallbackContext } = await import("./inference.js");
        context = buildFallbackContext(
          allBeliefs,
          workflowBeliefs,
          WORKFLOW_BASELINE,
          { name: projectName, cwd },
        );
      }

      // 6. Output JSON to stdout
      if (platform === "claude-code") {
        // Persist session ID for subsequent hooks via CLAUDE_ENV_FILE
        const envFile = process.env.CLAUDE_ENV_FILE;
        if (envFile) {
          try {
            fs.appendFileSync(
              envFile,
              `export MEMORY_SESSION_ID=${sessionId}\nexport MEMORY_PROJECT=${projectName}\n`,
            );
          } catch {
            // Non-blocking: env file write may fail in some environments
          }
        }

        const output = {
          hookSpecificOutput: {
            hookEventName: "SessionStart",
            additionalContext: context,
          },
        };
        console.log(JSON.stringify(output));
      } else {
        // Cursor format
        const output = {
          additional_context: context,
          env: {
            MEMORY_SESSION_ID: sessionId,
            MEMORY_PROJECT: projectName,
          },
        };
        console.log(JSON.stringify(output));
      }
    } finally {
      closeDatabase(state);
    }
  });

// ---------------------------------------------------------------------------
// hook-prompt command — beforeSubmitPrompt hook (Cursor only)
// ---------------------------------------------------------------------------

program
  .command("hook-prompt")
  .description("beforeSubmitPrompt hook: buffer the user prompt for pairing with afterAgentResponse (Cursor)")
  .action(async () => {
    if (process.stdin.isTTY) return;

    const stdinContent = await readStdin();
    if (!stdinContent.trim()) return;

    const {
      parseStopHookInput,
      savePendingPrompt,
    } = await import("./conversation.js");

    const hookInput = parseStopHookInput(stdinContent);
    if (!hookInput?.session_id || !hookInput.prompt) return;

    // Store the prompt keyed by the platform conversation_id so
    // afterAgentResponse can retrieve it.
    savePendingPrompt(hookInput.session_id, hookInput.prompt);
  });

// ---------------------------------------------------------------------------
// hook-stop command — afterAgentResponse (Cursor) / Stop (Claude Code)
// ---------------------------------------------------------------------------

program
  .command("hook-stop")
  .description("Stop hook: capture turn, extract beliefs, re-index (async)")
  .option("--transcript-path <path>", "Path to transcript file (deprecated: now read from stdin JSON)")
  .option("--session-id <id>", "Session ID (or reads from MEMORY_SESSION_ID env)")
  .option("--project <name>", "Project name (or reads from MEMORY_PROJECT env)")
  .option("--no-inference", "Skip LLM belief extraction")
  .action(async (opts: {
    transcriptPath?: string;
    sessionId?: string;
    project?: string;
    inference?: boolean;
  }) => {
    let sessionId = opts.sessionId ?? process.env.MEMORY_SESSION_ID;
    const projectName = opts.project ?? process.env.MEMORY_PROJECT ?? detectProjectFromGit() ?? "unknown";
    const useInference = opts.inference !== false;

    const {
      appendTurn,
      readLatestTurnFromTranscript,
      parseStopHookInput,
      readLatestTurnFromClaudeTranscript,
      lookupSessionMapping,
      consumePendingPrompt,
    } = await import("./conversation.js");

    // 1. Read stdin JSON (both Cursor and Claude Code send hook input on stdin)
    let turn: import("./conversation.js").ConversationTurn | null = null;
    let transcriptPath = opts.transcriptPath || undefined;
    let platformSessionId: string | undefined;

    if (!process.stdin.isTTY) {
      const stdinContent = await readStdin();
      if (stdinContent.trim()) {
        const hookInput = parseStopHookInput(stdinContent);

        platformSessionId = hookInput?.session_id;

        // Extract transcript_path from stdin (Claude Code provides this)
        if (hookInput?.transcript_path) {
          transcriptPath = hookInput.transcript_path;
        }

        // Resolve session ID: env var > CLI flag > session mapping
        if (!sessionId && platformSessionId) {
          const mapped = lookupSessionMapping(platformSessionId);
          if (mapped) {
            sessionId = mapped;
          }
        }

        // Cursor path: afterAgentResponse provides `text` (assistant response).
        // Pair it with the buffered user prompt from beforeSubmitPrompt.
        if (hookInput?.text && platformSessionId) {
          const pendingPrompt = consumePendingPrompt(platformSessionId);
          turn = {
            user: pendingPrompt ?? undefined,
            assistant: hookInput.text,
          };
        }
      }
    }

    // 2. If no turn yet, try reading from the transcript file (Claude Code path)
    if (!turn && transcriptPath) {
      turn = readLatestTurnFromClaudeTranscript(transcriptPath);
      if (!turn) {
        turn = readLatestTurnFromTranscript(transcriptPath);
      }
    }

    if (!sessionId) {
      return;
    }

    if (!turn) {
      return;
    }

    // 3. Append turn to conversation file
    appendTurn(sessionId, turn, {
      project: projectName,
      cwd: process.cwd(),
    });

    // 4. Re-index
    try {
      const memoryDir = getMemoryDir();
      const state = await openDatabase();
      const provider = createEmbeddingProvider();

      try {
        await indexMemoryFiles(state, provider, memoryDir);
      } finally {
        provider.dispose();
        closeDatabase(state);
      }
    } catch {
      // Non-blocking: don't fail the hook if indexing fails
    }

    // 5. Extract beliefs from the turn (if inference enabled)
    if (useInference) {
      try {
        const { createInferenceProvider } = await import("./inference.js");
        const { upsertBelief } = await import("./graph.js");

        const turnContent = [
          turn.user ? `User: ${turn.user}` : "",
          turn.assistant ? `Assistant: ${turn.assistant}` : "",
        ]
          .filter(Boolean)
          .join("\n\n");

        const inference = createInferenceProvider();
        const state = await openDatabase();

        try {
          const beliefs = await inference.extractBeliefs(turnContent, projectName);

          for (const belief of beliefs) {
            await upsertBelief(
              state.db,
              belief,
              `conversation:${sessionId}`,
            );
          }
        } finally {
          await inference.dispose();
          closeDatabase(state);
        }
      } catch {
        // Non-blocking: don't fail the hook if extraction fails
      }
    }
  });

// ---------------------------------------------------------------------------
// hook-end command — sessionEnd hook
// ---------------------------------------------------------------------------

program
  .command("hook-end")
  .description("Session end hook: finalize conversation file, final re-index")
  .option("--session-id <id>", "Session ID (or reads from MEMORY_SESSION_ID env)")
  .action(async (opts: { sessionId?: string }) => {
    let sessionId = opts.sessionId ?? process.env.MEMORY_SESSION_ID;

    // Both Cursor and Claude Code send JSON on stdin with session/conversation ID.
    // Resolve to our memory session ID via the session mapping.
    if (!sessionId && !process.stdin.isTTY) {
      try {
        const stdinContent = await readStdin();
        if (stdinContent.trim()) {
          const { parseStopHookInput, lookupSessionMapping, removeSessionMapping } =
            await import("./conversation.js");
          const hookInput = parseStopHookInput(stdinContent);
          // Try session_id (Claude Code) then conversation_id (Cursor)
          const platformId = hookInput?.session_id;
          if (platformId) {
            const mapped = lookupSessionMapping(platformId);
            if (mapped) {
              sessionId = mapped;
              // Clean up the mapping file since the session is ending
              removeSessionMapping(platformId);
            }
          }
        }
      } catch {
        // Non-blocking
      }
    }

    if (!sessionId) {
      return;
    }

    const { finalizeConversation } = await import("./conversation.js");

    // 1. Finalize conversation file
    finalizeConversation(sessionId);

    // 2. Final re-index
    try {
      const memoryDir = getMemoryDir();
      const state = await openDatabase();
      const provider = createEmbeddingProvider();

      try {
        await indexMemoryFiles(state, provider, memoryDir);
      } finally {
        provider.dispose();
        closeDatabase(state);
      }
    } catch {
      // Non-blocking
    }
  });

// ---------------------------------------------------------------------------
// migrate command
// ---------------------------------------------------------------------------

program
  .command("migrate")
  .description("Migrate old graph node types (preferences, lessons, patterns) to belief_node")
  .action(async () => {
    const state = await openDatabase();

    try {
      const { migrateAllToBeliefs } = await import("./graph.js");
      const result = await migrateAllToBeliefs(state.db);

      console.log("Migration complete:");
      console.log(`  Preferences → beliefs: ${result.preferences}`);
      console.log(`  Lessons → beliefs:     ${result.lessons}`);
      console.log(`  Patterns → beliefs:    ${result.patterns}`);
      console.log(`  Total beliefs created: ${result.preferences + result.lessons + result.patterns}`);
    } finally {
      closeDatabase(state);
    }
  });

// ---------------------------------------------------------------------------
// graph-status command
// ---------------------------------------------------------------------------

program
  .command("graph-status")
  .description("Show graph database statistics (node and edge counts)")
  .action(async () => {
    const state = await openDatabase();
    try {
      const { getGraphStats } = await import("./graph.js");
      const stats = await getGraphStats(state.db);

      console.log("Graph Node Counts:");
      console.log(`  Users:     ${stats.nodes.users}`);
      console.log(`  Errors:    ${stats.nodes.errors}`);
      console.log(`  Solutions: ${stats.nodes.solutions}`);
      console.log(`  Patterns:  ${stats.nodes.patterns}`);
      console.log(`  Libraries: ${stats.nodes.libraries}`);
      console.log(`  Sessions:  ${stats.nodes.sessions}`);
      console.log(`  Beliefs:   ${stats.nodes.beliefs}`);
      console.log("");
      console.log("Graph Edge Counts:");
      console.log(`  encountered:     ${stats.edges.encountered}`);
      console.log(`  solved_by:       ${stats.edges.solved_by}`);
      console.log(`  uses_lib:        ${stats.edges.uses_lib}`);
      console.log(`  applies_pattern: ${stats.edges.applies_pattern}`);
      console.log(`  prefers:         ${stats.edges.prefers}`);
      console.log(`  avoids:          ${stats.edges.avoids}`);
      console.log(`  conflicts_with:  ${stats.edges.conflicts_with}`);
      console.log(`  similar_to:      ${stats.edges.similar_to}`);
      console.log(`  caused_by:       ${stats.edges.caused_by}`);
    } finally {
      closeDatabase(state);
    }
  });

// ---------------------------------------------------------------------------
// graph-update command
// ---------------------------------------------------------------------------

program
  .command("graph-update")
  .description("Extract entities from a session summary and update the graph database")
  .option("--content <json>", "Session extraction JSON (if omitted, reads from stdin)")
  .action(async (opts: { content?: string }) => {
    // Resolve content from --content flag or stdin
    let content: string;
    if (opts.content != null) {
      content = opts.content;
    } else {
      if (process.stdin.isTTY) {
        console.error(
          "Error: No content provided. Use --content <json> or pipe JSON via stdin.",
        );
        process.exit(1);
      }
      content = await readStdin();
    }

    let extraction: import("./graph.js").SessionExtraction | undefined;
    try {
      extraction = JSON.parse(content) as import("./graph.js").SessionExtraction;
    } catch {
      console.error("Error: Invalid JSON. Expected a SessionExtraction object.");
      process.exit(1);
    }

    const state = await openDatabase();
    try {
      const { upsertGraphEntities } = await import("./graph.js");
      const result = await upsertGraphEntities(state.db, extraction!);
      console.log(`Graph updated: ${result.nodesCreated} nodes, ${result.edgesCreated} edges`);
    } finally {
      closeDatabase(state);
    }
  });

// ---------------------------------------------------------------------------
// graph-query command
// ---------------------------------------------------------------------------

program
  .command("graph-query <type>")
  .description("Query the graph database. Types: errors, solutions, preferences, lessons, projects, recall, search-errors, search-solutions, causal-chain")
  .option("--user <id>", "User ID for user-scoped queries", "default")
  .option("--error <id>", "Error ID for error-scoped queries")
  .option("--project <name>", "Project name for project-scoped queries")
  .option("--query <text>", "Search query for FTS-based graph queries")
  .option("-n, --limit <n>", "Maximum results", "10")
  .option("--json", "Output as JSON")
  .action(
    async (
      type: string,
      opts: { user?: string; error?: string; project?: string; query?: string; limit?: string; json?: boolean },
    ) => {
      const state = await openDatabase();
      const limit = parseInt(opts.limit ?? "10", 10);

      try {
        const graph = await import("./graph.js");
        let result: unknown;
        let formatted: string | null = null;

        switch (type) {
          case "errors": {
            const userId = opts.user ?? "default";
            result = await graph.queryUserErrors(state.db, userId);
            break;
          }
          case "solutions": {
            if (!opts.error) {
              console.error("Error: --error <id> is required for 'solutions' query type.");
              process.exit(1);
            }
            result = await graph.queryErrorSolutions(state.db, opts.error!);
            break;
          }
          case "preferences": {
            // Use new project-scoped query
            result = await graph.queryPreferences(state.db, opts.project);
            break;
          }
          case "lessons": {
            result = await graph.queryLessons(state.db, opts.project);
            break;
          }
          case "projects": {
            result = await graph.queryProjects(state.db);
            break;
          }
          case "recall": {
            // Get unified recall context
            const context = await graph.getRecallContext(
              state.db,
              opts.project,
              opts.user ?? "default",
            );
            result = context;
            if (!opts.json) {
              formatted = graph.formatRecallContext(context);
            }
            break;
          }
          case "search-errors": {
            if (!opts.query) {
              console.error("Error: --query <text> is required for 'search-errors' query type.");
              process.exit(1);
            }
            result = await graph.searchErrors(state.db, opts.query!, limit);
            break;
          }
          case "search-solutions": {
            if (!opts.query) {
              console.error("Error: --query <text> is required for 'search-solutions' query type.");
              process.exit(1);
            }
            result = await graph.searchSolutions(state.db, opts.query!, limit);
            break;
          }
          case "causal-chain": {
            if (!opts.error) {
              console.error("Error: --error <id> is required for 'causal-chain' query type.");
              process.exit(1);
            }
            result = await graph.queryCausalChain(state.db, opts.error!);
            break;
          }
          default:
            console.error(
              `Unknown query type: ${type}\n` +
              "Available types: errors, solutions, preferences, lessons, projects, recall, search-errors, search-solutions, causal-chain",
            );
            process.exit(1);
        }

        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
        } else if (formatted) {
          // Use pre-formatted output
          console.log(formatted);
        } else {
          // Pretty-print results
          if (Array.isArray(result)) {
            if (result.length === 0) {
              console.log("No results found.");
            } else {
              for (const item of result) {
                console.log(JSON.stringify(item, null, 2));
                console.log("---");
              }
            }
          } else {
            console.log(JSON.stringify(result, null, 2));
          }
        }
      } finally {
        closeDatabase(state);
      }
    },
  );

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

program.parse();
