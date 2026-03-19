// SPDX-License-Identifier: AGPL-3.0-only
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
import { createVerify } from 'crypto'
import { push as pushTask } from '@plexo/queue'
import { logger } from '../logger.js'
import { captureLifecycleEvent } from '../sentry.js'
import { recordConversation, type ChannelRef } from '../conversation-log.js'
import { emitToWorkspace } from '../sse-emitter.js'
import { chatWithAI, classifyIntent, ChannelChatHistory } from '../channel-ai.js'
import type { Request, Response } from 'express'

export const discordRouter: RouterType = Router()

// ── Discord interaction types ─────────────────────────────────────────────────

const INTERACTION_TYPE_PING = 1
const INTERACTION_TYPE_APPLICATION_COMMAND = 2
const INTERACTION_TYPE_MESSAGE_COMPONENT = 3

const INTERACTION_RESPONSE_TYPE_PONG = 1
const INTERACTION_RESPONSE_TYPE_CHANNEL_MESSAGE = 4
const INTERACTION_RESPONSE_TYPE_DEFERRED_CHANNEL_MESSAGE = 5

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
        options?: Array<{ name: string; value: string }>
        custom_id?: string
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
        const verifier = createVerify('sha512')
        verifier.update(timestamp + body)
        return verifier.verify(
            `-----BEGIN PUBLIC KEY-----\n${Buffer.from(publicKey, 'hex').toString('base64')}\n-----END PUBLIC KEY-----`,
            signature,
            'hex',
        )
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
): Promise<void> {
    await fetch(
        `https://discord.com/api/v10/webhooks/${applicationId}/${interactionToken}`,
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN ?? ''}`,
            },
            body: JSON.stringify({ content }),
        },
    )
}

// ── Chat history (shared helper from channel-ai.ts) ────────────────────────

const chatHistory = new ChannelChatHistory()

/** Stable session ID for a Discord thread/channel */
function discordSessionId(guildId: string, channelId: string): string {
    return `discord:${guildId}:${channelId}`
}

// ── POST /api/channels/discord/interactions ───────────────────────────────────

discordRouter.post('/interactions', async (req: Request, res: Response) => {
    // 1. Verify signature
    if (!verifyDiscordSignature(req)) {
        res.status(401).json({ error: 'Invalid signature' })
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
                    data: { content: '❌ Please provide a task description.' },
                })
                return
            }

            const workspaceId = resolveWorkspaceId(interaction.guild_id)
            if (!workspaceId) {
                res.json({
                    type: INTERACTION_RESPONSE_TYPE_CHANNEL_MESSAGE,
                    data: { content: '❌ This server is not connected to a Plexo workspace.' },
                })
                return
            }

            const user = interaction.member?.user ?? interaction.user
            const username = user?.username ?? 'unknown'

            // Defer reply immediately (must respond within 3s)
            res.json({ type: INTERACTION_RESPONSE_TYPE_DEFERRED_CHANNEL_MESSAGE })

            const threadId = interaction.channel_id ?? interaction.user?.id ?? 'default'
            chatHistory.add(threadId, 'user', description)
            const history = chatHistory.get(threadId) ?? []

            const intent = await classifyIntent(workspaceId, history)

            if (intent === 'CONVERSATION' || intent === 'PROJECT') {
                const result = await chatWithAI(
                    workspaceId,
                    history,
                    `You are Plexo, a helpful AI agent. Personality: Warm, sharp, direct. You get things done. Never hedge, over-explain, or ask unnecessary questions.

Critical rules — follow without exception:
1. NEVER ask for confirmation before answering. Just answer.
2. NEVER ask clarifying questions unless the request is genuinely ambiguous AND a reasonable assumption cannot be made.
3. Keep replies concise. No filler: no "Certainly!", "Of course!", "Great question!", "I'd be happy to help!".
4. If the user mentions a large initiative without supplying details, ALWAYS ask about strategy, timeline, goals, and ask if they'd like to start a project.
5. You are the agent. Act like one. Produce results, not process descriptions.
6. PROMPT OPTIMIZER: If the user asks you to optimize, improve, or write a prompt, DO NOT just write the prompt right away. Instead, act as a "first principles prompt optimizer": ask 2-3 specific, clarifying questions about their actual goals, context, target audience, and constraints. Only after they answer should you build the new optimized prompt.`,
                    true
                )

                if (result.error) {
                    logger.warn({ threadId, workspaceId, error: result.error }, 'AI error during Discord conversation')
                }
                const replyText = result.text ?? `⚠️ ${result.error ?? 'Unknown error — check Settings → AI Providers.'}`
                chatHistory.add(threadId, 'assistant', replyText)
                await sendFollowUp(interaction.application_id, interaction.token, replyText)

                const sessionId = discordSessionId(interaction.guild_id ?? '', interaction.channel_id ?? '')
                const channelRef: ChannelRef = { channel: 'discord', channelId: interaction.channel_id ?? '', chatId: user?.id ?? '' }
                await recordConversation({
                    workspaceId,
                    sessionId,
                    source: 'discord',
                    message: description,
                    reply: replyText,
                    status: result.error ? 'failed' : 'complete',
                    errorMsg: result.error ? `AI error: ${result.error}` : null,
                    intent: intent === 'PROJECT' ? 'PROJECT' : 'CONVERSATION',
                    channelRef,
                }).catch((err: Error) => logger.warn({ err }, 'Failed to record Discord conversation'))
                emitToWorkspace(workspaceId, { type: 'conversation_updated', sessionId, source: 'discord' })
                captureLifecycleEvent('channel.conversation_turn', 'info', {
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
                        description,
                        channel: 'discord',
                        guildId: interaction.guild_id,
                        channelId: interaction.channel_id,
                        userId: user?.id,
                        username,
                    },
                })

                const discordReply = `✅ Task queued (ID: \`${taskId.slice(0, 8)}\`)\n> ${description}`
                await sendFollowUp(interaction.application_id, interaction.token, discordReply)

                const sessionId = discordSessionId(interaction.guild_id ?? '', interaction.channel_id ?? '')
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
                }).catch((err: Error) => logger.warn({ err }, 'Failed to record Discord task conversation'))
                captureLifecycleEvent('channel.task_created', 'info', {
                    channel: 'discord', taskId, workspaceId, sessionId,
                })

                logger.info({ taskId, workspaceId, username }, 'Discord /task queued')
            } catch (err) {
                logger.error({ err }, 'Discord /task push failed')
                captureLifecycleEvent('channel.error', 'error', { channel: 'discord', error: 'task_push_failed' })
                const queueErrorReply = '❌ Failed to queue task. Check Plexo logs.'
                await sendFollowUp(
                    interaction.application_id,
                    interaction.token,
                    queueErrorReply,
                )
                const sessionId = discordSessionId(interaction.guild_id ?? '', interaction.channel_id ?? '')
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
