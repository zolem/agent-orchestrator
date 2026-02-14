/**
 * cli.ts — CLI entry point for memory-search.
 *
 * Commands:
 *   memory-search index          — Index/re-index memory files
 *   memory-search query          — Hybrid search over indexed memories
 *   memory-search status         — Show index statistics
 *   memory-search save-session   — Write a session log file and re-index
 *   memory-search update-memory  — Overwrite MEMORY.md and re-index
 *   memory-search uninstall      — Remove all installed files and optionally delete data
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
  .description("Remove all installed orchestrator files and uninstall the package")
  .action(async () => {
    const home = os.homedir();
    const configDir = getConfigDir();
    const cursorDir = path.join(home, ".cursor");
    const claudeDir = path.join(home, ".claude");

    // Files/symlinks the postinstall created (for each platform)
    const installedFiles: string[] = [];
    const installedSymlinks: string[] = [];

    // Cursor files
    if (fs.existsSync(cursorDir)) {
      installedFiles.push(
        path.join(cursorDir, "commands", "orchestrator.md"),
        path.join(cursorDir, "agents", "memory-agent.md"),
        path.join(cursorDir, "agents", "memory-recall-agent.md"),
      );
      installedSymlinks.push(path.join(cursorDir, "agents", "dynamic"));
    }

    // Claude Code files
    if (fs.existsSync(claudeDir)) {
      installedFiles.push(
        path.join(claudeDir, "skills", "orchestrator", "SKILL.md"),
        path.join(claudeDir, "agents", "memory-agent.md"),
        path.join(claudeDir, "agents", "memory-recall-agent.md"),
      );
      installedSymlinks.push(path.join(claudeDir, "agents", "dynamic"));
    }

    // Directories created by postinstall (only removed if empty)
    const installedDirs = [
      path.join(claudeDir, "skills", "orchestrator"),
    ];

    console.log("This will remove:\n");

    for (const file of installedFiles) {
      if (fs.existsSync(file)) {
        console.log(`  ${file}`);
      }
    }
    for (const link of installedSymlinks) {
      try {
        if (fs.lstatSync(link).isSymbolicLink()) {
          console.log(`  ${link} (symlink)`);
        }
      } catch {
        // doesn't exist
      }
    }
    for (const dir of installedDirs) {
      if (fs.existsSync(dir)) {
        console.log(`  ${dir}/ (if empty)`);
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
      "  This includes MEMORY.md, session logs, the search index, and the\n" +
      "  downloaded embedding model (~0.6GB).\n\n" +
      "  [k]eep data for later  /  [d]elete everything: ",
    );

    const deleteData = dataAnswer.trim().toLowerCase().startsWith("d");

    rl.close();
    console.log("");

    // Remove installed files
    for (const file of installedFiles) {
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

    // Remove symlinks
    for (const link of installedSymlinks) {
      try {
        const stats = fs.lstatSync(link);
        if (stats.isSymbolicLink()) {
          fs.unlinkSync(link);
          console.log(`  Removed: ${link} (symlink)`);
        }
      } catch {
        // doesn't exist, skip
      }
    }

    // Remove empty directories
    for (const dir of installedDirs) {
      try {
        if (fs.existsSync(dir)) {
          const entries = fs.readdirSync(dir);
          if (entries.length === 0) {
            fs.rmdirSync(dir);
            console.log(`  Removed: ${dir}/`);
          } else {
            console.log(`  Skipped: ${dir}/ (not empty)`);
          }
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`  Warning: could not remove ${dir}: ${msg}`);
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
            result = await graph.queryErrorSolutions(state.db, opts.error);
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
            result = await graph.searchErrors(state.db, opts.query, limit);
            break;
          }
          case "search-solutions": {
            if (!opts.query) {
              console.error("Error: --query <text> is required for 'search-solutions' query type.");
              process.exit(1);
            }
            result = await graph.searchSolutions(state.db, opts.query, limit);
            break;
          }
          case "causal-chain": {
            if (!opts.error) {
              console.error("Error: --error <id> is required for 'causal-chain' query type.");
              process.exit(1);
            }
            result = await graph.queryCausalChain(state.db, opts.error);
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
