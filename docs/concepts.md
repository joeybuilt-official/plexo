# Concepts

Core ideas behind Plexo, explained without jargon.

## Tasks

A task is a unit of work given to the agent. You describe what you want done — "Add rate limiting to the login endpoint" — and Plexo plans it, executes it, and delivers the result.

Tasks have a lifecycle: **Queued** > **Planning** > **Running** > **Complete** (or **Blocked** / **Cancelled**).

Every completed task produces a **deliverable**: a structured output with a summary, work products (files, diffs, URLs, data), and verification steps you can use to confirm the work is correct.

## Workspaces

A workspace is an isolated environment — its own AI provider configuration, agent rules, task history, and channels. Multi-workspace support means you can run separate projects with separate settings without interference.

## Agent Rules (Behavior)

Rules you define that the agent follows on every task. Examples: "Always use TypeScript strict mode", "Never force-push to main", "Write tests for every new function". Rules are per-workspace.

## Channels

External connections where you can talk to Plexo: Telegram, Slack, Discord. You send a message, Plexo classifies it as a conversation (answers immediately) or a task (queues it for the agent), then delivers results back through the same channel.

## Projects (Sprints)

A project is a large, multi-task goal. You describe the objective, and Plexo breaks it into individual tasks, runs them in parallel where possible, and tracks completion. Projects have their own cost budgets and quality tracking.

## One-Way Doors

Irreversible operations — database migrations, force pushes, external API calls with side effects. When the agent encounters one, it pauses and asks for your approval before proceeding. You can approve or reject from the dashboard or via channel reply.

## Works

The typed outputs of a completed task. Each work has a type (file, diff, URL, data, command) and content. This is what the agent produced — the deliverable, not the log of how it got there.

## Quality Judge

An independent evaluation system that scores the agent's output. The judge uses a different model than the executor to prevent self-assessment bias. Scores are based on rubrics specific to each task type (coding, research, ops, writing).
