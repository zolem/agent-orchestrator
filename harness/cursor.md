<!-- Cursor-specific appendix - appended to orchestrator.md at install time -->

## Path Reference (Cursor)

| Concept | Path |
|:--------|:-----|
| Memory directory | `~/.config/agent-orchestrator/memory/` |
| Session logs | `~/.config/agent-orchestrator/memory/sessions/` |
| Search index | `~/.config/agent-orchestrator/memory/.search-index.sqlite` |
| Dynamic agents directory | `~/.cursor/agents/dynamic/` (symlinked to `~/.config/agent-orchestrator/agents/dynamic/`) |
| Static agents | `~/.cursor/agents/` |

## Sub-Agent Invocation Syntax (Cursor)

### Built-in Agent Types

For built-in agent types, use the Task tool directly:

```
Task({
  subagent_type: "<built-in-type>",
  prompt: "<task description>",
  description: "<short 3-5 word description>"
})
```

Built-in types: `explore`, `generalPurpose`, `shell`, `browser-use`

### Custom Agents (memory-recall-agent, memory-agent, dynamic agents)

Custom agents defined at `~/.cursor/agents/` must be invoked via `generalPurpose` with explicit instructions from the agent file. This is because the Task tool only accepts built-in subagent_types.

### Example: Invoking the memory-recall-agent

```
Task({
  subagent_type: "generalPurpose",
  prompt: "You are the memory recall agent. Your job is to read memory and search past sessions, then return a unified briefing.\n\n1. Read ~/.config/agent-orchestrator/memory/MEMORY.md in full\n2. Run `memory-search query \"<user's task description>\" --json -n 10` via shell\n3. For the top 3-5 results (score > 0.25), read the source files at ~/.config/agent-orchestrator/memory/<path>\n4. Return a briefing with: User Preferences, Sub-Agent Patterns, Relevant Past Sessions, Key Lessons, Pitfalls to Avoid, Suggested Approach\n\nThe user's request: <paste or summarize the user's request here>. Project: <project name if known>.",
  description: "Recall relevant memories"
})
```

### Example: Invoking the memory-agent

```
Task({
  subagent_type: "generalPurpose",
  prompt: "You are the memory curator agent. Your job is to distill a session log into MEMORY.md.\n\n1. Read the session log at ~/.config/agent-orchestrator/memory/sessions/YYYY-MM-DD-<slug>.md\n2. Read the current ~/.config/agent-orchestrator/memory/MEMORY.md\n3. Extract new preferences, patterns, lessons, and anti-patterns from the session\n4. Prepare the updated MEMORY.md content (merge new info, don't replace wholesale)\n5. Keep MEMORY.md concise — distill, don't copy verbatim\n6. Write the updated content using: memory-search update-memory --content \"<updated content>\"",
  description: "Curate session into memory"
})
```

### Example: Creating and invoking a dynamic agent

First, write the agent file to `~/.cursor/agents/dynamic/research-agent.md` for reference:

```markdown
---
name: research-agent
description: Explores codebase structure, finds relevant files, and summarizes patterns.
---

You are a research agent. Explore the codebase and report back with:
1. Relevant files and their purposes
2. Existing patterns and conventions
3. Dependencies and relationships
```

Then invoke it via generalPurpose (or use `explore` for read-only research):

```
Task({
  subagent_type: "explore",
  prompt: "Research the authentication flow in this codebase. Report back with: 1) Relevant files and their purposes 2) Existing patterns 3) Dependencies",
  description: "Research auth flow"
})
```

## User Interaction (Cursor)

To ask the user for approval, use the AskQuestion tool:

```
AskQuestion({
  questions: [{
    id: "approval",
    prompt: "Review the changes above. How would you like to proceed?",
    options: [
      { id: "approve", label: "Approve — commit and proceed" },
      { id: "changes", label: "Request changes — describe what needs to change" },
      { id: "reject", label: "Reject — revert all changes" }
    ]
  }]
})
```

## Model Tiers (Cursor)

Use the cheapest model that can handle the task. For the full list of available models and current pricing, see: https://cursor.com/docs/models

| Tier | Model IDs | Cost (input/output per 1M tokens) | Use When |
|:-----|:----------|:----------------------------------|:---------|
| Budget | `fast`, `grok-code` | ~$0.20 / ~$1.50 | Simple searches, formatting, straightforward edits |
| Mid | `gemini-3-flash`, `gpt-5.2` | ~$0.50-1.75 / ~$3-14 | Research, file exploration, standard implementation |
| Standard | `claude-4.5-sonnet`, `gemini-3-pro` | ~$2-3 / ~$12-15 | Code review, test writing, complex implementation |
| Premium | `claude-4.6-opus` | ~$5 / ~$25 | Complex architecture, nuanced decisions, difficult debugging |
| Inherited | `inherit` | (matches parent model) | When the task needs whatever the orchestrator runs on |

## Built-in Agent Types (Cursor)

These agent types can be used directly with the Task tool's `subagent_type` parameter:

| Agent Type | Description |
|:-----------|:------------|
| `explore` | Fast, read-only agent for codebase exploration. Use for quick file searches and pattern discovery. |
| `generalPurpose` | General-purpose agent for complex multi-step tasks. Can read, write, and execute commands. |
| `shell` | Command execution specialist for running bash commands. |
| `browser-use` | Browser automation for testing web applications. |

## Custom Agents (Cursor)

The memory agents are installed at `~/.cursor/agents/` for reference, but must be invoked via `generalPurpose` with explicit prompts (see examples above):

| Agent File | Purpose |
|:-----------|:--------|
| `memory-recall-agent.md` | Reference prompt for memory recall at session start |
| `memory-agent.md` | Reference prompt for curating sessions into MEMORY.md |

## Example: Full Team Setup (Cursor)

For a complex feature, create multiple dynamic agents at session start:

```
~/.cursor/agents/dynamic/
  research-agent.md      (model: claude-4.5-haiku, readonly: true)
  architect-agent.md     (model: inherit)
  engineer-agent.md      (model: claude-4.5-haiku)
  qa-agent.md            (model: claude-4.5-haiku, readonly: true)
```

This gives you cost-efficient delegation — only the architect uses the expensive model, while research, implementation, and QA run on Haiku.

## Installation Note

Type `/orchestrator` in any Cursor chat to invoke this command.
