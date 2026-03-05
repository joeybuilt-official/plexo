/**
 * Telegram channel adapter.
 *
 * Architecture:
 * - Production: webhook (registered via PUBLIC_URL at startup)
 * - Local dev: long polling (getUpdates loop, no public URL needed)
 *
 * Message routing:
 * - Conversational messages → direct AI reply (no task queued)
 * - Task requests → queued, agent executes, replies when done
 */

import { Router, type Router as RouterType, type Request, type Response } from 'express'
import { pushTask } from '@plexo/queue'
import { logger } from '../logger.js'
import { emitToWorkspace, onAgentEvent } from '../sse-emitter.js'
import { db, eq } from '@plexo/db'
import { channels, workspaces } from '@plexo/db'
import { generateText } from 'ai'
import { buildModel } from '@plexo/agent/providers/registry'
import type { WorkspaceAISettings, ProviderKey, AIProviderConfig } from '@plexo/agent/providers/registry'

export const telegramRouter: RouterType = Router()

const TELEGRAM_API = 'https://api.telegram.org/bot'

let _botToken: string | null = null
let _webhookSecret: string | null = null

// ── Telegram API helpers ─────────────────────────────────────────────────────

async function sendMessage(chatId: number | string, text: string): Promise<void> {
    if (!_botToken) return
    await fetch(`${TELEGRAM_API}${_botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
    }).catch((err: Error) => logger.warn({ err }, 'Telegram sendMessage failed'))
}

async function sendTyping(chatId: number | string): Promise<void> {
    if (!_botToken) return
    await fetch(`${TELEGRAM_API}${_botToken}/sendChatAction`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, action: 'typing' }),
    }).catch(() => null)
}

async function setWebhook(url: string, secret: string): Promise<void> {
    if (!_botToken) return
    const res = await fetch(`${TELEGRAM_API}${_botToken}/setWebhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, secret_token: secret }),
    })
    const data = await res.json() as { ok: boolean; description?: string }
    if (data.ok) logger.info({ url }, 'Telegram webhook registered')
    else logger.error({ description: data.description }, 'Telegram webhook registration failed')
}

async function deleteWebhook(): Promise<void> {
    if (!_botToken) return
    await fetch(`${TELEGRAM_API}${_botToken}/deleteWebhook`, { method: 'POST' }).catch(() => null)
}

// ── AI helpers (provider-agnostic) ───────────────────────────────────────────

/**
 * Load workspace AI settings from DB — same logic as agent-loop's loadWorkspaceAISettings
 * but returns the resolved settings + provider config for direct use.
 */
async function loadWorkspaceAI(workspaceId: string): Promise<{
    aiSettings: WorkspaceAISettings | null
    providerKey: ProviderKey | null
    config: AIProviderConfig | null
}> {
    const nil = { aiSettings: null, providerKey: null, config: null }
    try {
        const [ws] = await db.select({ settings: workspaces.settings })
            .from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const s = ws?.settings as any
        const ap = s?.aiProviders
        if (!ap) return nil

        const rawProviders = ap.providers ?? {}
        const providerKeys = Object.keys(rawProviders)

        const aiSettings: WorkspaceAISettings = {
            primaryProvider: (ap.primary ?? ap.primaryProvider ?? 'anthropic') as ProviderKey,
            fallbackChain: (ap.fallbackOrder ?? ap.fallbackChain ?? []) as ProviderKey[],
            providers: Object.fromEntries(
                providerKeys.map((k) => {
                    const p = rawProviders[k]
                    return [k, {
                        provider: k as ProviderKey,
                        apiKey: p.apiKey,
                        oauthToken: p.oauthToken,
                        baseUrl: p.baseUrl,
                        status: p.status,
                        model: p.selectedModel ?? p.defaultModel,
                    }]
                })
            ) as WorkspaceAISettings['providers'],
        }

        // Walk chain to find first usable provider
        const chain = [aiSettings.primaryProvider, ...aiSettings.fallbackChain.filter(p => p !== aiSettings.primaryProvider)]
        for (const pk of chain) {
            const p = rawProviders[pk]
            if (!p) continue
            const apiKey = p.apiKey as string | undefined
            const oauthToken = p.oauthToken as string | undefined
            const baseUrl = p.baseUrl as string | undefined
            const status = p.status as string | undefined

            const isValidKey = (k: string) => k !== 'placeholder' && k.length > 10 && !k.includes(' ')
            const isValidOAuth = (t: string) => t.startsWith('sk-ant-oat') && t.length > 20 && !t.includes(' ')

            if (pk === 'anthropic') {
                if ((oauthToken && isValidOAuth(oauthToken)) || (apiKey && isValidKey(apiKey))) {
                    const key = (oauthToken && isValidOAuth(oauthToken)) ? oauthToken : apiKey!
                    return { aiSettings: { ...aiSettings, primaryProvider: pk }, providerKey: pk, config: { provider: pk, apiKey: key, model: p.selectedModel ?? p.defaultModel } }
                }
            } else {
                if (apiKey && isValidKey(apiKey)) {
                    return { aiSettings: { ...aiSettings, primaryProvider: pk }, providerKey: pk, config: { provider: pk, apiKey, baseUrl, model: p.selectedModel ?? p.defaultModel } }
                }
                if (status === 'configured' || baseUrl) {
                    return { aiSettings: { ...aiSettings, primaryProvider: pk }, providerKey: pk, config: { provider: pk, apiKey: 'local', baseUrl, model: p.selectedModel ?? p.defaultModel } }
                }
            }
        }
    } catch (err) {
        logger.error({ err, workspaceId }, 'Telegram: failed to load workspace AI settings')
    }
    return nil
}

interface ChatMessage { role: 'user' | 'assistant'; content: string }

interface AiResult {
    text: string | null
    error: string | null
}

/**
 * Provider-agnostic chat — uses the workspace's configured provider via ai-sdk.
 */
async function chatWithAI(workspaceId: string, messages: ChatMessage[], system?: string): Promise<AiResult> {
    const { aiSettings, providerKey, config } = await loadWorkspaceAI(workspaceId)
    if (!aiSettings || !providerKey || !config) {
        return { text: null, error: 'no_credential' }
    }

    try {
        const model = buildModel(providerKey, config, 'summarization', aiSettings)
        const result = await generateText({
            model,
            system: system ?? 'You are Plexo, an AI agent assistant.',
            messages: messages.map(m => ({ role: m.role, content: m.content })),
            maxTokens: 1024,
            abortSignal: AbortSignal.timeout(30_000),
        })
        return { text: result.text ?? null, error: null }
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.warn({ err, workspaceId, providerKey }, 'Telegram AI chat call failed')
        return { text: null, error: msg }
    }
}

// ── Workspace resolver ───────────────────────────────────────────────────────

const CHAT_TO_WORKSPACE = new Map<string, string>()

export function registerTelegramChat(chatId: string, workspaceId: string): void {
    CHAT_TO_WORKSPACE.set(chatId, workspaceId)
}

async function resolveWorkspace(chatId: string): Promise<string | null> {
    if (CHAT_TO_WORKSPACE.has(chatId)) return CHAT_TO_WORKSPACE.get(chatId)!
    if (process.env.DEFAULT_WORKSPACE_ID) return process.env.DEFAULT_WORKSPACE_ID
    try {
        const [ch] = await db.select({ workspaceId: channels.workspaceId })
            .from(channels).where(eq(channels.type, 'telegram')).limit(1)
        if (ch?.workspaceId) {
            CHAT_TO_WORKSPACE.set(chatId, ch.workspaceId)
            return ch.workspaceId
        }
    } catch (err) { logger.warn({ err }, 'Telegram workspace DB lookup failed') }
    return null
}

// ── Intent classification ────────────────────────────────────────────────────

const CLASSIFY_SYSTEM = `You are an intent classifier for an AI agent called Plexo.
Decide if the user's message is a TASK REQUEST or CONVERSATION.

TASK: requires autonomous execution — create, write, fix, research, build, deploy, analyze, automate, schedule, etc.
CONVERSATION: greetings, status checks, questions about you, small talk, thanks, clarifications.

Reply with ONLY one word: TASK or CONVERSATION.`

async function classifyIntent(workspaceId: string, text: string): Promise<'TASK' | 'CONVERSATION'> {
    const result = await chatWithAI(workspaceId, [{ role: 'user', content: text }], CLASSIFY_SYSTEM)
    // On AI error, default to CONVERSATION so the error path handles it
    if (result.error) return 'CONVERSATION'
    return result.text?.trim().toUpperCase().startsWith('TASK') ? 'TASK' : 'CONVERSATION'
}

// Per-chat conversation history (last 20 messages, in-memory)
const chatHistory = new Map<string, ChatMessage[]>()

function addToHistory(chatId: string, role: 'user' | 'assistant', content: string): void {
    const hist = chatHistory.get(chatId) ?? []
    hist.push({ role, content })
    if (hist.length > 20) hist.splice(0, hist.length - 20)
    chatHistory.set(chatId, hist)
}

// ── Update handler ───────────────────────────────────────────────────────────

interface TelegramUpdate {
    update_id: number
    message?: {
        message_id: number
        from: { id: number; username?: string; first_name?: string }
        chat: { id: number; type: string }
        date: number
        text?: string
    }
}

async function handleUpdate(update: TelegramUpdate): Promise<void> {
    const msg = update.message
    if (!msg?.text) return

    const chatId = String(msg.chat.id)
    const text = msg.text.trim()

    // /start — always welcome response
    if (text === '/start') {
        await sendMessage(chatId,
            '👋 Hi! I\'m *Plexo*, your AI agent.\n\n'
            + 'Tell me what you want done — I can research, write, build, automate, and more.\n\n'
            + 'Just describe the task in plain language.')
        return
    }

    const workspaceId = await resolveWorkspace(chatId)
    if (!workspaceId) {
        await sendMessage(chatId, '⚠️ This chat isn\'t linked to a Plexo workspace yet. Connect via Settings → Channels.')
        return
    }

    // Check if workspace has any AI provider configured
    const { providerKey } = await loadWorkspaceAI(workspaceId)
    if (!providerKey) {
        await sendMessage(chatId, '⚠️ No AI provider configured. Add your API key in Settings → AI Providers.')
        return
    }

    addToHistory(chatId, 'user', text)
    await sendTyping(chatId)

    // Classify: is this a task or just conversation?
    const intent = await classifyIntent(workspaceId, text)

    if (intent === 'CONVERSATION') {
        const history = chatHistory.get(chatId) ?? []
        const result = await chatWithAI(
            workspaceId,
            history,
            'You are Plexo, a helpful AI agent. Keep replies concise and friendly. '
            + 'If the user describes something they want done, ask them to confirm so you can execute it as a task.'
        )
        // Log internal errors server-side; expose only neutral message to user
        if (result.error) {
            logger.warn({ chatId, workspaceId, error: result.error }, 'AI error during Telegram conversation')
        }
        const replyText = result.text ?? "I'm having a bit of trouble right now — please try again in a moment."
        addToHistory(chatId, 'assistant', replyText)
        await sendMessage(chatId, replyText)
        return
    }

    // Task — queue and reply when done
    logger.info({ chatId, workspaceId, text: text.slice(0, 80) }, 'Telegram task queued')
    try {
        const taskId = await pushTask({
            workspaceId,
            type: 'automation',
            source: 'telegram',
            context: {
                description: text,
                channel: 'telegram',
                chatId,
                from: msg.from.username ?? msg.from.first_name ?? String(msg.from.id),
                messageId: msg.message_id,
            },
            priority: 2,
        })

        await sendMessage(chatId, `⏳ On it… _(${taskId.slice(0, 8)})_`)

        const unsub = onAgentEvent((event) => {
            if (event.taskId !== taskId) return
            if (event.type === 'task_complete') {
                unsub()
                const result = (event.result as string | undefined) ?? 'Done.'
                sendMessage(chatId, `✅ ${result}`).catch(() => null)
                addToHistory(chatId, 'assistant', result)
            } else if (event.type === 'task_failed' || event.type === 'task_blocked') {
                unsub()
                const reason = (event.reason as string | undefined) ?? 'Unknown error'
                sendMessage(chatId, `❌ ${reason}`).catch(() => null)
            }
        })
        setTimeout(() => unsub(), 5 * 60 * 1000)

        emitToWorkspace(workspaceId, { type: 'task_queued_via_telegram', taskId, chatId, text: text.slice(0, 200) })
    } catch (err) {
        logger.error({ err, chatId }, 'Failed to queue Telegram task')
        await sendMessage(chatId, '❌ Failed to queue task. Please try again.')
    }
}

// ── Webhook handler (production) ─────────────────────────────────────────────

telegramRouter.post('/webhook', async (req: Request, res: Response) => {
    const secret = req.headers['x-telegram-bot-api-secret-token']
    if (_webhookSecret && secret !== _webhookSecret) {
        logger.warn('Telegram webhook secret mismatch')
        res.status(403).json({ error: 'Forbidden' })
        return
    }
    res.json({ ok: true })
    await handleUpdate(req.body as TelegramUpdate)
})

// ── GET /api/channels/telegram/info ─────────────────────────────────────────

telegramRouter.get('/info', (_req, res) => {
    res.json({
        configured: !!_botToken,
        webhookSecret: !!_webhookSecret,
        registeredChats: CHAT_TO_WORKSPACE.size,
        mode: process.env.PUBLIC_URL && !process.env.PUBLIC_URL.includes('localhost') ? 'webhook' : 'polling',
    })
})

// ── Long polling (local dev) ─────────────────────────────────────────────────

let _pollingActive = false

async function startLongPolling(token: string): Promise<void> {
    if (_pollingActive) return
    _pollingActive = true
    await deleteWebhook()
    logger.info('Telegram long polling started (local dev mode)')

    let offset = 0
    while (_pollingActive) {
        try {
            const res = await fetch(
                `${TELEGRAM_API}${token}/getUpdates?timeout=25&offset=${offset}`,
                { signal: AbortSignal.timeout(30_000) }
            )
            if (!res.ok) { await new Promise(r => setTimeout(r, 5000)); continue }
            const data = await res.json() as { ok: boolean; result: TelegramUpdate[] }
            if (!data.ok) { await new Promise(r => setTimeout(r, 5000)); continue }
            for (const update of data.result) {
                offset = update.update_id + 1
                handleUpdate(update).catch(err => logger.warn({ err }, 'Telegram update handler failed'))
            }
        } catch (err: unknown) {
            if ((err as Error)?.name !== 'TimeoutError') {
                logger.warn({ err }, 'Telegram polling error')
                await new Promise(r => setTimeout(r, 5000))
            }
        }
    }
}

export function stopTelegramPolling(): void { _pollingActive = false }

// ── Init ─────────────────────────────────────────────────────────────────────

export async function initTelegramWebhook(): Promise<void> {
    const envToken = process.env.TELEGRAM_BOT_TOKEN
    if (envToken) {
        _botToken = envToken
    } else {
        try {
            const [ch] = await db.select({ config: channels.config })
                .from(channels).where(eq(channels.type, 'telegram')).limit(1)
            const config = ch?.config as { token?: string; bot_token?: string } | null
            _botToken = config?.token ?? config?.bot_token ?? null
        } catch { /* non-fatal */ }
    }

    if (!_botToken) {
        logger.info('No Telegram bot token found — Telegram adapter disabled')
        return
    }

    _webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET ?? null

    const publicUrl = process.env.PUBLIC_URL
    if (publicUrl && !publicUrl.includes('localhost')) {
        const secret = _webhookSecret ?? 'plexo-telegram-prod'
        _webhookSecret = secret
        await setWebhook(`${publicUrl}/api/channels/telegram/webhook`, secret)
    } else {
        startLongPolling(_botToken).catch(err => logger.error({ err }, 'Telegram polling crashed'))
    }
}
