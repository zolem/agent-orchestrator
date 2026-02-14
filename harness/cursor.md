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

To invoke a sub-agent, use the Task tool:

```
Task({
  subagent_type: "<agent-name>",
  prompt: "<task description>",
  description: "<short 3-5 word description>"
})
```

### Example: Invoking the memory-recall-agent

```
Task({
  subagent_type: "memory-recall-agent",
  prompt: "The user's request: <paste or summarize the user's request here>. Project: <project name if known>.",
  description: "Recall relevant memories"
})
```

### Example: Invoking the memory-agent

```
Task({
  subagent_type: "memory-agent",
  prompt: "Update ~/.config/agent-orchestrator/memory/MEMORY.md based on the session log at ~/.config/agent-orchestrator/memory/sessions/YYYY-MM-DD-<slug>.md",
  description: "Curate session into memory"
})
```

### Example: Creating and invoking a dynamic agent

First, write the agent file to `~/.cursor/agents/dynamic/research-agent.md`:

```markdown
---
name: research-agent
model: claude-4.5-haiku
description: Explores codebase structure, finds relevant files, and summarizes patterns.
readonly: true
---

You are a research agent. Explore the codebase and report back with:
1. Relevant files and their purposes
2. Existing patterns and conventions
3. Dependencies and relationships
```

Then invoke it:

```
Task({
  subagent_type: "research-agent",
  prompt: "Research the authentication flow in this codebase...",
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

These agent types are available without creating a dynamic agent file:

| Agent Type | Description |
|:-----------|:------------|
| `explore` | Fast agent for codebase exploration. Use for quick file searches and pattern discovery. |
| `generalPurpose` | General-purpose agent for complex multi-step tasks. |
| `shell` | Command execution specialist for running bash commands. |
| `memory-recall-agent` | Reads MEMORY.md and searches past sessions at session start. |
| `memory-agent` | Curates session logs into MEMORY.md at session end. |

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
