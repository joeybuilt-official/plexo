// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Sentry webhook → Plexo task
 *
 * Sentry sends a POST for every new issue (or regression).
 * We create an `ops` task so an agent can investigate and push a fix.
 *
 * Setup in Sentry:
 *   Settings → Integrations → Webhooks → add https://APP_DOMAIN/api/v1/webhooks/sentry
 *   Trigger: "Issue" events (new issue, regression)
 *   Secret: value of SENTRY_WEBHOOK_SECRET env var (used for HMAC-SHA256 verification)
 */
import express, { Router, type Router as RouterType } from 'express'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { push } from '@plexo/queue'
import { db } from '@plexo/db'
import { workspaces } from '@plexo/db'
import { logger } from '../logger.js'
import { emitToWorkspace } from '../sse-emitter.js'

export const sentryWebhookRouter: RouterType = Router()


const SENTRY_WEBHOOK_SECRET = process.env.SENTRY_WEBHOOK_SECRET

// ── Verify Sentry HMAC-SHA256 signature ──────────────────────────────────────

function verifySignature(body: string, header: string | undefined): boolean {
    if (!SENTRY_WEBHOOK_SECRET) {
        // If no secret configured, skip verification (warn once)
        logger.warn('SENTRY_WEBHOOK_SECRET not set — skipping signature verification')
        return true
    }
    if (!header) return false
    const expected = createHmac('sha256', SENTRY_WEBHOOK_SECRET)
        .update(body, 'utf8')
        .digest('hex')
    try {
        return timingSafeEqual(Buffer.from(header), Buffer.from(expected))
    } catch {
        return false
    }
}

// ── GET default workspace ─────────────────────────────────────────────────────

async function getDefaultWorkspaceId(): Promise<string | null> {
    const workspaceId = process.env.DEFAULT_WORKSPACE_ID
    if (workspaceId) return workspaceId
    try {
        const [ws] = await db.select({ id: workspaces.id }).from(workspaces).limit(1)
        return ws?.id ?? null
    } catch {
        return null
    }
}

// ── POST /api/v1/webhooks/sentry ──────────────────────────────────────────────

sentryWebhookRouter.post('/sentry', express.raw({ type: 'application/json' }), async (req, res) => {
    const rawBody = req.body instanceof Buffer ? req.body.toString('utf8') : JSON.stringify(req.body)
    const sig = req.headers['sentry-hook-signature'] as string | undefined

    if (!verifySignature(rawBody, sig)) {
        logger.warn({ sig }, 'Sentry webhook: invalid signature')
        res.status(401).json({ error: 'Invalid signature' })
        return
    }

    let payload: SentryWebhookPayload
    try {
        payload = JSON.parse(rawBody) as SentryWebhookPayload
    } catch {
        res.status(400).json({ error: 'Invalid JSON' })
        return
    }

    // Only handle new issues and regressions
    const { action, data } = payload
    if (action !== 'created' && action !== 'regression') {
        res.json({ ok: true, skipped: true })
        return
    }

    const issue = data?.issue
    if (!issue) {
        res.status(400).json({ error: 'Missing issue in payload' })
        return
    }

    const workspaceId = await getDefaultWorkspaceId()
    if (!workspaceId) {
        logger.error('Sentry webhook: no workspace found')
        res.status(500).json({ error: 'No workspace configured' })
        return
    }

    const isRegression = action === 'regression'
    const label = isRegression ? 'Regression' : 'New error'
    const level = issue.level ?? 'error'

    const taskRequest = [
        `${label} detected by Sentry [${level.toUpperCase()}]: ${issue.title}`,
        '',
        issue.culprit ? `Culprit: ${issue.culprit}` : '',
        issue.permalink ? `Sentry issue: ${issue.permalink}` : '',
        '',
        'Investigate this error, identify the root cause in the Plexo codebase, and push a fix.',
        'If the fix is straightforward, open a PR. If it needs more context, add a comment to the Sentry issue.',
    ].filter(Boolean).join('\n')

    try {
        const taskId = await push({
            workspaceId,
            type: 'ops',
            source: 'sentry' as Parameters<typeof push>[0]['source'],
            context: {
                request: taskRequest,
                sentryIssueId: issue.id,
                sentryIssueUrl: issue.permalink,
                sentryLevel: level,
                sentryTitle: issue.title,
                sentryCulprit: issue.culprit,
                isRegression,
            },
            priority: isRegression ? 9 : level === 'fatal' ? 10 : 7,
        })

        emitToWorkspace(workspaceId, {
            type: 'task_queued',
            taskId,
            source: 'sentry',
            meta: { sentryIssueId: issue.id, level, isRegression },
        })

        logger.info({ taskId, sentryIssueId: issue.id, action, level }, 'Sentry webhook: task created')
        res.status(201).json({ ok: true, taskId })
    } catch (err) {
        logger.error({ err }, 'Sentry webhook: failed to create task')
        res.status(500).json({ error: 'Failed to create task' })
    }
})

// ── Types ─────────────────────────────────────────────────────────────────────

interface SentryWebhookPayload {
    action: 'created' | 'regression' | 'resolved' | 'assigned' | 'ignored'
    data: {
        issue?: {
            id: string
            title: string
            culprit?: string
            permalink?: string
            level?: 'fatal' | 'error' | 'warning' | 'info' | 'debug'
            status?: string
            project?: { slug: string; name: string }
        }
    }
    installation?: { uuid: string }
}
