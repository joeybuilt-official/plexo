<div align="center">

<img src="images/overview.png" alt="Plexo Dashboard" width="100%" style="border-radius: 12px; box-shadow: 0 4px 24px rgba(0,0,0,0.2);" />

<br/>

# Plexo

**The Agentic Operating System. Built for Production.**

A persistent, self-hosted AI workforce that autonomously handles software engineering, business operations, and deep research. Engineered for trust, built for scale, and entirely extensible via the Kapsel standard.

<a href="https://getplexo.com"><b>☁️ Managed Cloud</b></a> • <a href="docs/"><b>📖 Documentation</b></a> • <a href="https://github.com/joeybuilt-official/kapsel"><b>🔌 Kapsel Protocol</b></a>

<br/>

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Docker](https://img.shields.io/badge/Deploy-Docker-2496ED?logo=docker&logoColor=white)](docker-compose.yml)
[![Kapsel](https://img.shields.io/badge/Kapsel_v0.3.0-Full%20compliant-6C47FF)](https://github.com/joeybuilt-official/kapsel)

</div>

<br/>

## ✨ The Paradigm Shift

Most AI tools are glorified chat interfaces. You ask. They answer. *You* still do the work. The ceiling of a chat UI is human bandwidth.

**Plexo is an inversion of that model.** You describe an objective—in Slack, Telegram, or the native Dashboard—and your Plexo workspace takes over. It formulates a topological execution plan, works asynchronously, verifies its own output, and only interrupts you for critical decisions.

It is not an assistant. **It is a persistent, scalable workforce that you completely control.**

- **💻 Software Engineering:** Run parallel code sprints, open PRs, auto-diagnose and fix failing CI builds.
- **📈 Business Operations:** Generate internal MRR reports, monitor PostHog/Stripe events, and sync issues across Linear.
- **🔍 Deep Research:** Asynchronous topic tracking, document synthesis, and structured web data extraction.

---

## ⚡️ Quick Start

Deploy your own agentic workforce in under 3 minutes. Plexo ships as a single, optimized Docker Compose stack.

```bash
git clone https://github.com/joeybuilt-official/plexo.git
cd plexo
cp .env.example .env

# Start the stack (Next.js, Express, Postgres, Valkey)
docker compose up -d
```
> **Note:** First boot runs database migrations before the API starts. Caddy handles TLS automatically if `PUBLIC_DOMAIN` is set in your `.env`.

[**Read the full self-hosting guide →**](docs/)

---

## 🛡️ Engineered For Trust

An autonomous agent with write-access to your codebase and production systems is a profound liability without an obsessive focus on architecture and safety. Plexo was engineered from first principles to mitigate risk.

### Verifiable Safety Rails
*   **The Escalation Contract (§23):** Any irreversible or high-value action triggers a hard execution pause. Agents signal `sdk.escalate()` with the trigger type, proposed action, and context. The host pauses execution, notifies you via dashboard or Slack, and waits for your decision: approve, deny, or approve-and-remember. Standing approval rules let you pre-authorize common patterns so future identical actions proceed without interruption.
*   **Capability-Gated Execution:** Extensions cannot arbitrarily access host systems. Permissions are declared in the manifest and enforced at the SDK call boundary. Entity-scoped memory tokens (`memory:read:person`, `memory:write:transaction`) ensure a finance extension never reads your email threads.
*   **Immutable Audit Trail (§18):** Every action an Agent or Extension takes is recorded in a tamper-proof ledger — including which LLM model produced the decision, the SHA-256 hash of inputs, and escalation outcomes. Owner-tier extensions can query the audit trail via `sdk.audit.query()`.
*   **Trust Tiers (§17):** Extensions operate at one of three trust levels — `owner` (host-built, full access), `verified` (registry-signed, standard caps), or `community` (unreviewed, user-approved per capability). Capability ceilings are enforced at install time, not runtime.
*   **Memory Shorthand:** To prevent context bloat and "hallucination," Plexo uses AI to asynchronously summarize every memory into a dense shorthand of principles, facts, and outcomes. The agent retrieves these summarized heuristics during planning rather than wading through raw logs, maximizing performance and reducing token costs.
*   **Hard Boundaries:** Hard-coded limits on consecutive tool calls, execution wall-clock time, and API token spend per task.

### The Stack
Plexo is built on a modern, typed, and scalable foundation:

| Layer | Technology | Rationale |
|-------|-----------|-----|
| **Core Runtime** | **Node.js ≥22, TypeScript** | Fully typed execution paths, isolated persistent worker threads. |
| **Web & API** | **Next.js 15, Express 5** | Server components, edge streaming, native async middleware. |
| **Data & State** | **PostgreSQL 16 + pgvector, Valkey** | Native vector search parity, ultra-low latency task queues. |
| **Intelligence** | **Vercel AI SDK** | Provider-agnostic. Route to Anthropic, OpenAI, Groq, or local Ollama. |

---

## ⚙️ Agent Behavior Configuration

Agent behavior is not a document — it is a **structured, layered graph** of rules with inheritance, overrides, and scoped applicability.

*   **Autonomous Intent Classification:** Before taking action, Plexo's classifier analyzes your message to distinguish between `CONVERSATION`, `TASK`, `PROJECT`, or `MEMORY`. It auto-queues simple tasks immediately while proposing structured "Sprints" for multi-step engineering goals.
*   **Description Synthesis:** When a task is queued via chat, a background synthesizer LLM call crafts a clean, third-person task description from the full conversation context, ensuring the agent's goal is precise regardless of short user utterances.

```
Platform Defaults (read-only)
    ↓ inherited by
Workspace Defaults (you control)
    ↓ inherited by
Project Overrides (per-sprint rules)
    ↓ inherited by
Task Context (ephemeral, single-task injection)
```

Every task execution resolves this graph and compiles it into a system prompt fragment. The compiled output is what the agent actually receives — nothing more, nothing less.

**Rule types:** Safety Constraints (locked, non-negotiable) · Operational Rules · Communication Style · Domain Knowledge · Persona Traits · Tool Preferences · Quality Gates

**Settings → Agent → Behavior** exposes a full rule editor:
*   Color-coded card groups with lock indicators for safety constraints
*   Inline editors by value type: toggle, number slider, enum dropdown, text block
*   Inheritance view that diffs workspace defaults against project overrides
*   System Prompt Preview: live view of the exact compiled prompt the agent receives
*   Snapshot history: every task start captures the resolved rule set

**Import from AGENTS.md** — paste any markdown document; the parser categorizes each section header into the correct rule type. **Export** regenerates a standards-compliant `AGENTS.md` from live rules — no manual sync required.

---

## 🧠 The Intelligent LLM Router

Plexo features an automatic transmission for language models, optimizing for cost, context, and capabilities at runtime without developer intervention.

*   **Four-Mode Model Selection:** Choose your abstraction. Run in **Full Auto** (Plexo arbitrates the best model), drop in your own keys (**BYOK**), connect a self-hosted instance to our managed inference pool (**Mode 3**), or explicitly lock specific models to critical workflows (**Override**).
*   **Cost vs. Quality Arbitration:** Tasks are dynamically scored and routed based on an up-to-date registry of model context windows, tokens costs, and benchmarked domain strengths. Cheaper models handle basic parsing, while high-tier reasoning models are reserved for complex pathfinding.
*   **LLM Identity & Model Context (§24):** Every Agent declares its model requirements in its manifest — minimum context window, function calling support, local-model acceptability. Every audited action logs the exact model ID, version, and provider that produced it, making behavior reproducible and transparent.
*   **Separation of Keys & State:** The Intelligent LLM router abstracts away the credentials. The executor simply requests a "coding model with 128k context" and the router provisions a connection through deep fallback chains to guarantee uptime.

---

## 🔌 The Extensibility Moat

A platform's survival depends on its ecosystem. Plexo natively adheres to [**Kapsel v0.3.0**](https://github.com/joeybuilt-official/kapsel), the definitive open standard for AI agent extensions. This is the App Store model for AI—decentralized, host-agnostic, and secure by default.

### Three Pillars

Kapsel v0.3.0 establishes three distinct architectural pillars:

| Pillar | What it is | Analogy |
|--------|-----------|---------|
| **Connection** | Authenticated pipe to an external service. Inert on its own. | Power outlet |
| **Extension** | A capability package — functions, schedules, widgets, memory access. Does work when invoked. Requires one or more Connections. | Appliance |
| **Agent** | An autonomous actor with a goal, a planning loop, and an identity. Orchestrates any number of Extensions to accomplish work. | Person using appliances |

An Agent is not a subtype of Extension. An Extension does not think. An Agent does. An Agent picks up Extensions the way a person picks up tools.

### Core Capabilities

*   **Personal Entity Schema (§16):** Seven canonical entity types — Person, Task, Thread, Note, Transaction, CalendarEvent, File — with host-managed resolution. Extensions reference entities by ID, never duplicating data. `sdk.entities.resolve('person', id)` and `sdk.entities.search('task', query)` are built into every host.
*   **Persistent UserSelf (§20):** A durable user identity graph — preferences, relationships, communication style, accumulated context — that persists across all Extensions and sessions. Extensions contribute via structured proposals; the host resolves conflicts.
*   **Data Residency (§19):** Extensions declare every external destination in their manifest. An extension claiming `sendsDataExternally: false` that makes external HTTP calls is flagged non-compliant at runtime.
*   **Live Conversation Mode:** A unified "always-listening" mode for hands-free voice interaction. It features autonomous turn-taking (linked to TTS completion), interruption support, and sub-500ms latency for a natural dialogue flow.
*   **Persistent Sandboxes:** Extensions run in their own persistent `worker_threads`. Zero cold-start overhead. Crashes are caught, isolated, and respawned without affecting the host.
*   **Write Once, Run Anywhere:** A Kapsel extension written for Plexo runs on any other Kapsel-compliant host.
*   **Omni-Channel Native:** Native adapters for Slack, Discord, and Telegram. Agents live where your team communicates.

### 🧬 Self-Extending: The Agent Builds Its Own Tools

Plexo's most powerful extensibility feature is the ability for the agent to **generate its own extensions and connections on demand** — without any code deployment from you.

When you ask the agent to integrate with a service that isn't already installed, it autonomously:
1. **Scrapes the official API documentation** from the service's website
2. **Generates a valid Kapsel extension** (ESM JavaScript + `kapsel.json` manifest) via LLM
3. **Writes the code to a persistent Docker volume** so it survives restarts
4. **Registers a connection entry** so the credential UI appears immediately in Settings → Connections
5. **Auto-activates the extension** — it's live for the next task
6. **Tells you where to enter credentials** — you just supply the API key like any other connection

Generated extensions appear in the Extensions catalog with a **✦ Custom** badge. They run in the same Kapsel sandbox as marketplace extensions — capability-gated, isolated, non-fatal on errors. The agent cannot grant itself capabilities beyond what the requested operations require.

**Example:** Ask Plexo to "connect to Intercom and list open conversations" — it will build the Intercom extension, register the connection, activate it, and prompt you to add your API key. No code deployment needed.

```
User: "I need you to connect to Intercom and build a tool that fetches open conversations."

Agent: Researching Intercom API docs...
       Generating extension code...
       Installing @generated/intercom...

       ✦ Intercom extension is now active. Go to Connections → Intercom
         to enter your API key and start using it.
```

### Kapsel Protocol Example
Plexo provides a transparent, capability-gated SDK for developers.

```ts
import type { KapselSDK } from '@plexo/sdk'

export async function activate(sdk: KapselSDK) {
  // Register a function (the atomic unit of work)
  sdk.registerTool({
    name: 'stripe_report',
    description: 'Generate a Stripe MRR report',
    parameters: { /* JSON schema */ },
    handler: async ({ from, to }, ctx) => {
      const creds = await sdk.connections.getCredentials('stripe')
      return fetchStripeData(creds);
    },
  })

  // Resolve a canonical entity (§16)
  const person = await sdk.entities.resolve('person', contactId)

  // Read UserSelf for personalization (§20)
  const { identity } = await sdk.self.read(['identity'])
}
```

---

## 💻 IDE Integration (MCP Server)

Plexo acts as the intelligent backend for your favorite built-in AI tools using the open [Model Context Protocol (MCP)](https://modelcontextprotocol.io). Tools like Claude Desktop and Cursor can **read directly from your Plexo workspace**, check on background tasks, and query your systems intuitively.

**Connecting Cursor IDE:**
1. Open Cursor Settings > **Features** > **MCP Servers**.
2. Click **+ Add New MCP Server** (Type: `command`, Name: `Plexo`).
3. Command: `npx -y @plexo/cli@latest mcp-proxy`
4. Add Env Vars: `PLEXO_URL=http://localhost:3001` and `PLEXO_TOKEN=your-workspace-token`.

---

## 🖥️ The Platform Interface

*The Plexo Dashboard is designed to rival top-tier SaaS applications—clinical, fast, and actionable.*

<details>
<summary><strong>📸 Expand to view platform features & screenshots</strong></summary>
<br/>

### 1. Projects (Sprints) Orchestration
Manage large-scale autonomous initiatives and their topological sub-tasks.
<img src="images/projects.png" alt="Projects View" width="100%" style="border-radius:8px;" />

### 2. Task Introspection
Deep visibility into agent tool usage, execution logs, cost burn, and exact reasoning traces.
<img src="images/tasks.png" alt="Tasks View" width="100%" style="border-radius:8px;" />

### 3. Omni-Channel Conversations
Seamless handoffs between Slack/Telegram and the Web Dashboard.
<img src="images/conversations.png" alt="Conversations View" width="100%" style="border-radius:8px;" />

### 4. Escalation & Approvals
The safety valve. Agents pause and request your decision for irreversible actions, high-value transactions, and novel patterns.
<img src="images/approvals.png" alt="Approvals View" width="100%" style="border-radius:8px;" />

### 5. Deep Agent Configuration
Total control over identity, behavior, limits, and multi-model fallback chains.
<img src="images/agent_settings.png" alt="Agent Settings View" width="100%" style="border-radius:8px;" />

</details>

---

## 🔧 The Developer CLI (`@plexo/cli`)

For engineers, Plexo lives natively in your terminal and CI/CD runners. Securely authenticate with your local or cloud instance and trigger complex background workflows without leaving the command line.

```bash
npm install -g @plexo/cli
plexo auth login http://localhost:3001

# Trigger an asynchronous sprint and wait for result
plexo sprint start "review code and run integration tests" --wait --timeout 2h
```

---

## License

Plexo is open source software licensed under the [GNU Affero General Public License v3.0](LICENSE) (AGPL-3.0).

**What this means:**
- You can use, modify, and self-host Plexo freely.
- If you modify Plexo and offer it as a network service, you must publish your modifications under the same AGPL-3.0 license.
- You cannot take Plexo, make proprietary improvements, and offer it as a closed-source hosted service.

**Commercial licensing:** If AGPL-3.0 does not work for your use case, contact [licensing@getplexo.com](mailto:licensing@getplexo.com) to discuss a commercial license.

Copyright (C) 2026 Joeybuilt LLC
