// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Slack channel adapter.
 *
 * Architecture:
 * - Receives events via Events API webhook (URL verification + event handling)
 * - App mentions and DMs create tasks in the queue
 * - Replies to the original thread when task is queued
 * - Uses Slack's block kit for structured replies
 *
 * Setup:
 * - Set SLACK_BOT_TOKEN (xoxb-...) and SLACK_SIGNING_SECRET env vars
 * - Webhook URL: ${PUBLIC_URL}/api/channels/slack/events
 * - Required OAuth scopes: app_mentions:read, chat:write, im:history, im:read
 */
import { Router, type Router as RouterType, type Request, type Response } from 'express'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { push as pushTask } from '@plexo/queue'
import { logger } from '../logger.js'
import { trackEvent } from '../event-tracker.js'
import { emitToWorkspace } from '../sse-emitter.js'
import { recordConversation, type ChannelRef } from '../conversation-log.js'
import { resolveSessionId } from '../lib/session-resolver.js'
import { chatWithAI, classifyIntent, ChannelChatHistory, buildConversationSystemPrompt, translateErrorForUser, TASK_SUGGEST_HINT } from '../channel-ai.js'
import { detectCredentialMessage, autoInstallConnection } from '../credential-setup.js'
import { trackDelivery } from '../delivery-tracker.js'
import { maybeReact } from '@plexo/agent/channels/reaction-manager'
import { hasInstructionIntent, persistInstruction, extractConversationMemory } from '@plexo/agent/memory/conversation-bridge'
import { sanitizeForSlack } from '../lib/telegram-sanitize.js'

export const slackRouter: RouterType = Router()

const BOT_TOKEN = process.env.SLACK_BOT_TOKEN
const SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET

// ── Slack signature verification ─────────────────────────────────────────────

function verifySlackSignature(req: Request): boolean {
    if (!SIGNING_SECRET) return false
    const timestamp = req.headers['x-slack-request-timestamp'] as string
    const signature = req.headers['x-slack-signature'] as string
    if (!timestamp || !signature) return false

    // Reject requests older than 5 minutes to prevent replay attacks
    if (Math.abs(Date.now() / 1000 - parseInt(timestamp, 10)) > 300) return false

    const rawBody = JSON.stringify(req.body)
    const sigBase = `v0:${timestamp}:${rawBody}`
    const expected = 'v0=' + createHmac('sha256', SIGNING_SECRET).update(sigBase).digest('hex')

    try {
        return timingSafeEqual(Buffer.from(expected), Buffer.from(signature))
    } catch {
        return false
    }
}

// ── Workspace resolver ───────────────────────────────────────────────────────

const TEAM_TO_WORKSPACE = new Map<string, string>()

export function registerSlackTeam(teamId: string, workspaceId: string): void {
    TEAM_TO_WORKSPACE.set(teamId, workspaceId)
}

function resolveWorkspace(teamId: string): string | null {
    return TEAM_TO_WORKSPACE.get(teamId) ?? process.env.DEFAULT_WORKSPACE_ID ?? null
}

// ── Slack API helpers ─────────────────────────────────────────────────────────

async function postMessage(channel: string, text: string, threadTs?: string, trackingCtx?: { workspaceId: string }): Promise<void> {
    if (!BOT_TOKEN) return
    if (!text || !text.trim()) {
        logger.warn({ channel }, 'Slack postMessage called with empty text — skipping')
        if (trackingCtx) trackDelivery({ workspaceId: trackingCtx.workspaceId, channel: 'slack', chatId: channel, status: 'empty_response', messageLength: 0 })
        return
    }
    const start = Date.now()
    // Phase 5: rewrite standard markdown into Slack's mrkdwn dialect so
    // `**bold**` doesn't leak as literal asterisks and links render as
    // Slack's <url|label> form.
    const sanitized = sanitizeForSlack(text)
    if (!sanitized.trim()) return
    try {
        const res = await fetch('https://slack.com/api/chat.postMessage', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${BOT_TOKEN}`,
            },
            body: JSON.stringify({
                channel,
                text: sanitized,
                ...(threadTs ? { thread_ts: threadTs } : {}),
            }),
        })
        const ok = res.ok
        if (trackingCtx) trackDelivery({ workspaceId: trackingCtx.workspaceId, channel: 'slack', chatId: channel, status: ok ? 'sent' : 'failed', messageLength: sanitized.length, latencyMs: Date.now() - start, errorMessage: ok ? null : `HTTP ${res.status}` })
    } catch (err: unknown) {
        logger.warn({ err }, 'Slack postMessage failed')
        if (trackingCtx) trackDelivery({ workspaceId: trackingCtx.workspaceId, channel: 'slack', chatId: channel, status: 'failed', messageLength: sanitized.length, latencyMs: Date.now() - start, errorMessage: (err as Error).message })
    }
}

// ── Chat history (shared helper from channel-ai.ts) ────────────────────────

const chatHistory = new ChannelChatHistory()

/**
 * Universal session resolution for a Slack thread.
 *
 * Routes through the shared session resolver, which decides whether to
 * continue the existing session or start a new one based on time gap,
 * explicit break phrases, task completion, and topic change.
 */
async function slackResolveSession(
    workspaceId: string,
    teamId: string,
    channel: string,
    threadTs: string,
    text: string,
    userId?: string | null,
): Promise<{ sessionId: string; embedding: number[] | null; isNew: boolean; reason: string }> {
    const channelThreadId = `${teamId}:${channel}:${threadTs}`
    try {
        const r = await resolveSessionId({
            workspaceId,
            channel: 'slack',
            channelThreadId,
            userId: userId ?? null,
            newMessage: text,
        })
        return { sessionId: r.sessionId, embedding: r.newMessageEmbedding, isNew: r.isNewSession, reason: r.reason }
    } catch (err) {
        logger.warn({ err, channelThreadId }, 'slack: session resolver failed, falling back to stable id')
        return {
            sessionId: `slack:${channelThreadId}:${Date.now()}`,
            embedding: null,
            isNew: true,
            reason: 'resolver_error',
        }
    }
}

/**
 * Backwards-compatible shim — returns just the sessionId.
 * Used by error paths where we don't also need the embedding.
 */
async function slackSessionId(
    workspaceId: string,
    teamId: string,
    channel: string,
    threadTs: string,
    text = '[slack event]',
): Promise<string> {
    const r = await slackResolveSession(workspaceId, teamId, channel, threadTs, text)
    return r.sessionId
}

// ── Event types ───────────────────────────────────────────────────────────────

interface SlackEvent {
    type: string
    text?: string
    user?: string
    channel?: string
    channel_type?: string
    ts?: string
    thread_ts?: string
    bot_id?: string
    subtype?: string
    files?: Array<{
        id: string
        name: string
        mimetype: string
        url_private: string
    }>
}

interface SlackPayload {
    type: string
    challenge?: string
    team_id?: string
    event?: SlackEvent
}

// ── POST /api/channels/slack/events ──────────────────────────────────────────

slackRouter.post('/events', async (req: Request, res: Response) => {
    // 1. Verify signature on ALL requests (including url_verification — Slack signs those too)
    if (!verifySlackSignature(req)) {
        logger.warn('Slack signature verification failed')
        res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Invalid signature' } })
        return
    }

    // 2. URL verification challenge (Slack sends this when you first configure the webhook)
    const payload = req.body as SlackPayload
    if (payload.type === 'url_verification') {
        res.json({ challenge: payload.challenge })
        return
    }

    // 3. Acknowledge immediately — Slack requires <3s response
    res.json({ ok: true })

    const event = payload.event
    if (!event) return

    // 4. Ignore bot messages and message edits
    if (event.bot_id || event.subtype) return

    // 5. Handle: app_mention (in channels) and message.im (direct messages)
    const isDirectMessage = event.channel_type === 'im' && event.type === 'message'
    const isMention = event.type === 'app_mention'
    if (!isDirectMessage && !isMention) return

    const teamId = payload.team_id ?? ''
    const workspaceId = resolveWorkspace(teamId)

    if (!workspaceId) {
        logger.warn({ teamId }, 'Slack message from unregistered team — ignored')
        if (event.channel) {
            await postMessage(
                event.channel,
                'This Slack workspace is not connected to Plexo yet. Connect it in Settings.',
                event.ts,
            )
        }
        return
    }

    // ── Handle Voice / Audio Files ──────────────────────────────────────────
    const audioFile = event.files?.find(f => f.mimetype.startsWith('audio/'))
    if (audioFile && !event.text) {
        if (!BOT_TOKEN) return

        try {
            // Check voice settings first
            const apiBase = `http://localhost:${process.env.PORT ?? 3001}`
            const settingsRes = await fetch(`${apiBase}/api/v1/voice/settings?workspaceId=${workspaceId}`, {
                signal: AbortSignal.timeout(5000),
            }).catch((err) => { logger.warn({ err, workspaceId }, 'Voice settings fetch failed'); return null })
            const voiceSettings = settingsRes?.ok ? await settingsRes.json() as { configured: boolean } : null

            if (!voiceSettings?.configured) {
                const errorReply = '🎙️ I received your audio file, but voice transcription is not set up.\n\n' +
                    'Go to *Settings → Voice* in your Plexo dashboard to add your Deepgram key.'
                if (event.channel) {
                    await postMessage(event.channel, errorReply, event.ts)
                }
                const { sessionId } = await slackResolveSession(workspaceId, teamId, event.channel ?? '', event.thread_ts ?? event.ts ?? '', '[audio file]', event.user)
                const channelRef: ChannelRef = { channel: 'slack', channelId: event.channel ?? '', chatId: event.user ?? '' }
                await recordConversation({
                    workspaceId,
                    sessionId,
                    source: 'slack',
                    message: '[audio file]',
                    reply: errorReply,
                    status: 'failed',
                    errorMsg: 'Voice transcription not configured',
                    intent: 'TASK',
                    channelRef,
                }).catch((err: Error) => logger.warn({ err }, 'Failed to record Slack voice-not-configured conversation'))
                return
            }

            // Download file from Slack
            const fileRes = await fetch(audioFile.url_private, {
                headers: { Authorization: `Bearer ${BOT_TOKEN}` },
                signal: AbortSignal.timeout(30_000),
            })
            if (!fileRes.ok) throw new Error(`Slack file download failed: ${fileRes.status}`)
            
            const audioBuffer = Buffer.from(await fileRes.arrayBuffer())

            // Transcribe
            const transcribeRes = await fetch(`${apiBase}/api/v1/voice/transcribe?workspaceId=${workspaceId}`, {
                method: 'POST',
                headers: { 'Content-Type': audioFile.mimetype },
                body: audioBuffer,
                signal: AbortSignal.timeout(35_000),
            })

            if (!transcribeRes.ok) {
                const errorData = await transcribeRes.json().catch(() => ({})) as { error?: { message: string } }
                throw new Error(errorData.error?.message || `Transcribe API Error ${transcribeRes.status}`)
            }

            const { transcript } = await transcribeRes.json() as { transcript: string }
            if (!transcript?.trim()) {
                const emptyReply = '🎙️ I received your audio, but couldn\'t hear anything clear. Please try again.'
                if (event.channel) {
                    await postMessage(event.channel, emptyReply, event.ts)
                }
                const { sessionId } = await slackResolveSession(workspaceId, teamId, event.channel ?? '', event.thread_ts ?? event.ts ?? '', '[audio file]', event.user)
                const channelRef: ChannelRef = { channel: 'slack', channelId: event.channel ?? '', chatId: event.user ?? '' }
                await recordConversation({
                    workspaceId,
                    sessionId,
                    source: 'slack',
                    message: '[audio file]',
                    reply: emptyReply,
                    status: 'failed',
                    errorMsg: 'Empty transcript from audio',
                    intent: 'TASK',
                    channelRef,
                }).catch((err: Error) => logger.warn({ err }, 'Failed to record Slack empty-transcript conversation'))
                return
            }

            logger.info({ workspaceId, channel: event.channel, chars: transcript.length }, 'Slack audio transcribed')

            // Re-invoke the handler with the transcript as text
            req.body.event.text = transcript
            // Recursion is messy for Express handlers, but we can just continue with the resolved text
            event.text = transcript
        } catch (err) {
            logger.error({ err, workspaceId, channel: event.channel }, 'Slack transcription failed')
            trackEvent('channel.error', 'error', { channel: 'slack', error: 'transcription_failed', workspaceId })
            const errMsg = err instanceof Error ? err.message.toLowerCase() : ''
            const detail = errMsg.includes('timeout') || errMsg.includes('etimedout')
                ? 'Transcription service timed out.'
                : errMsg.includes('401') || errMsg.includes('api key')
                ? 'Deepgram API key issue — check Settings → Voice.'
                : errMsg.includes('econnrefused') || errMsg.includes('fetch failed')
                ? 'Could not reach the transcription service.'
                : 'Transcription failed unexpectedly.'
            const transcribeErrorReply = `Could not process that audio — ${detail} Try text instead.`
            if (event.channel) {
                await postMessage(event.channel, transcribeErrorReply, event.ts)
            }
            const { sessionId } = await slackResolveSession(workspaceId, teamId, event.channel ?? '', event.thread_ts ?? event.ts ?? '', '[audio file]', event.user)
            const channelRef: ChannelRef = { channel: 'slack', channelId: event.channel ?? '', chatId: event.user ?? '' }
            await recordConversation({
                workspaceId,
                sessionId,
                source: 'slack',
                message: '[audio file]',
                reply: transcribeErrorReply,
                status: 'failed',
                errorMsg: 'Audio transcription failed',
                intent: 'TASK',
                channelRef,
            }).catch((err: Error) => logger.warn({ err }, 'Failed to record Slack transcription-error conversation'))
            return
        }
    }

    // ── Handle Image Files ──────────────────────────────────────────────────
    // Download any image attachments from Slack (bot-token-protected) and
    // re-upload to workspace storage so the vision LLM can fetch them
    // anonymously. The resulting signed URLs are passed down the conversation
    // history + task context.
    const imageUrls: string[] = []
    try {
        const imageFiles = (event.files ?? []).filter(f => f.mimetype?.startsWith('image/'))
        if (imageFiles.length > 0 && BOT_TOKEN) {
            const { uploadContent } = await import('@plexo/storage')
            for (const file of imageFiles) {
                try {
                    const fileRes = await fetch(file.url_private, {
                        headers: { Authorization: `Bearer ${BOT_TOKEN}` },
                        signal: AbortSignal.timeout(15_000),
                    })
                    if (!fileRes.ok) {
                        logger.warn({ status: fileRes.status, name: file.name }, 'Slack image download failed')
                        continue
                    }
                    const buf = Buffer.from(await fileRes.arrayBuffer())
                    const safeName = (file.name || `image-${file.id}.png`).replace(/[^a-zA-Z0-9._-]/g, '_')
                    const up = await uploadContent({
                        taskId: `slack-${workspaceId}`,
                        filename: `${Date.now()}-${safeName}`,
                        content: buf,
                        contentType: file.mimetype,
                    })
                    imageUrls.push(up.url)
                } catch (err) {
                    logger.warn({ err, fileId: file.id, workspaceId }, 'Failed to process Slack image file')
                }
            }
        }
    } catch (err) {
        logger.warn({ err, workspaceId }, 'Slack image handling failed — proceeding without')
    }

    const text = event.text?.replace(/<@[A-Z0-9]+>/g, '').trim() ?? (imageUrls.length > 0 ? '[image]' : '')
    if (!text && imageUrls.length === 0) return

    // Resolve the session ID once per inbound message. Any downstream
    // conversation insert reuses this value so the session boundary is
    // consistent whether the turn succeeds or errors out.
    const { sessionId: resolvedSessionId, embedding: resolvedEmbedding, isNew: _sessionIsNew, reason: _sessionReason } = await slackResolveSession(
        workspaceId,
        teamId,
        event.channel ?? '',
        event.thread_ts ?? event.ts ?? '',
        text,
        event.user,
    )
    if (_sessionIsNew) {
        logger.info({ workspaceId, channel: event.channel, sessionId: resolvedSessionId, reason: _sessionReason }, 'slack: new session started')
    }

    // ── Phase 4: CONFIRM / CANCEL routing for awaiting_confirmation tasks ────
    {
        const { classifyConfirmCancel, handleInboundConfirmCancel } = await import('../channel-delivery.js')
        if (event.channel && classifyConfirmCancel(text)) {
            const result = await handleInboundConfirmCancel({
                workspaceId,
                channel: 'slack',
                chatId: event.channel,
                text,
                decidedBy: `slack:${event.user ?? 'unknown'}`,
            })
            if (result.outcome === 'approved') {
                await postMessage(event.channel, '✅ Confirmed — resuming the task.', event.thread_ts || undefined, { workspaceId })
                return
            }
            if (result.outcome === 'cancelled') {
                await postMessage(event.channel, '🚫 Cancelled.', event.thread_ts || undefined, { workspaceId })
                return
            }
            if (result.outcome === 'expired') {
                await postMessage(event.channel, '⌛ That confirmation already timed out or was resolved elsewhere.', event.thread_ts || undefined, { workspaceId })
                return
            }
            // 'no_pending' falls through to normal handling.
        }
    }

    // ── Self-configuration: detect credentials and auto-install connection ──
    const credMatch = event.channel ? detectCredentialMessage(text) : null
    if (credMatch && event.channel) {
        try {
            const reply = await autoInstallConnection(workspaceId, credMatch)
            await postMessage(event.channel, reply, event.thread_ts || undefined)
        } catch (err) {
            logger.error({ err, workspaceId }, 'Slack: auto-install integration failed')
            await postMessage(event.channel, `Failed to connect to ${credMatch.serviceName}. Check that the URL and token are correct.`, event.thread_ts || undefined)
        }
        return
    }

    const threadId = event.thread_ts ?? event.ts ?? 'default'
    const slackChannelThreadId = `${teamId}:${event.channel ?? ''}:${event.thread_ts ?? event.ts ?? ''}`
    const sessionPrefix = `slack:${slackChannelThreadId}:`

    chatHistory.add(threadId, 'user', text, imageUrls.length > 0 ? imageUrls : undefined)
    const history = await chatHistory.getOrHydrate(threadId, workspaceId, sessionPrefix)

    const { intent, suggestTask, isMemoryInstruction } = await classifyIntent(workspaceId, history)

    // ── Memory instruction shortcut ─────────────────────────────────────
    if (isMemoryInstruction) {
        const memReply = "Got it — I'll remember that."
        try {
            const { rememberInstruction } = await import('@plexo/agent/memory/store')
            await rememberInstruction({ workspaceId, instruction: text, source: 'api' })
        } catch (memErr) {
            logger.warn({ err: memErr, workspaceId }, 'Slack: failed to store memory instruction')
        }
        chatHistory.add(threadId, 'assistant', memReply)
        if (event.channel) await postMessage(event.channel, memReply, event.ts, { workspaceId })
        const channelRef: ChannelRef = { channel: 'slack', channelId: event.channel ?? '', chatId: event.user ?? '' }
        await recordConversation({ workspaceId, sessionId: resolvedSessionId, source: 'slack', message: text, reply: memReply, status: 'complete', intent: 'CONVERSATION', channelRef, messageEmbedding: resolvedEmbedding }).catch((e: Error) => logger.warn({ e }, 'Slack: recordConversation failed (MEMORY)'))
        return
    }

    // ── Acknowledge receipt immediately with an emoji reaction ──────────
    if (event.channel && event.ts) {
        maybeReact(
            { channel: 'slack', workspaceId, messageText: text, intent, isError: false },
            { channel: 'slack', slackBotToken: BOT_TOKEN ?? '', slackChannel: event.channel, slackTimestamp: event.ts },
        )
    }

    if (intent === 'CONVERSATION' || intent === 'PROJECT') {
        const result = await chatWithAI(
            workspaceId,
            history,
            buildConversationSystemPrompt('slack', undefined, { reactionsAvailable: !!(event.channel && event.ts && BOT_TOKEN) }),
            true,
            undefined,
            event.channel && event.ts && BOT_TOKEN
                ? { channel: 'slack', chatId: event.channel, messageId: event.ts, botToken: BOT_TOKEN }
                : undefined,
        )

        if (result.error) {
            logger.warn({ threadId, workspaceId, error: result.error }, 'AI error during Slack conversation')
        }
        let replyText = (result.text && result.text.trim())
            ? result.text
            : result.error
                ? translateErrorForUser(result.error)
                : "I wasn't able to generate a response for that. Could you rephrase or try again?"
        if (suggestTask && !result.error) replyText += TASK_SUGGEST_HINT
        chatHistory.add(threadId, 'assistant', replyText)
        if (event.channel) {
            await postMessage(event.channel, replyText, event.ts, { workspaceId })
        }

        // Reaction already sent above (before AI processing)

        const sessionId = resolvedSessionId

        // Fire-and-forget conversation memory bridge.
        if (hasInstructionIntent(text)) {
            void persistInstruction({ workspaceId, userMessage: text, assistantReply: replyText, sessionId })
                .catch((err: unknown) => logger.warn({ err }, 'Slack: persistInstruction failed'))
        }
        void extractConversationMemory({ workspaceId, userMessage: text, assistantReply: replyText, sessionId, source: 'slack' })
            .catch((err: unknown) => logger.warn({ err }, 'Slack: extractConversationMemory failed'))

        const channelRef: ChannelRef = { channel: 'slack', channelId: event.channel ?? '', chatId: event.user ?? '' }
        await recordConversation({
            workspaceId,
            sessionId,
            source: 'slack',
            message: text,
            reply: replyText,
            status: result.error ? 'failed' : 'complete',
            errorMsg: result.error ? `AI error: ${result.error}` : null,
            intent: intent === 'PROJECT' ? 'PROJECT' : 'CONVERSATION',
            channelRef,
            messageEmbedding: resolvedEmbedding,
        }).catch((err: Error) => logger.warn({ err }, 'Failed to record Slack conversation'))
        emitToWorkspace(workspaceId, { type: 'conversation_updated', sessionId, source: 'slack' })
        trackEvent('channel.conversation_turn', 'info', {
            channel: 'slack',
            workspaceId,
            sessionId,
            intent: intent === 'PROJECT' ? 'PROJECT' : 'CONVERSATION',
        })

        return
    }

    try {
        const taskId = await pushTask({
            workspaceId,
            type: 'automation',
            source: 'slack',
            context: {
                description: text,
                channel: 'slack',
                chatId: event.channel,
                slackChannel: event.channel,
                slackUser: event.user,
                threadTs: event.thread_ts ?? event.ts,
                ...(imageUrls.length > 0 ? { imageUrls } : {}),
            },
            priority: 2,
        })

        const slackReply = `On it. I'll reply in this thread when done.`
        if (event.channel) {
            await postMessage(event.channel, slackReply, event.ts, { workspaceId })
        }

        // Reaction already sent above (before AI processing)

        const sessionId = resolvedSessionId
        const channelRef: ChannelRef = { channel: 'slack', channelId: event.channel ?? '', chatId: event.user ?? '' }
        await recordConversation({
            workspaceId,
            sessionId,
            source: 'slack',
            message: text,
            reply: slackReply,
            status: 'complete',
            intent: 'TASK',
            taskId,
            channelRef,
            messageEmbedding: resolvedEmbedding,
        }).catch((err: Error) => logger.warn({ err }, 'Failed to record Slack task conversation'))
        trackEvent('channel.task_created', 'info', {
            channel: 'slack', taskId, workspaceId, sessionId,
        })

        emitToWorkspace(workspaceId, {
            type: 'task_queued_via_slack',
            taskId,
            slackChannel: event.channel,
            text: text.slice(0, 200),
        })
    } catch (err) {
        logger.error({ err, channel: event.channel }, 'Failed to queue Slack task')
        trackEvent('channel.error', 'error', { channel: 'slack', error: 'task_queue_failed' })
        const reason = err instanceof Error ? err.message.slice(0, 80) : 'Unknown error'
        const queueErrorReply = `Task queue failed — ${reason}. Try again or check Settings.`
        if (event.channel) {
            await postMessage(event.channel, queueErrorReply, event.ts)
        }
        const sessionId = resolvedSessionId
        const channelRef: ChannelRef = { channel: 'slack', channelId: event.channel ?? '', chatId: event.user ?? '' }
        await recordConversation({
            workspaceId,
            sessionId,
            source: 'slack',
            message: text,
            reply: queueErrorReply,
            status: 'failed',
            errorMsg: 'Task queue failed',
            intent: 'TASK',
            channelRef,
        }).catch((err: Error) => logger.warn({ err }, 'Failed to record Slack task-queue-error conversation'))
    }
})

// ── GET /api/channels/slack/info ─────────────────────────────────────────────

slackRouter.get('/info', (_req, res) => {
    res.json({
        configured: !!BOT_TOKEN && !!SIGNING_SECRET,
        registeredTeams: TEAM_TO_WORKSPACE.size,
    })
})
