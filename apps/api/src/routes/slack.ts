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
import { push as pushTask, completeTask } from '@plexo/queue'
import { logger } from '../logger.js'
import { emitToWorkspace } from '../sse-emitter.js'
import { generateText } from 'ai'
import { buildModel } from '@plexo/agent/providers/registry'
import { loadWorkspaceAISettings } from '../agent-loop.js'

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

async function postMessage(channel: string, text: string, threadTs?: string): Promise<void> {
    if (!BOT_TOKEN) return
    await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${BOT_TOKEN}`,
        },
        body: JSON.stringify({
            channel,
            text,
            ...(threadTs ? { thread_ts: threadTs } : {}),
        }),
    }).catch((err: Error) => logger.warn({ err }, 'Slack postMessage failed'))
}

// ── AI helpers (provider-agnostic) ──────────────────────────────────────────

interface ChatMessage { role: 'user' | 'assistant'; content: string }

interface AiResult {
    text: string | null
    error: string | null
}

async function chatWithAI(workspaceId: string, messages: ChatMessage[], system?: string, includeSnapshot = false): Promise<AiResult> {
    const { credential, aiSettings } = await loadWorkspaceAISettings(workspaceId)
    if (!credential || !aiSettings) return { text: null, error: 'no_credential' }

    const providerKey = aiSettings.primaryProvider
    const config = aiSettings.providers[providerKey]
    if (!config) return { text: null, error: `no config for provider ${providerKey}` }

    try {
        let finalSystem = system ?? 'You are Plexo, an AI agent assistant.'
        
        if (includeSnapshot) {
            const { buildIntrospectionSnapshot } = await import('@plexo/agent/introspection')
            const resolvedModel = config.model ?? '(unknown)'
            const snapshot = await buildIntrospectionSnapshot(workspaceId, providerKey, resolvedModel)
            finalSystem += `\n\nYour identity: you are Plexo, running on provider "${providerKey}", model "${resolvedModel}". If asked what model, AI, or system you are, answer truthfully using this information. Never claim to be a different model or say you don't know.\n\nHere is your full state and self-awareness snapshot (tools, agents, skills, memory, integrations, channels, exact model, provider, and workspace):\n${JSON.stringify(snapshot, null, 2)}`
        }

        const model = buildModel(providerKey, config, 'summarization', aiSettings)
        const result = await generateText({
            model,
            system: finalSystem,
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
    // 1. URL verification challenge (Slack sends this when you first configure the webhook)
    const payload = req.body as SlackPayload
    if (payload.type === 'url_verification') {
        res.json({ challenge: payload.challenge })
        return
    }

    // 2. Verify signature on all non-challenge requests
    if (!verifySlackSignature(req)) {
        logger.warn('Slack signature verification failed')
        res.status(403).json({ error: 'Invalid signature' })
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
                '⚠️ This Slack workspace is not linked to Plexo. Connect via Settings → Channels.',
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
            }).catch(() => null)
            const voiceSettings = settingsRes?.ok ? await settingsRes.json() as { configured: boolean } : null

            if (!voiceSettings?.configured) {
                if (event.channel) {
                    await postMessage(
                        event.channel,
                        '🎙️ I received your audio file, but voice transcription is not set up.\n\n' +
                        'Go to *Settings → Voice* in your Plexo dashboard to add your Deepgram key.',
                        event.ts
                    )
                }
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
                if (event.channel) {
                    await postMessage(event.channel, '🎙️ I received your audio, but couldn\'t hear anything clear. Please try again.', event.ts)
                }
                return
            }

            logger.info({ workspaceId, channel: event.channel, chars: transcript.length }, 'Slack audio transcribed')

            // Re-invoke the handler with the transcript as text
            req.body.event.text = transcript
            // Recursion is messy for Express handlers, but we can just continue with the resolved text
            event.text = transcript
        } catch (err) {
            logger.error({ err, workspaceId, channel: event.channel }, 'Slack transcription failed')
            if (event.channel) {
                await postMessage(event.channel, '❌ Failed to process that audio message. Please try text.', event.ts)
            }
            return
        }
    }

    const text = event.text?.replace(/<@[A-Z0-9]+>/g, '').trim()
    if (!text) return

    const threadId = event.thread_ts ?? event.ts ?? 'default'
    addToHistory(threadId, 'user', text)
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
            logger.warn({ threadId, workspaceId, error: result.error }, 'AI error during Slack conversation')
        }
        const replyText = result.text ?? "I'm having a bit of trouble right now — please try again in a moment."
        addToHistory(threadId, 'assistant', replyText)
        if (event.channel) {
            await postMessage(event.channel, replyText, event.ts)
        }

        // Log as a completed task so it appears in the Conversations list
        try {
            const taskId = await pushTask({
                workspaceId,
                type: 'online',
                source: 'slack',
                status: 'complete',
                context: {
                    description: text,
                    channel: 'slack',
                    slackChannel: event.channel,
                    slackUser: event.user,
                    threadTs: event.thread_ts ?? event.ts,
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
            emitToWorkspace(workspaceId, { type: 'task_complete', taskId, source: 'slack' })
        } catch (err) {
            logger.error({ err, channel: event.channel }, 'Failed to log Slack conversation to DB')
        }

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
                slackChannel: event.channel,
                slackUser: event.user,
                threadTs: event.thread_ts ?? event.ts,
            },
            priority: 2,
        })

        if (event.channel) {
            await postMessage(
                event.channel,
                `✅ Task queued (\`${taskId.slice(0, 8)}…\`)\n_I'll reply in this thread when done._`,
                event.ts,
            )
        }

        emitToWorkspace(workspaceId, {
            type: 'task_queued_via_slack',
            taskId,
            slackChannel: event.channel,
            text: text.slice(0, 200),
        })
    } catch (err) {
        logger.error({ err, channel: event.channel }, 'Failed to queue Slack task')
        if (event.channel) {
            await postMessage(event.channel, '❌ Failed to queue task. Please try again.', event.ts)
        }
    }
})

// ── GET /api/channels/slack/info ─────────────────────────────────────────────

slackRouter.get('/info', (_req, res) => {
    res.json({
        configured: !!BOT_TOKEN && !!SIGNING_SECRET,
        registeredTeams: TEAM_TO_WORKSPACE.size,
    })
})
