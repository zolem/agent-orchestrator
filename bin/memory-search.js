#!/usr/bin/env node

// Bin entry point — delegates to compiled CLI.
import("../dist/cli.js").catch((err) => {
  console.error("Failed to load memory-search CLI.");
  console.error(err.message);
  process.exit(1);
});
