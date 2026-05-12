# @plexo/research-agent

The first installable reference agent shipped with Plexo. Demonstrates the
full PEX v0.4 manifest surface (`capabilities`, `modelRequirements`,
`escalation`, `agentHints`, `dataResidency`, `trust`) and registers two
research-focused tools via the Plexo SDK.

> Phase 5 ships this as a **tool bundle**. Under the agent-as-mode
> interpretation of PEX agents, activation simply registers tools. Phase 6
> wires up the agent-as-mode runtime — scoped tool subsets, persona, model
> preference. This agent is designed to still behave sensibly once that
> landing happens.

## What it does

The agent provides two tools that the primary workspace agent can call:

### `research_query`

Gather sources for a research question. Performs a web search and extracts
titles, URLs, and snippets from the top results.

**Input**
```ts
{
  query: string            // the research question
  depth?: 'quick' | 'deep' // default: 'quick' (5 sources) — 'deep' fetches up to 10
  maxSources?: number      // hard cap (overrides depth)
}
```

**Output**
```ts
{
  query: string
  depth: 'quick' | 'deep'
  fetchedAt: string   // ISO-8601
  sources: Array<{ title: string; url: string; snippet: string; rank: number }>
  notes: string[]
}
```

### `summarize_findings`

Synthesize the output of `research_query` into a markdown report with
citations.

**Input**
```ts
{
  findings: ResearchFindings         // the output of research_query
  format?: 'brief' | 'detailed'      // default: 'brief'
}
```

**Output**
```ts
{
  report: string       // markdown report ready to present
  sourceCount: number
  format: 'brief' | 'detailed'
}
```

## How to install

From the in-app marketplace:

1. Open `/app/extensions` (or the Hub at `hub.getplexo.com`).
2. Find **Research Agent** and click **Install**.
3. Enable it on `/app/agents` under **Additional Agents**.

From the CLI (once `plexo ext install` supports named registry installs):

```bash
plexo ext install @plexo/research-agent
```

## Capabilities

The agent requests the minimum capability set:

- `storage:read` / `storage:write` — cache recent queries between invocations
- `ui:notify` — surface long-running research status to the user

It does **not** request memory, channel, tasks, or connection capabilities.
Web fetches go direct to DuckDuckGo and Wikipedia with no API key required.

## Trust and data residency

Trust tier: **verified** (first-party, shipped with the host).

Data residency (declared in the manifest):

- `duckduckgo.com` — anonymous web search
- `*.wikipedia.org` — source fetches

No credentials, no memory writes, no telemetry.

## Model requirements

The agent requests at least 32,000 tokens of context window and function
calling support. It prefers Anthropic or OpenAI providers when the host
is running under workspace `defaultModel` routing.

## Building

The bundled `dist/index.js` is checked into the repo so the API container
can import it directly at activation time. To rebuild after editing `src/`:

```bash
pnpm --filter @plexo/research-agent build
```

## Sample usage

Once installed and enabled, the primary workspace agent gets two new tools:

- `plugin__plexo_research-agent__research_query`
- `plugin__plexo_research-agent__summarize_findings`

Ask the workspace agent something like:

> Research recent developments in small language models under 3B params
> and give me a brief report with citations.

The agent will call `research_query({ query: "...", depth: "quick" })`,
feed the result into `summarize_findings`, and return the markdown report.
