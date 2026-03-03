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
import { emitToWorkspace } from '../sse-emitter.js'

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
}

interface SlackPayload {
    type: string
    challenge?: string
    team_id?: string
    event?: SlackEvent
}

// ── POST /api/channels/slack/events ──────────────────────────────────────────

slackRouter.post('/events', async (req: Request, res: Response) => {
    // URL verification challenge (Slack sends this when you first configure the webhook)
    const payload = req.body as SlackPayload
    if (payload.type === 'url_verification') {
        res.json({ challenge: payload.challenge })
        return
    }

    // Verify signature on all non-challenge requests
    if (!verifySlackSignature(req)) {
        logger.warn('Slack signature verification failed')
        res.status(403).json({ error: 'Invalid signature' })
        return
    }

    // Acknowledge immediately — Slack requires <3s response
    res.json({ ok: true })

    const event = payload.event
    if (!event) return

    // Ignore bot messages and message edits
    if (event.bot_id || event.subtype) return

    // Handle: app_mention (in channels) and message.im (direct messages)
    const isDirectMessage = event.channel_type === 'im' && event.type === 'message'
    const isMention = event.type === 'app_mention'
    if (!isDirectMessage && !isMention) return

    const text = event.text?.replace(/<@[A-Z0-9]+>/g, '').trim()
    if (!text) return

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

    logger.info({ teamId, workspaceId, text: text.slice(0, 80) }, 'Slack message received')

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
