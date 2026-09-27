# App → Plexo Integration Guide

Connect any sibling app to Plexo in under an hour.
**Reference implementation**: Levio, under your Plexo checkout at `apps/levio/` (sibling apps lived in the private platform repo; paths below are illustrative).

---

## Architecture

Every sibling app connects to Plexo as a **trusted service client**:

```
App (your sibling app)
  ↓  Authorization: Bearer <PLEXO_SERVICE_KEY>
  ↓  X-App-Id: <app_slug>
Plexo API (plexo-api:3001)
  ↓  workspace-scoped data, OAuth tokens, connections
Plexo DB (plexo database on your-postgres)
```

Users connect OAuth services once in Plexo. All apps read from that shared store.
The agent routes intent across apps via Plexo Core — users never switch bots or UIs.

---

## 1. Required Env Vars

Add to `docker-compose.prod.yml` for the app's service:

```yaml
environment:
  PLEXO_URL: http://plexo-api:3001                 # internal Docker DNS
  PLEXO_SERVICE_KEY: ${PLEXO_SERVICE_KEY}           # from your infra .env
  NEXT_PUBLIC_PLEXO_URL: https://<your-app-domain>  # public, for client-side OAuth popups
  NEXT_PUBLIC_PLEXO_PANEL_URL: https://plexo.example.com      # optional
```

The app must be on the `internal` Docker network to resolve `plexo-api`.

**Never** put these in `.env.local` for container use — edit `docker-compose.prod.yml` and rebuild.

---

## 2. Plexo Client (server-side only)

Copy `apps/levio/src/lib/plexo/client.ts` from the reference implementation into your app's `src/lib/plexo/client.ts`.
It needs no changes — it reads `PLEXO_URL` and `PLEXO_SERVICE_KEY` from the environment.

```typescript
import { plexo } from '@/lib/plexo/client'

// Get or create a Plexo workspace for this user
const workspaceId = await plexo.ensureWorkspace(userId, userEmail)

// List all active connections for the workspace
const connections = await plexo.getInstalledConnections(workspaceId)
// → [{ id, registryId: 'google-workspace', name: 'user@example.com', status: 'active', ... }]

// Get decrypted OAuth token for a provider
const token = await plexo.getToken(workspaceId, 'google-workspace')
// → { access_token, refresh_token, expires_at, email, scope }

// Build OAuth popup URL (open in frontend)
const url = plexo.oauthPopupUrl('google', workspaceId)
// → https://<your-app-domain>/api/oauth/google/start?workspaceId=...
```

All methods use `Authorization: Bearer <PLEXO_SERVICE_KEY>` + `X-App-Id: <slug>`.
The service key bypasses session auth — `req.user` is NOT set for these requests.

---

## 3. Reading Connections from Plexo API

### Server-side proxy routes

Create `src/app/api/plexo/registry/route.ts` and `src/app/api/plexo/workspace/route.ts`.
These proxy client requests to Plexo without exposing the service key to browsers.

**Registry route** (GET `/api/plexo/registry`):
```typescript
// Returns merged view: available integrations + which ones are installed
export async function GET(req: NextRequest) {
  const { userId } = await getSessionUser(req)  // your app's auth
  const workspaceId = await plexo.ensureWorkspace(userId)
  const installed = await plexo.getInstalledConnections(workspaceId)
  // Build registry items (see levio implementation)
  return NextResponse.json({ items, plexoConfigured: !!process.env.PLEXO_URL })
}
```

**Workspace route** (GET `/api/plexo/workspace`):
```typescript
export async function GET(req: NextRequest) {
  const { userId, email } = await getSessionUser(req)
  const workspaceId = await plexo.ensureWorkspace(userId, email)
  return NextResponse.json({
    workspaceId,
    oauthBaseUrl: process.env.NEXT_PUBLIC_PLEXO_URL,
  })
}
```

### Direct Plexo API calls (from server routes)

```
GET  /api/v1/connections/installed?workspaceId=<UUID>
     → { items: PlexoConnection[] }

GET  /api/v1/connections/token?workspaceId=<UUID>&registryId=google-workspace
     → { access_token, refresh_token, expires_at, email, scope }

GET  /api/v1/connections/registry
     → { items: RegistryEntry[] }

DELETE /api/v1/connections/installed/:id?workspaceId=<UUID>
     → { ok: true }
```

All require `Authorization: Bearer <PLEXO_SERVICE_KEY>` + `X-App-Id: <slug>`.

---

## 4. OAuth Flows Through Plexo

When a user clicks "Connect Google" (or any OAuth service):

**Frontend** opens a popup to:
```
${NEXT_PUBLIC_PLEXO_URL}/api/oauth/google/start?workspaceId=<workspaceId>
```

Listen for `postMessage` from the popup:
```typescript
window.addEventListener('message', (e) => {
  if (e.data?.type === 'oauth_callback' && e.data?.ok) {
    // Refresh the connections list
  }
})
```

The popup automatically closes and posts `{ type: 'oauth_callback', ok: true, provider, workspaceId, email }`.

**Server-side install** (API key / webhook connections — no OAuth):
```typescript
// POST /api/plexo/install (your proxy route, hides service key)
await fetch(`${process.env.PLEXO_URL}/api/v1/connections/install`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${process.env.PLEXO_SERVICE_KEY}`,
    'X-App-Id': 'your-app-slug',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ workspaceId, registryId, credentials: { api_key: key } }),
})
```

---

## 5. App Profile Registration

Register your app with Plexo Core so the agent knows about its capabilities:

```typescript
// src/lib/plexo-registration.ts
const PLEXO_URL = process.env.PLEXO_URL
const PLEXO_SERVICE_KEY = process.env.PLEXO_SERVICE_KEY

export async function registerWithPlexo(appUrl: string) {
  if (!PLEXO_URL || !PLEXO_SERVICE_KEY) return
  try {
    await fetch(`${PLEXO_URL}/api/v1/profiles/register`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${PLEXO_SERVICE_KEY}`,
        'X-App-Id': 'your-app-slug',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        appId: 'your-app-slug',
        name: 'Your App Name',
        description: 'What this app does',
        appUrl,
        capabilities: ['list-tasks', 'create-task', 'search-calendar'],
        schema: 'your-app-slug',  // postgres schema name
      }),
    })
    console.log('[plexo] Registered with Core as appId=your-app-slug')
  } catch {
    // non-fatal — agent degrades gracefully
  }
}
```

Call this at app startup (e.g., in `instrumentation.ts` or `src/app/layout.tsx` server side).

---

## 6. Routing Chat Through Plexo Core

The user's chat in your app should route through Plexo Core, not your own LLM call:

```typescript
// src/app/api/chat/route.ts
const PLEXO_URL = process.env.PLEXO_URL
const PLEXO_SERVICE_KEY = process.env.PLEXO_SERVICE_KEY

export async function POST(req: NextRequest) {
  const { message, conversationId } = await req.json()
  const { userId } = await getSessionUser(req)

  if (PLEXO_URL && PLEXO_SERVICE_KEY) {
    // Route through Plexo Core agent
    const workspaceId = await plexo.ensureWorkspace(userId)
    const response = await fetch(`${PLEXO_URL}/api/v1/chat`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${PLEXO_SERVICE_KEY}`,
        'X-App-Id': 'your-app-slug',
        'X-User-Id': userId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        workspaceId,
        message,
        conversationId,
        appContext: { source: 'your-app-slug' },
      }),
    })
    return new Response(response.body, { headers: response.headers })
  }

  // Fallback: direct LLM call (dev/standalone mode)
  // ...
}
```

The Plexo agent has context of all connected apps via registered profiles.
"What's on my calendar?" → routes to your calendar app data.
"How's my budget?" → routes to your finance app data.

---

## 7. Docker Compose Checklist

```yaml
your-app:
  container_name: your-app
  build:
    context: <your-infra-dir>/apps/your-app
    dockerfile: Dockerfile
    args:
      NEXT_PUBLIC_PLEXO_URL: https://<your-app-domain>     # baked at build time
      NEXT_PUBLIC_PLEXO_PANEL_URL: https://plexo.example.com
  environment:
    PLEXO_URL: http://plexo-api:3001                        # runtime, internal
    PLEXO_SERVICE_KEY: ${PLEXO_SERVICE_KEY}
    NEXT_PUBLIC_PLEXO_URL: https://<your-app-domain>       # also needed at runtime
  networks:
    - internal                                              # must match plexo-api network
```

**Common mistakes:**
- `PLEXO_URL` must use `plexo-api` (the container name), matching your compose service name
- `NEXT_PUBLIC_PLEXO_URL` needs to be set as both a build arg AND runtime env (Next.js bakes it)
- App must be on `internal` network — `plexo-api` is not on `default` network

---

## 8. Verification

After setup, test the integration:

```bash
# 1. Check the plexo client can reach the API
docker exec your-app wget -qO- \
  --header="Authorization: Bearer $PLEXO_SERVICE_KEY" \
  --header="X-App-Id: your-app-slug" \
  "http://plexo-api:3001/api/v1/connections/installed?workspaceId=<uuid>"
# Should return 200 with { items: [...] }

# 2. Check registration appeared
docker logs your-app | grep "\[plexo\]"
# Should show: [plexo] Registered with Core as appId=your-app-slug

# 3. Check the connections page shows active connections
# Navigate to your-app.example.com/settings/connections
# Google Workspace should show your-email@example.com as connected
```

---

## Reference: Levio Implementation

| Pattern | File |
|---------|------|
| Plexo client | `src/lib/plexo/client.ts` |
| Registry proxy | `src/app/api/plexo/registry/route.ts` |
| Workspace proxy | `src/app/api/plexo/workspace/route.ts` |
| Install proxy | `src/app/api/plexo/install/route.ts` |
| Connections hub UI | `src/components/settings/connections-hub.tsx` |
| Registration | Called from app startup |

---

## Plexo API Quick Reference

Base URL (internal): `http://plexo-api:3001`
Auth headers (all requests): `Authorization: Bearer <PLEXO_SERVICE_KEY>` + `X-App-Id: <slug>`

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/v1/auth/workspace/ensure` | POST | Get-or-create workspace for userId |
| `/api/v1/connections/installed` | GET | List connections for workspaceId |
| `/api/v1/connections/token` | GET | Get decrypted token for registryId |
| `/api/v1/connections/install` | POST | Install connection (API key flow) |
| `/api/v1/connections/installed/:id` | DELETE | Disconnect |
| `/api/v1/connections/registry` | GET | All available integrations |
| `/api/oauth/:provider/start` | GET | Begin OAuth popup flow |
| `/api/v1/profiles/register` | POST | Register app with Core |
| `/api/v1/chat` | POST | Route message through Plexo agent |
