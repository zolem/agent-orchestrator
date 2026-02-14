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
import { openDatabase, closeDatabase, getMemoryDir, getConfigDir } from "./db.js";
import { createEmbeddingProvider } from "./embeddings.js";
import { indexMemoryFiles } from "./indexer.js";
import { hybridSearch } from "./search.js";
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

    const state = openDatabase();
    const provider = createEmbeddingProvider();

    try {
      if (opts.verbose) {
        console.log(`Memory dir: ${memoryDir}`);
        console.log(`Database: ${state.db.name}`);
        console.log(`FTS5: ${state.ftsAvailable ? "available" : "unavailable"}`);
        console.log(`sqlite-vec: ${state.vecAvailable ? "available" : "unavailable"}`);
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

      const state = openDatabase();
      const provider = createEmbeddingProvider();

      try {
        // Check if index exists
        const fileCount = state.db
          .prepare(`SELECT COUNT(*) as count FROM files`)
          .get() as { count: number };

        if (fileCount.count === 0) {
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
  .action(() => {
    const state = openDatabase();
    try {
      const files = state.db
        .prepare(`SELECT COUNT(*) as count FROM files`)
        .get() as { count: number };
      const chunks = state.db
        .prepare(`SELECT COUNT(*) as count FROM chunks`)
        .get() as { count: number };
      const cache = state.db
        .prepare(`SELECT COUNT(*) as count FROM embedding_cache`)
        .get() as { count: number };
      const model = state.db
        .prepare(`SELECT value FROM meta WHERE key = 'provider_model'`)
        .get() as { value: string } | undefined;

      console.log(`Files indexed:    ${files.count}`);
      console.log(`Chunks stored:    ${chunks.count}`);
      console.log(`Embedding cache:  ${cache.count} entries`);
      console.log(`Embedding model:  ${model?.value ?? "(none)"}`);
      console.log(`FTS5:             ${state.ftsAvailable ? "available" : "unavailable"}`);
      console.log(`sqlite-vec:       ${state.vecAvailable ? "available" : "unavailable"}`);
    } finally {
      closeDatabase(state);
    }
  });

// ---------------------------------------------------------------------------
// save-session command
// ---------------------------------------------------------------------------

program
  .command("save-session")
  .description("Write a session log file and re-index")
  .requiredOption("--slug <slug>", "Slug for the session filename (YYYY-MM-DD-<slug>.md)")
  .option("--content <content>", "Session content (if omitted, reads from stdin)")
  .option("--memory-dir <path>", "Override memory directory path")
  .action(async (opts: { slug: string; content?: string; memoryDir?: string }) => {
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
    const state = openDatabase();
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
    const state = openDatabase();
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
// Run
// ---------------------------------------------------------------------------

program.parse();
