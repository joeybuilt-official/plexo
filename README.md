<div align="center">

<img src="images/overview.png" alt="Plexo Dashboard" width="100%" style="border-radius: 12px; box-shadow: 0 4px 24px rgba(0,0,0,0.2);" />

<br/>

# Plexo

**The Agentic Operating System. Built for Production.**

<p align="center">
  A persistent, self-hosted AI workforce that autonomously handles software engineering, business operations, and deep research. Engineered for trust, built for scale, and entirely extensible via the Kapsel standard.
</p>

[![License: BSL 1.1](https://img.shields.io/badge/License-BSL%201.1-orange.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Docker](https://img.shields.io/badge/Deploy-Docker-2496ED?logo=docker&logoColor=white)](docker/compose.yml)
[![Kapsel](https://img.shields.io/badge/Kapsel-Full%20compliant-6C47FF)](https://github.com/joeybuilt-official/kapsel)

[**Managed Cloud**](https://getplexo.com) · [**Documentation**](docs/) · [**Kapsel Protocol**](https://github.com/joeybuilt-official/kapsel)

</div>

---

## 1. The Paradigm Shift

Most AI tools are glorified chat interfaces. You ask. They answer. *You* still do the work. The ceiling of a chat UI is human bandwidth.

**Plexo is an inversion of that model.** You describe an objective—in Slack, Telegram, or the native Dashboard—and your Plexo instance takes over. It formulates a topological execution plan, works asynchronously, verifies its own output, and only interrupts you for critical decisions. 

It is not an assistant; it is a persistent, scalable workforce that you completely control.

*   **Software Engineering:** Run parallel code sprints, open PRs, auto-diagnose and fix failing CI builds.
*   **Business Operations:** Generate internal MRR reports, monitor PostHog/Stripe events, and sync issues across Linear.
*   **Deep Research:** Asynchronous topic tracking, document synthesis, and structured web data extraction.

---

## 2. Engineered For Trust

An autonomous agent with write-access to your codebase and production systems is a profound liability without an obsessive focus on architecture and safety. Plexo was engineered from first principles to mitigate risk.

#### The Stack
| Layer | Technology | Rationale |
|-------|-----------|-----|
| **Core Runtime** | Node.js ≥22, TypeScript (Strict) | Fully typed execution paths, isolated worker threads. |
| **Web & API** | Next.js 15, Express 5 | Server components, edge streaming, native async middleware. |
| **Data & State** | PostgreSQL 16 + pgvector, Valkey (Redis) | Native vector search parity, ultra-low latency task queues. |
| **Intelligence** | Vercel AI SDK | Provider-agnostic. Route to Anthropic, OpenAI, Groq, or local Ollama. |

#### Verifiable Safety Rails
*   **Capability-Gated Execution:** Plugins cannot arbitrarily access the host network. Permissions (`storage:write`, `connections:github`) must be explicitly granted.
*   **The One-Way Door (OWD) Protocol:** Any destructive operation (modifying schemas, pushing commits, spending >$X) triggers a hard execution pause. The system requests explicit authorization via a real-time SSE push to your dashboard or Slack thread.
*   **Hard Boundaries:** Hard-coded limits on consecutive tool calls, execution wall-clock time, and API token spend per task.

---

## 3. The Extensibility Moat

A platform's survival depends on its ecosystem. Plexo natively adheres to [**Kapsel**](https://github.com/joeybuilt-official/kapsel), the definitive open standard for AI agent extensions.

This is the App Store model for AI—decentralized, host-agnostic, and secure by default.

*   **Persistent Sandboxes:** Extensions run in their own persistent `worker_threads`. Zero cold-start overhead across tool invocations. Crashes are caught, isolated, and respawned without bringing down the host.
*   **Write Once, Run Anywhere:** A Kapsel plugin written for Plexo will run on any other Kapsel-compliant host. 
*   **Built-in Registry:** Publish, discover, and install extensions directly via the internal Plexo registry. Validate via SHA-256 checksums.
*   **Omni-Channel Native:** Native adapters for Slack, Discord, and Telegram. Agents live where the team communicates. Integrate IDEs (Cursor/Claude) via the built-in MCP server (`@plexo/mcp-server`).

---

## The Platform Interface

<div align="center">
  <em>The Plexo Dashboard is designed to rival top-tier SaaS applications—clinical, fast, and actionable.</em>
</div>

<br/>

<details>
<summary><strong>Expand to view platform screenshots</strong></summary>
<br/>

### Projects (Sprints) Orchestration
Manage large-scale autonomous initiatives and their topological sub-tasks.
<img src="images/projects.png" alt="Projects View" width="100%" />

### Task Introspection
Deep visibility into agent tool usage, execution logs, cost burn, and exact reasoning traces.
<img src="images/tasks.png" alt="Tasks View" width="100%" />

### Omni-Channel Conversations
Seamless handoffs between Slack/Telegram and the Web Dashboard.
<img src="images/conversations.png" alt="Conversations View" width="100%" />

### The One-Way Door (OWD) Approvals
The safety valve. Review and approve critical actions before they execute.
<img src="images/approvals.png" alt="Approvals View" width="100%" />

### Deep Agent Configuration
Total control over identity, behavior, limits, and multi-model fallback chains.
<img src="images/agent_settings.png" alt="Agent Settings View" width="100%" />

</details>

---

## 4. Deep Integrations & Technical Surface

Plexo exposes several robust methods for integration to ensure your automation seamlessly fits into your existing infrastructure.

### The Kapsel Extension Protocol
Plexo is **Kapsel Full compliant** (v0.2.0). Extensions are sandboxed and communicate via a transparent, capability-gated SDK.

```ts
// kapsel.json manifest
{
  "name": "@acme/stripe-reporter",
  "version": "1.0.0",
  "kapselVersion": "^0.2.0",
  "capabilities": ["storage:read", "storage:write", "memory:write"]
}

// index.ts execution logic
import type { KapselSDK } from '@plexo/sdk'

export async function activate(sdk: KapselSDK) {
  sdk.registerTool({
    name: 'stripe_report',
    description: 'Generate a Stripe MRR report',
    parameters: { ... },
    handler: async ({ from, to }, ctx) => {
      const apiKey = await sdk.storage.get('stripe_key')
      // Execution logic here...
    },
  })
}
```

### Bring Plexo into Claude & Cursor (MCP Server)
Plexo acts as the intelligent backend for your favorite AI tools. By connecting Plexo via the open [Model Context Protocol (MCP)](https://modelcontextprotocol.io), tools like Claude Desktop and Cursor can **read directly from your Plexo workspace**, check on background tasks, view budgets, and query your systems—without you having to manually explain context.

Because your Plexo instance is hosted securely (or running locally), your IDE connects to it remotely via an MCP proxy.

**Connecting Claude Desktop:**
Add this to your `claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "plexo": {
      "command": "npx",
      "args": ["-y", "@plexo/cli@latest", "mcp-proxy"],
      "env": {
        "PLEXO_URL": "http://localhost:3001", 
        "PLEXO_TOKEN": "your-workspace-token"
      }
    }
  }
}
```
*(Note: If using Managed Cloud, change URL to `https://api.getplexo.com`)*
*Restart Claude, and it will immediately connect to your Plexo workspace.*

**Connecting Cursor IDE:**
1. Open Cursor Settings > **Features** > **MCP Servers**.
2. Click **+ Add New MCP Server**.
3. Set Name to `Plexo` and Type to `command`.
4. Command: `npx -y @plexo/cli@latest mcp-proxy`
5. Click the "Env vars" arrow and add: 
   - `PLEXO_URL=http://localhost:3001` *(or `https://api.getplexo.com`)*
   - `PLEXO_TOKEN=your-workspace-token`

---

### The Developer CLI (`@plexo/cli`)
For engineers, Plexo lives natively in your terminal and CI/CD runners. Anyone in the world can download the CLI, but they must authenticate with an instance URL (either your local machine or the managed cloud) and API key.

**1. Install & Authenticate:**
```bash
npm install -g @plexo/cli

# For local development:
plexo auth login http://localhost:3001

# For Managed Cloud:
plexo auth login https://api.getplexo.com
```

**2. Trigger workers on-the-fly:**
```bash
plexo task run "diagnose the memory leak in production" --wait
```

**Native CI/CD Integration:**
Pass the connection details explicitly in your automation pipelines. Plexo yields structured exit codes: `0` (success), `2` (task failed), `3` (blocked for human approval), and `5` (timeout).
```bash
PLEXO_URL=http://localhost:3001 PLEXO_TOKEN=sk-xxx \
  npx @plexo/cli@latest sprint start "review code and run integration tests" --wait --timeout 2h
```

**Available Commands:**
`auth`, `task`, `sprint`, `cron`, `connection`, `plugin`, `memory`, `logs`, `status`, `config`


### Complete API Surface
All endpoints require a valid `workspaceId` UUID, providing enterprise multi-tenant separation out of the box.

```text
GET    /health                               Postgres + Redis latency, active workers
GET    /api/v1/tasks                         List tasks (paginated, filter algorithms)
POST   /api/v1/tasks                         Create task execution
GET    /api/v1/sprints                       Manage grouped topological task waves
GET    /api/v1/workspaces/:id/members        Full RBAC Control
POST   /api/v1/approvals/:id/approve         Execute One-Way Door operations
POST   /api/v1/plugins                       Install sandboxed extensions
GET    /api/v1/memory/search                 Semantic vector DB HNSW search
GET    /api/sse                              Real-time broadcast for UI/Bots
```

---

## Self-Host in < 3 Minutes

Plexo ships as a single `docker compose` stack — Postgres, Valkey, API, Web, and Caddy (auto-TLS).

### Minimum Requirements

| Resource | Minimum | Recommended |
|----------|---------|-------------|
| CPU | 1 vCPU | 2 vCPU |
| RAM | 2 GB | 4 GB |
| Disk | 10 GB | 20 GB |
| OS | Any Linux with Docker ≥24 | Ubuntu 22.04 LTS |

> Caddy handles TLS automatically. **You need a domain pointing at your server before running `compose up`** — Caddy will fail to obtain a cert without DNS resolving to the host.

### 1. Clone and configure

```bash
git clone https://github.com/joeybuilt-official/plexo.git
cd plexo
cp .env.example .env
```

Open `.env` and fill in **all required fields** before proceeding:

| Variable | Required | Description |
|----------|----------|-------------|
| `POSTGRES_PASSWORD` | ✅ | Strong random password — `openssl rand -hex 32` |
| `SESSION_SECRET` | ✅ | ≥64 char secret — `openssl rand -hex 64` |
| `ENCRYPTION_SECRET` | ✅ | 32 char key — `openssl rand -hex 32` |
| `PUBLIC_URL` | ✅ | Your domain with scheme, e.g. `https://plexo.example.com` |
| `PUBLIC_DOMAIN` | ✅ | Bare domain for Caddy TLS, e.g. `plexo.example.com` |
| `ANTHROPIC_API_KEY` | ⚠️ | At least one AI provider key required for agent tasks |

All other variables (channels, OAuth providers, cost limits) are optional and can be configured from the Settings UI after first boot.

### 2. Start the stack

```bash
docker compose -f docker/compose.yml up -d
```

Migrations run automatically before the API starts. First boot takes ~60s. Subsequent starts are fast.

### 3. Open the dashboard

Navigate to `https://your-domain.com`. Create your admin account on first visit.

*(No Anthropic API key yet? Link your Claude.ai Pro account from Settings → Connections instead.)*

---

### Updating

Plexo checks for new releases automatically. When you're behind, a modal appears in the dashboard with update options.

**Manually (always works):**
```bash
cd /path/to/plexo
git pull
docker compose -f docker/compose.yml up -d --build
```

**One-click update (opt-in):** Add to `.env` and uncomment the `volumes` block in `docker/compose.yml`:
```bash
DOCKER_SOCKET_ENABLED=true
COMPOSE_PROJECT_NAME=plexo
```
> **Security note:** Mounting the Docker socket grants root-equivalent host access. Only enable this if you understand the tradeoff.

---

## License

Plexo is licensed under **BSL 1.1** (Converts to Apache 2.0 on 2030-03-03). See [LICENSE](LICENSE) for details.
