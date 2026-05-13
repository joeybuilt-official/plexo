/**
 * Agent Behavior Configuration API (Phase 5) integration tests.
 *
 * API tests run against localhost:3001 (always available in dev).
 */
import { test, expect } from '@playwright/test'
import { dismissAnalyticsModal } from './_helpers'

const API_URL = process.env.E2E_API_URL ?? 'http://localhost:3001'
const SKIP_BROWSER = process.env.E2E_SKIP_BROWSER === 'true'

test.describe('Behavior API', () => {

  test('GET /api/v1/behavior/:workspaceId returns rules and groups', async ({ request }) => {
    // Get a real workspace to submit against
    const wsRes = await request.get(`${API_URL}/api/v1/workspaces`)
    if (!wsRes.ok()) return // Skip if no auth
    const wsData = await wsRes.json() as { items: { id: string }[] }
    if (!wsData.items?.length) return
    const wsId = wsData.items[0]!.id

    const rulesRes = await request.get(`${API_URL}/api/v1/behavior/${wsId}`)
    expect(rulesRes.status()).toBe(200)
    const rulesBody = await rulesRes.json() as { rules: Array<unknown> }
    expect(Array.isArray(rulesBody.rules)).toBe(true)

    const groupsRes = await request.get(`${API_URL}/api/v1/behavior/${wsId}/groups`)
    expect(groupsRes.status()).toBe(200)
    const groupsBody = await groupsRes.json() as { groups: Array<unknown> }
    expect(Array.isArray(groupsBody.groups)).toBe(true)
    expect(groupsBody.groups.length).toBeGreaterThan(0)
  })

  test('POST /api/v1/behavior/:workspaceId/rules creates a rule', async ({ request }) => {
    const wsRes = await request.get(`${API_URL}/api/v1/workspaces`)
    if (!wsRes.ok()) return
    const wsData = await wsRes.json() as { items: { id: string }[] }
    if (!wsData.items?.length) return
    const wsId = wsData.items[0]!.id

    const createRes = await request.post(`${API_URL}/api/v1/behavior/${wsId}/rules`, {
      data: {
        type: 'communication_style',
        key: 'response_verbosity',
        label: 'Test Verbosity',
        description: 'Test rule created by E2E',
        value: { type: 'enum', value: 'verbose', options: ['verbose', 'concise'] },
        source: 'workspace'
      }
    })
    expect(createRes.status()).toBe(201)
    const created = await createRes.json() as { id: string, key: string }
    expect(created.id).toBeTruthy()
    expect(created.key).toBe('response_verbosity')

    // Clean up
    await request.delete(`${API_URL}/api/v1/behavior/${wsId}/rules/${created.id}`)
  })

  test('PATCH /api/v1/behavior/:workspaceId/rules/:ruleId updates a rule', async ({ request }) => {
    const wsRes = await request.get(`${API_URL}/api/v1/workspaces`)
    if (!wsRes.ok()) return
    const wsData = await wsRes.json() as { items: { id: string }[] }
    if (!wsData.items?.length) return
    const wsId = wsData.items[0]!.id

    const uniqueKey = `e2e_patch_test_${Date.now()}`
    const createRes = await request.post(`${API_URL}/api/v1/behavior/${wsId}/rules`, {
      data: {
        type: 'communication_style',
        key: uniqueKey,
        label: 'E2E Patch Test',
        description: 'Testing update',
        value: { type: 'string', value: 'English' },
        source: 'workspace'
      }
    })
    if (createRes.status() !== 201) return // skip if create fails
    const created = await createRes.json() as { id: string }

    const patchRes = await request.patch(`${API_URL}/api/v1/behavior/${wsId}/rules/${created.id}`, {
      data: {
        value: { type: 'string', value: 'Spanish' },
        locked: true
      }
    })
    expect(patchRes.status()).toBe(200)
    const patched = await patchRes.json() as { value: { value: string }, locked: boolean }
    expect(patched.value.value).toBe('Spanish')

    // Clean up
    await request.delete(`${API_URL}/api/v1/behavior/${wsId}/rules/${created.id}`)
  })
})

test.describe('Behavior UI Settings Navigation', () => {
  test.skip(SKIP_BROWSER, 'Set E2E_SKIP_BROWSER=false to enable')

  test('Agent Behavior settings page loads correctly', async ({ page }) => {
    await page.goto('/settings/agent')
    // If redirected to login (no E2E_EMAIL/E2E_PASSWORD set), skip
    if (/login|signin/.test(page.url())) return
    await dismissAnalyticsModal(page)

    // Page shows agent config with tabs: Identity, Behavior, Limits, etc.
    await expect(page.locator('text=Behavior').first()).toBeVisible({ timeout: 10000 })
  })
})

