<div align="center">

<img src="images/overview.png" alt="Plexo Dashboard" width="100%" style="border-radius: 12px; box-shadow: 0 4px 24px rgba(0,0,0,0.2);" />

<br/>

# Plexo

**The Agentic Operating System. Built for Production.**

A persistent, self-hosted AI workforce that autonomously handles software engineering, business operations, and deep research. Engineered for trust, built for scale, and entirely extensible via the Kapsel standard.

<a href="https://getplexo.com"><b>☁️ Managed Cloud</b></a> • <a href="docs/"><b>📖 Documentation</b></a> • <a href="https://github.com/joeybuilt-official/kapsel"><b>🔌 Kapsel Protocol</b></a>

<br/>

[![License: BSL 1.1](https://img.shields.io/badge/License-BSL%201.1-orange.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Docker](https://img.shields.io/badge/Deploy-Docker-2496ED?logo=docker&logoColor=white)](docker/compose.yml)
[![Kapsel](https://img.shields.io/badge/Kapsel-Full%20compliant-6C47FF)](https://github.com/joeybuilt-official/kapsel)

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
docker compose -f docker/compose.yml up -d
```
> **Note:** First boot takes ~60s as migrations run. Caddy handles TLS automatically if `PUBLIC_DOMAIN` is set in your `.env`.

[**Read the full self-hosting guide →**](docs/)

---

## 🛡️ Engineered For Trust

An autonomous agent with write-access to your codebase and production systems is a profound liability without an obsessive focus on architecture and safety. Plexo was engineered from first principles to mitigate risk.

### Verifiable Safety Rails
*   **The One-Way Door (OWD) Protocol:** Any destructive operation (modifying schemas, pushing commits, spending >$X) triggers a hard execution pause. The system requests explicit authorization via a real-time SSE push to your dashboard or Slack thread.
*   **Capability-Gated Execution:** Plugins cannot arbitrarily access the host network. Permissions (`storage:write`, `connections:github`) must be explicitly granted per-workspace.
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

## 🧠 The Intelligent LLM Router

Plexo features an automatic transmission for language models, optimizing for cost, context, and capabilities at runtime without developer intervention.

*   **Four-Mode Model Selection:** Choose your abstraction. Run in **Full Auto** (Plexo arbitrates the best model), drop in your own keys (**BYOK**), connect a self-hosted instance to our managed inference pool (**Mode 3**), or explicitly lock specific models to critical workflows (**Override**).
*   **Cost vs. Quality Arbitration:** Tasks are dynamically scored and routed based on an up-to-date registry of model context windows, tokens costs, and benchmarked domain strengths. Cheaper models handle basic parsing, while high-tier reasoning models are reserved for complex pathfinding.
*   **Separation of Keys & State:** The Intelligent LLM router abstracts away the credentials. The executor simply requests a "coding model with 128k context" and the router provisions a connection through deep fallback chains to guarantee uptime.

---

## 🔌 The Extensibility Moat

A platform's survival depends on its ecosystem. Plexo natively adheres to [**Kapsel**](https://github.com/joeybuilt-official/kapsel), the definitive open standard for AI agent extensions. This is the App Store model for AI—decentralized, host-agnostic, and secure by default.

*   **Persistent Sandboxes:** Extensions run in their own persistent `worker_threads`. Zero cold-start overhead. Crashes are caught, isolated, and respawned without affecting the host.
*   **Write Once, Run Anywhere:** A Kapsel plugin written for Plexo runs on any other Kapsel-compliant host.
*   **Omni-Channel Native:** Native adapters for Slack, Discord, and Telegram. Agents live where your team communicates.

### 🧬 Self-Extending: The Agent Builds Its Own Tools

Plexo's most powerful extensibility feature is the ability for the agent to **generate its own skills and connections on demand** — without any code deployment from you.

When you ask the agent to integrate with a service that isn't already installed, it autonomously:
1. **Scrapes the official API documentation** from the service's website
2. **Generates a valid Kapsel skill** (ESM JavaScript + `kapsel.json` manifest) via LLM
3. **Writes the code to a persistent Docker volume** so it survives restarts
4. **Registers a connection entry** so the credential UI appears immediately in Settings → Connections
5. **Auto-activates the skill** — it's live for the next task
6. **Tells you where to enter credentials** — you just supply the API key like any other connection

Generated skills appear in the Skills, Tools, and Marketplace pages with a **✦ Custom** badge. They run in the same Kapsel sandbox as marketplace plugins — capability-gated, isolated, non-fatal on errors. The agent cannot grant itself capabilities beyond what the requested operations require.

**Example:** Ask Plexo to "connect to Intercom and list open conversations" — it will build the Intercom skill, register the connection, activate it, and prompt you to add your API key. No code deployment needed.

```
User: "I need you to connect to Intercom and build a tool that fetches open conversations."

Agent: Researching Intercom API docs...
       Generating skill code...
       Installing @generated/intercom-skill...

       ✦ Intercom skill is now active. Go to Connections → Intercom
         to enter your API key and start using it.
```

### Kapsel Protocol Example
Plexo provides a transparent, capability-gated SDK for developers.

```ts
import type { KapselSDK } from '@plexo/sdk'

export async function activate(sdk: KapselSDK) {
  sdk.registerTool({
    name: 'stripe_report',
    description: 'Generate a Stripe MRR report',
    parameters: { /* zod schema */ },
    handler: async ({ from, to }, ctx) => {
      // Execution logic bounded by declared permissions
      const apiKey = await sdk.storage.get('stripe_key')
      return fetchStripeData(apiKey);
    },
  })
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

### 4. The One-Way Door (OWD) Approvals
The safety valve. Review and approve critical actions before they execute.
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

## 📄 License & Commercial

Plexo is licensed under **BSL 1.1** (Converts to Apache 2.0 on 2030-03-03). See [LICENSE](LICENSE) for details.

This allows full free usage for self-hosting and internal deployment, while protecting the commercial target offering. For managed cloud and enterprise features, visit [getplexo.com](https://getplexo.com).

