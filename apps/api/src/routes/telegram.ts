/**
 * Telegram channel adapter.
 *
 * Architecture:
 * - Receives messages via webhook (registered at startup)
 * - Each message from a chat/group creates a task in the queue
 * - Subscribes to SSE task_complete events for that workspaceId and replies
 *
 * Setup:
 * - Set TELEGRAM_BOT_TOKEN env var
 * - Set TELEGRAM_WEBHOOK_SECRET for request validation
 * - Webhook URL: ${PUBLIC_URL}/api/channels/telegram/webhook
 */

import { Router, type Router as RouterType, type Request, type Response } from 'express'
import { pushTask } from '@plexo/queue'
import { logger } from '../logger.js'
import { emitToWorkspace } from '../sse-emitter.js'

export const telegramRouter: RouterType = Router()

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET
const API_BASE = 'https://api.telegram.org/bot'

// ── Telegram API helpers ─────────────────────────────────────────────────────

async function sendMessage(chatId: number | string, text: string): Promise<void> {
    if (!BOT_TOKEN) return
    await fetch(`${API_BASE}${BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            chat_id: chatId,
            text,
            parse_mode: 'Markdown',
        }),
    }).catch((err: Error) => logger.warn({ err }, 'Telegram sendMessage failed'))
}

async function setWebhook(url: string, secret: string): Promise<void> {
    if (!BOT_TOKEN) return
    const res = await fetch(`${API_BASE}${BOT_TOKEN}/setWebhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, secret_token: secret }),
    })
    const data = await res.json() as { ok: boolean; description?: string }
    if (data.ok) {
        logger.info({ url }, 'Telegram webhook registered')
    } else {
        logger.error({ description: data.description }, 'Telegram webhook registration failed')
    }
}

// ── Workspace resolver ───────────────────────────────────────────────────────
// Maps a Telegram chat ID to a workspace ID.
// Phase 3: reads from channel_connections table. Phase 4: per-user mapping.

const CHAT_TO_WORKSPACE = new Map<string, string>()

export function registerTelegramChat(chatId: string, workspaceId: string): void {
    CHAT_TO_WORKSPACE.set(chatId, workspaceId)
}

function resolveWorkspace(chatId: string): string | null {
    // Fallback: use env var for single-workspace setups
    return CHAT_TO_WORKSPACE.get(chatId) ?? process.env.DEFAULT_WORKSPACE_ID ?? null
}

// ── Webhook handler ──────────────────────────────────────────────────────────

interface TelegramUpdate {
    update_id: number
    message?: {
        message_id: number
        from: { id: number; username?: string; first_name?: string }
        chat: { id: number; type: string; title?: string }
        date: number
        text?: string
    }
}

telegramRouter.post('/webhook', async (req: Request, res: Response) => {
    // Validate secret token header
    const secret = req.headers['x-telegram-bot-api-secret-token']
    if (WEBHOOK_SECRET && secret !== WEBHOOK_SECRET) {
        logger.warn('Telegram webhook secret mismatch')
        res.status(403).json({ error: 'Forbidden' })
        return
    }

    // Acknowledge immediately — Telegram needs <1s response
    res.json({ ok: true })

    const update = req.body as TelegramUpdate
    const msg = update.message
    if (!msg?.text) return

    const chatId = String(msg.chat.id)
    const workspaceId = resolveWorkspace(chatId)

    if (!workspaceId) {
        logger.warn({ chatId }, 'Telegram message from unregistered chat — ignored')
        await sendMessage(chatId,
            '⚠️ This chat is not linked to a Plexo workspace. '
            + 'Connect via https://getplexo.com/settings/channels')
        return
    }

    logger.info({ chatId, workspaceId, text: msg.text.slice(0, 80) }, 'Telegram message received')

    try {
        const taskId = await pushTask({
            workspaceId,
            type: 'automation',
            source: 'telegram',
            context: {
                description: msg.text,
                channel: 'telegram',
                chatId,
                from: msg.from.username ?? msg.from.first_name ?? String(msg.from.id),
                messageId: msg.message_id,
            },
            priority: 2,
        })

        await sendMessage(chatId, `✅ Task queued (${taskId.slice(0, 8)}…)\n_I'll reply here when it's done._`)

        // Emit to dashboard so it shows up live
        emitToWorkspace(workspaceId, {
            type: 'task_queued_via_telegram',
            taskId,
            chatId,
            text: msg.text.slice(0, 200),
        })
    } catch (err) {
        logger.error({ err, chatId }, 'Failed to queue Telegram task')
        await sendMessage(chatId, '❌ Failed to queue task. Please try again.')
    }
})

// ── GET /api/channels/telegram/info ─────────────────────────────────────────

telegramRouter.get('/info', (_req, res) => {
    res.json({
        configured: !!BOT_TOKEN,
        webhookSecret: !!WEBHOOK_SECRET,
        registeredChats: CHAT_TO_WORKSPACE.size,
    })
})

// ── Register webhook on startup ──────────────────────────────────────────────

export async function initTelegramWebhook(): Promise<void> {
    if (!BOT_TOKEN) {
        logger.info('TELEGRAM_BOT_TOKEN not set — Telegram adapter disabled')
        return
    }
    const publicUrl = process.env.PUBLIC_URL
    if (!publicUrl || publicUrl.includes('localhost')) {
        logger.info('PUBLIC_URL is localhost — skipping Telegram webhook registration')
        return
    }
    const secret = WEBHOOK_SECRET ?? 'plexo-telegram-dev'
    await setWebhook(`${publicUrl}/api/channels/telegram/webhook`, secret)
}
