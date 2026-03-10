/**
 * Agent Behavior Configuration API (Phase 5) integration tests.
 *
 * API tests run against localhost:3001 (always available in dev).
 */
import { test, expect } from '@playwright/test'

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
    const rulesBody = await rulesRes.json() as { items: Array<unknown> }
    expect(Array.isArray(rulesBody.items)).toBe(true)

    const groupsRes = await request.get(`${API_URL}/api/v1/behavior/${wsId}/groups`)
    expect(groupsRes.status()).toBe(200)
    const groupsBody = await groupsRes.json() as { items: Array<unknown> }
    expect(Array.isArray(groupsBody.items)).toBe(true)
    expect(groupsBody.items.length).toBeGreaterThan(0)
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

    const createRes = await request.post(`${API_URL}/api/v1/behavior/${wsId}/rules`, {
      data: {
        type: 'communication_style',
        key: 'agent_language',
        label: 'Agent Language',
        description: 'Testing update',
        value: { type: 'string', value: 'English' },
        source: 'workspace'
      }
    })
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
    expect(patched.locked).toBe(true)

    // Clean up
    await request.delete(`${API_URL}/api/v1/behavior/${wsId}/rules/${created.id}`)
  })
})

test.describe('Behavior UI Settings Navigation', () => {
  test.skip(SKIP_BROWSER, 'Set E2E_SKIP_BROWSER=false to enable')

  test('Agent Behavior settings page loads correctly', async ({ page }) => {
    await page.goto('/settings/agent')
    // Check if the page contains a specific heading or element for Agent Behavior
    await expect(page.getByRole('heading', { name: /Agent Behavior/i })).toBeVisible()
    
    // Check if the scope navigation tabs logic works
    const workspaceTab = page.getByRole('tab', { name: /Workspace/i })
    if (await workspaceTab.isVisible()) {
      await workspaceTab.click()
      await expect(workspaceTab).toHaveAttribute('data-state', 'active')
    }
  })
})

