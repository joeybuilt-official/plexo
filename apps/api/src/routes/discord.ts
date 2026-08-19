// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Discord channel adapter — handles incoming interactions and DMs via
 * Discord's Interactions API (slash commands + DM messages).
 *
 * Discord sends interactions as signed HTTP POST requests to a registered
 * endpoint. All requests are verified with Ed25519 signature before processing.
 *
 * Supported interactions:
 * - Slash command: /task <description>  — create a task and return ACK
 * - DM message events (via webhook/bot gateway falls back to interactions)
 *
 * Setup requires:
 *   DISCORD_PUBLIC_KEY   — used for Ed25519 signature verification
 *   DISCORD_BOT_TOKEN    — used for sending follow-up messages
 *   DISCORD_APPLICATION_ID
 *   DISCORD_WORKSPACE_MAP — JSON: { "discord_server_id": "workspace-uuid" }
 *
 * Reference: https://discord.com/developers/docs/interactions/receiving-and-responding
 */
import { Router, type Router as RouterType } from 'express'
import { verify, createPublicKey } from 'crypto'
import { push as pushTask } from '@plexo/queue'
import { logger } from '../logger.js'
import { trackEvent } from '../event-tracker.js'
import { recordConversation, type ChannelRef } from '../conversation-log.js'
import { resolveSessionId } from '../lib/session-resolver.js'
import { emitToWorkspace } from '../sse-emitter.js'
import { chatWithAI, classifyIntent, ChannelChatHistory, buildConversationSystemPrompt, translateErrorForUser, TASK_SUGGEST_HINT } from '../channel-ai.js'
import { sanitizeForDiscord } from '../lib/telegram-sanitize.js'
import { detectCredentialMessage, autoInstallConnection } from '../credential-setup.js'
import { trackDelivery } from '../delivery-tracker.js'
import { hasInstructionIntent, persistInstruction, extractConversationMemory } from '@plexo/agent/memory/conversation-bridge'
import type { Request, Response } from 'express'

export const discordRouter: RouterType = Router()

// ── Discord interaction types ─────────────────────────────────────────────────

const INTERACTION_TYPE_PING = 1
const INTERACTION_TYPE_APPLICATION_COMMAND = 2
const INTERACTION_TYPE_MESSAGE_COMPONENT = 3

const INTERACTION_RESPONSE_TYPE_PONG = 1
const INTERACTION_RESPONSE_TYPE_CHANNEL_MESSAGE = 4
const INTERACTION_RESPONSE_TYPE_DEFERRED_CHANNEL_MESSAGE = 5

interface DiscordAttachment {
    id: string
    filename: string
    size: number
    url: string
    proxy_url: string
    content_type?: string
    width?: number
    height?: number
}

interface DiscordInteraction {
    id: string
    type: number
    token: string
    application_id: string
    guild_id?: string
    channel_id?: string
    user?: { id: string; username: string }
    member?: { user: { id: string; username: string } }
    data?: {
        name?: string
        options?: Array<{ name: string; value: string; type?: number }>
        custom_id?: string
        resolved?: {
            attachments?: Record<string, DiscordAttachment>
        }
    }
}

// ── Signature verification (Ed25519) ─────────────────────────────────────────

function verifyDiscordSignature(req: Request): boolean {
    const publicKey = process.env.DISCORD_PUBLIC_KEY
    if (!publicKey) return false

    const signature = req.headers['x-signature-ed25519'] as string | undefined
    const timestamp = req.headers['x-signature-timestamp'] as string | undefined

    if (!signature || !timestamp) return false

    try {
        const body = JSON.stringify(req.body)
        const message = Buffer.from(timestamp + body)
        const sig = Buffer.from(signature, 'hex')
        // Ed25519 SPKI prefix (RFC 8410): 12 bytes wrapping a 32-byte raw key
        const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')
        const rawKey = Buffer.from(publicKey, 'hex')
        const spkiKey = Buffer.concat([ED25519_SPKI_PREFIX, rawKey])
        const pub = createPublicKey({ key: spkiKey, format: 'der', type: 'spki' })
        return verify(null, message, pub, sig)
    } catch {
        return false
    }
}

// ── Workspace resolution ──────────────────────────────────────────────────────

function resolveWorkspaceId(guildId?: string): string | null {
    const raw = process.env.DISCORD_WORKSPACE_MAP ?? '{}'
    try {
        const map = JSON.parse(raw) as Record<string, string>
        if (guildId && map[guildId]) return map[guildId]!
        // DMs have no guild — use default workspace if configured
        const defaultId = process.env.DISCORD_DEFAULT_WORKSPACE_ID
        return defaultId ?? null
    } catch {
        return null
    }
}

// ── Follow-up message (for deferred responses) ────────────────────────────────

async function sendFollowUp(
    applicationId: string,
    interactionToken: string,
    content: string,
    trackingCtx?: { workspaceId: string; chatId: string },
): Promise<void> {
    if (!content || !content.trim()) {
        logger.warn('Discord sendFollowUp called with empty content — skipping')
        if (trackingCtx) trackDelivery({ workspaceId: trackingCtx.workspaceId, channel: 'discord', chatId: trackingCtx.chatId, status: 'empty_response', messageLength: 0 })
        return
    }
    const start = Date.now()
    // Phase 5: normalize headers/horizontal rules to Discord-friendly markdown.
    // Discord accepts most standard markdown so this is lighter-touch than
    // Telegram; emoji and code blocks pass through unchanged.
    const sanitized = sanitizeForDiscord(content)
    if (!sanitized.trim()) return
    try {
        const res = await fetch(
            `https://discord.com/api/v10/webhooks/${applicationId}/${interactionToken}`,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN ?? ''}`,
                },
                body: JSON.stringify({ content: sanitized }),
                signal: AbortSignal.timeout(8_000),
            },
        )
        if (trackingCtx) trackDelivery({ workspaceId: trackingCtx.workspaceId, channel: 'discord', chatId: trackingCtx.chatId, status: res.ok ? 'sent' : 'failed', messageLength: sanitized.length, latencyMs: Date.now() - start, errorMessage: res.ok ? null : `HTTP ${res.status}` })
    } catch (err: unknown) {
        logger.warn({ err }, 'Discord sendFollowUp failed')
        if (trackingCtx) trackDelivery({ workspaceId: trackingCtx.workspaceId, channel: 'discord', chatId: trackingCtx.chatId, status: 'failed', messageLength: sanitized.length, latencyMs: Date.now() - start, errorMessage: (err as Error).message })
    }
}

// ── Chat history (shared helper from channel-ai.ts) ────────────────────────

const chatHistory = new ChannelChatHistory()

/**
 * Session ID for a Discord channel with a SESSION_TIMEOUT_MINUTES inactivity
 * gap (default 30). Delegates to the universal session resolver — same
 * break logic as Telegram and Slack (time gap, explicit break, task
 * completion, topic change).
 */
async function discordResolveSession(
    workspaceId: string,
    guildId: string,
    channelId: string,
    messageText: string,
    userId?: string | null,
): Promise<{ sessionId: string; embedding: number[] | null; isNew: boolean; reason: string }> {
    const channelThreadId = `${guildId || 'dm'}:${channelId}`
    try {
        const r = await resolveSessionId({
            workspaceId,
            channel: 'discord',
            channelThreadId,
            userId: userId ?? null,
            newMessage: messageText,
        })
        return { sessionId: r.sessionId, embedding: r.newMessageEmbedding, isNew: r.isNewSession, reason: r.reason }
    } catch (err) {
        logger.warn({ err, channelThreadId }, 'discord: session resolver failed, falling back to stable id')
        return { sessionId: `discord:${channelThreadId}:${Date.now()}`, embedding: null, isNew: true, reason: 'resolver_error' }
    }
}

/** Back-compat shim: returns only the sessionId. */
async function discordSessionId(
    workspaceId: string,
    guildId: string,
    channelId: string,
    messageText: string,
    userId?: string | null,
): Promise<string> {
    const channelThreadId = `${guildId || 'dm'}:${channelId}`
    try {
        const r = await resolveSessionId({
            workspaceId,
            channel: 'discord',
            channelThreadId,
            userId: userId ?? null,
            newMessage: messageText,
        })
        return r.sessionId
    } catch (err) {
        logger.warn({ err, channelThreadId }, 'discord: session resolver failed, falling back to stable id')
        return `discord:${channelThreadId}:${Date.now()}`
    }
}

// ── POST /api/channels/discord/interactions ───────────────────────────────────

discordRouter.post('/interactions', async (req: Request, res: Response) => {
    // 1. Verify signature
    if (!verifyDiscordSignature(req)) {
        res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Invalid signature' } })
        return
    }

    const interaction = req.body as DiscordInteraction

    // 2. Handle ping (Discord sends this for endpoint verification)
    if (interaction.type === INTERACTION_TYPE_PING) {
        res.json({ type: INTERACTION_RESPONSE_TYPE_PONG })
        return
    }

    // 3. Handle slash commands
    if (interaction.type === INTERACTION_TYPE_APPLICATION_COMMAND) {
        const commandName = interaction.data?.name

        if (commandName === 'task') {
            const descriptionOption = interaction.data?.options?.find((o) => o.name === 'description')
            const description = descriptionOption?.value?.trim()

            if (!description) {
                res.json({
                    type: INTERACTION_RESPONSE_TYPE_CHANNEL_MESSAGE,
                    data: { content: 'Please include a description of what you need.' },
                })
                return
            }

            const workspaceId = resolveWorkspaceId(interaction.guild_id)
            if (!workspaceId) {
                res.json({
                    type: INTERACTION_RESPONSE_TYPE_CHANNEL_MESSAGE,
                    data: { content: 'This server is not connected to a Plexo workspace yet.' },
                })
                return
            }

            const user = interaction.member?.user ?? interaction.user
            const username = user?.username ?? 'unknown'

            // Defer reply immediately (must respond within 3s)
            res.json({ type: INTERACTION_RESPONSE_TYPE_DEFERRED_CHANNEL_MESSAGE })

            // ── Image attachments ─────────────────────────────────────────
            // Discord exposes attachments on slash commands via
            // interaction.data.resolved.attachments (keyed by attachment id).
            // CDN URLs are public for their expiry window, so the vision LLM
            // can fetch them directly — no re-upload needed.
            const imageUrls: string[] = []
            const resolved = interaction.data?.resolved?.attachments
            if (resolved) {
                for (const att of Object.values(resolved)) {
                    if (att.content_type && att.content_type.startsWith('image/')) {
                        imageUrls.push(att.url)
                    }
                }
            }

            const threadId = interaction.channel_id ?? interaction.user?.id ?? 'default'
            const discordGuildOrDm = interaction.guild_id || 'dm'
            const discordChannelId = interaction.channel_id ?? ''
            const sessionPrefix = `discord:${discordGuildOrDm}:${discordChannelId}:`

            chatHistory.add(threadId, 'user', description, imageUrls.length > 0 ? imageUrls : undefined)
            const history = await chatHistory.getOrHydrate(threadId, workspaceId, sessionPrefix)

            // ── Phase 4: CONFIRM / CANCEL routing for awaiting_confirmation tasks ────
            {
                const { classifyConfirmCancel, handleInboundConfirmCancel } = await import('../channel-delivery.js')
                if (interaction.channel_id && classifyConfirmCancel(description)) {
                    const result = await handleInboundConfirmCancel({
                        workspaceId,
                        channel: 'discord',
                        chatId: interaction.channel_id,
                        text: description,
                        decidedBy: `discord:${user?.id ?? 'unknown'}`,
                    })
                    if (result.outcome === 'approved') {
                        await sendFollowUp(interaction.application_id, interaction.token, '✅ Confirmed — resuming the task.', { workspaceId, chatId: user?.id ?? '' })
                        return
                    }
                    if (result.outcome === 'cancelled') {
                        await sendFollowUp(interaction.application_id, interaction.token, '🚫 Cancelled.', { workspaceId, chatId: user?.id ?? '' })
                        return
                    }
                    if (result.outcome === 'expired') {
                        await sendFollowUp(interaction.application_id, interaction.token, '⌛ That confirmation already timed out or was resolved elsewhere.', { workspaceId, chatId: user?.id ?? '' })
                        return
                    }
                    // 'no_pending' falls through to normal handling.
                }
            }

            // ── Self-configuration: detect credentials and auto-install connection ──
            const credMatch = detectCredentialMessage(description)
            if (credMatch) {
                try {
                    const reply = await autoInstallConnection(workspaceId, credMatch)
                    await sendFollowUp(interaction.application_id, interaction.token, reply)
                } catch (err) {
                    logger.error({ err, workspaceId }, 'Discord: auto-install integration failed')
                    await sendFollowUp(interaction.application_id, interaction.token, `Failed to connect to ${credMatch.serviceName}. Check that the URL and token are correct.`)
                }
                return
            }

            const { intent, suggestTask, isMemoryInstruction } = await classifyIntent(workspaceId, history)

            // Resolve session ONCE per interaction — avoids repeating the
            // embedding lookup for every recordConversation call downstream.
            const discordSession = await discordResolveSession(
                workspaceId,
                interaction.guild_id ?? '',
                interaction.channel_id ?? '',
                description,
                user?.id,
            )
            if (discordSession.isNew) {
                logger.info({ workspaceId, sessionId: discordSession.sessionId, reason: discordSession.reason }, 'discord: new session started')
            }

            // ── Memory instruction shortcut ─────────────────────────────────
            if (isMemoryInstruction) {
                const memReply = "Got it — I'll remember that."
                try {
                    const { rememberInstruction } = await import('@plexo/agent/memory/store')
                    await rememberInstruction({ workspaceId, instruction: description, source: 'api' })
                } catch (memErr) {
                    logger.warn({ err: memErr, workspaceId }, 'Discord: failed to store memory instruction')
                }
                chatHistory.add(threadId, 'assistant', memReply)
                await sendFollowUp(interaction.application_id, interaction.token, memReply, { workspaceId, chatId: user?.id ?? '' })
                const channelRef: ChannelRef = { channel: 'discord', channelId: interaction.channel_id ?? '', chatId: user?.id ?? '' }
                await recordConversation({ workspaceId, sessionId: discordSession.sessionId, source: 'discord', message: description, reply: memReply, status: 'complete', intent: 'CONVERSATION', channelRef }).catch((e: Error) => logger.warn({ e }, 'Discord: recordConversation failed (MEMORY)'))
                return
            }

            if (intent === 'CONVERSATION' || intent === 'PROJECT') {
                // Discord interactions don't expose a user message id, so
                // react_to_message won't be bound here until DM/gateway
                // message handling is added.
                const result = await chatWithAI(
                    workspaceId,
                    history,
                    buildConversationSystemPrompt('discord', undefined),
                    true,
                    undefined,
                    undefined,
                )

                if (result.error) {
                    logger.warn({ threadId, workspaceId, error: result.error }, 'AI error during Discord conversation')
                }
                let replyText = (result.text && result.text.trim())
                    ? result.text
                    : result.error
                        ? translateErrorForUser(result.error)
                        : "I wasn't able to generate a response for that. Could you rephrase or try again?"
                if (suggestTask && !result.error) replyText += TASK_SUGGEST_HINT
                chatHistory.add(threadId, 'assistant', replyText)
                await sendFollowUp(interaction.application_id, interaction.token, replyText, { workspaceId, chatId: user?.id ?? '' })

                // Reaction already sent above (before AI processing)

                const sessionId = discordSession.sessionId

                // Fire-and-forget conversation memory bridge.
                if (hasInstructionIntent(description)) {
                    void persistInstruction({ workspaceId, userMessage: description, assistantReply: replyText, sessionId })
                        .catch((err: unknown) => logger.warn({ err }, 'Discord: persistInstruction failed'))
                }
                void extractConversationMemory({ workspaceId, userMessage: description, assistantReply: replyText, sessionId, source: 'discord' })
                    .catch((err: unknown) => logger.warn({ err }, 'Discord: extractConversationMemory failed'))

                const channelRef: ChannelRef = { channel: 'discord', channelId: interaction.channel_id ?? '', chatId: user?.id ?? '' }
                await recordConversation({
                    workspaceId,
                    sessionId,
                    source: 'discord',
                    message: description,
                    reply: replyText,
                    status: result.error ? 'failed' : 'complete',
                    errorMsg: result.error ?? null,
                    intent: intent === 'PROJECT' ? 'PROJECT' : 'CONVERSATION',
                    channelRef,
                    messageEmbedding: discordSession.embedding,
                }).catch((err: Error) => logger.warn({ err }, 'Failed to record Discord conversation'))
                emitToWorkspace(workspaceId, { type: 'conversation_updated', sessionId, source: 'discord' })
                trackEvent('channel.conversation_turn', 'info', {
                    channel: 'discord', workspaceId, sessionId,
                    intent: intent === 'PROJECT' ? 'PROJECT' : 'CONVERSATION',
                })
                return
            }

            // Queue task async
            try {
                const taskId = await pushTask({
                    workspaceId,
                    type: 'automation',
                    source: 'discord',
                    priority: 1,
                    context: {
                        description: description,
                        channel: 'discord',
                        chatId: interaction.channel_id,
                        guildId: interaction.guild_id,
                        channelId: interaction.channel_id,
                        userId: user?.id,
                        username,
                        ...(imageUrls.length > 0 ? { imageUrls } : {}),
                    },
                })

                const discordReply = `On it.\n> ${description}`
                await sendFollowUp(interaction.application_id, interaction.token, discordReply)

                // Reaction already sent above (before AI processing)

                const sessionId = discordSession.sessionId
                const channelRef: ChannelRef = { channel: 'discord', channelId: interaction.channel_id ?? '', chatId: user?.id ?? '' }
                await recordConversation({
                    workspaceId,
                    sessionId,
                    source: 'discord',
                    message: description,
                    reply: discordReply,
                    status: 'complete',
                    intent: 'TASK',
                    taskId,
                    channelRef,
                    messageEmbedding: discordSession.embedding,
                }).catch((err: Error) => logger.warn({ err }, 'Failed to record Discord task conversation'))
                trackEvent('channel.task_created', 'info', {
                    channel: 'discord', taskId, workspaceId, sessionId,
                })

                logger.info({ taskId, workspaceId, username }, 'Discord /task queued')
            } catch (err) {
                logger.error({ err }, 'Discord /task push failed')
                trackEvent('channel.error', 'error', { channel: 'discord', error: 'task_push_failed' })
                const reason = err instanceof Error ? err.message.slice(0, 80) : 'Unknown error'
                const queueErrorReply = `Task queue failed — ${reason}. Try again or check Settings.`
                await sendFollowUp(
                    interaction.application_id,
                    interaction.token,
                    queueErrorReply,
                )
                const sessionId = discordSession.sessionId
                const channelRef: ChannelRef = { channel: 'discord', channelId: interaction.channel_id ?? '', chatId: user?.id ?? '' }
                await recordConversation({
                    workspaceId,
                    sessionId,
                    source: 'discord',
                    message: description,
                    reply: queueErrorReply,
                    status: 'failed',
                    errorMsg: 'Task queue failed',
                    intent: 'TASK',
                    channelRef,
                    messageEmbedding: discordSession.embedding,
                }).catch((err: Error) => logger.warn({ err }, 'Failed to record Discord task-queue-error conversation'))
            }
            return
        }

        // Unknown command
        res.json({
            type: INTERACTION_RESPONSE_TYPE_CHANNEL_MESSAGE,
            data: { content: '❓ Unknown command.' },
        })
        return
    }

    // 4. Ignore other interaction types for now
    res.status(200).json({ ok: true })
})

// ── GET /api/channels/discord/info ────────────────────────────────────────────

discordRouter.get('/info', async (_req, res) => {
    const configured = !!(
        process.env.DISCORD_PUBLIC_KEY &&
        process.env.DISCORD_BOT_TOKEN &&
        process.env.DISCORD_APPLICATION_ID
    )

    const workspaceMapRaw = process.env.DISCORD_WORKSPACE_MAP ?? '{}'
    let serverCount = 0
    try {
        serverCount = Object.keys(JSON.parse(workspaceMapRaw) as object).length
    } catch { /* malformed JSON in env var — default to 0 */ }

    res.json({
        configured,
        applicationId: process.env.DISCORD_APPLICATION_ID ?? null,
        serverCount,
        supportedCommands: ['/task'],
    })
})
