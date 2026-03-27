# Concepts

Plexo is a self-hosted AI agent platform that autonomously executes software engineering, business operations, and research tasks. You describe what you want done; Plexo plans it, executes it, and delivers structured results.

## Core Concepts

### Workspaces

An isolated environment with its own AI provider configuration, agent behavior rules, task history, and channel connections. Run multiple workspaces for separate projects or teams without interference.

### Tasks

A unit of work given to the agent. You describe the objective -- "Add rate limiting to the login endpoint" -- and Plexo plans it, executes it with tool calls, and delivers a structured result.

Lifecycle: **Queued** > **Planning** > **Running** > **Complete** (or **Blocked** / **Cancelled**).

Every completed task produces a **deliverable**: a summary, work products (files, diffs, URLs, data), and verification steps.

### Projects (Sprints)

A large, multi-task goal. Plexo breaks the objective into individual tasks, determines dependencies, runs independent tasks in parallel, and tracks completion. Projects have their own cost budgets and quality tracking.

### Agent Behavior Rules

Rules you define that the agent follows on every task. Examples: "Always use TypeScript strict mode", "Never force-push to main", "Write tests for every new function." Rules are structured into types (safety constraints, operational rules, domain knowledge, quality gates) and resolved through an inheritance chain:

```
Platform Defaults > Workspace Defaults > Project Overrides > Task Context
```

### Channels

External messaging integrations where you interact with Plexo: Telegram, Slack, Discord, or the web dashboard. Messages are classified as conversations (answered immediately) or tasks (queued for the agent). Results are delivered back through the same channel.

### Extensions (Plexo Fabric)

Capability packages that give the agent access to external services. An extension declares what it can do (functions, schedules, memory access) and what permissions it needs. Extensions run in isolated worker threads -- a crash in one never affects the host.

### Context Library

The agent's memory system. Plexo asynchronously summarizes every interaction into dense shorthand -- principles, facts, outcomes -- that the agent retrieves during planning. This prevents context bloat and keeps token costs low while preserving institutional knowledge.

### One-Way Doors (Escalation)

Irreversible operations -- database migrations, force pushes, external API calls with side effects. When the agent encounters one, it pauses execution and requests your approval. You approve, reject, or set a standing rule from the dashboard or via channel reply.

## How a message becomes a task

```
1. You send a message (dashboard, Telegram, Slack, Discord)
        |
2. Intent Classifier analyzes the message
   |                    |
   CONVERSATION         TASK / PROJECT
   (reply inline)       |
                   3. Description Synthesizer creates a precise,
                      third-person task description from context
                        |
                   4. Task is queued in the workspace
                        |
                   5. Agent picks it up:
                      - Resolves behavior rules
                      - Retrieves relevant context from memory
                      - Formulates an execution plan
                        |
                   6. Executor runs the plan step by step
                      (tool calls, code generation, API calls)
                        |
                   7. Quality Judge scores the output
                      (uses a different model to prevent self-assessment bias)
                        |
                   8. Deliverable is posted back through the original channel
                        |
                   9. Outcome is summarized into context library for future tasks
```
