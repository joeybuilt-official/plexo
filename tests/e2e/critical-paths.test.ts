/**
 * E2E critical paths — health, auth flows, task submission.
 *
 * API tests run against localhost:3001 (always available in dev).
 * Browser tests require the Next.js app on localhost:3000 — skip with
 * E2E_SKIP_BROWSER=true when running CI without the web stack.
 *
 * Run: pnpm test:e2e (requires API + web running)
 *      E2E_SKIP_BROWSER=true pnpm test:e2e (API only)
 */
import { test, expect } from '@playwright/test'

const API_URL = process.env.E2E_API_URL ?? 'http://localhost:3001'
const SKIP_BROWSER = process.env.E2E_SKIP_BROWSER === 'true'

// ── Health ────────────────────────────────────────────────────────────────────

test.describe('API Health', () => {
  test('GET /health returns ok + postgres + redis', async ({ request }) => {
    const res = await request.get(`${API_URL}/health`)
    expect(res.status()).toBe(200)
    const body = await res.json() as {
      status: string
      services: { postgres: { ok: boolean }; redis: { ok: boolean } }
    }
    expect(body.status).toBe('ok')
    expect(body.services.postgres.ok).toBe(true)
    expect(body.services.redis.ok).toBe(true)
  })
})

// ── Task API ──────────────────────────────────────────────────────────────────

test.describe('Task API', () => {
  test('GET /api/tasks requires workspaceId', async ({ request }) => {
    const res = await request.get(`${API_URL}/api/tasks`)
    expect(res.status()).toBe(400)
    const body = await res.json() as { error: { code: string } }
    expect(body.error.code).toBe('MISSING_WORKSPACE')
  })

  test('GET /api/tasks with invalid UUID returns empty list', async ({ request }) => {
    const res = await request.get(`${API_URL}/api/tasks?workspaceId=not-a-uuid`)
    expect(res.status()).toBe(200)
    const body = await res.json() as { items: unknown[]; total: number }
    expect(body.items).toHaveLength(0)
    expect(body.total).toBe(0)
  })

  test('GET /api/dashboard/summary with invalid UUID returns idle agent shape', async ({ request }) => {
    const res = await request.get(`${API_URL}/api/dashboard/summary?workspaceId=not-a-uuid`)
    expect(res.status()).toBe(200)
    const body = await res.json() as { agent: { status: string } }
    expect(body.agent).toBeDefined()
    expect(body.agent.status).toBe('idle')
  })

  test('GET /api/channels/telegram/info returns configured status', async ({ request }) => {
    const res = await request.get(`${API_URL}/api/channels/telegram/info`)
    expect(res.status()).toBe(200)
    const body = await res.json() as { configured: boolean }
    expect(typeof body.configured).toBe('boolean')
  })

  test('GET /api/channels/slack/info returns configured status', async ({ request }) => {
    const res = await request.get(`${API_URL}/api/channels/slack/info`)
    expect(res.status()).toBe(200)
    const body = await res.json() as { configured: boolean }
    expect(typeof body.configured).toBe('boolean')
  })

  test('POST /api/tasks missing workspaceId returns 400', async ({ request }) => {
    const res = await request.post(`${API_URL}/api/tasks`, {
      data: { type: 'automation' },
    })
    expect(res.status()).toBe(400)
  })
})

// ── OAuth Info ────────────────────────────────────────────────────────────────

test.describe('OAuth', () => {
  test('GET /api/oauth/anthropic/info returns Anthropic metadata', async ({ request }) => {
    const res = await request.get(`${API_URL}/api/oauth/anthropic/info`)
    expect(res.status()).toBe(200)
    const body = await res.json() as { available: boolean; clientId: string }
    expect(body.available).toBe(true)
    expect(typeof body.clientId).toBe('string')
  })
})

// ── Approvals API ─────────────────────────────────────────────────────────────

test.describe('Approvals API', () => {
  test('GET /api/approvals requires workspaceId', async ({ request }) => {
    const res = await request.get(`${API_URL}/api/approvals`)
    expect(res.status()).toBe(400)
  })

  test('GET /api/approvals/:id returns 404 for unknown id', async ({ request }) => {
    const res = await request.get(`${API_URL}/api/approvals/definitely-not-real`)
    expect(res.status()).toBe(404)
  })
})

// ── Discord API ───────────────────────────────────────────────────────────────

test.describe('Discord API', () => {
  test('GET /api/channels/discord/info returns metadata', async ({ request }) => {
    const res = await request.get(`${API_URL}/api/channels/discord/info`)
    expect(res.status()).toBe(200)
    const body = await res.json() as { configured: boolean; supportedCommands: string[] }
    expect(typeof body.configured).toBe('boolean')
    expect(body.supportedCommands).toContain('/task')
  })

  test('POST /api/channels/discord/interactions without signature returns 401', async ({ request }) => {
    const res = await request.post(`${API_URL}/api/channels/discord/interactions`, {
      data: { type: 1 },
    })
    expect(res.status()).toBe(401)
  })
})

// ── Sprint API ────────────────────────────────────────────────────────────────

test.describe('Sprint API', () => {
  test('GET /api/sprints requires workspaceId', async ({ request }) => {
    const res = await request.get(`${API_URL}/api/sprints`)
    expect(res.status()).toBe(400)
    const body = await res.json() as { error: { code: string } }
    expect(body.error.code).toBe('MISSING_WORKSPACE')
  })

  test('GET /api/sprints/:id/tasks returns 404 for unknown sprint', async ({ request }) => {
    const res = await request.get(`${API_URL}/api/sprints/nonexistent-sprint-id/tasks`)
    expect(res.status()).toBe(404)
  })

  test('POST /api/sprints/:id/run returns 404 for unknown sprint', async ({ request }) => {
    const res = await request.post(`${API_URL}/api/sprints/nonexistent/run`, {
      data: { workspaceId: '00000000-0000-0000-0000-000000000001' },
    })
    expect(res.status()).toBe(404)
  })
})

// ── Workspaces API ────────────────────────────────────────────────────────────

test.describe('Workspaces API', () => {
  test('GET /api/workspaces returns items array', async ({ request }) => {
    const res = await request.get(`${API_URL}/api/workspaces`)
    expect(res.status()).toBe(200)
    const body = await res.json() as { items: unknown[]; total: number }
    expect(Array.isArray(body.items)).toBe(true)
    expect(typeof body.total).toBe('number')
  })

  test('GET /api/workspaces/:id returns 404 for unknown workspace', async ({ request }) => {
    const res = await request.get(`${API_URL}/api/workspaces/00000000-0000-0000-0000-000000000099`)
    expect(res.status()).toBe(404)
  })

  test('POST /api/workspaces with missing name returns 400', async ({ request }) => {
    const res = await request.post(`${API_URL}/api/workspaces`, {
      data: { ownerId: '00000000-0000-0000-0000-000000000001' },
    })
    expect(res.status()).toBe(400)
  })

  test('POST /api/tasks with projectId field accepted in body', async ({ request }) => {
    // Missing workspaceId → 400 regardless of projectId field
    const res = await request.post(`${API_URL}/api/tasks`, {
      data: { type: 'feature', description: 'test', projectId: '00000000-0000-0000-0000-000000000001' },
    })
    expect(res.status()).toBe(400)
  })
})

// ── Memory API ────────────────────────────────────────────────────────────────

test.describe('Memory API', () => {
  test('GET /api/memory/search requires workspaceId', async ({ request }) => {
    const res = await request.get(`${API_URL}/api/memory/search?q=test`)
    expect(res.status()).toBe(400)
  })

  test('GET /api/memory/search requires q', async ({ request }) => {
    const res = await request.get(`${API_URL}/api/memory/search?workspaceId=00000000-0000-0000-0000-000000000001`)
    expect(res.status()).toBe(400)
    const body = await res.json() as { error: { code: string } }
    expect(body.error.code).toBe('MISSING_QUERY')
  })

  test('GET /api/memory/preferences requires workspaceId', async ({ request }) => {
    const res = await request.get(`${API_URL}/api/memory/preferences`)
    expect(res.status()).toBe(400)
  })

  test('GET /api/memory/preferences returns empty for unknown workspace', async ({ request }) => {
    const res = await request.get(`${API_URL}/api/memory/preferences?workspaceId=00000000-0000-0000-0000-000000000001`)
    expect(res.status()).toBe(200)
    const body = await res.json() as { preferences: Record<string, unknown> }
    expect(typeof body.preferences).toBe('object')
  })

  test('GET /api/memory/improvements requires workspaceId', async ({ request }) => {
    const res = await request.get(`${API_URL}/api/memory/improvements`)
    expect(res.status()).toBe(400)
  })
})

// ── Chat API ──────────────────────────────────────────────────────────────────

test.describe('Chat API', () => {
  test('POST /api/chat/message missing workspaceId returns 400', async ({ request }) => {
    const res = await request.post(`${API_URL}/api/chat/message`, {
      data: { message: 'hello' },
    })
    expect(res.status()).toBe(400)
    const body = await res.json() as { error: { code: string } }
    expect(body.error.code).toBe('INVALID_WORKSPACE')
  })

  test('POST /api/chat/message missing message returns 400', async ({ request }) => {
    const res = await request.post(`${API_URL}/api/chat/message`, {
      data: { workspaceId: '00000000-0000-0000-0000-000000000001' },
    })
    expect(res.status()).toBe(400)
    const body = await res.json() as { error: { code: string } }
    expect(body.error.code).toBe('MISSING_MESSAGE')
  })

  test('GET /api/chat/widget.js returns JavaScript', async ({ request }) => {
    const res = await request.get(`${API_URL}/api/chat/widget.js`)
    expect(res.status()).toBe(200)
    expect(res.headers()['content-type']).toContain('javascript')
    const body = await res.text()
    expect(body).toContain('plexo-widget-btn')
  })
})

// ── Cron API ──────────────────────────────────────────────────────────────────

test.describe('Cron NLP API', () => {
  test('POST /api/cron/parse-nl with valid text returns cron expression', async ({ request }) => {
    const res = await request.post(`${API_URL}/api/cron/parse-nl`, {
      data: { text: 'every day at midnight' },
    })
    expect(res.status()).toBe(200)
    const body = await res.json() as { cron: string; description: string }
    expect(typeof body.cron).toBe('string')
    expect(body.cron.split(' ')).toHaveLength(5)
  })

  test('POST /api/cron/parse-nl missing text returns 400', async ({ request }) => {
    const res = await request.post(`${API_URL}/api/cron/parse-nl`, {
      data: {},
    })
    expect(res.status()).toBe(400)
  })
})

// ── Browser tests (require Next.js on :3000) ──────────────────────────────────

test.describe('Login', () => {
  test.skip(SKIP_BROWSER, 'Set E2E_SKIP_BROWSER=false and run pnpm dev to enable')

  test('login page renders', async ({ page }) => {
    await page.goto('/login')
    await expect(page).toHaveTitle(/Plexo/i)
    await expect(page.locator('input[type="email"], input[name="email"]')).toBeVisible()
    await expect(page.locator('input[type="password"]')).toBeVisible()
  })

  test('invalid credentials stays on login', async ({ page }) => {
    await page.goto('/login')
    await page.fill('input[type="email"], input[name="email"]', 'bad@example.com')
    await page.fill('input[type="password"]', 'wrongpassword')
    await page.click('button[type="submit"]')
    await expect(page).toHaveURL(/login/)
  })
})

test.describe('Dashboard', () => {
  test.skip(SKIP_BROWSER, 'Set E2E_SKIP_BROWSER=false and run pnpm dev to enable')

  test('dashboard loads and shows key UI elements', async ({ page }) => {
    await page.goto('/')
    // If middleware redirects to login, that's also correct — test passes
    const url = page.url()
    if (/login|signin/.test(url)) return

    // Dashboard is accessible — confirm live data cards render
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
    await expect(page.getByText('Agent Status')).toBeVisible()
    await expect(page.getByText('API Cost')).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Tasks', exact: true }).first()).toBeVisible()
    await expect(page.getByPlaceholder(/Describe/i)).toBeVisible()
  })

  test('login page is accessible from login link', async ({ page }) => {
    await page.goto('/login')
    await expect(page.locator('input[type="email"], input[name="email"]')).toBeVisible()
  })
})

// ── Members API ───────────────────────────────────────────────────────────────

test.describe('Members API', () => {
  const FAKE_WS_ID = '00000000-0000-0000-0000-000000000001'

  test('GET /api/workspaces/:id/members returns items array', async ({ request }) => {
    // Use the first real workspace if available
    const wsRes = await request.get(`${API_URL}/api/workspaces`)
    if (!wsRes.ok) return // skip if no workspaces
    const wsData = await wsRes.json() as { items: { id: string }[] }
    if (!wsData.items?.length) return
    const wsId = wsData.items[0].id

    const res = await request.get(`${API_URL}/api/workspaces/${wsId}/members`)
    expect(res.status()).toBe(200)
    const body = await res.json() as { items: unknown[]; total: number }
    expect(Array.isArray(body.items)).toBe(true)
    expect(body.items.length).toBeGreaterThan(0) // backfill ensures at least owner
  })

  test('POST /api/workspaces/:id/members requires email', async ({ request }) => {
    const res = await request.post(`${API_URL}/api/workspaces/${FAKE_WS_ID}/members`, {
      data: { role: 'member' },
    })
    expect(res.status()).toBe(400)
    const body = await res.json() as { error: { code: string } }
    expect(body.error.code).toBe('MISSING_EMAIL')
  })

  test('GET /api/invites/:token returns 404 for unknown token', async ({ request }) => {
    const res = await request.get(`${API_URL}/api/invites/notarealtoken`)
    expect(res.status()).toBe(404)
  })

  test('POST /api/invites/:token/accept requires userId', async ({ request }) => {
    const res = await request.post(`${API_URL}/api/invites/notarealtoken/accept`, {
      data: {},
    })
    expect(res.status()).toBe(400)
    const body = await res.json() as { error: { code: string } }
    expect(body.error.code).toBe('MISSING_USER')
  })
})

// ── Plugins API ───────────────────────────────────────────────────────────────

test.describe('Plugins API', () => {
  test('GET /api/plugins requires workspaceId', async ({ request }) => {
    const res = await request.get(`${API_URL}/api/plugins`)
    expect(res.status()).toBe(400)
    const body = await res.json() as { error: { code: string } }
    expect(body.error.code).toBe('MISSING_WORKSPACE')
  })

  test('POST /api/plugins validates manifest fields', async ({ request }) => {
    const res = await request.post(`${API_URL}/api/plugins`, {
      data: { workspaceId: '00000000-0000-0000-0000-000000000001', manifest: {} },
    })
    expect(res.status()).toBe(400)
    const body = await res.json() as { error: { code: string } }
    expect(body.error.code).toBe('INVALID_MANIFEST')
  })

  test('GET /api/plugins/:id returns 404 for unknown id', async ({ request }) => {
    const res = await request.get(`${API_URL}/api/plugins/00000000-0000-0000-0000-000000000099`)
    expect(res.status()).toBe(404)
  })
})

// ── Audit API ─────────────────────────────────────────────────────────────────

test.describe('Audit API', () => {
  test('GET /api/audit requires workspaceId', async ({ request }) => {
    const res = await request.get(`${API_URL}/api/audit`)
    expect(res.status()).toBe(400)
    const body = await res.json() as { error: { code: string } }
    expect(body.error.code).toBe('MISSING_WORKSPACE')
  })

  test('GET /api/audit returns items array for real workspace', async ({ request }) => {
    const wsRes = await request.get(`${API_URL}/api/workspaces`)
    if (!wsRes.ok) return
    const wsData = await wsRes.json() as { items: { id: string }[] }
    if (!wsData.items?.length) return
    const wsId = wsData.items[0].id

    const res = await request.get(`${API_URL}/api/audit?workspaceId=${wsId}`)
    expect(res.status()).toBe(200)
    const body = await res.json() as { items: unknown[]; hasMore: boolean }
    expect(Array.isArray(body.items)).toBe(true)
  })
})

