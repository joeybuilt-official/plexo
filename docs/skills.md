# Skills

Skills extend what the Plexo agent can do. They follow the SKILL.md open standard -- a markdown file with YAML frontmatter that declares the skill's name, description, and behavior. Plexo also supports Skill+ extensions with `runtime: plexo` for deeper platform integration.

## SKILL.md format

A skill is a markdown file with YAML frontmatter:

```markdown
---
name: code-reviewer
description: Reviews code changes for bugs, security issues, and style violations
invocation: auto
tags:
  - code
  - review
version: "0.1.0"
author: your-name
---

## Instructions

When reviewing code, check for: security vulnerabilities, performance issues
(N+1 queries, missing indexes), type safety violations, and missing error handling.
Output a structured review with severity levels: critical, warning, info.
```

### Required fields

| Field | Description |
|-------|-------------|
| `name` | Unique identifier (kebab-case) |
| `description` | What the skill does (one line) |

### Optional fields

| Field | Description |
|-------|-------------|
| `invocation` | `auto` (agent loads when relevant) or `manual` (user must invoke) |
| `globs` | File patterns that trigger auto-loading |
| `tags` | Discovery tags |
| `version` | Semver string |
| `author` | Skill author |
| `model` | Override the default model for this skill |
| `effort` | `low`, `medium`, `high`, or `max` |

The markdown body after the frontmatter contains the skill's instructions -- what the agent should do when the skill is active.

## Installing a skill

Skills are installed through the extensions API. Send the skill manifest:

```bash
curl -X POST https://plexo.yourdomain.com/api/extensions \
  -H "Content-Type: application/json" \
  -d '{
    "workspaceId": "YOUR_WORKSPACE_ID",
    "manifest": {
      "plexo": "0.4.0",
      "name": "code-reviewer",
      "version": "0.1.0",
      "type": "skill",
      "entry": "SKILL.md",
      "description": "Reviews code for bugs and security issues",
      "capabilities": [],
      "author": "your-name"
    }
  }'
```

Skills install in a disabled state. Enable them via `PATCH /api/extensions/:id` with `{ "enabled": true }`.

You can also install skills from the dashboard under **Settings > Extensions**.

## Skill+ runtime

Standard SKILL.md skills are prompt-only -- they inject instructions into the agent context. Skill+ extensions add `runtime: plexo` to unlock platform features:

```yaml
---
name: deploy-manager
description: Manages zero-downtime deployments with rollback
runtime: plexo
capabilities:
  - connections:github
  - memory:read
resource_limits:
  max_memory_mb: 256
  timeout_ms: 60000
trust_tier: verified
escalation:
  require_approval:
    - production-deploy
---
```

### Skill+ fields

| Field | Description |
|-------|-------------|
| `runtime` | Must be `plexo` to activate Skill+ |
| `capabilities` | Fine-grained tokens like `memory:read`, `connections:stripe` |
| `resource_limits` | Memory, timeout, and CPU constraints for sandboxed execution |
| `trust_tier` | `community`, `verified`, or `official` |
| `persistent` | Keep a stateful worker running between invocations |
| `escalation` | Require user approval for specific actions |
| `entry` | Code entry point for programmatic skills |

## Creating your own skill

1. Write a SKILL.md file with frontmatter and instructions
2. Test by pasting the instructions into a task to verify behavior
3. Install via the API or dashboard, then enable in your workspace

Skills compose -- multiple can be active on the same task. The agent resolves which apply based on `invocation`, `globs`, and task context.

## Related docs

- [Getting Started](getting-started.md) -- First task setup
- [MCP](mcp.md) -- Connect external tool servers
- [A2A](a2a.md) -- Agent-to-Agent protocol
