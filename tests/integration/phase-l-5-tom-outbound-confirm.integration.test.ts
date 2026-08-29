// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Phase L5 integration test — Tom's outbound CONFIRM blocker (07-DEFERRED.md #8).
 *
 * Tom: a workspace agent asked to send email/SMS must hit CONFIRM before the
 * outbound tool fires, regardless of `requireApprovalForGeneralTasks` and
 * regardless of whether the planner LLM tagged the step as a one-way door.
 *
 * This file pins fix-A only: brand-new workspaces created via the same path
 * the dashboard uses (Better Auth signup → POST /api/v1/workspaces) carry
 * `requireApprovalForGeneralTasks: true` in `workspaces.settings` (the column
 * `loadWorkspaceApprovalPolicy` actually reads from — see ADR 0006 §D1
 * Stage 3 critical correction: original placement in intelligenceSettings was
 * a no-op for the policy gate).
 *
 * Fix-B (deterministic OWD elevation for outbound tools, even when the policy
 * is OFF) is asserted by the unit suite at
 * `packages/agent/src/__tests__/elevate-outbound-owd.test.ts` — pure-function
 * tests on `elevateOutboundOneWayDoors` from `@plexo/agent/one-way-door`.
 *
 * Harness mirrors `phase-h-signup-flow.integration.test.ts`: real Better Auth
 * pool, real DB writes via the workspaces router, no SQL workarounds.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import express, { type Request, type Response, type NextFunction } from 'express'
import type { AddressInfo } from 'node:net'
import { Pool } from 'pg'
import type { Auth } from 'better-auth'
import { createPlexoBetterAuth } from '@plexo/auth/config'
import { requireBetterAuth } from '../../apps/api/src/middleware/better-auth.js'
import { workspacesRouter } from '../../apps/api/src/routes/workspaces.js'

const TEST_PASSWORD = 'Phase-L5-Test-Password-1234!'
const BASE_URL = 'http://localhost:9877'
const TRUSTED_ORIGINS = ['http://localhost:9877']

let webAuth: Auth
let webPool: Pool
let server: import('node:http').Server
let baseUrl: string
const createdEmails: string[] = []
const createdWorkspaceIds: string[] = []

function uniqueEmail(label: string): string {
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
    const email = `phase-l5-test+${label}-${suffix}@plexo.test`
    createdEmails.push(email)
    return email
}

function extractSessionCookie(headers: Headers): string {
    const setCookies =
        typeof (headers as unknown as { getSetCookie?: () => string[] }).getSetCookie === 'function'
            ? (headers as unknown as { getSetCookie: () => string[] }).getSetCookie()
            : (headers.get('set-cookie') ?? '').split(/,(?=[^;]+=)/g)
    const sessionCookies = setCookies
        .map((line) => line.split(';')[0])
        .filter((kv) => kv.startsWith('better-auth.session_token=') || kv.startsWith('better-auth.session_data='))
    if (sessionCookies.length === 0) {
        throw new Error(`No better-auth session cookie in Set-Cookie: ${JSON.stringify(setCookies)}`)
    }
    return sessionCookies.join('; ')
}

beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must be set')
    process.env.AUTH_DATABASE_URL ??= process.env.DATABASE_URL
    process.env.AUTH_SECRET ??= 'test-secret-32-bytes-aaaaaaaaaaaaaaaa'

    webPool = new Pool({ connectionString: process.env.AUTH_DATABASE_URL })
    webPool.on('connect', (client: { query: (sql: string) => Promise<unknown> }) => {
        client.query('SET search_path TO auth').catch(() => {})
    })

    webAuth = createPlexoBetterAuth({
        pool: webPool,
        secret: process.env.AUTH_SECRET!,
        baseURL: BASE_URL,
        trustedOrigins: TRUSTED_ORIGINS,
        secureCookies: false,
    })

    const app = express()
    app.use(express.json({ limit: '1mb' }))
    app.use(requireBetterAuth)
    app.use('/api/v1/workspaces', workspacesRouter)

    app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
        res.status(500).json({ error: { code: 'TEST_HARNESS_ERROR', message: err.message } })
    })

    server = app.listen(0)
    await new Promise<void>((resolve) => server.once('listening', resolve))
    const addr = server.address() as AddressInfo
    baseUrl = `http://127.0.0.1:${addr.port}`
})

afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))

    const cleanup = new Pool({ connectionString: process.env.AUTH_DATABASE_URL })
    try {
        if (createdWorkspaceIds.length > 0) {
            await cleanup.query(`DELETE FROM workspace_members WHERE workspace_id = ANY($1::uuid[])`, [createdWorkspaceIds])
            await cleanup.query(`DELETE FROM workspaces WHERE id = ANY($1::uuid[])`, [createdWorkspaceIds])
        }
        if (createdEmails.length > 0) {
            await cleanup.query(
                `DELETE FROM auth."session" WHERE "userId" IN (SELECT id FROM auth."user" WHERE email = ANY($1::text[]))`,
                [createdEmails],
            )
            await cleanup.query(
                `DELETE FROM auth."account" WHERE "userId" IN (SELECT id FROM auth."user" WHERE email = ANY($1::text[]))`,
                [createdEmails],
            )
            await cleanup.query(`DELETE FROM auth."user" WHERE email = ANY($1::text[])`, [createdEmails])
        }
    } finally {
        await cleanup.end()
    }
    if (webPool) await webPool.end()
})

// ── L5b: executor-side mid-stream guard (ADR 0006 §D5) ───────────────────
// Pins the contract that the wrap helper produced by L5b is importable from
// the agent package and refuses to invoke an uncovered outbound tool. Full
// executor-driven integration (real LLM emitting an uncovered tool call mid-
// task) would require the executor-side LLM stub that Phase K explicitly
// scoped out (plan.md:106 — "Executor generateText is OUT OF SCOPE — separate
// stub needed for full task execution"). When that stub lands, extend this
// file with a case that exercises the wrap inside executeTask end-to-end.

describe('Phase L5b — executor-side approval guard refuses uncovered outbound calls', () => {
    it('throws when the LLM-emitted tool call has no covering OWD in plan.oneWayDoors[]', async () => {
        const requestApprovalMock = vi.fn().mockResolvedValue({ id: 'owd-l5b-int-1', decision: 'pending' })
        const waitForDecisionMock = vi.fn().mockResolvedValue('rejected')
        // approval-guard.ts imports from '../one-way-door.js' (relative), not
        // the '@plexo/agent/one-way-door' package specifier — mock the same
        // specifier it actually resolves so the mock binds to its import.
        vi.doMock('../../packages/agent/src/one-way-door.js', async () => {
            const actual = await vi.importActual<typeof import('../../packages/agent/src/one-way-door.js')>(
                '../../packages/agent/src/one-way-door.js',
            )
            return { ...actual, requestApproval: requestApprovalMock, waitForDecision: waitForDecisionMock }
        })

        const { wrapOutboundToolsWithApprovalGuard } = await import(
            '../../packages/agent/src/connections/approval-guard.js'
        )
        const send = vi.fn(async () => 'must-not-fire')
        const wrapped = wrapOutboundToolsWithApprovalGuard(
            { gmail__send_email: { description: 'Send email', inputSchema: {}, execute: send } as unknown as Parameters<typeof wrapOutboundToolsWithApprovalGuard>[0][string] },
            { plan: { oneWayDoors: [] }, taskId: 'task-l5b-int', workspaceId: 'ws-l5b-int' },
        )

        const exec = (wrapped.gmail__send_email as unknown as { execute: (input: unknown) => Promise<string> }).execute
        await expect(exec({ to: 'tom@example.com' })).rejects.toThrow(/decision=rejected/)
        expect(send).not.toHaveBeenCalled()
        expect(requestApprovalMock).toHaveBeenCalledWith(
            expect.objectContaining({ operation: 'gmail__send_email', riskLevel: 'high' }),
        )

        vi.doUnmock('../../packages/agent/src/one-way-door.js')
    })
})

describe('Phase L5 — Tom outbound CONFIRM (fix-A: new-workspace policy default)', () => {
    it('a fresh workspace created via the dashboard signup path has requireApprovalForGeneralTasks=true', async () => {
        // ── Step 1: Brand-new user signs up via Better Auth ──────────────
        const email = uniqueEmail('policy-default')
        const signUp = (await webAuth.api.signUpEmail({
            body: { email, password: TEST_PASSWORD, name: 'Phase L5 Test' },
            returnHeaders: true,
        })) as { headers: Headers; response: { user: { id: string; email: string } } }

        expect(signUp.response.user.email).toBe(email)
        const cookieHeader = extractSessionCookie(signUp.headers)

        // ── Step 2: Create a workspace via the same router the dashboard uses
        const wsRes = await fetch(`${baseUrl}/api/v1/workspaces`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', cookie: cookieHeader },
            body: JSON.stringify({ name: 'Phase L5 Tom Outbound Test' }),
        })
        if (wsRes.status !== 201) {
            const body = await wsRes.text()
            throw new Error(`workspace POST expected 201, got ${wsRes.status}: ${body}`)
        }
        const wsBody = (await wsRes.json()) as { id: string }
        expect(wsBody.id).toBeTruthy()
        createdWorkspaceIds.push(wsBody.id)

        // ── Step 3: Read settings + intelligence_settings back from the row ──
        // L5 fix-A: every freshly-created workspace must carry
        //   workspaces.settings = DEFAULT_WORKSPACE_SETTINGS = { requireApprovalForGeneralTasks: true }
        //   workspaces.intelligence_settings = DEFAULT_INTELLIGENCE_SETTINGS = { firstRunPending: true }
        // Read the columns directly — workspace GET projections redact them,
        // and loadWorkspaceApprovalPolicy reads workspaces.settings (NOT
        // intelligence_settings) — see ADR 0006 §D1 Stage 3 correction.
        const row = await webPool.query(
            'SELECT settings, intelligence_settings FROM public.workspaces WHERE id = $1::uuid',
            [wsBody.id],
        )
        expect(row.rowCount).toBe(1)
        const settings = row.rows[0].settings as Record<string, unknown>
        const intelligenceSettings = row.rows[0].intelligence_settings as Record<string, unknown>
        expect(settings).toBeTruthy()
        expect(settings.requireApprovalForGeneralTasks).toBe(true)
        expect(intelligenceSettings).toBeTruthy()
        expect(intelligenceSettings.firstRunPending).toBe(true)
    })
})
