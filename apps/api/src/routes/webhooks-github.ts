// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * GitHub Webhook Receiver
 *
 * POST /api/v1/webhooks/github/:workspaceId
 *
 * Verifies X-Hub-Signature-256 on the RAW request body (Buffer).
 * Maps push / pull_request / issues / issue_comment → executor tasks.
 * Secret: PLEXO_GITHUB_WEBHOOK_SECRET env var (returns 501 if unset).
 */
import { Router, type Router as RouterType } from 'express'
import express from 'express'
import * as crypto from 'crypto'
import { timingSafeEqual } from 'crypto'
import { push } from '@plexo/queue'
import * as workspacesRepo from '../repositories/workspaces.repository.js'
import * as connectionsRepo from '../repositories/connections.repository.js'
import { logger } from '../logger.js'

export const githubWebhooksRouter: RouterType = Router()

// ── POST /api/v1/webhooks/github/:workspaceId ───────────────────────────────

githubWebhooksRouter.post(
    '/:workspaceId',
    express.raw({ type: 'application/json', limit: '2mb' }),
    async (req: express.Request, res: express.Response) => {
        // 1. Guard: secret must be configured
        const secret = process.env.PLEXO_GITHUB_WEBHOOK_SECRET
        if (!secret) {
            res.status(501).json({ error: { code: 'NOT_CONFIGURED' } })
            return
        }

        // 2. HMAC verification on raw bytes
        const sigHeader = req.headers['x-hub-signature-256'] as string | undefined
        if (!sigHeader) {
            res.status(401).json({ error: { code: 'MISSING_SIGNATURE', message: 'Missing X-Hub-Signature-256 header' } })
            return
        }

        const expected = 'sha256=' + crypto
            .createHmac('sha256', secret)
            .update(req.body as Buffer)
            .digest('hex')

        const sigBuf = Buffer.from(sigHeader)
        const expBuf = Buffer.from(expected)
        if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
            res.status(401).json({ error: { code: 'INVALID_SIGNATURE', message: 'Invalid signature' } })
            return
        }

        // 3. Parse after verification
        const payload = JSON.parse((req.body as Buffer).toString('utf8')) as Record<string, unknown>

        // 4. Workspace lookup
        const workspaceId = req.params.workspaceId as string
        try {
            const ws = await workspacesRepo.getIdById(workspaceId)

            if (!ws) {
                res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Workspace not found' } })
                return
            }
        } catch (err) {
            logger.error({ err, workspaceId }, 'POST /webhooks/github/:workspaceId workspace lookup failed')
            res.status(400).json({ error: { code: 'INVALID_ID', message: 'Invalid workspace ID' } })
            return
        }

        // 5. Event dispatch
        const event = req.headers['x-github-event'] as string | undefined

        let context: Record<string, unknown>

        switch (event) {
            case 'push': {
                const repo = (payload.repository as Record<string, unknown> | undefined)?.full_name as string | undefined
                const branch = ((payload.ref as string | undefined) ?? '').replace('refs/heads/', '')
                const commits = (payload.commits as unknown[] | undefined)?.length ?? 0
                const pusher = (payload.pusher as Record<string, unknown> | undefined)?.name as string | undefined
                const headCommit = ((payload.head_commit as Record<string, unknown> | undefined)?.message as string | undefined)?.slice(0, 200)
                const userMessage = `Push to ${branch}: ${headCommit ?? commits + ' commit(s)'}`
                context = { githubEvent: 'push', repo, branch, commits, pusher, headCommit, userMessage }
                break
            }

            case 'pull_request': {
                const action = payload.action as string | undefined
                const repo = (payload.repository as Record<string, unknown> | undefined)?.full_name as string | undefined
                const pr = payload.pull_request as Record<string, unknown> | undefined
                const prNumber = pr?.number as number | undefined
                const prTitle = pr?.title as string | undefined
                const prUrl = pr?.html_url as string | undefined
                // Phase D critic: opened/synchronize → fetch GitHub connector for the workspace
                // so agent-loop's fail-closed gate (cron/github → deny-all) grants access.
                const isCriticEvent = action === 'opened' || action === 'synchronize'
                let criticConnectorIds: string[] | undefined
                if (isCriticEvent) {
                    try {
                        const connRows = await connectionsRepo.listActiveConnectionIds(workspaceId, 'github')
                        criticConnectorIds = connRows.map(r => r.id)
                    } catch {
                        // non-fatal — task will be dispatched but with deny-all connectors
                    }
                }
                const userMessage = isCriticEvent
                    ? `Review PR #${prNumber} for correctness and style. Fetch the diff with github__get_pr_files, identify issues, then post a review with github__create_pr_review. PR: ${prTitle} (${prUrl})`
                    : `PR #${prNumber} ${action}: ${prTitle}`
                context = {
                    githubEvent: 'pull_request',
                    action,
                    repo,
                    prNumber,
                    prTitle,
                    prUrl,
                    userMessage,
                    ...(criticConnectorIds ? { connectorIds: criticConnectorIds } : {}),
                }
                break
            }

            case 'issues': {
                const action = payload.action as string | undefined
                const repo = (payload.repository as Record<string, unknown> | undefined)?.full_name as string | undefined
                const issue = payload.issue as Record<string, unknown> | undefined
                const issueNumber = issue?.number as number | undefined
                const issueTitle = issue?.title as string | undefined
                const issueBody = (issue?.body as string | undefined)?.slice(0, 500)
                const issueUrl = issue?.html_url as string | undefined
                const userMessage = `Issue #${issueNumber} ${action}: ${issueTitle}`
                context = { githubEvent: 'issues', action, repo, issueNumber, issueTitle, issueBody, issueUrl, userMessage }
                break
            }

            case 'issue_comment': {
                const action = payload.action as string | undefined
                const repo = (payload.repository as Record<string, unknown> | undefined)?.full_name as string | undefined
                const issue = payload.issue as Record<string, unknown> | undefined
                const issueNumber = issue?.number as number | undefined
                const comment = payload.comment as Record<string, unknown> | undefined
                const commentBody = comment?.body as string | undefined
                const commentUrl = comment?.html_url as string | undefined
                const userMessage = `Comment on #${issueNumber}: ${commentBody?.slice(0, 100)}`
                context = { githubEvent: 'issue_comment', action, repo, issueNumber, comment: commentBody?.slice(0, 500), commentUrl, userMessage }
                break
            }

            default:
                res.status(202).json({ status: 'ignored', event })
                return
        }

        // 6. Enqueue task
        try {
            const taskId = await push({
                workspaceId,
                type: 'general',
                source: 'github',
                context,
            })

            logger.info({ taskId, workspaceId, source: 'github', event }, 'GitHub webhook task created')
            res.status(201).json({ taskId, status: 'queued' })
        } catch (err) {
            logger.error({ err, workspaceId, event }, 'POST /webhooks/github/:workspaceId task push failed')
            res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to create task' } })
        }
    },
)
