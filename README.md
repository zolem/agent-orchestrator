# agent-orchestrator

An orchestrator slash command for [Cursor](https://cursor.com) that manages sub-agents, maintains long-term memory across sessions, and provides hybrid vector + keyword search over your memory files.

## Prerequisites

- [Node.js](https://nodejs.org/) >= 18

## Install

```bash
npm install -g agent-orchestrator
```

This will:

1. Install the `memory-search` CLI on your PATH
2. Copy the `/orchestrator` slash command to `~/.cursor/commands/`
3. Copy the memory agents to `~/.cursor/agents/`
4. Create the memory directory at `~/.cursor/memory/` with an initial `MEMORY.md`
5. Download the embedding model (~0.6GB) and build the initial search index

Installation takes a few minutes on first run due to the model download.

## Usage

### The Orchestrator

Open any Cursor chat and type `/orchestrator` to invoke the orchestrator slash command. It acts as a technical project manager that:

- Breaks down your request into tasks and delegates to specialized sub-agents
- Never writes code itself -- all implementation is done by sub-agents
- Maintains memory across sessions so it learns your preferences over time
- Creates and refines dynamic sub-agents at `~/.cursor/agents/dynamic/`

### Memory Search CLI

The `memory-search` command provides hybrid vector + keyword search over your memory files.

#### Index your memory files

```bash
memory-search index
```

Scans all markdown files in `~/.cursor/memory/`, chunks them, generates embeddings, and stores everything in a local SQLite database. Run this after updating memory files or at the end of each orchestrator session.

Use `--verbose` for detailed output:

```bash
memory-search index --verbose
```

#### Search your memories

```bash
memory-search query "how did we handle authentication"
```

Returns ranked results combining vector similarity (70% weight) with BM25 keyword matching (30% weight).

Options:

```bash
memory-search query "auth flow" -n 5          # Limit to 5 results
memory-search query "auth flow" --json         # Output as JSON
```

#### Check index status

```bash
memory-search status
```

Shows the number of indexed files, chunks, cached embeddings, the embedding model in use, and whether FTS5 and sqlite-vec extensions are available.

## How Memory Works

The orchestrator's memory system persists across sessions in `~/.cursor/memory/`:

| Path | Purpose |
|:-----|:--------|
| `~/.cursor/memory/MEMORY.md` | Curated long-term memory -- preferences, patterns, lessons learned |
| `~/.cursor/memory/sessions/*.md` | Raw session logs -- detailed notes from each orchestrator session |
| `~/.cursor/memory/.search-index.sqlite` | Vector + keyword search index (auto-managed, rebuildable) |

### Session lifecycle

1. **Session start**: The orchestrator invokes the `memory-recall-agent` which reads `MEMORY.md`, searches past sessions, and delivers a unified briefing.
2. **During the session**: The orchestrator delegates work to sub-agents, evaluates results, and refines agents as needed.
3. **Session end**: The orchestrator writes a session log, invokes the `memory-agent` to curate learnings into `MEMORY.md`, and runs `memory-search index` to refresh the search index.

### Agents

The following agents are installed to `~/.cursor/agents/`:

| Agent | Purpose |
|:------|:--------|
| `memory-agent` | Curates session logs into `MEMORY.md` at session end. Handles upserts, deduplication, and pruning. |
| `memory-recall-agent` | Reads all memory sources at session start and delivers a unified briefing to the orchestrator. |

The orchestrator also creates dynamic sub-agents at runtime in `~/.cursor/agents/dynamic/`. These are ephemeral by default but effective ones can be kept for reuse across sessions.

## File Locations

After installation, these files are on your system:

| Location | Contents |
|:---------|:---------|
| `~/.cursor/commands/orchestrator.md` | The `/orchestrator` slash command |
| `~/.cursor/agents/memory-agent.md` | Memory curation agent |
| `~/.cursor/agents/memory-recall-agent.md` | Memory recall agent |
| `~/.cursor/agents/dynamic/` | Runtime sub-agents (created by the orchestrator) |
| `~/.cursor/memory/MEMORY.md` | Your curated long-term memory |
| `~/.cursor/memory/sessions/` | Session logs |
| `~/.cursor/memory/.search-index.sqlite` | Search index (rebuildable) |

The embedding model (~0.6GB) is cached by `node-llama-cpp` in its default model directory.

## Uninstall

```bash
memory-search uninstall
```

This will:

1. Remove the orchestrator command and agent files from `~/.cursor/`
2. Ask whether you want to **keep your memory data** (for a future reinstall) or **delete everything** (including `MEMORY.md`, session logs, the search index, and the ~0.6GB embedding model)
3. Run `npm uninstall -g agent-orchestrator` to remove the package and CLI from your PATH

## Development

### Building from source

```bash
git clone <repo-url>
cd orchestrator-command
npm install
npm run build
```

The build uses [esbuild](https://esbuild.github.io/) to bundle all TypeScript source into a single minified `dist/cli.js` file.

### Project structure

```
orchestrator-command/
  src/              TypeScript source (not published to npm)
    cli.ts          CLI entry point and command definitions
    db.ts           SQLite schema and database management
    indexer.ts       Delta-based file indexing
    search.ts       Hybrid BM25 + vector search
    embeddings.ts   Local embedding via node-llama-cpp
    chunker.ts      Markdown chunking with overlap
  dist/             Built output (single file, published to npm)
  bin/              CLI shebang entry point
  commands/         Orchestrator slash command
  agents/           Memory agents
  postinstall.js    Post-install setup script
```

### Publishing

```bash
npm publish
```

The `prepublishOnly` hook runs the build automatically before publishing.
