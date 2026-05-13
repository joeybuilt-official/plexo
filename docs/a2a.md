# A2A (Agent-to-Agent) Protocol

Plexo implements the A2A protocol for cross-agent task delegation. Any A2A-compatible agent can discover Plexo and submit tasks to it, and Plexo can route tasks to external A2A agents.

## Plexo as an A2A server

### Agent discovery

Plexo exposes a standard agent card at the well-known endpoint:

```
GET /.well-known/agent.json
```

Response:

```json
{
  "name": "Plexo",
  "description": "AI agentic platform -- autonomous task execution, skills, and multi-agent orchestration",
  "url": "https://plexo.yourdomain.com/api/v1/a2a/default/tasks",
  "version": "0.8.0",
  "capabilities": {
    "streaming": true,
    "pushNotifications": true,
    "stateTransitionHistory": true
  },
  "defaultInputModes": ["text", "data"],
  "defaultOutputModes": ["text", "data"],
  "skills": [],
  "authentication": { "schemes": ["Bearer"] }
}
```

To list all agent cards (default + workspace extension agents):

```
GET /.well-known/agents
GET /api/v1/a2a/agents?workspaceId=<id>
```

To get a single agent's card:

```
GET /api/v1/a2a/agents/:id/card
```

### Submitting tasks

Send a task to any agent using the A2A message format:

```bash
curl -X POST https://plexo.yourdomain.com/api/v1/a2a/default/tasks \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "workspaceId": "YOUR_WORKSPACE_ID",
    "message": {
      "role": "user",
      "parts": [{ "type": "text", "text": "Analyze our API error rates for the last 7 days" }]
    }
  }'
```

Plexo also accepts a simpler format:

```json
{
  "workspaceId": "YOUR_WORKSPACE_ID",
  "message": "Analyze our API error rates for the last 7 days"
}
```

Response:

```json
{
  "id": "task-uuid",
  "status": "submitted",
  "artifacts": []
}
```

### Checking task status

```
GET /api/v1/a2a/:agentId/tasks/:taskId
```

Returns the task with A2A-compatible status mapping:

| Plexo status | A2A status |
|-------------|------------|
| queued | submitted |
| claimed / running | working |
| complete | completed |
| blocked | failed |
| cancelled | canceled |

The response includes `artifacts` (deliverables), `result` (outcome summary), and `children` (sub-agent tasks).

## Connecting external A2A agents

Register external A2A agents as extensions in your workspace. The agent card URL is used for task routing -- when Plexo's planner determines a step should be handled by an external agent, it delegates via the A2A task submission endpoint.

External agents need to expose:
1. An agent card at `/.well-known/agent.json`
2. A task submission endpoint (the `url` field in the card)
3. A task status endpoint for polling results

## Agent cards

Every A2A agent publishes a card describing its capabilities. Plexo uses cards to discover capabilities, route tasks, negotiate formats, and determine auth requirements. Custom agents registered as extensions automatically get their own cards derived from the extension manifest.

## Related docs

- [Getting Started](getting-started.md) -- First task setup
- [MCP](mcp.md) -- Tool-level integration (vs A2A's task-level)
- [Skills](skills.md) -- Extend agent capabilities with SKILL.md
