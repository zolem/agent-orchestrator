# agent-orchestrator

An orchestrator slash command for [Cursor](https://cursor.com) and [Claude Code](https://code.claude.com) that manages sub-agents, maintains long-term memory across sessions, and provides hybrid vector + keyword search over your memory files.

## Supported Platforms

- **Cursor** -- Installs as a slash command at `~/.cursor/commands/orchestrator.md`
- **Claude Code** -- Installs as a skill at `~/.claude/skills/orchestrator/SKILL.md`

Both platforms share the same memory and dynamic agents, so learnings persist whether you're using Cursor or Claude Code.

## Prerequisites

- [Node.js](https://nodejs.org/) >= 18

## Install

```bash
npm install -g agent-orchestrator
```

This will:

1. Install the `memory-search` CLI on your PATH
2. Detect installed platforms (Cursor and/or Claude Code)
3. Install the orchestrator command/skill to each detected platform
4. Copy the memory agents to each platform's agents directory
5. Create the shared memory directory at `~/.config/agent-orchestrator/memory/`
6. Create symlinks so dynamic agents are shared across platforms
7. Download the embedding model (~0.6GB) and build the initial search index

Installation takes a few minutes on first run due to the model download.

## Usage

### The Orchestrator

**In Cursor**: Open any chat and type `/orchestrator`

**In Claude Code**: Type `/orchestrator` or let Claude invoke it automatically based on the task

The orchestrator acts as a technical project manager that:

- Breaks down your request into tasks and delegates to specialized sub-agents
- Never writes code itself -- all implementation is done by sub-agents
- Maintains memory across sessions so it learns your preferences over time
- Creates and refines dynamic sub-agents that persist across sessions

### Memory Search CLI

The `memory-search` command provides hybrid vector + keyword search over your memory files.

#### Index your memory files

```bash
memory-search index
```

Scans all markdown files in `~/.config/agent-orchestrator/memory/`, chunks them, generates embeddings, and stores everything in a local SQLite database. Run this after updating memory files or at the end of each orchestrator session.

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

#### Save a session log

```bash
memory-search save-session --slug "auth-feature" --content "# Session: Auth Feature..."
```

Writes a session log to `~/.config/agent-orchestrator/memory/sessions/YYYY-MM-DD-<slug>.md` and automatically re-indexes. Content can be passed via `--content` or piped via stdin:

```bash
echo "# Session content..." | memory-search save-session --slug "auth-feature"
```

#### Update MEMORY.md

```bash
memory-search update-memory --content "# Orchestrator Memory..."
```

Overwrites `MEMORY.md` with new content and automatically re-indexes. Content can be passed via `--content` or piped via stdin.

## How Memory Works

The orchestrator's memory system persists across sessions in a shared, tool-agnostic directory:

| Path | Purpose |
|:-----|:--------|
| `~/.config/agent-orchestrator/memory/MEMORY.md` | Curated long-term memory -- preferences, patterns, lessons learned |
| `~/.config/agent-orchestrator/memory/sessions/*.md` | Raw session logs -- detailed notes from each orchestrator session |
| `~/.config/agent-orchestrator/memory/.search-index.sqlite` | Vector + keyword search index (auto-managed, rebuildable) |

### Session lifecycle

1. **Session start**: The orchestrator invokes the `memory-recall-agent` which reads `MEMORY.md`, searches past sessions, and delivers a unified briefing.
2. **During the session**: The orchestrator delegates work to sub-agents, evaluates results, and refines agents as needed.
3. **Session end**: The orchestrator runs `memory-search save-session` to write the session log (with automatic re-indexing), then invokes the `memory-agent` to curate learnings into `MEMORY.md` via `memory-search update-memory`.

### Agents

The following agents are installed to each platform's agents directory:

| Agent | Purpose |
|:------|:--------|
| `memory-agent` | Curates session logs into `MEMORY.md` at session end. Handles upserts, deduplication, and pruning. |
| `memory-recall-agent` | Reads all memory sources at session start and delivers a unified briefing to the orchestrator. |

The orchestrator also creates dynamic sub-agents at runtime. These are stored in a shared location and symlinked to each platform's agents directory, so a refined agent created in Cursor is also available in Claude Code.

## File Locations

After installation, these files are on your system:

### Shared (tool-agnostic)

| Location | Contents |
|:---------|:---------|
| `~/.config/agent-orchestrator/memory/MEMORY.md` | Your curated long-term memory |
| `~/.config/agent-orchestrator/memory/sessions/` | Session logs |
| `~/.config/agent-orchestrator/memory/.search-index.sqlite` | Search index (rebuildable) |
| `~/.config/agent-orchestrator/agents/dynamic/` | Runtime sub-agents (shared via symlinks) |

### Cursor (if installed)

| Location | Contents |
|:---------|:---------|
| `~/.cursor/commands/orchestrator.md` | The `/orchestrator` slash command |
| `~/.cursor/agents/memory-agent.md` | Memory curation agent |
| `~/.cursor/agents/memory-recall-agent.md` | Memory recall agent |
| `~/.cursor/agents/dynamic/` | Symlink to shared dynamic agents |

### Claude Code (if installed)

| Location | Contents |
|:---------|:---------|
| `~/.claude/skills/orchestrator/SKILL.md` | The `/orchestrator` skill |
| `~/.claude/agents/memory-agent.md` | Memory curation agent |
| `~/.claude/agents/memory-recall-agent.md` | Memory recall agent |
| `~/.claude/agents/dynamic/` | Symlink to shared dynamic agents |

The embedding model (~0.6GB) is cached by `node-llama-cpp` in its default model directory.

## Uninstall

```bash
memory-search uninstall
```

This will:

1. Remove the orchestrator command/skill and agent files from both `~/.cursor/` and `~/.claude/`
2. Remove the dynamic agents symlinks
3. Ask whether you want to **keep your shared data** (for a future reinstall) or **delete everything** (including `MEMORY.md`, session logs, the search index, and the ~0.6GB embedding model)
4. Run `npm uninstall -g agent-orchestrator` to remove the package and CLI from your PATH

## Development

### Building from source

```bash
git clone <repo-url>
cd agent-orchestrator
npm install
npm run build
```

The build uses [esbuild](https://esbuild.github.io/) to bundle all TypeScript source into a single minified `dist/cli.js` file.

### Project structure

```
agent-orchestrator/
  src/              TypeScript source (not published to npm)
    cli.ts          CLI entry point (index, query, status, save-session, update-memory, uninstall)
    db.ts           SQLite schema and database management
    indexer.ts      Delta-based file indexing
    search.ts       Hybrid BM25 + vector search
    embeddings.ts   Local embedding via node-llama-cpp
    chunker.ts      Markdown chunking with overlap
  dist/             Built output (single file, published to npm)
  bin/              CLI shebang entry point
  commands/         Generic orchestrator core
  harness/          Platform-specific appendices (cursor.md, claude-code.md)
  agents/           Memory agents
  postinstall.js    Post-install setup script (multi-platform)
```

### Publishing

```bash
npm publish
```

The `prepublishOnly` hook runs the build automatically before publishing.
