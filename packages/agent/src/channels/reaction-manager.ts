// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Channel Reaction Manager — intelligent emoji reactions for Telegram, Slack, Discord.
 *
 * Analyzes message content and context to decide whether a reaction is appropriate.
 * Designed to feel natural: reacts to ~30-40% of messages with cooldown and
 * deduplication so the bot never feels spammy.
 *
 * Platform adapters handle the API differences:
 *   - Telegram: setMessageReaction with { type: "emoji", emoji: "👍" }
 *   - Slack: reactions.add with emoji name (no colons)
 *   - Discord: PUT message reactions with URL-encoded unicode
 *
 * All reaction calls are fire-and-forget — failures never block message handling.
 */
import pino from 'pino'

const logger = pino({ name: 'reaction-manager' })

// ── Types ────────────────────────────────────────────────────────────────────

export type ChannelType = 'telegram' | 'slack' | 'discord'

export interface ReactionContext {
    /** The channel type */
    channel: ChannelType
    /** Workspace ID — used for settings lookup */
    workspaceId: string
    /** The raw user message text */
    messageText: string
    /** Intent classification result from channel-ai */
    intent: 'CONVERSATION' | 'TASK' | 'PROJECT'
    /** Whether the AI response was an error */
    isError?: boolean
}

/** Platform-specific identifiers needed to send a reaction */
export interface ReactionTarget {
    channel: ChannelType

    // Telegram
    telegramToken?: string
    telegramChatId?: string | number
    telegramMessageId?: number

    // Slack
    slackBotToken?: string
    slackChannel?: string
    slackTimestamp?: string

    // Discord
    discordBotToken?: string
    discordChannelId?: string
    discordMessageId?: string
}

// ── Emoji sets per message category ──────────────────────────────────────────

interface EmojiOption {
    unicode: string
    slackName: string
}

const EMOJI_SETS: Record<string, EmojiOption[]> = {
    question: [
        { unicode: '🤔', slackName: 'thinking_face' },
        { unicode: '❓', slackName: 'question' },
    ],
    request: [
        { unicode: '✅', slackName: 'white_check_mark' },
        { unicode: '👌', slackName: 'ok_hand' },
    ],
    positive: [
        { unicode: '👍', slackName: 'thumbsup' },
        { unicode: '❤️', slackName: 'heart' },
        { unicode: '🎉', slackName: 'tada' },
    ],
    technical: [
        { unicode: '🔧', slackName: 'wrench' },
        { unicode: '⚙️', slackName: 'gear' },
        { unicode: '💻', slackName: 'computer' },
    ],
    processing: [
        { unicode: '⚡', slackName: 'zap' },
        { unicode: '💭', slackName: 'thought_balloon' },
    ],
    success: [
        { unicode: '🎉', slackName: 'tada' },
        { unicode: '✨', slackName: 'sparkles' },
        { unicode: '🚀', slackName: 'rocket' },
    ],
}

// ── Message classification patterns ──────────────────────────────────────────

const QUESTION_PATTERNS = [
    /\?$/,
    /^(what|who|where|when|why|how|is|are|can|could|would|should|do|does|did)\s/i,
    /^(tell me|explain|describe|clarify)\b/i,
]

const REQUEST_PATTERNS = [
    /^(please|pls|plz)\b/i,
    /^(do|create|make|build|set up|configure|run|deploy|send|update|fix|install)\b/i,
    /^(can you|could you|would you)\b/i,
]

const POSITIVE_PATTERNS = [
    /^(thanks|thank you|thx|ty|great|awesome|perfect|nice|good job|well done|love it)/i,
    /^(👍|❤️|🙏|😊|🎉)/,
    /\b(appreciate|grateful)\b/i,
]

const TECHNICAL_PATTERNS = [
    /\b(deploy|server|database|api|endpoint|docker|container|config|env|ssl|dns)\b/i,
    /\b(error|bug|crash|exception|stack\s?trace|log|debug)\b/i,
    /```/,
    /\b(git|npm|pnpm|yarn|pip|docker)\s/i,
]

// ── Core classification ──────────────────────────────────────────────────────

type MessageCategory = keyof typeof EMOJI_SETS

function classifyMessage(text: string, intent: string): MessageCategory | null {
    // Short messages (under 3 chars) — skip
    if (text.length < 3) return null

    // Positive feedback — high priority
    if (POSITIVE_PATTERNS.some(p => p.test(text))) return 'positive'

    // Questions
    if (QUESTION_PATTERNS.some(p => p.test(text))) return 'question'

    // Technical content
    if (TECHNICAL_PATTERNS.some(p => p.test(text))) return 'technical'

    // Explicit requests / commands
    if (REQUEST_PATTERNS.some(p => p.test(text))) return 'request'

    // Task/project intent = processing
    if (intent === 'TASK' || intent === 'PROJECT') return 'processing'

    return null
}

// ── Cooldown and frequency management ────────────────────────────────────────

interface CooldownEntry {
    lastReactionAt: number
    recentCount: number
    windowStart: number
}

const COOLDOWN_MS = 10_000             // 10s between reactions in same chat
const RATE_WINDOW_MS = 5 * 60_000     // 5-minute sliding window
const MAX_REACTIONS_PER_WINDOW = 3    // Max reactions per window per chat
const BASE_REACTION_PROBABILITY = 0.35 // ~35% baseline reaction rate

/** chatKey → cooldown state */
const cooldowns = new Map<string, CooldownEntry>()

// Prune cooldown map periodically to prevent memory leak
const PRUNE_INTERVAL_MS = 10 * 60_000
let lastPrune = Date.now()

function pruneCooldowns(): void {
    const now = Date.now()
    if (now - lastPrune < PRUNE_INTERVAL_MS) return
    lastPrune = now
    for (const [key, entry] of cooldowns) {
        if (now - entry.lastReactionAt > RATE_WINDOW_MS * 2) {
            cooldowns.delete(key)
        }
    }
}

function shouldReact(chatKey: string, category: MessageCategory): boolean {
    pruneCooldowns()

    const now = Date.now()
    const entry = cooldowns.get(chatKey)

    // Cooldown: too soon since last reaction
    if (entry && now - entry.lastReactionAt < COOLDOWN_MS) return false

    // Rate limit: too many reactions in current window
    if (entry) {
        if (now - entry.windowStart > RATE_WINDOW_MS) {
            // Reset window
            entry.recentCount = 0
            entry.windowStart = now
        }
        if (entry.recentCount >= MAX_REACTIONS_PER_WINDOW) return false
    }

    // Positive feedback always gets a reaction — feels rude not to acknowledge
    if (category === 'positive') return true

    // Probabilistic: roll the dice
    return Math.random() < BASE_REACTION_PROBABILITY
}

function recordReaction(chatKey: string): void {
    const now = Date.now()
    const entry = cooldowns.get(chatKey)
    if (entry) {
        entry.lastReactionAt = now
        entry.recentCount++
    } else {
        cooldowns.set(chatKey, {
            lastReactionAt: now,
            recentCount: 1,
            windowStart: now,
        })
    }
}

// ── Emoji selection ──────────────────────────────────────────────────────────

function pickEmoji(category: MessageCategory): EmojiOption {
    const options = EMOJI_SETS[category]!
    return options[Math.floor(Math.random() * options.length)]!
}

// ── Platform-specific reaction senders (low-level, exported) ─────────────────

/**
 * Low-level Telegram reaction sender. Does NOT honor cooldowns or rate limits —
 * use `maybeReact()` for middleware-driven reactions. Exposed so agent tools
 * can send reactions on explicit user request.
 */
export async function sendTelegramReactionRaw(
    botToken: string,
    chatId: string | number,
    messageId: number,
    emoji: string,
): Promise<{ ok: boolean; error?: string }> {
    try {
        const res = await fetch(
            `https://api.telegram.org/bot${botToken}/setMessageReaction`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: chatId,
                    message_id: messageId,
                    reaction: [{ type: 'emoji', emoji }],
                }),
            },
        )
        if (!res.ok) {
            const body = await res.text().catch(() => '')
            logger.warn({ status: res.status, body: body.slice(0, 200) }, 'Telegram setMessageReaction failed')
            return { ok: false, error: `Telegram HTTP ${res.status}: ${body.slice(0, 200)}` }
        }
        return { ok: true }
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { ok: false, error: msg }
    }
}

/**
 * Low-level Slack reaction sender. Takes the raw unicode emoji and maps it
 * to a Slack shortcode via EMOJI_SETS when possible; otherwise passes the
 * unicode through (Slack accepts both `:thumbsup:` names and unicode).
 */
export async function sendSlackReactionRaw(
    botToken: string,
    channel: string,
    timestamp: string,
    emoji: string,
): Promise<{ ok: boolean; error?: string }> {
    try {
        // Map unicode → slack short name if we have it; else strip colons and use as-is
        const slackName = unicodeToSlackName(emoji) ?? emoji.replace(/:/g, '')
        const res = await fetch('https://slack.com/api/reactions.add', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${botToken}`,
            },
            body: JSON.stringify({ channel, timestamp, name: slackName }),
        })
        if (!res.ok) {
            logger.warn({ status: res.status }, 'Slack reactions.add failed')
            return { ok: false, error: `Slack HTTP ${res.status}` }
        }
        const data = await res.json().catch(() => ({})) as { ok?: boolean; error?: string }
        if (data.ok === false) return { ok: false, error: data.error ?? 'unknown' }
        return { ok: true }
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { ok: false, error: msg }
    }
}

/** Low-level Discord reaction sender. */
export async function sendDiscordReactionRaw(
    botToken: string,
    channelId: string,
    messageId: string,
    emoji: string,
): Promise<{ ok: boolean; error?: string }> {
    try {
        const encoded = encodeURIComponent(emoji)
        const res = await fetch(
            `https://discord.com/api/v10/channels/${channelId}/messages/${messageId}/reactions/${encoded}/@me`,
            {
                method: 'PUT',
                headers: {
                    Authorization: `Bot ${botToken}`,
                    'Content-Length': '0',
                },
            },
        )
        if (!res.ok) {
            logger.warn({ status: res.status }, 'Discord reaction PUT failed')
            return { ok: false, error: `Discord HTTP ${res.status}` }
        }
        return { ok: true }
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { ok: false, error: msg }
    }
}

/** Look up a known slack shortcode for a unicode emoji. */
function unicodeToSlackName(unicode: string): string | null {
    for (const opts of Object.values(EMOJI_SETS)) {
        for (const opt of opts) {
            if (opt.unicode === unicode) return opt.slackName
        }
    }
    return null
}

// ── Middleware wrappers (used by maybeReact) ─────────────────────────────────

async function sendTelegramReaction(target: ReactionTarget, emoji: EmojiOption): Promise<void> {
    if (!target.telegramToken || !target.telegramChatId || !target.telegramMessageId) return
    await sendTelegramReactionRaw(target.telegramToken, target.telegramChatId, target.telegramMessageId, emoji.unicode)
}

async function sendSlackReaction(target: ReactionTarget, emoji: EmojiOption): Promise<void> {
    if (!target.slackBotToken || !target.slackChannel || !target.slackTimestamp) return
    // Middleware path already knows the slack name — call raw helper with unicode
    // since it re-maps correctly.
    await sendSlackReactionRaw(target.slackBotToken, target.slackChannel, target.slackTimestamp, emoji.unicode)
}

async function sendDiscordReaction(target: ReactionTarget, emoji: EmojiOption): Promise<void> {
    if (!target.discordBotToken || !target.discordChannelId || !target.discordMessageId) return
    await sendDiscordReactionRaw(target.discordBotToken, target.discordChannelId, target.discordMessageId, emoji.unicode)
}

// ── Workspace settings cache ─────────────────────────────────────────────────

const settingsCache = new Map<string, { enabled: boolean; cachedAt: number }>()
const SETTINGS_CACHE_TTL_MS = 60_000 // 1 minute

/**
 * Check if reactions are enabled for a workspace. Uses workspace.settings JSONB.
 * Defaults to true when the field is absent.
 */
async function isReactionsEnabled(workspaceId: string): Promise<boolean> {
    const cached = settingsCache.get(workspaceId)
    if (cached && Date.now() - cached.cachedAt < SETTINGS_CACHE_TTL_MS) {
        return cached.enabled
    }

    try {
        // Dynamic import to avoid circular deps — this module lives in @plexo/agent
        // but the DB query is straightforward.
        const { db } = await import('@plexo/db')
        const { eq } = await import('drizzle-orm')
        const { workspaces } = await import('@plexo/db')
        const [ws] = await db
            .select({ settings: workspaces.settings })
            .from(workspaces)
            .where(eq(workspaces.id, workspaceId))
            .limit(1)

        const settings = (ws?.settings ?? {}) as Record<string, unknown>
        const enabled = settings.reactionsEnabled !== false // default true
        settingsCache.set(workspaceId, { enabled, cachedAt: Date.now() })
        return enabled
    } catch (err) {
        logger.warn({ err, workspaceId }, 'Failed to check reactions setting — defaulting to enabled')
        return true
    }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Analyze a message and potentially send a reaction. Fire-and-forget.
 *
 * Call this after message processing. It never throws and never blocks.
 * Returns immediately — the reaction is sent asynchronously.
 */
export function maybeReact(context: ReactionContext, target: ReactionTarget): void {
    // Kick off async work without awaiting
    void _maybeReactAsync(context, target).catch((err) => {
        logger.warn({ err }, 'Reaction manager error (non-fatal)')
    })
}

async function _maybeReactAsync(context: ReactionContext, target: ReactionTarget): Promise<void> {
    // Don't react to error responses
    if (context.isError) return

    // Check workspace setting
    const enabled = await isReactionsEnabled(context.workspaceId)
    if (!enabled) return

    // Classify the message
    const category = classifyMessage(context.messageText, context.intent)
    if (!category) return

    // Build chat key for cooldown tracking
    const chatKey = buildChatKey(target)
    if (!chatKey) return

    // Check cooldown and probability
    if (!shouldReact(chatKey, category)) return

    // Pick an emoji and send it
    const emoji = pickEmoji(category)
    recordReaction(chatKey)

    switch (context.channel) {
        case 'telegram':
            await sendTelegramReaction(target, emoji)
            break
        case 'slack':
            await sendSlackReaction(target, emoji)
            break
        case 'discord':
            await sendDiscordReaction(target, emoji)
            break
    }

    logger.info(
        { channel: context.channel, category, emoji: emoji.unicode, chatKey },
        'Reaction sent',
    )
}

function buildChatKey(target: ReactionTarget): string | null {
    switch (target.channel) {
        case 'telegram':
            return target.telegramChatId ? `tg:${target.telegramChatId}` : null
        case 'slack':
            return target.slackChannel ? `sl:${target.slackChannel}` : null
        case 'discord':
            return target.discordChannelId ? `dc:${target.discordChannelId}` : null
        default:
            return null
    }
}

// ── Exported for testing ─────────────────────────────────────────────────────

export const _internal = {
    classifyMessage,
    shouldReact,
    pickEmoji,
    cooldowns,
    settingsCache,
}
