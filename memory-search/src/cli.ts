/**
 * cli.ts — CLI entry point for memory-search.
 *
 * Commands:
 *   memory-search index   — Index/re-index memory files
 *   memory-search query   — Hybrid search over indexed memories
 */

import { Command } from "commander";
import { openDatabase, closeDatabase, getMemoryDir } from "./db.js";
import { createEmbeddingProvider } from "./embeddings.js";
import { indexMemoryFiles } from "./indexer.js";
import { hybridSearch } from "./search.js";
import fs from "node:fs";

const program = new Command();

program
  .name("memory-search")
  .description(
    "Hybrid vector + BM25 memory search for the Cursor orchestrator command",
  )
  .version("1.0.0");

// ---------------------------------------------------------------------------
// index command
// ---------------------------------------------------------------------------

program
  .command("index")
  .description("Index or re-index all markdown files in ~/.cursor/memory/")
  .option("-v, --verbose", "Show detailed indexing progress")
  .option("--memory-dir <path>", "Override memory directory path")
  .action(async (opts: { verbose?: boolean; memoryDir?: string }) => {
    const memoryDir = opts.memoryDir ?? getMemoryDir();

    if (!fs.existsSync(memoryDir)) {
      console.error(`Memory directory not found: ${memoryDir}`);
      console.error(
        "Create it with: mkdir -p ~/.cursor/memory",
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
// Run
// ---------------------------------------------------------------------------

program.parse();
