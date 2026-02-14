<!-- Claude Code-specific appendix - appended to orchestrator.md at install time -->

## Path Reference (Claude Code)

| Concept | Path |
|:--------|:-----|
| Memory directory | `~/.config/agent-orchestrator/memory/` |
| Session logs | `~/.config/agent-orchestrator/memory/sessions/` |
| Search index | `~/.config/agent-orchestrator/memory/.search-index.sqlite` |
| Dynamic agents directory | `~/.claude/agents/dynamic/` (symlinked to `~/.config/agent-orchestrator/agents/dynamic/`) |
| Static agents | `~/.claude/agents/` |

## Sub-Agent Invocation Syntax (Claude Code)

To invoke a sub-agent, use the Task tool with the agent name:

```
Task: <agent-name>
<task description>
```

Or ask Claude to delegate:

```
Use the <agent-name> agent to <task description>
```

**Important constraint**: In Claude Code, subagents cannot spawn other subagents. Your dynamic agents must be self-contained — they cannot further delegate work. Design each agent to complete its task independently.

### Example: Invoking the memory-recall-agent

```
Use the memory-recall-agent to recall context for this session.
The user's request: <paste or summarize the user's request here>. Project: <project name if known>.
```

### Example: Invoking the memory-agent

```
Use the memory-agent to curate ~/.config/agent-orchestrator/memory/MEMORY.md based on the session log at ~/.config/agent-orchestrator/memory/sessions/YYYY-MM-DD-<slug>.md. 
Use `memory-search update-memory --content "<updated content>"` to write the updated MEMORY.md (this also re-indexes automatically).
```

### Example: Creating and invoking a dynamic agent

First, write the agent file to `~/.claude/agents/dynamic/research-agent.md`:

```markdown
---
name: research-agent
model: haiku
description: Explores codebase structure, finds relevant files, and summarizes patterns.
tools: Read, Grep, Glob
---

You are a research agent. Explore the codebase and report back with:
1. Relevant files and their purposes
2. Existing patterns and conventions
3. Dependencies and relationships
```

Then invoke it:

```
Use the research-agent to research the authentication flow in this codebase.
```

## User Interaction (Claude Code)

To ask the user for approval, use natural language or the AskUserQuestion tool:

```
Please review the changes above. How would you like to proceed?
- **Approve** — commit and proceed
- **Request changes** — describe what needs to change
- **Reject** — revert all changes
```

## Model Tiers (Claude Code)

Use the cheapest model that can handle the task.

| Tier | Model IDs | Use When |
|:-----|:----------|:---------|
| Budget | `haiku` | Simple searches, formatting, straightforward edits |
| Standard | `sonnet` | Code review, test writing, standard implementation |
| Premium | `opus` | Complex architecture, nuanced decisions, difficult debugging |
| Inherited | `inherit` | When the task needs whatever the orchestrator runs on |

## Built-in Agent Types (Claude Code)

These agent types are available without creating a dynamic agent file:

| Agent Type | Description |
|:-----------|:------------|
| `Explore` | Fast, read-only agent (uses Haiku) for codebase analysis. |
| `Plan` | Research agent for gathering context before planning. |
| `general-purpose` | Capable agent for complex multi-step tasks requiring exploration and modification. |
| `memory-recall-agent` | Reads MEMORY.md and searches past sessions at session start. |
| `memory-agent` | Curates session logs into MEMORY.md at session end. |

## Agent Configuration Fields (Claude Code)

Claude Code supports additional agent configuration fields:

| Field | Description |
|:------|:------------|
| `tools` | Tools the agent can use (e.g., `Read, Grep, Glob, Bash`). Defaults to all tools. |
| `disallowedTools` | Tools to deny from the agent. |
| `permissionMode` | Permission handling: `default`, `acceptEdits`, `dontAsk`, `bypassPermissions`, `plan`. |
| `maxTurns` | Maximum agentic turns before the agent stops. |
| `skills` | Skills to preload into the agent's context. |
| `memory` | Persistent memory scope: `user`, `project`, or `local`. |

## Example: Full Team Setup (Claude Code)

For a complex feature, create multiple dynamic agents at session start:

```
~/.claude/agents/dynamic/
  research-agent.md      (model: haiku, tools: Read, Grep, Glob)
  architect-agent.md     (model: inherit)
  engineer-agent.md      (model: haiku)
  qa-agent.md            (model: haiku, tools: Read, Grep, Glob, Bash)
```

This gives you cost-efficient delegation — only the architect uses the expensive model, while research, implementation, and QA run on Haiku.

## Key Constraints (Claude Code)

1. **No nested subagents**: Subagents cannot spawn other subagents. Design each dynamic agent to complete its task independently.
2. **MCP tools in background**: MCP tools are not available in background subagents.
3. **Agent discovery**: Claude Code discovers agents from `~/.claude/agents/` and its subdirectories.

## Installation Note

Type `/orchestrator` in Claude Code to invoke this skill, or let Claude invoke it automatically when relevant based on the skill description.
