# MCP (Model Context Protocol)

Plexo is both an MCP consumer (connects to external MCP servers for tools) and an MCP producer (exposes Plexo tools to external clients like Claude Code).

## Plexo as MCP consumer

Connect external MCP servers to give the agent access to third-party tools. Plexo ships with bindings for common servers:

| Connection | MCP Package |
|-----------|-------------|
| GitHub | `@modelcontextprotocol/server-github` |
| GitLab | `@modelcontextprotocol/server-gitlab` |
| Slack | `@modelcontextprotocol/server-slack` |
| Notion | `@modelcontextprotocol/server-notion` |
| Linear | `@linear/mcp` |
| Jira | `@mcp-atlassian/jira` |

### Installing a connection

1. Go to **Settings > Connections** in the dashboard
2. Select the integration from the registry
3. Provide the required credentials (API key, token, etc.)
4. Enable the tools you want the agent to use

Via API:

```bash
curl -X POST https://plexo.yourdomain.com/api/connections/install \
  -H "Content-Type: application/json" \
  -d '{
    "workspaceId": "YOUR_WORKSPACE_ID",
    "registryId": "github",
    "credentials": { "token": "ghp_..." }
  }'
```

Credentials are encrypted at rest with AES-256-GCM. The agent loads enabled connection tools at task start.

## Plexo as MCP producer

Plexo runs an MCP server that exposes 11 tools to external clients. Enable it by setting `MCP_ENABLED=true` in your `.env`.

### Built-in tools

| Tool | Scope | Description |
|------|-------|-------------|
| `plexo_health` | none | System health check |
| `plexo_workspace_info` | `system:read` | Workspace metadata, agent status, cost usage |
| `plexo_list_tasks` | `tasks:read` | List recent tasks, filter by status |
| `plexo_create_task` | `tasks:write` | Create and queue a new task |
| `plexo_get_task` | `tasks:read` | Get task details by ID |
| `plexo_cancel_task` | `tasks:write` | Cancel a queued or running task |
| `plexo_search_memory` | `memory:read` | Search workspace memory entries |
| `plexo_remember` | `memory:write` | Store a fact or pattern in memory |
| `plexo_pax_register` | `pax:manage` | Register a PAX app |
| `plexo_pax_status` | `pax:read` | Check PAX app registration status |
| `plexo_pax_revoke` | `pax:manage` | Revoke a PAX app |

### Transport options

**Streamable HTTP** (default) -- runs on port 3002:

```
POST /mcp
Authorization: Bearer <token>
```

**stdio** -- for local integration with Claude Code or similar tools:

```bash
MCP_TRANSPORT=stdio PLEXO_MCP_TOKEN=<token> node packages/mcp-server/dist/index.js
```

### Authentication

MCP requests require a Bearer token. Generate tokens in the dashboard under **Settings > API Tokens** with the scopes your client needs.

`plexo_health` is the only tool that works without authentication.

### Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `MCP_ENABLED` | `false` | Enable the MCP server sidecar |
| `MCP_TRANSPORT` | `http` | `http` or `stdio` |
| `MCP_PORT` | `3002` | Port for HTTP transport |
| `PLEXO_MCP_TOKEN` | -- | Required for stdio transport |

### Connecting from Claude Code

Add to your Claude Code MCP config:

```json
{
  "mcpServers": {
    "plexo": {
      "command": "node",
      "args": ["packages/mcp-server/dist/index.js", "--transport=stdio"],
      "env": {
        "PLEXO_MCP_TOKEN": "your-token-here"
      }
    }
  }
}
```

Or connect to the HTTP endpoint from any MCP-compatible client using the Streamable HTTP transport at `https://plexo.yourdomain.com:3002/mcp`.

## Related docs

- [Getting Started](getting-started.md) -- First task setup
- [A2A](a2a.md) -- Task-level agent integration (vs MCP's tool-level)
- [Skills](skills.md) -- Extend agent capabilities with SKILL.md
- [Configuration](configuration.md) -- Full environment variable reference
