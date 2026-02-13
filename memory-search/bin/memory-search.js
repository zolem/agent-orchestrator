#!/usr/bin/env node

// Bin entry point — delegates to compiled CLI.
// When built: loads dist/cli.js
// For development: use `node --loader ts-node/esm src/cli.ts`

import("../dist/cli.js").catch((err) => {
  console.error("Failed to load memory-search CLI.");
  console.error("Have you run `npm run build` in the memory-search directory?");
  console.error(err.message);
  process.exit(1);
});
