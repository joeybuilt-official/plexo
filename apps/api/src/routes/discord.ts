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
import { db, eq } from '@plexo/db'
import { installedConnections } from '@plexo/db'
import { push as pushTask, completeTask } from '@plexo/queue'
import { logger } from '../logger.js'
import { generateText } from 'ai'
import { buildModel } from '@plexo/agent/providers/registry'
import { loadWorkspaceAISettings } from '../agent-loop.js'
import { emitToWorkspace } from '../sse-emitter.js'
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

// ── AI helpers (provider-agnostic) ──────────────────────────────────────────

interface ChatMessage { role: 'user' | 'assistant'; content: string }

interface AiResult {
    text: string | null
    error: string | null
}

async function chatWithAI(workspaceId: string, messages: ChatMessage[], system?: string): Promise<AiResult> {
    const { credential, aiSettings } = await loadWorkspaceAISettings(workspaceId)
    if (!credential || !aiSettings) return { text: null, error: 'no_credential' }

    const providerKey = aiSettings.primaryProvider
    const config = aiSettings.providers[providerKey]
    if (!config) return { text: null, error: `no config for provider ${providerKey}` }

    try {
        const model = buildModel(providerKey, config, 'summarization', aiSettings)
        const result = await generateText({
            model,
            system: system ?? 'You are Plexo, an AI agent assistant.',
            messages: messages.map(m => ({ role: m.role, content: m.content })),
            abortSignal: AbortSignal.timeout(30_000),
        })
        return { text: result.text ?? null, error: null }
    } catch (err) {
        return { text: null, error: err instanceof Error ? err.message : String(err) }
    }
}

const CLASSIFY_SYSTEM = `You are an intent classifier for an AI agent called Plexo.
Decide if the user's message is a TASK, PROJECT, or CONVERSATION.

TASK: Clear, specific, actionable request that can be executed autonomously IMMEDIATELY (e.g., "Deploy the web app", "Sort the files"). Requires no further clarification.
PROJECT: A large, multi-step goal requiring planning (e.g., "Build a new features", "Implement auth").
CONVERSATION: Vague requests, requests for help/troubleshooting ("I need help troubleshooting", "How do I..."), queries needing clarification, greetings, checks, small talk.

Reply with ONLY one word: TASK, PROJECT, or CONVERSATION.`

async function classifyIntent(workspaceId: string, history: ChatMessage[]): Promise<'TASK' | 'PROJECT' | 'CONVERSATION'> {
    const result = await chatWithAI(workspaceId, history, CLASSIFY_SYSTEM)
    if (result.error) return 'CONVERSATION'
    const resText = result.text?.trim().toUpperCase() ?? ''
    if (resText.startsWith('TASK')) return 'TASK'
    else if (resText.startsWith('PROJECT')) return 'PROJECT'
    return 'CONVERSATION'
}

const chatHistory = new Map<string, ChatMessage[]>()

function addToHistory(threadId: string, role: 'user' | 'assistant', content: string): void {
    const hist = chatHistory.get(threadId) ?? []
    hist.push({ role, content })
    if (hist.length > 20) hist.splice(0, hist.length - 20)
    chatHistory.set(threadId, hist)
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
            addToHistory(threadId, 'user', description)
            const history = chatHistory.get(threadId) ?? []

            const intent = await classifyIntent(workspaceId, history)

            if (intent === 'CONVERSATION' || intent === 'PROJECT') {
                const result = await chatWithAI(
                    workspaceId,
                    history,
                    'You are Plexo, a helpful AI agent. Keep replies concise and friendly. '
                    + 'If the user proposes a single distinct action, tell them you can execute it as a task and ask for confirmation. '
                    + 'If the user proposes a large conceptual goal, tell them you can create a Project for it and ask for confirmation. '
                    + 'If they ask for troubleshooting, help, or advice, ask clarifying questions first and do not rush to create tasks. '
                    + 'Only agree to start a task or project when the scope is clear.'
                )

                if (result.error) {
                    logger.warn({ threadId, workspaceId, error: result.error }, 'AI error during Discord conversation')
                }
                const replyText = result.text ?? "I'm having a bit of trouble right now — please try again in a moment."
                addToHistory(threadId, 'assistant', replyText)
                await sendFollowUp(interaction.application_id, interaction.token, replyText)

                try {
                    const taskId = await pushTask({
                        workspaceId,
                        type: 'online',
                        source: 'discord',
                        status: 'complete',
                        context: {
                            description,
                            channel: 'discord',
                            guildId: interaction.guild_id,
                            channelId: interaction.channel_id,
                            userId: user?.id,
                            username,
                        },
                        priority: 2,
                    })
                    await completeTask(taskId, {
                        qualityScore: 1,
                        outcomeSummary: replyText,
                        tokensIn: 0,
                        tokensOut: 0,
                        costUsd: 0,
                    })
                    emitToWorkspace(workspaceId, { type: 'task_complete', taskId, source: 'discord' })
                } catch (err) {
                    logger.error({ err }, 'Failed to log Discord conversation to DB')
                }
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

                await sendFollowUp(
                    interaction.application_id,
                    interaction.token,
                    `✅ Task queued (ID: \`${taskId.slice(0, 8)}\`)\n> ${description}`,
                )

                logger.info({ taskId, workspaceId, username }, 'Discord /task queued')
            } catch (err) {
                logger.error({ err }, 'Discord /task push failed')
                await sendFollowUp(
                    interaction.application_id,
                    interaction.token,
                    '❌ Failed to queue task. Check Plexo logs.',
                )
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
    } catch { /* ignore */ }

    res.json({
        configured,
        applicationId: process.env.DISCORD_APPLICATION_ID ?? null,
        serverCount,
        supportedCommands: ['/task'],
    })
})
