// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Phase E integration tests — ENABLE_SPRINT_CODING_TASKS gate (#7).
 *
 * Pins the beta safety flag that gates sprint coding tasks:
 *   - POST /api/sprints with category='code' is 503'd when the flag is off.
 *   - POST /api/sprints/:id/run on a code sprint is 503'd when the flag is off.
 *   - POST /api/sprints/:id/retry on a code sprint is 503'd when the flag is off.
 *   - Non-code categories are never gated by this flag.
 *   - The runner (packages/agent/src/sprint/runner.ts) defends in depth: if a
 *     code sprint somehow reaches it with the flag off, it marks the sprint
 *     failed, logs SPRINT_CODING_DISABLED, and rejects.
 *   - Only the literal string 'true' enables; '', 'TRUE', 'false', unset → off.
 *
 * Runs against the dev postgres at DATABASE_URL.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach } from 'vitest'
import express, { type Express, type Request, type Response, type NextFunction } from 'express'
import type { AddressInfo } from 'node:net'
import { randomUUID, randomBytes } from 'node:crypto'
import { db, sprints, sprintLogs, workspaces } from '@plexo/db'
import { sql, eq } from 'drizzle-orm'
import { sprintsRouter } from '../../apps/api/src/routes/sprints.js'
import { sprintRunnerRouter } from '../../apps/api/src/routes/sprint-runner.js'
import { runSprint } from '../../packages/agent/src/sprint/runner.js'

const createdSprintIds: string[] = []
const createdWorkspaceIds: string[] = []
const createdUserIds: string[] = []

let server: import('node:http').Server
let baseUrl: string
const ORIGINAL_FLAG = process.env.ENABLE_SPRINT_CODING_TASKS

async function createUser(): Promise<string> {
    const id = randomUUID()
    const email = `phase-e-${id}@example.test`
    // The live users table is uuid; mirror Phase C/D's raw-cast workaround
    // for the schema.ts text/uuid drift on users.id.
    await db.execute(sql`
        INSERT INTO users (id, email, role, "createdAt")
        VALUES (${id}::uuid, ${email}, 'member'::user_role, NOW())
    `)
    createdUserIds.push(id)
    return id
}

async function createWorkspace(): Promise<string> {
    const ownerId = await createUser()
    const [row] = await db.insert(workspaces).values({
        name: `phase-e-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
        ownerId,
    }).returning({ id: workspaces.id })
    if (!row) throw new Error('failed to create workspace')
    createdWorkspaceIds.push(row.id)
    return row.id
}

async function insertSprint(params: {
    workspaceId: string
    category: string
    repo?: string | null
    status?: 'planning' | 'running' | 'complete' | 'failed' | 'cancelled' | 'finalizing'
    request?: string
}): Promise<string> {
    // Sprints.id is plain text in the schema; any short unique token works.
    const id = `phase-e-${randomBytes(8).toString('hex')}`
    await db.insert(sprints).values({
        id,
        workspaceId: params.workspaceId,
        repo: params.repo ?? null,
        request: params.request ?? 'phase-e seeded sprint',
        category: params.category,
        status: params.status ?? 'planning',
    })
    createdSprintIds.push(id)
    return id
}

beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must be set')

    const app: Express = express()
    app.use(express.json())
    // Test-only auth shim: mark every request as a super-admin so
    // ensureWorkspaceAccess in workspace-access.ts short-circuits without
    // having to mint a Better Auth session for this gate-only suite.
    app.use((req: Request, _res: Response, next: NextFunction) => {
        req.user = { id: 'phase-e-tester', isSuperAdmin: true } as Request['user']
        next()
    })
    app.use('/api/sprints', sprintsRouter)
    app.use('/api/sprints', sprintRunnerRouter)

    server = app.listen(0)
    await new Promise<void>((resolve) => server.once('listening', resolve))
    const addr = server.address() as AddressInfo
    baseUrl = `http://127.0.0.1:${addr.port}`
})

beforeEach(() => {
    // Default each test to flag-off; tests that need it on flip it themselves.
    delete process.env.ENABLE_SPRINT_CODING_TASKS
})

afterEach(async () => {
    if (createdSprintIds.length > 0) {
        for (const id of createdSprintIds) {
            await db.delete(sprintLogs).where(eq(sprintLogs.sprintId, id))
            await db.delete(sprints).where(eq(sprints.id, id))
        }
        createdSprintIds.length = 0
    }
    if (createdWorkspaceIds.length > 0) {
        for (const id of createdWorkspaceIds) {
            await db.delete(workspaces).where(eq(workspaces.id, id))
        }
        createdWorkspaceIds.length = 0
    }
    if (createdUserIds.length > 0) {
        for (const id of createdUserIds) {
            await db.execute(sql`DELETE FROM users WHERE id::text = ${id}`)
        }
        createdUserIds.length = 0
    }
})

afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
    if (ORIGINAL_FLAG === undefined) delete process.env.ENABLE_SPRINT_CODING_TASKS
    else process.env.ENABLE_SPRINT_CODING_TASKS = ORIGINAL_FLAG
})

describe('Phase E — ENABLE_SPRINT_CODING_TASKS gate', () => {
    describe('POST /api/sprints', () => {
        it('flag off → category=code returns 503 SPRINT_CODING_DISABLED', async () => {
            const workspaceId = await createWorkspace()

            const res = await fetch(`${baseUrl}/api/sprints`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    workspaceId,
                    repo: 'foo/bar',
                    request: 'add a feature',
                    category: 'code',
                }),
            })

            expect(res.status).toBe(503)
            const body = await res.json() as { error?: { code?: string; message?: string } }
            expect(body.error?.code).toBe('SPRINT_CODING_DISABLED')
            expect(typeof body.error?.message).toBe('string')
            expect(body.error?.message).toMatch(/ENABLE_SPRINT_CODING_TASKS/)
            expect(body.error?.message).toMatch(/docs\/operations\/sprint-coding-flag\.md/)
        })

        it('flag off → category=code with no repo STILL returns 503 (flag check fires before repo check)', async () => {
            const workspaceId = await createWorkspace()

            const res = await fetch(`${baseUrl}/api/sprints`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    workspaceId,
                    request: 'add a feature',
                    category: 'code',
                    // intentionally omit repo
                }),
            })

            expect(res.status).toBe(503)
            const body = await res.json() as { error?: { code?: string } }
            expect(body.error?.code).toBe('SPRINT_CODING_DISABLED')
        })

        it('flag off → category=research returns 201 (non-code is unaffected)', async () => {
            const workspaceId = await createWorkspace()

            const res = await fetch(`${baseUrl}/api/sprints`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    workspaceId,
                    request: 'survey the literature on X',
                    category: 'research',
                }),
            })

            expect(res.status).toBe(201)
            const body = await res.json() as { id: string; category: string }
            expect(body.category).toBe('research')
            // Track for cleanup
            createdSprintIds.push(body.id)
        })

        it('flag on → category=code with valid workspace + repo returns 201', async () => {
            process.env.ENABLE_SPRINT_CODING_TASKS = 'true'
            const workspaceId = await createWorkspace()

            const res = await fetch(`${baseUrl}/api/sprints`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    workspaceId,
                    repo: 'foo/bar',
                    request: 'add a feature',
                    category: 'code',
                }),
            })

            expect(res.status).toBe(201)
            const body = await res.json() as { id: string; category: string; repo: string }
            expect(body.category).toBe('code')
            expect(body.repo).toBe('foo/bar')
            createdSprintIds.push(body.id)
        })
    })

    describe('POST /api/sprints/:id/run', () => {
        it('flag off → 503 on a seeded code sprint', async () => {
            const workspaceId = await createWorkspace()
            const sprintId = await insertSprint({ workspaceId, category: 'code', repo: 'foo/bar' })

            const res = await fetch(`${baseUrl}/api/sprints/${sprintId}/run`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ workspaceId }),
            })

            expect(res.status).toBe(503)
            const body = await res.json() as { error?: { code?: string; message?: string } }
            expect(body.error?.code).toBe('SPRINT_CODING_DISABLED')
            expect(body.error?.message).toMatch(/ENABLE_SPRINT_CODING_TASKS/)
        })

        it('flag off → 404 still returned for missing sprint (sprint load runs before flag check)', async () => {
            const workspaceId = await createWorkspace()

            const res = await fetch(`${baseUrl}/api/sprints/01ABCDEFGHJKMNPQRSTVWXYZ00/run`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ workspaceId }),
            })

            expect(res.status).toBe(404)
            const body = await res.json() as { error?: { code?: string } }
            expect(body.error?.code).toBe('NOT_FOUND')
        })

        it('flag on → no longer 503; passes the flag gate on a code sprint', async () => {
            process.env.ENABLE_SPRINT_CODING_TASKS = 'true'
            const workspaceId = await createWorkspace()
            const sprintId = await insertSprint({ workspaceId, category: 'code', repo: 'foo/bar' })

            const res = await fetch(`${baseUrl}/api/sprints/${sprintId}/run`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ workspaceId }),
            })

            // With flag on we must NOT get the gate's 503. Downstream the
            // route then checks for an AI credential (this dev workspace
            // has none) and returns 402 NO_AI_CREDENTIAL — or 202 if a
            // workspace happens to be fully configured. Either is proof
            // that the flag gate let the request through.
            expect(res.status).not.toBe(503)
            const body = await res.json() as { error?: { code?: string } }
            expect(body.error?.code).not.toBe('SPRINT_CODING_DISABLED')
            // Sanity: it's one of the expected non-gate outcomes.
            expect([202, 402, 409]).toContain(res.status)
        })
    })

    describe('POST /api/sprints/:id/retry', () => {
        it('flag off → 503 on a seeded code sprint', async () => {
            const workspaceId = await createWorkspace()
            const sprintId = await insertSprint({
                workspaceId,
                category: 'code',
                repo: 'foo/bar',
                status: 'failed',
            })

            const res = await fetch(`${baseUrl}/api/sprints/${sprintId}/retry`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({}),
            })

            expect(res.status).toBe(503)
            const body = await res.json() as { error?: { code?: string; message?: string } }
            expect(body.error?.code).toBe('SPRINT_CODING_DISABLED')
            expect(body.error?.message).toMatch(/ENABLE_SPRINT_CODING_TASKS/)
        })
    })

    describe('flag-value semantics', () => {
        it('flag value "TRUE" (uppercase) is treated as off — only literal "true" enables', async () => {
            process.env.ENABLE_SPRINT_CODING_TASKS = 'TRUE'
            const workspaceId = await createWorkspace()

            const res = await fetch(`${baseUrl}/api/sprints`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    workspaceId,
                    repo: 'foo/bar',
                    request: 'add a feature',
                    category: 'code',
                }),
            })

            expect(res.status).toBe(503)
            const body = await res.json() as { error?: { code?: string } }
            expect(body.error?.code).toBe('SPRINT_CODING_DISABLED')
        })

        it('flag value "false" is treated as off', async () => {
            process.env.ENABLE_SPRINT_CODING_TASKS = 'false'
            const workspaceId = await createWorkspace()

            const res = await fetch(`${baseUrl}/api/sprints`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    workspaceId,
                    repo: 'foo/bar',
                    request: 'add a feature',
                    category: 'code',
                }),
            })

            expect(res.status).toBe(503)
        })

        it('503 envelope shape matches { error: { code, message } }', async () => {
            const workspaceId = await createWorkspace()

            const res = await fetch(`${baseUrl}/api/sprints`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    workspaceId,
                    repo: 'foo/bar',
                    request: 'add a feature',
                    category: 'code',
                }),
            })

            expect(res.status).toBe(503)
            const body = await res.json() as { error?: { code?: string; message?: string } }
            expect(body).toHaveProperty('error')
            expect(body.error).toHaveProperty('code')
            expect(body.error).toHaveProperty('message')
            expect(body.error?.code).toBe('SPRINT_CODING_DISABLED')
            expect(typeof body.error?.message).toBe('string')
            expect((body.error?.message ?? '').length).toBeGreaterThan(0)
        })
    })

    describe('defense-in-depth — runner refuses code sprints when flag is off', () => {
        it('runSprint() rejects, marks sprint failed, and writes a SPRINT_CODING_DISABLED log row', async () => {
            const workspaceId = await createWorkspace()
            const sprintId = await insertSprint({
                workspaceId,
                category: 'code',
                repo: 'foo/bar',
                status: 'planning',
            })

            // Flag is off (beforeEach unsets it). Calling runSprint directly
            // simulates a code sprint somehow reaching the runner.
            await expect(runSprint({
                sprintId,
                workspaceId,
                repo: 'foo/bar',
                category: 'code',
                request: 'should be refused',
            })).rejects.toThrow(/disabled/i)

            // Sprint row marked failed
            const [after] = await db.select({ status: sprints.status })
                .from(sprints).where(eq(sprints.id, sprintId)).limit(1)
            expect(after?.status).toBe('failed')

            // Log row with metadata.reason: 'SPRINT_CODING_DISABLED'
            const logs = await db.select().from(sprintLogs).where(eq(sprintLogs.sprintId, sprintId))
            const refusalLog = logs.find((l) =>
                l.event === 'sprint_failed' &&
                (l.metadata as Record<string, unknown> | null)?.reason === 'SPRINT_CODING_DISABLED'
            )
            expect(refusalLog).toBeDefined()
        })
    })
})
