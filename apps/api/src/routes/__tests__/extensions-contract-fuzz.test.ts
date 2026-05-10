// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Contract fuzz tests for the extensions (tools) router.
 *
 *   1. Missing required fields → 400, not 500
 *   2. Wrong types / invalid values → 400
 *   3. Oversized payloads → 413, not 500
 *   4. Invalid UUIDs → 400, not 500
 *   5. SSRF-probe URLs → 400 BLOCKED_URL (not a network error / 500)
 *   6. SQL injection probes → 400 (UUID regex) or 201/200 (freeform, parameterized)
 *   7. Every error has shape: { error: { code: string, message: string } }
 *
 * Routers under test: GET /, GET /:id, POST /, POST /sideload,
 *   POST /skill, POST /skill/validate, POST /skill/install-url,
 *   POST /invoke, PATCH /:id, PUT /:id/upgrade, DELETE /:id.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'

// ── Shared state ──────────────────────────────────────────────────────────────

const ctl = {
    authed: true,
    userId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    role: 'owner' as string,
    wsExists: true,
    extExists: true,
    dupCheck: false,    // true → simulate ALREADY_INSTALLED
    registryCatalog: false,
    validateOk: false,  // validateManifest valid flag
}

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('@plexo/db', () => {
    // Returns current extension data — read at query time so ctl changes take effect.
    const getData = () => ctl.extExists ? [{
        id: EXT_ID,
        workspaceId: WS,
        name: '@test/fuzz-ext',
        version: '1.0.0',
        pexVersion: '0.4.0',
        entry: 'index.js',
        type: 'tool',
        enabled: true,
        settings: {},
        manifest: {},
    }] : []

    const builder: any = {
        select: vi.fn(() => builder),
        from: vi.fn(() => builder),
        where: vi.fn(() => builder),
        orderBy: vi.fn(() => builder),
        // limit() is SYNC so the chain can continue with .offset()
        limit: vi.fn(() => builder),
        // offset() is the async terminal for paginated queries (.limit().offset())
        offset: vi.fn(async () => getData()),
    }
    // Make the builder thenable so `await db...limit(n)` works without .offset()
    builder.then = (resolve: (v: any[]) => void, reject?: (r: unknown) => void) => {
        Promise.resolve(getData()).then(resolve, reject)
    }
    const insertBuilder: any = {
        values: vi.fn(() => insertBuilder),
        onConflictDoNothing: vi.fn(() => insertBuilder),
        returning: vi.fn(async () => [{
            id: EXT_ID,
            workspaceId: WS,
            name: '@test/fuzz-ext',
            version: '1.0.0',
        }]),
    }
    const updateBuilder: any = {
        set: vi.fn(() => updateBuilder),
        where: vi.fn(async () => ({})),
    }
    const deleteBuilder: any = {
        where: vi.fn(async () => ({})),
    }
    return {
        db: {
            select: vi.fn(() => builder),
            insert: vi.fn(() => insertBuilder),
            update: vi.fn(() => updateBuilder),
            delete: vi.fn(() => deleteBuilder),
            transaction: vi.fn(async (fn: any) => {
                const txInsert: any = {
                    values: vi.fn(() => txInsert),
                    onConflictDoNothing: vi.fn(() => txInsert),
                    returning: vi.fn(async () => [{ id: EXT_ID, workspaceId: WS, name: '@test/fuzz-ext' }]),
                }
                return fn({ insert: vi.fn(() => txInsert) })
            }),
            execute: vi.fn(async () => ({})),
        },
        extensions: { id: 'id', workspaceId: 'workspace_id', name: 'name', enabled: 'enabled', entry: 'entry', version: 'version', type: 'type', installedAt: 'installed_at' },
        workspaces: { id: 'id' },
        extensionPrompts: {},
        extensionContexts: {},
        extensionRegistry: { name: 'name', manifest: 'manifest' },
        eq: vi.fn(),
        and: vi.fn(),
        sql: Object.assign(
            (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
            { join: vi.fn() },
        ),
    }
})

vi.mock('../../middleware/workspace-access.js', () => ({
    ensureWorkspaceAccess: vi.fn(async (req: any, _res: any, _id: string) => {
        req.workspaceRole = ctl.role
        return true
    }),
    requireWorkspaceMember: () => (_req: any, _res: any, next: any) => next(),
}))

vi.mock('@plexo/sdk', () => ({
    validateManifest: vi.fn((_manifest: unknown, _opts?: unknown) => {
        if (ctl.validateOk) return { valid: true, errors: [] }
        return {
            valid: false,
            errors: [{ field: 'name', message: 'name is required', severity: 'error' }],
        }
    }),
}))

vi.mock('@plexo/agent/persistent-pool', () => ({
    terminateWorker: vi.fn(),
    getWorker: vi.fn(),
    invokeTool: vi.fn(),
}))

vi.mock('@plexo/agent/skills/parser', () => ({
    parseSkillMd: vi.fn((_content: string) => ({
        frontmatter: { name: '@test/skill', version: '1.0.0', type: 'skill' },
        markdownBody: '# Test',
        isSkillPlus: false,
    })),
    synthesizeManifest: vi.fn(() => ({
        name: '@test/skill',
        version: '1.0.0',
        type: 'skill',
        entry: 'index.js',
        plexo: '0.4.0',
        description: 'Test skill',
        author: 'test',
        license: 'MIT',
        displayName: 'Test Skill',
        capabilities: [],
    })),
}))

vi.mock('@plexo/agent/tool-set-cache', () => ({
    invalidateWorkspaceToolSets: vi.fn(),
}))

vi.mock('../../logger.js', () => ({
    logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}))
vi.mock('../../audit.js', () => ({ audit: vi.fn() }))
vi.mock('../../analytics/events.js', () => ({ emitExtensionInstalled: vi.fn() }))

// ── Constants ─────────────────────────────────────────────────────────────────

const WS = 'cccccccc-cccc-cccc-cccc-cccccccccccc'
const EXT_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd'
const DROP_TABLE = "'; DROP TABLE extensions--"
const OR_INJECTION = '" OR "1"="1'

// ── Server helpers ────────────────────────────────────────────────────────────

let server: Server | null = null
let baseUrl: string

async function ensureServer() {
    if (server) return
    const { extensionsRouter } = await import('../extensions.js')
    const app = express()
    app.use(express.json({ limit: '1mb' }))
    app.use((req: any, _res, next) => {
        if (ctl.authed) req.user = { id: ctl.userId, isSuperAdmin: false }
        next()
    })
    app.use('/api/extensions', extensionsRouter)
    server = app.listen(0)
    await new Promise<void>(r => server!.once('listening', r))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

beforeEach(() => {
    ctl.authed = true
    ctl.role = 'owner'
    ctl.wsExists = true
    ctl.extExists = true
    ctl.dupCheck = false
    ctl.registryCatalog = false
    ctl.validateOk = false
    delete process.env.ALLOW_SIDELOAD
    vi.clearAllMocks()
})

afterAll(() => { server?.close() })

// ── Assertion helper ──────────────────────────────────────────────────────────

function assertErrorShape(body: unknown) {
    const b = body as any
    expect(b.error, 'error must be an object, not a bare string').toBeTypeOf('object')
    expect(b.error, 'error must not be null').not.toBeNull()
    expect(typeof b.error.code, 'error.code must be a string').toBe('string')
    expect(b.error.code.length, 'error.code must be non-empty').toBeGreaterThan(0)
    expect(typeof b.error.message, 'error.message must be a string').toBe('string')
    expect(b.error.message.length, 'error.message must be non-empty').toBeGreaterThan(0)
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Missing required fields → 400, not 500
// ─────────────────────────────────────────────────────────────────────────────

describe('missing required fields → 400, not 500', () => {
    it('GET /api/extensions — no workspaceId → 400 MISSING_WORKSPACE', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/extensions`)
        expect(res.status).toBe(400)
        const body = await res.json() as any
        assertErrorShape(body)
        expect(body.error.code).toBe('MISSING_WORKSPACE')
    })

    it('POST /api/extensions — no workspaceId → 400 MISSING_WORKSPACE', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/extensions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ manifest: {} }),
        })
        expect(res.status).toBe(400)
        const body = await res.json() as any
        assertErrorShape(body)
        expect(body.error.code).toBe('MISSING_WORKSPACE')
    })

    it('POST /api/extensions — workspaceId present, no manifest → 400 INVALID_MANIFEST', async () => {
        await ensureServer()
        // validateManifest returns invalid (default ctl.validateOk = false)
        const res = await fetch(`${baseUrl}/api/extensions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceId: WS }),
        })
        expect(res.status).toBe(400)
        const body = await res.json() as any
        assertErrorShape(body)
        expect(body.error.code).toBe('INVALID_MANIFEST')
    })

    it('POST /api/extensions/sideload — ALLOW_SIDELOAD not set → 403 SIDELOAD_DISABLED', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/extensions/sideload`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceId: WS, manifest: {}, consent: true }),
        })
        expect(res.status).toBe(403)
        const body = await res.json() as any
        assertErrorShape(body)
        expect(body.error.code).toBe('SIDELOAD_DISABLED')
    })

    it('POST /api/extensions/sideload — no consent → 400 CONSENT_REQUIRED', async () => {
        process.env.ALLOW_SIDELOAD = 'true'
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/extensions/sideload`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceId: WS, manifest: {} }),
        })
        expect(res.status).toBe(400)
        const body = await res.json() as any
        assertErrorShape(body)
        expect(body.error.code).toBe('CONSENT_REQUIRED')
    })

    it('POST /api/extensions/sideload — consent: false → 400 CONSENT_REQUIRED', async () => {
        process.env.ALLOW_SIDELOAD = 'true'
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/extensions/sideload`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceId: WS, manifest: {}, consent: false }),
        })
        expect(res.status).toBe(400)
        assertErrorShape(await res.json())
    })

    it('POST /api/extensions/skill — no content → 400 MISSING_CONTENT', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/extensions/skill`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceId: WS }),
        })
        expect(res.status).toBe(400)
        const body = await res.json() as any
        assertErrorShape(body)
        expect(body.error.code).toBe('MISSING_CONTENT')
    })

    it('POST /api/extensions/skill/validate — no content → 400 MISSING_CONTENT', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/extensions/skill/validate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        })
        expect(res.status).toBe(400)
        const body = await res.json() as any
        assertErrorShape(body)
        expect(body.error.code).toBe('MISSING_CONTENT')
    })

    it('POST /api/extensions/skill/install-url — no url → 400 MISSING_URL', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/extensions/skill/install-url`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceId: WS }),
        })
        expect(res.status).toBe(400)
        const body = await res.json() as any
        assertErrorShape(body)
        expect(body.error.code).toBe('MISSING_URL')
    })

    it('POST /api/extensions/invoke — missing workspaceId → 400 MISSING_FIELDS', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/extensions/invoke`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ extensionName: 'test', toolName: 'run' }),
        })
        expect(res.status).toBe(400)
        const body = await res.json() as any
        assertErrorShape(body)
        expect(body.error.code).toBe('MISSING_FIELDS')
    })

    it('POST /api/extensions/invoke — missing toolName → 400 MISSING_FIELDS', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/extensions/invoke`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceId: WS, extensionName: 'test' }),
        })
        expect(res.status).toBe(400)
        assertErrorShape(await res.json())
    })

    it('POST /api/extensions/invoke — completely empty body → 400 MISSING_FIELDS', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/extensions/invoke`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        })
        expect(res.status).toBe(400)
        assertErrorShape(await res.json())
    })

    it('PATCH /api/extensions/:id — no workspaceId → 400 MISSING_WORKSPACE', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/extensions/${EXT_ID}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled: true }),
        })
        expect(res.status).toBe(400)
        const body = await res.json() as any
        assertErrorShape(body)
        expect(body.error.code).toBe('MISSING_WORKSPACE')
    })

    it('PATCH /api/extensions/:id — no enabled or settings → 400 NOTHING_TO_UPDATE', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/extensions/${EXT_ID}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceId: WS }),
        })
        expect(res.status).toBe(400)
        const body = await res.json() as any
        assertErrorShape(body)
        expect(body.error.code).toBe('NOTHING_TO_UPDATE')
    })

    it('DELETE /api/extensions/:id — no workspaceId → 400 MISSING_WORKSPACE', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/extensions/${EXT_ID}`, { method: 'DELETE' })
        expect(res.status).toBe(400)
        const body = await res.json() as any
        assertErrorShape(body)
        expect(body.error.code).toBe('MISSING_WORKSPACE')
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. Invalid UUIDs → 400, not 500
// ─────────────────────────────────────────────────────────────────────────────

describe('invalid UUID → 400, not 500', () => {
    it('GET /api/extensions — non-UUID workspaceId → 400 INVALID_WORKSPACE', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/extensions?workspaceId=not-a-uuid`)
        expect(res.status).toBe(400)
        const body = await res.json() as any
        assertErrorShape(body)
        expect(body.error.code).toBe('INVALID_WORKSPACE')
    })

    it('GET /api/extensions — numeric workspaceId → 400 INVALID_WORKSPACE', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/extensions?workspaceId=12345`)
        expect(res.status).toBe(400)
        assertErrorShape(await res.json())
    })

    it('GET /api/extensions/:id — non-UUID id → 400 INVALID_ID', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/extensions/not-a-uuid`)
        expect(res.status).toBe(400)
        const body = await res.json() as any
        assertErrorShape(body)
        expect(body.error.code).toBe('INVALID_ID')
    })

    it('POST /api/extensions — non-UUID workspaceId → 400 INVALID_WORKSPACE', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/extensions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceId: 'not-a-uuid', manifest: {} }),
        })
        expect(res.status).toBe(400)
        const body = await res.json() as any
        assertErrorShape(body)
        expect(body.error.code).toBe('INVALID_WORKSPACE')
    })

    it('PATCH /api/extensions/:id — non-UUID extension id → 400 INVALID_ID', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/extensions/not-a-uuid`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceId: WS, enabled: true }),
        })
        expect(res.status).toBe(400)
        const body = await res.json() as any
        assertErrorShape(body)
        expect(body.error.code).toBe('INVALID_ID')
    })

    it('DELETE /api/extensions/:id — non-UUID extension id → 400 INVALID_ID', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/extensions/not-a-uuid?workspaceId=${WS}`, { method: 'DELETE' })
        expect(res.status).toBe(400)
        const body = await res.json() as any
        assertErrorShape(body)
        expect(body.error.code).toBe('INVALID_ID')
    })

    it('PUT /api/extensions/:id/upgrade — non-UUID id → 400 INVALID_ID', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/extensions/not-a-uuid/upgrade`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceId: WS }),
        })
        expect(res.status).toBe(400)
        const body = await res.json() as any
        assertErrorShape(body)
        expect(body.error.code).toBe('INVALID_ID')
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. SSRF probe URLs → 400 BLOCKED_URL
// ─────────────────────────────────────────────────────────────────────────────

describe('SSRF probe URLs → 400 BLOCKED_URL, not 500 or network error', () => {
    it('HTTP (not HTTPS) URL → 400 BLOCKED_URL', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/extensions/skill/install-url`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceId: WS, url: 'http://example.com/SKILL.md' }),
        })
        expect(res.status).toBe(400)
        const body = await res.json() as any
        assertErrorShape(body)
        expect(body.error.code).toBe('BLOCKED_URL')
    })

    it('localhost URL → 400 BLOCKED_URL', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/extensions/skill/install-url`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceId: WS, url: 'https://localhost/SKILL.md' }),
        })
        expect(res.status).toBe(400)
        const body = await res.json() as any
        assertErrorShape(body)
        expect(body.error.code).toBe('BLOCKED_URL')
    })

    it('RFC-1918 10.x.x.x → 400 BLOCKED_URL', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/extensions/skill/install-url`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceId: WS, url: 'https://10.0.0.1/SKILL.md' }),
        })
        expect(res.status).toBe(400)
        assertErrorShape(await res.json())
    })

    it('RFC-1918 192.168.x.x → 400 BLOCKED_URL', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/extensions/skill/install-url`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceId: WS, url: 'https://192.168.1.1/SKILL.md' }),
        })
        expect(res.status).toBe(400)
        assertErrorShape(await res.json())
    })

    it('AWS IMDS 169.254.169.254 → 400 BLOCKED_URL', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/extensions/skill/install-url`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceId: WS, url: 'https://169.254.169.254/latest/meta-data/SKILL.md' }),
        })
        expect(res.status).toBe(400)
        assertErrorShape(await res.json())
    })

    it('IPv6 loopback [::1] → 400 BLOCKED_URL', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/extensions/skill/install-url`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceId: WS, url: 'https://[::1]/SKILL.md' }),
        })
        expect(res.status).toBe(400)
        assertErrorShape(await res.json())
    })

    it('totally invalid URL string → 400 BLOCKED_URL', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/extensions/skill/install-url`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceId: WS, url: 'not-a-url-at-all' }),
        })
        expect(res.status).toBe(400)
        assertErrorShape(await res.json())
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. Oversized payloads → 413, not 500
// ─────────────────────────────────────────────────────────────────────────────

describe('oversized payload → 413, not 500', () => {
    it('POST /api/extensions — body exceeds 1 MB → 413', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/extensions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceId: WS, manifest: { data: 'x'.repeat(1_200_000) } }),
        })
        expect(res.status).toBe(413)
    })

    it('POST /api/extensions/skill — oversized content → 413', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/extensions/skill`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceId: WS, content: '#'.repeat(1_200_000) }),
        })
        expect(res.status).toBe(413)
    })

    it('PATCH /api/extensions/:id — oversized settings → 413', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/extensions/${EXT_ID}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceId: WS, settings: { blob: 'y'.repeat(1_200_000) } }),
        })
        expect(res.status).toBe(413)
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// 5. SQL injection probes → not a crash
// ─────────────────────────────────────────────────────────────────────────────

describe('SQL injection probes → not a crash', () => {
    it('GET — injection in workspaceId query param → 400 (UUID regex blocks it)', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/extensions?workspaceId=${encodeURIComponent(DROP_TABLE)}`)
        expect(res.status).toBe(400)
    })

    it('GET — OR-injection in workspaceId → 400', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/extensions?workspaceId=${encodeURIComponent(OR_INJECTION)}`)
        expect(res.status).toBe(400)
    })

    it('PATCH — injection in extension id path param → 400 (UUID regex blocks it)', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/extensions/${encodeURIComponent(DROP_TABLE)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceId: WS, enabled: true }),
        })
        expect(res.status).toBe(400)
    })

    it('DELETE — injection in id path param → 400 (UUID regex blocks it)', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/extensions/${encodeURIComponent(OR_INJECTION)}?workspaceId=${WS}`, { method: 'DELETE' })
        expect(res.status).toBe(400)
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// 6. Empty arrays / omitted optional fields → handled gracefully
// ─────────────────────────────────────────────────────────────────────────────

describe('empty / omitted optional fields → handled gracefully', () => {
    it('GET /api/extensions — valid workspaceId, no extensions → 200 empty list', async () => {
        ctl.extExists = false
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/extensions?workspaceId=${WS}`)
        expect(res.status).toBe(200)
        const body = await res.json() as any
        expect(body.items).toEqual([])
        expect(body.total).toBe(0)
    })

    it('POST /api/extensions/skill — valid content, no skillPath → 201', async () => {
        ctl.validateOk = true
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/extensions/skill`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceId: WS, content: '# Test skill\n\nDoes something.' }),
        })
        expect(res.status).toBe(201)
    })
})

// ─────────────────────────────────────────────────────────────────────────────
// 7. Every error response has { error: { code: string, message: string } }
// ─────────────────────────────────────────────────────────────────────────────

describe('error response shape: { error: { code, message } }', () => {
    it('GET no workspaceId → structured 400', async () => {
        await ensureServer()
        assertErrorShape(await (await fetch(`${baseUrl}/api/extensions`)).json())
    })

    it('GET invalid UUID → structured 400', async () => {
        await ensureServer()
        assertErrorShape(await (await fetch(`${baseUrl}/api/extensions?workspaceId=bad`)).json())
    })

    it('GET /:id non-UUID → structured 400', async () => {
        await ensureServer()
        assertErrorShape(await (await fetch(`${baseUrl}/api/extensions/bad-id`)).json())
    })

    it('POST no workspaceId → structured 400', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/extensions`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
        })
        assertErrorShape(await res.json())
    })

    it('POST sideload disabled → structured 403', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/extensions/sideload`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspaceId: WS }),
        })
        assertErrorShape(await res.json())
    })

    it('POST skill no content → structured 400', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/extensions/skill`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspaceId: WS }),
        })
        assertErrorShape(await res.json())
    })

    it('POST install-url SSRF → structured 400', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/extensions/skill/install-url`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceId: WS, url: 'http://localhost/evil' }),
        })
        assertErrorShape(await res.json())
    })

    it('PATCH non-UUID id → structured 400', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/extensions/bad-id`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspaceId: WS }),
        })
        assertErrorShape(await res.json())
    })

    it('DELETE non-UUID id → structured 400', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/extensions/bad-id?workspaceId=${WS}`, { method: 'DELETE' })
        assertErrorShape(await res.json())
    })

    it('POST invoke missing fields → structured 400', async () => {
        await ensureServer()
        const res = await fetch(`${baseUrl}/api/extensions/invoke`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
        })
        assertErrorShape(await res.json())
    })
})
