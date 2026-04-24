// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * App-Transport Chat API (Levio-Pex Phase 4)
 *
 * POST /api/v1/chat/app-message
 *
 * Enables external apps (e.g. Levio) to send chat messages through Plexo's
 * AI pipeline without running a worker adapter. This is the transport
 * endpoint for channel extensions with `channelTransport: 'api'`.
 *
 * Auth: PLEXO_SERVICE_KEY (Bearer + X-App-Id) OR Better Auth session.
 * The service key path resolves the user from X-User-Id header.
 */

import { Router, type Router as RouterType } from 'express'
import { db, eq } from '@plexo/db'
import { workspaces } from '@plexo/db'
import { ulid } from 'ulid'
import { logger } from '../logger.js'
import { generateText } from 'ai'
import { withFallback } from '@plexo/agent/providers/registry'
import { loadWorkspaceAISettings } from '../agent-loop.js'
import {
    recordConversation,
    getSessionTurns,
    type ChannelRef,
} from '../conversation-log.js'
import {
    resolveSessionId as resolveUniversalSession,
    embedMessage as embedSessionMessage,
} from '../lib/session-resolver.js'
import { buildConversationSystemPrompt } from '../channel-ai.js'
import { UUID_RE } from '../validation.js'
import { requireServiceKey } from '../middleware/service-key-auth.js'
import { emitToWorkspace } from '../sse-emitter.js'
import type { FallbackOptions } from '@plexo/agent/providers/registry'
import type { Request, Response } from 'express'

export const chatAppTransportRouter: RouterType = Router()

// ── Per-session mutex ────────────────────────────────────────────────────────
const sessionLocks = new Map<string, Promise<void>>()

function withSessionLock<T>(sessionKey: string, fn: () => Promise<T>): Promise<T> {
    const prev = sessionLocks.get(sessionKey) ?? Promise.resolve()
    let resolve: () => void
    const current = new Promise<void>(r => { resolve = r })
    sessionLocks.set(sessionKey, current)
    return prev.then(() => fn()).finally(() => {
        resolve!()
        if (sessionLocks.get(sessionKey) === current) {
            sessionLocks.delete(sessionKey)
        }
    })
}

function fallbackOpts(workspaceId: string): FallbackOptions {
    return {
        workspaceId,
        onAuthFailure: (provider, error) => {
            logger.warn({ workspaceId, provider, error }, 'Provider auth failed — removed from fallback chain')
            emitToWorkspace(workspaceId, {
                type: 'provider_auth_error',
                provider,
                message: `API key for "${provider}" is invalid or expired. Update it in Settings > AI Providers.`,
            })
        },
    }
}

// ── Auth: service key OR session ─────────────────────────────────────────────

/**
 * Middleware that accepts EITHER a valid service key (Bearer + X-App-Id)
 * OR a Better Auth session. Populates req.serviceContext for service-key
 * callers; session callers already have req.user.
 */
function requireServiceKeyOrSession(req: Request, res: Response, next: () => void): void {
    const authHeader = req.headers.authorization
    if (authHeader?.startsWith('Bearer ')) {
        // Attempt service key auth
        return requireServiceKey(req, res, next)
    }
    // Fall through to session auth — req.user populated by auth middleware
    if (req.user?.id) {
        return next()
    }
    res.status(401).json({
        error: { code: 'UNAUTHORIZED', message: 'Service key (Bearer + X-App-Id) or session required' },
    })
}

// ── Body types ───────────────────────────────────────────────────────────────

interface AppMessageBody {
    workspaceId: string
    channelRef: {
        channel: string
        appId: string
        threadId: string
    }
    message: string
    sessionContext?: {
        activeView?: {
            type: string
            id: string
            summary: string
            metadata?: Record<string, unknown>
        }
        appState?: Record<string, unknown>
    }
}

// ── POST /app-message ────────────────────────────────────────────────────────

chatAppTransportRouter.post('/app-message', requireServiceKeyOrSession, async (req: Request, res: Response) => {
    const body = req.body as AppMessageBody

    // ── Validate ─────────────────────────────────────────────────────────────
    const { workspaceId, channelRef, message, sessionContext } = body

    if (!workspaceId || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE', message: 'Valid workspaceId required' } })
        return
    }
    if (!channelRef?.channel || !channelRef.appId || !channelRef.threadId) {
        res.status(400).json({ error: { code: 'INVALID_CHANNEL_REF', message: 'channelRef requires channel, appId, and threadId' } })
        return
    }
    const trimmedMsg = (message ?? '').trim()
    if (!trimmedMsg) {
        res.status(400).json({ error: { code: 'MISSING_MESSAGE', message: 'message is required' } })
        return
    }
    if (trimmedMsg.length > 100_000) {
        res.status(400).json({ error: { code: 'MESSAGE_TOO_LONG', message: 'Max 100,000 characters' } })
        return
    }

    // ── Resolve user ─────────────────────────────────────────────────────────
    // Service key callers provide userId via X-User-Id header.
    // Session callers have req.user.id.
    const userId = req.serviceContext?.userId ?? req.user?.id
    if (!userId) {
        res.status(400).json({
            error: { code: 'MISSING_USER', message: 'Service key calls require X-User-Id header' },
        })
        return
    }

    // Session-anchor key: deterministic per app + thread
    const sessionAnchor = `${channelRef.channel}:${channelRef.appId}:${channelRef.threadId}`
    const lockKey = `${workspaceId}:${sessionAnchor}`

    await withSessionLock(lockKey, async () => {
        try {
            // ── Load workspace + AI settings ─────────────────────────────────
            const [wsResult, aiResult] = await Promise.all([
                db.select({ id: workspaces.id, name: workspaces.name, settings: workspaces.settings })
                    .from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1),
                loadWorkspaceAISettings(workspaceId),
            ])

            const [ws] = wsResult
            if (!ws) {
                res.status(404).json({ error: { code: 'WORKSPACE_NOT_FOUND', message: 'Workspace not found' } })
                return
            }

            const { credential, aiSettings } = aiResult
            if (!credential || !aiSettings) {
                res.status(503).json({ error: { code: 'NO_AI_PROVIDER', message: 'No AI provider configured' } })
                return
            }

            const providerKey = aiSettings.primaryProvider
            const config = aiSettings.providers[providerKey]
            if (!config) {
                res.status(503).json({ error: { code: 'NO_AI_PROVIDER', message: `No config for provider ${providerKey}` } })
                return
            }

            // ── Session resolution ───────────────────────────────────────────
            let sessionId: string
            let messageEmbedding: number[] | null = null
            try {
                const resolved = await resolveUniversalSession({
                    workspaceId,
                    channel: 'api',
                    channelThreadId: sessionAnchor,
                    newMessage: trimmedMsg,
                })
                sessionId = resolved.sessionId
                messageEmbedding = resolved.newMessageEmbedding
                if (resolved.isNewSession) {
                    logger.info({ workspaceId, sessionAnchor, sessionId, reason: resolved.reason }, 'app-transport: new session')
                }
            } catch (err) {
                logger.warn({ err, sessionAnchor }, 'app-transport: session resolver failed, using anchor')
                sessionId = sessionAnchor
                try {
                    messageEmbedding = await embedSessionMessage(workspaceId, trimmedMsg)
                } catch { /* non-fatal */ }
            }

            // ── Load conversation history ────────────────────────────────────
            const dbTurns = await getSessionTurns(workspaceId, sessionId, 30)

            type HistoryMessage = { role: 'user'; content: string } | { role: 'assistant'; content: string }
            const history: HistoryMessage[] = []
            for (const t of dbTurns) {
                if (t.message) history.push({ role: 'user', content: t.message })
                if (t.reply) history.push({ role: 'assistant', content: t.reply })
            }

            // ── Build system prompt ──────────────────────────────────────────
            let extraContext = ''
            if (sessionContext?.activeView?.summary) {
                extraContext += `\n\n=== ACTIVE VIEW CONTEXT ===\nThe user is currently viewing: ${sessionContext.activeView.type} (id: ${sessionContext.activeView.id})\nSummary: ${sessionContext.activeView.summary}\n=== END ACTIVE VIEW ===`
            }
            if (sessionContext?.appState && Object.keys(sessionContext.appState).length > 0) {
                extraContext += `\n\n=== APP STATE ===\n${JSON.stringify(sessionContext.appState)}\n=== END APP STATE ===`
            }

            const systemPrompt = buildConversationSystemPrompt(channelRef.channel, extraContext || undefined)

            // ── AI call ──────────────────────────────────────────────────────
            const messages = [
                ...history,
                { role: 'user' as const, content: trimmedMsg },
            ]

            // Check for SSE streaming request
            const wantsStream = req.headers.accept === 'text/event-stream'

            if (wantsStream) {
                res.setHeader('Content-Type', 'text/event-stream')
                res.setHeader('Cache-Control', 'no-cache')
                res.setHeader('Connection', 'keep-alive')
                res.flushHeaders()

                try {
                    const { streamText } = await import('ai')
                    const conversationId = ulid()

                    const convChannelRef: ChannelRef = {
                        channel: channelRef.channel,
                        channelId: channelRef.appId,
                        chatId: channelRef.threadId,
                    }

                    let fullText = ''
                    const result = await withFallback(aiSettings, 'conversation', async (model) =>
                        streamText({
                            model,
                            system: systemPrompt,
                            messages,
                            abortSignal: AbortSignal.timeout(120_000),
                        }),
                        fallbackOpts(workspaceId),
                    )

                    for await (const chunk of result.textStream) {
                        fullText += chunk
                        res.write(`data: ${JSON.stringify({ type: 'text', text: chunk })}\n\n`)
                    }

                    // Record conversation
                    void recordConversation({
                        workspaceId,
                        sessionId,
                        source: channelRef.channel,
                        message: trimmedMsg,
                        reply: fullText,
                        status: 'complete',
                        intent: 'CONVERSATION',
                        channelRef: convChannelRef,
                        messageEmbedding,
                    }).catch(err => logger.warn({ err }, 'app-transport: recordConversation failed'))

                    // Send final event with metadata
                    res.write(`data: ${JSON.stringify({
                        type: 'done',
                        conversationId,
                        sessionId,
                    })}\n\n`)
                    res.end()
                } catch (err) {
                    logger.error({ err, workspaceId }, 'app-transport: SSE stream failed')
                    res.write(`data: ${JSON.stringify({ type: 'error', message: 'Stream failed' })}\n\n`)
                    res.end()
                }
                return
            }

            // Non-streaming path
            const aiResult2 = await withFallback(aiSettings, 'conversation', async (model) =>
                generateText({
                    model,
                    system: systemPrompt,
                    messages,
                    abortSignal: AbortSignal.timeout(120_000),
                }),
                fallbackOpts(workspaceId),
            )

            const replyText = (aiResult2.text ?? '').trim()

            const convChannelRef: ChannelRef = {
                channel: channelRef.channel,
                channelId: channelRef.appId,
                chatId: channelRef.threadId,
            }

            // Record conversation turn
            const conversationId = await recordConversation({
                workspaceId,
                sessionId,
                source: channelRef.channel,
                message: trimmedMsg,
                reply: replyText,
                status: 'complete',
                intent: 'CONVERSATION',
                channelRef: convChannelRef,
                messageEmbedding,
            })

            logger.info({ workspaceId, conversationId, sessionId, channel: channelRef.channel }, 'app-transport: reply sent')

            res.json({
                reply: replyText,
                conversationId,
                sessionId,
            })
        } catch (err) {
            logger.error({ err, workspaceId }, 'app-transport: request failed')
            const message = err instanceof Error ? err.message : 'Internal error'
            res.status(500).json({ error: { code: 'INTERNAL_ERROR', message } })
        }
    })
})
