// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * session-resolver.ts
 *
 * Universal session break logic for every Plexo channel.
 *
 * A "session" is a contiguous stretch of conversation that shares a topic and
 * a short time window. Sessions break on ANY of the following triggers:
 *
 *   1. Time gap       — > SESSION_TIMEOUT_MINUTES since last turn
 *   2. Explicit break — user says "new topic", "forget that", etc.
 *   3. Task complete  — last session had a task that finished, and this new
 *                       message arrives after a short follow-up window
 *   4. Topic change   — cosine similarity between the new message embedding
 *                       and the session's running topic embedding < threshold
 *
 * The resolver is called from every channel handler BEFORE recording the
 * conversation turn. It returns the session ID to use plus a flag + reason
 * for observability.
 *
 * Config (env):
 *   SESSION_TIMEOUT_MINUTES    — default 30
 *   SESSION_SIMILARITY_THRESHOLD — default 0.4 (below = new session)
 *   SESSION_TOPIC_DETECTION    — default 'true' ('false' disables embedding call)
 */

import { sql } from 'drizzle-orm'
import { db } from '@plexo/db'
import { ulid } from 'ulid'
import { logger } from '../logger.js'

// ── Types ─────────────────────────────────────────────────────────────────────

export type SessionChannel = 'telegram' | 'slack' | 'discord' | 'web' | 'dashboard' | 'widget' | 'api' | 'twilio'

export interface ResolveSessionParams {
    workspaceId: string
    /**
     * Source string matching conversations.source (telegram/slack/discord/dashboard/widget).
     * The resolver treats "web" as "dashboard" for storage compatibility.
     */
    channel: SessionChannel
    /**
     * Stable per-thread/chat identifier. Telegram: chat_id. Slack: channel+thread.
     * Discord: guild+channel. Web: the caller-supplied sessionId seed (falls back
     * to userId when not provided).
     */
    channelThreadId: string
    /** User identifier for filtering prior messages (optional). */
    userId?: string | null
    /** The new inbound message text (used for explicit break detection + embedding). */
    newMessage: string
    /** Optional pre-computed embedding of newMessage. If omitted, resolver fetches one. */
    newMessageEmbedding?: number[] | null
}

export type SessionBreakReason =
    | 'first_message'
    | 'time_gap'
    | 'explicit_break'
    | 'task_complete'
    | 'topic_change'
    | 'continue'

export interface ResolveSessionResult {
    sessionId: string
    isNewSession: boolean
    reason: SessionBreakReason
    /**
     * Embedding of the new message. Returned so callers can persist it as the
     * running session embedding on the next turn without re-embedding.
     */
    newMessageEmbedding: number[] | null
}

// ── Config ────────────────────────────────────────────────────────────────────

function getTimeoutMs(): number {
    const minutes = Number(process.env.SESSION_TIMEOUT_MINUTES ?? '30')
    if (!Number.isFinite(minutes) || minutes <= 0) return 30 * 60 * 1000
    return Math.floor(minutes * 60 * 1000)
}

function getSimilarityThreshold(): number {
    const v = Number(process.env.SESSION_SIMILARITY_THRESHOLD ?? '0.4')
    if (!Number.isFinite(v)) return 0.4
    return Math.max(0, Math.min(1, v))
}

function topicDetectionEnabled(): boolean {
    const v = (process.env.SESSION_TOPIC_DETECTION ?? 'true').toLowerCase()
    return v !== 'false' && v !== '0' && v !== 'off'
}

// ── Explicit break phrases ────────────────────────────────────────────────────

/**
 * Patterns that, when matched in the user's message, force a new session.
 * Kept deliberately conservative — false positives here are annoying.
 */
const EXPLICIT_BREAK_PATTERNS: RegExp[] = [
    /\bnew topic\b/i,
    /\bchange (?:the )?(?:subject|topic)\b/i,
    /\blet'?s talk about something else\b/i,
    /\b(?:different|another) (?:subject|topic|thing)\b/i,
    /\bforget (?:that|what i said|it)\b/i,
    /\bmoving on\b/i,
    /\bunrelated\b.*\b(?:question|thing)\b/i,
    /^never ?mind\b/i,
    /^scrap that\b/i,
]

export function matchesExplicitBreak(text: string): boolean {
    const t = text.trim()
    if (!t) return false
    return EXPLICIT_BREAK_PATTERNS.some(r => r.test(t))
}

/**
 * Short retry/continuation messages that should never trigger a session break.
 * These have low semantic signal and would cause false topic-change detections.
 */
const FORCED_CONTINUE_PATTERNS: RegExp[] = [
    /^try again\.?$/i,
    /^retry\.?$/i,
    /^do (?:it|that) again\.?$/i,
    /^one more time\.?$/i,
    /^again\.?$/i,
    /^go\.?$/i,
    /^continue\.?$/i,
    /^keep going\.?$/i,
    /^yes\.?$/i,
    /^ok(?:ay)?\.?$/i,
    /^sure\.?$/i,
    /^please\.?$/i,
    /^do it\.?$/i,
    /^send it\.?$/i,
]

function matchesForcedContinue(text: string): boolean {
    const t = text.trim()
    if (!t) return false
    // Very short messages (under 15 chars) carry insufficient semantic signal
    if (t.length < 15) return true
    return FORCED_CONTINUE_PATTERNS.some(r => r.test(t))
}

// ── Vector math ───────────────────────────────────────────────────────────────

export function cosineSimilarity(a: number[], b: number[]): number {
    const len = Math.min(a.length, b.length)
    if (len === 0) return 0
    let dot = 0
    let magA = 0
    let magB = 0
    for (let i = 0; i < len; i++) {
        const av = a[i] ?? 0
        const bv = b[i] ?? 0
        dot += av * bv
        magA += av * av
        magB += bv * bv
    }
    if (magA === 0 || magB === 0) return 0
    return dot / (Math.sqrt(magA) * Math.sqrt(magB))
}

/**
 * Running-average update for a session's topic embedding.
 * Simple mean of all per-turn embeddings — cheap and stable.
 */
export function mergeSessionEmbedding(
    current: number[] | null,
    incoming: number[],
    turnCount: number,
): number[] {
    if (!current || current.length !== incoming.length || turnCount <= 1) {
        return incoming.slice()
    }
    const out = new Array<number>(current.length)
    const w = turnCount
    for (let i = 0; i < current.length; i++) {
        out[i] = ((current[i] ?? 0) * (w - 1) + (incoming[i] ?? 0)) / w
    }
    return out
}

// ── Embedding fetch (lazy, non-fatal) ─────────────────────────────────────────

export async function embedMessage(workspaceId: string, text: string): Promise<number[] | null> {
    if (!topicDetectionEnabled()) return null
    const trimmed = text.trim()
    if (!trimmed) return null
    try {
        const { resolveEmbeddingAdapterAsync } = await import('@plexo/agent/embeddings/router')
        const result = await resolveEmbeddingAdapterAsync(workspaceId)
        if (!result.adapter) return null
        // Cap input to something sensible so we don't blow the gateway on huge messages
        const capped = trimmed.slice(0, 4000)
        // Hard budget: embedding is best-effort (searchability for future recall).
        // A stalled ollama/gateway must not hang the chat request path — the
        // sibling memory-recall call is bounded the same way (chat.ts). On
        // timeout we degrade to time-gap-only, identical to the catch below.
        const EMBED_BUDGET_MS = Number(process.env.PLEXO_EMBED_BUDGET_MS) || 2000
        const vec = await Promise.race([
            result.adapter.embed(capped),
            new Promise<null>(resolve => setTimeout(() => resolve(null), EMBED_BUDGET_MS)),
        ])
        if (vec === null) {
            logger.debug({ workspaceId, budgetMs: EMBED_BUDGET_MS }, 'session-resolver: embedding over budget — falling back to time-gap only')
            return null
        }
        return Array.isArray(vec) && vec.length > 0 ? vec : null
    } catch (err) {
        logger.debug({ err, workspaceId }, 'session-resolver: embedding fetch failed, falling back to time-gap only')
        return null
    }
}

// ── DB helpers ────────────────────────────────────────────────────────────────

interface LastSessionRow {
    id: string
    sessionId: string | null
    message: string
    taskId: string | null
    createdAt: Date
    sessionEmbedding: number[] | null
}

/**
 * Find the most recent turn in this workspace/channel/thread — the anchor
 * against which we decide continuity.
 */
async function findLastTurn(
    workspaceId: string,
    channel: SessionChannel,
    channelThreadId: string,
): Promise<LastSessionRow | null> {
    // Map "web" to "dashboard" for storage compatibility
    const source = channel === 'web' ? 'dashboard' : channel
    try {
        // Web channel uses strict session_id equality — the client mints a
        // fresh per-chat sessionId and each session is self-contained. The
        // old LIKE match caused false positives across unrelated web threads.
        // External channels (telegram/slack/discord) legitimately need fuzzy
        // matching on channel_ref since their thread IDs are reused.
        const rows = channel === 'web'
            ? await db.execute(sql`
                SELECT id, session_id, message, task_id, created_at, session_embedding
                FROM conversations
                WHERE workspace_id = ${workspaceId}
                  AND source = 'dashboard'
                  AND (session_id = ${channelThreadId} OR session_id LIKE ${'web:' + channelThreadId + ':%'})
                ORDER BY created_at DESC
                LIMIT 1
            `)
            : await db.execute(sql`
                SELECT id, session_id, message, task_id, created_at, session_embedding
                FROM conversations
                WHERE workspace_id = ${workspaceId}
                  AND source = ${source}
                  AND (
                        session_id LIKE ${'%' + channelThreadId + '%'}
                        OR channel_ref->>'chatId' = ${channelThreadId}
                  )
                ORDER BY created_at DESC
                LIMIT 1
            `)
        const row = (rows as Array<Record<string, unknown>>)[0]
        if (!row) return null
        return {
            id: row.id as string,
            sessionId: (row.session_id as string | null) ?? null,
            message: (row.message as string | null) ?? '',
            taskId: (row.task_id as string | null) ?? null,
            createdAt: new Date(row.created_at as string),
            sessionEmbedding: (row.session_embedding as number[] | null) ?? null,
        }
    } catch (err) {
        logger.warn({ err, workspaceId, channel, channelThreadId }, 'session-resolver: last-turn lookup failed')
        return null
    }
}

/**
 * Count how many turns already exist in the given session — used when we
 * incrementally update the running topic embedding.
 */
async function countSessionTurns(workspaceId: string, sessionId: string): Promise<number> {
    try {
        const rows = await db.execute(sql`
            SELECT COUNT(*)::int AS n
            FROM conversations
            WHERE workspace_id = ${workspaceId} AND session_id = ${sessionId}
        `)
        const row = (rows as Array<Record<string, unknown>>)[0]
        const n = row?.n as number | undefined
        return typeof n === 'number' && n >= 0 ? n : 0
    } catch {
        return 0
    }
}

/**
 * Is the task attached to the previous turn already finished?
 * (Used to close the session after a task completes.)
 */
async function isTaskComplete(taskId: string): Promise<boolean> {
    try {
        const rows = await db.execute(sql`
            SELECT status FROM tasks WHERE id = ${taskId} LIMIT 1
        `)
        const row = (rows as Array<Record<string, unknown>>)[0]
        const status = row?.status as string | undefined
        return status === 'complete' || status === 'failed' || status === 'cancelled'
    } catch {
        return false
    }
}

// ── Session ID minting ────────────────────────────────────────────────────────

function mintSessionId(channel: SessionChannel, channelThreadId: string): string {
    const c = channel === 'web' ? 'web' : channel
    return `${c}:${channelThreadId}:${ulid().toLowerCase()}`
}

// ── Main resolver ─────────────────────────────────────────────────────────────

/**
 * Decide which session a new message belongs to.
 *
 * Callers MUST invoke this before `recordConversation()` and use the returned
 * sessionId when inserting the turn. The returned `newMessageEmbedding` should
 * be stored as `session_embedding` on the inserted row so that future turns
 * can continue the running average.
 */
export async function resolveSessionId(
    params: ResolveSessionParams,
): Promise<ResolveSessionResult> {
    const { workspaceId, channel, channelThreadId, newMessage } = params

    // Step 1: explicit break phrases short-circuit everything.
    if (matchesExplicitBreak(newMessage)) {
        const sessionId = mintSessionId(channel, channelThreadId)
        const emb = params.newMessageEmbedding ?? await embedMessage(workspaceId, newMessage)
        return { sessionId, isNewSession: true, reason: 'explicit_break', newMessageEmbedding: emb }
    }

    // Step 2: look up the most recent prior turn.
    const last = await findLastTurn(workspaceId, channel, channelThreadId)
    if (!last) {
        const sessionId = mintSessionId(channel, channelThreadId)
        const emb = params.newMessageEmbedding ?? await embedMessage(workspaceId, newMessage)
        return { sessionId, isNewSession: true, reason: 'first_message', newMessageEmbedding: emb }
    }

    // Step 3: time gap.
    const now = Date.now()
    const lastMs = last.createdAt.getTime()
    const gap = now - lastMs
    if (gap > getTimeoutMs()) {
        const sessionId = mintSessionId(channel, channelThreadId)
        const emb = params.newMessageEmbedding ?? await embedMessage(workspaceId, newMessage)
        return { sessionId, isNewSession: true, reason: 'time_gap', newMessageEmbedding: emb }
    }

    // Step 4: task completion break.
    //   If the prior turn fired off a task and that task is already finished,
    //   the conversational context has logically closed. Only break if we're
    //   past a small grace window — otherwise immediate follow-ups ("thanks!",
    //   "can you tweak X?") should stay in the same session.
    const TASK_COMPLETE_FOLLOWUP_MS = 2 * 60 * 1000
    if (last.taskId && gap > TASK_COMPLETE_FOLLOWUP_MS) {
        const done = await isTaskComplete(last.taskId)
        if (done) {
            const sessionId = mintSessionId(channel, channelThreadId)
            const emb = params.newMessageEmbedding ?? await embedMessage(workspaceId, newMessage)
            return { sessionId, isNewSession: true, reason: 'task_complete', newMessageEmbedding: emb }
        }
    }

    // Step 5: topic continuity via embedding similarity.
    //   Skipped when topic detection is disabled, no prior embedding, or the
    //   message is a short retry/continuation that lacks semantic signal.
    let newEmb: number[] | null = params.newMessageEmbedding ?? null
    if (topicDetectionEnabled() && last.sessionEmbedding && last.sessionEmbedding.length > 0 && !matchesForcedContinue(newMessage)) {
        if (!newEmb) newEmb = await embedMessage(workspaceId, newMessage)
        if (newEmb && newEmb.length > 0) {
            const sim = cosineSimilarity(last.sessionEmbedding, newEmb)
            if (sim < getSimilarityThreshold()) {
                const sessionId = mintSessionId(channel, channelThreadId)
                return { sessionId, isNewSession: true, reason: 'topic_change', newMessageEmbedding: newEmb }
            }
        }
    } else if (!newEmb) {
        // Still embed for the current turn so future turns can compare.
        newEmb = await embedMessage(workspaceId, newMessage)
    }

    // Step 6: continue the existing session.
    const sessionId = last.sessionId ?? mintSessionId(channel, channelThreadId)
    return { sessionId, isNewSession: false, reason: 'continue', newMessageEmbedding: newEmb }
}

/**
 * After recording a turn, update the running topic embedding on that row.
 * Safe no-op when `newMessageEmbedding` is null.
 */
export async function persistTurnEmbedding(params: {
    conversationId: string
    workspaceId: string
    sessionId: string
    newMessageEmbedding: number[] | null
}): Promise<void> {
    if (!params.newMessageEmbedding || params.newMessageEmbedding.length === 0) return
    try {
        // Pull prior running embedding (if any) from the session
        const prior = await db.execute(sql`
            SELECT session_embedding
            FROM conversations
            WHERE workspace_id = ${params.workspaceId}
              AND session_id = ${params.sessionId}
              AND id <> ${params.conversationId}
            ORDER BY created_at DESC
            LIMIT 1
        `)
        const priorRow = (prior as Array<Record<string, unknown>>)[0]
        const priorEmb = (priorRow?.session_embedding as number[] | null) ?? null

        const turnCount = (await countSessionTurns(params.workspaceId, params.sessionId)) || 1
        const merged = mergeSessionEmbedding(priorEmb, params.newMessageEmbedding, turnCount)

        await db.execute(sql`
            UPDATE conversations
            SET session_embedding = ${JSON.stringify(merged)}::jsonb
            WHERE id = ${params.conversationId}
        `)
    } catch (err) {
        logger.debug({ err }, 'session-resolver: persistTurnEmbedding failed (non-fatal)')
    }
}

