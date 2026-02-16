# agent-orchestrator

A hooks-driven memory, beliefs, and workflow system for [Cursor](https://cursor.com) and [Claude Code](https://code.claude.com). Every coding session benefits from persistent episodic memory (vector search), developer beliefs (graph database), and context synthesis (local LLM) — making your AI assistant feel like it knows you.

## How It Works

The system uses platform hooks (`sessionStart`, `stop`, `sessionEnd`) to invisibly manage memory:

1. **Session start**: Queries the belief graph and memory index, synthesizes a context briefing using a local LLM, and injects it as `additional_context`. This replaces the old static orchestrator command with dynamic, learned workflow instructions.
2. **After each response**: Captures the conversation turn, re-indexes it, and extracts beliefs (preferences, workflow patterns, lessons) via the local LLM.
3. **Session end**: Finalizes the conversation file with closing metadata.

Over time, the system learns your preferences, workflow patterns, and coding conventions — and injects them into every new session automatically.

## Supported Platforms

- **Cursor** — Hooks installed at `~/.cursor/hooks.json`
- **Claude Code** — Hooks merged into `~/.claude/settings.json`

Both platforms share the same memory, beliefs, and conversation data.

## Prerequisites

- [Node.js](https://nodejs.org/) >= 18

## Install

```bash
npm install -g agent-orchestrator
```

This will:

1. Install the `memory-search` CLI on your PATH
2. Detect installed platforms (Cursor and/or Claude Code)
3. Install hook configurations for each detected platform
4. Create the shared memory directory at `~/.config/agent-orchestrator/memory/`
5. Download the embedding model (~0.6GB) and build the initial search index
6. Download the text-generation model (~2GB) for belief extraction and context synthesis
7. Run migration if upgrading from v1 (converts old preferences/lessons/patterns to beliefs)

Installation takes a few minutes on first run due to model downloads.

## Usage

### Automatic (via hooks)

Once installed, the hooks work invisibly. Every Cursor or Claude Code session will:

- Start with a personalized context briefing (your workflow preferences, coding conventions, relevant past conversations)
- Capture each conversation turn for future recall
- Extract and store beliefs about your preferences and workflow patterns

### Memory Search CLI

```bash
memory-search query "how did we handle authentication"
```

Returns ranked results combining vector similarity (70% weight) with BM25 keyword matching (30% weight).

```bash
memory-search query "auth flow" -n 5          # Limit to 5 results
memory-search query "auth flow" --json         # Output as JSON
```

### Index management

```bash
memory-search index              # Re-index all memory files
memory-search index --verbose    # Detailed output
memory-search status             # Show index statistics
```

### Graph database

```bash
memory-search graph-status                        # Show node/edge counts
memory-search graph-query recall --project myapp   # Get unified recall context
memory-search graph-query preferences              # Show learned preferences
```

### Migration

```bash
memory-search migrate            # Migrate v1 data to belief graph
```

Converts existing `preference_node`, `lesson_node`, and `pattern_node` entries into the unified `belief_node` schema.

## Architecture

### Memory Layer (Vector)

Conversation files and session logs are chunked, embedded, and indexed using CozoDB's HNSW vector index and FTS keyword index. Hybrid search combines both signals.

### Beliefs Layer (Graph)

Developer preferences, workflow patterns, and lessons are stored as `belief_node` triplets:

```
(developer, prefers, "named exports in TypeScript")       confidence=0.9, global
(developer, workflow, "use TDD for API routes")           confidence=0.8, project=my-api
(developer, avoids, "class components in React")          confidence=0.7, global
(developer, workflow, "get approval before committing")   confidence=1.0, global
```

Beliefs have confidence scores, are time-tracked, and can be contradicted/superseded as your preferences evolve.

### Judgement Layer (Local LLM)

A local text-generation model (Qwen2.5-3B-Instruct, ~2GB) handles:

- **Belief extraction**: Analyzes conversation turns to extract structured beliefs
- **Context synthesis**: Weaves beliefs, memories, and a workflow baseline into a natural-language context document

All inference runs locally — no data leaves your machine.

## File Locations

### Shared (tool-agnostic)

| Location | Contents |
|:---------|:---------|
| `~/.config/agent-orchestrator/memory/` | Memory directory |
| `~/.config/agent-orchestrator/memory/conversations/` | Conversation files from each session |
| `~/.config/agent-orchestrator/memory/sessions/` | Legacy session logs |
| `~/.config/agent-orchestrator/memory/.search-index.cozo` | CozoDB search index + graph (rebuildable) |

### Cursor

| Location | Contents |
|:---------|:---------|
| `~/.cursor/hooks.json` | Hook configurations for sessionStart/stop/sessionEnd |

### Claude Code

| Location | Contents |
|:---------|:---------|
| `~/.claude/settings.json` | Hook configurations (merged into existing settings) |

Models (~2.6GB total) are cached by `node-llama-cpp` in its default model directory.

## Uninstall

```bash
memory-search uninstall
```

## Development

### Building from source

```bash
git clone <repo-url>
cd agent-orchestrator
npm install
npm run build
```

### Project structure

```
agent-orchestrator/
  src/
    cli.ts              CLI entry point (hooks, search, graph commands)
    db.ts               CozoDB schema and database management
    graph.ts            Belief graph (belief_node + legacy node types)
    inference.ts        Local LLM for belief extraction + context synthesis
    conversation.ts     Conversation file management
    workflow-baseline.ts  Minimal baseline workflow instructions
    search.ts           Hybrid BM25 + vector search
    embeddings.ts       Local embedding via node-llama-cpp
    indexer.ts          Delta-based file indexing
    chunker.ts          Markdown chunking
    extractor.ts        Rule-based entity extraction (legacy)
  dist/                 Built output (single file, published to npm)
  bin/                  CLI shebang entry point
  postinstall.js        Post-install setup script (hook installation)
```

### Publishing

```bash
npm publish
```
