// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Shared AI helpers for channel adapters (Slack, Discord, Telegram).
 *
 * Consolidates the duplicated chatWithAI / classifyIntent / chat-history
 * logic that was previously copy-pasted across each adapter.
 */

import { generateText, tool, stepCountIs } from 'ai'
import { z } from 'zod'
import { PROVIDER_DEFAULT_MODELS, buildModel } from '@plexo/agent/providers/registry'
import { routeAndCall } from '@plexo/agent/providers/router-v2'
import { callModel } from '@plexo/agent/providers/call-model'
import { modelSupportsVision, findVisionCapableModel, GROQ_FREE_VISION_MODEL } from '@plexo/agent/providers/vision'
import { enforceSmallestAction, forceConversationOverrideWithContext, isObviousTaskRequest } from '@plexo/agent/principles'
import { emitClassifierDecision } from './analytics/events.js'
import { loadWorkspaceAISettings } from './agent-loop.js'
import { emitToWorkspace } from './sse-emitter.js'
import { logger } from './logger.js'
import { getDecryptedBraveKey } from './routes/search.js'
import { isSsrfTarget } from './utils/ssrf.js'
import { buildConversationPrompt, buildClassifierPrompt } from '@plexo/agent/prompts/build-system-prompt'

// ── Disclaimer stripper ───────────────────────────────────────────────────────

/**
 * Remove boilerplate disclaimer sentences that models append regardless of
 * system prompt instructions. Operates sentence-by-sentence so legitimate
 * content is never truncated.
 */
const DISCLAIMER_PATTERNS = [
    // "Please/consult a doctor/professional" variants
    /\bplease\b.{0,60}\b(consult|see|speak with|talk to|visit)\b.{0,60}\b(doctor|physician|healthcare|medical|professional|specialist|provider|therapist|expert)\b/i,
    /\b(consult|see|speak with|talk to|visit)\b.{0,60}\b(doctor|physician|healthcare|medical|professional|specialist|provider|therapist|expert)\b/i,
    /\b(always|please)?\s*(consult|check with|seek)\b.{0,80}\b(professional|qualified|licensed|certified)\b/i,
    // "This is not [X] advice" variants
    /\bthis (is not|isn'?t) (medical|professional|legal|financial) advice\b/i,
    /\bnot a substitute for (professional|medical|qualified)\b/i,
    // "If you experience symptoms...see a doctor"
    /\bif you (experience|have|notice|feel|develop)\b.{0,80}\b(symptom|side effect|pain|concern|issue)\b.{0,60}\b(doctor|physician|medical|professional|seek)\b/i,
    // "Seek [immediate/professional] help" — also handles "seek immediate medical attention" (3-word form)
    /\bseek\b.{0,30}\b(help|attention|care|advice)\b.{0,30}\b(immediate|emergency|professional|medical)\b/i,
    /\bseek (immediate|emergency|professional|medical).{0,30}\b(help|attention|care|advice)\b/i,
    // "Important/Note that: ...professional advice"
    /\b(important|please note|note that|disclaimer)[:\s].{0,200}(medical|professional|consult|advice|qualified)/i,
    // "I cannot/can't/am not able to/I'm not able to provide [X] advice"
    /\bI (cannot|can't|am not able to) (provide|offer|give) (medical|professional|legal|financial|specific) (advice|guidance|recommendations?)\b/i,
    /\bI'?m not able to (provide|offer|give) (medical|professional|legal|financial|specific) (advice|guidance|recommendations?)\b/i,
    // "Always follow/consult a doctor"
    /\balways (follow|check with|consult)\b.{0,80}\b(doctor|healthcare|professional|physician)\b/i,
    // "I should note / It's worth noting" lead-in disclaimers
    /\bI should (note|mention|point out)\b.{0,200}(professional|medical|consult|advice|qualified|healthcare|doctor|physician)\b/i,
    /\bit'?s (worth|important to) (noting|mentioning|remembering)\b.{0,200}(professional|medical|consult|advice|qualified|doctor|physician|healthcare)\b/i,
    // "For your safety / As a reminder" prefixed disclaimers
    /\bfor your (safety|wellbeing|health)\b.{0,150}(doctor|professional|medical|healthcare)\b/i,
    /\bas a (reminder|precaution|note|safety note)[,:\s].{0,200}(doctor|professional|medical|healthcare|consult)\b/i,
    // "Keep in mind / Please be aware" soft disclaimer patterns
    /\bkeep in mind\b.{0,150}(professional|medical|consult|doctor|advice|qualified)\b/i,
    /\bplease (be aware|note)\b.{0,150}(professional|medical|consult|doctor|advice|qualified)\b/i,
    // "Before attempting / Before trying" safety caveats
    /\bbefore (attempting|trying|doing|proceeding|starting)\b.{0,150}(professional|medical|consult|doctor|advice|qualified|healthcare)\b/i,
    // "My/this information is not a replacement for professional"
    /\b(my|this) (information|response|answer|advice) (is not|isn'?t|should not|shouldn'?t)\b.{0,150}(professional|medical|substitute|replace)\b/i,
    // Liability-style "I'm not a [professional]" statements
    /\bI'?m not (a|an) (doctor|physician|lawyer|attorney|financial|medical|licensed|certified|qualified)\b/i,
    /\bI am not (a|an) (doctor|physician|lawyer|attorney|financial|medical|licensed|certified|qualified)\b/i,
]

export function stripDisclaimers(text: string | null): string | null {
    if (!text) return text
    // Split on sentence boundaries, filter, rejoin
    const sentences = text.split(/(?<=[.!?])\s+/)
    const filtered = sentences.filter(s => !DISCLAIMER_PATTERNS.some(p => p.test(s)))
    const result = filtered.join(' ').trim()
    // If we stripped everything, return original (shouldn't happen, but safe)
    return result.length > 0 ? result : text
}

// ── Shared system prompt builder (P5: single source of truth) ────────────────

/**
 * Core conversation system prompt used by all channel adapters.
 *
 * The channel name is injected so the model knows the communication medium.
 * Additional context (recalled conversations, recent completions) is appended
 * by the caller. This is the ONLY place the agent's conversational posture
 * is defined — channel adapters must not inline their own copy.
 */
export function buildConversationSystemPrompt(
    channel: string,
    extraContext?: string,
    opts?: { reactionsAvailable?: boolean; userTimezone?: string },
): string {
    // Delegates to the unified prompt builder in @plexo/agent/prompts.
    // Every system-prompt variant used by Plexo now flows through the same
    // builder so fragments (identity, channel rules, memory block, capability
    // block) stay in lockstep across the conversation / task / classifier
    // paths. See docs/review/next/phase-6-intelligence-depth.md.
    let extra = extraContext ?? ''
    if (opts?.reactionsAvailable) {
        const note = `You can call react_to_message({emoji: '👍'}) to add an emoji reaction to the user's most recent message on ${channel}. Use this when they ask for a reaction or when a quick acknowledgment is more natural than a text reply. Reactions do not replace your text response — you can do both.`
        extra = extra ? `${extra}\n\n${note}` : note
    }
    return buildConversationPrompt({
        taskType: 'conversation',
        channel,
        extraConversationContext: extra || undefined,
        userTimezone: opts?.userTimezone,
    })
}

/**
 * Async variant that resolves the Levio user's timezone for a workspace and
 * threads it into the system prompt. Callers that already have a workspaceId
 * in context should prefer this over the sync builder so times are reported
 * in the user's local zone. Returns the sync builder's output when Levio is
 * not connected.
 */
export async function buildConversationSystemPromptForWorkspace(
    channel: string,
    workspaceId: string,
    extraContext?: string,
    opts?: { reactionsAvailable?: boolean },
): Promise<string> {
    // Resolve via the app-supplied user-timezone port (ADR 0001) — same source
    // the executor uses, wired once at boot — instead of reaching into a
    // specific connector here. Lazy import keeps sync-builder test mocks simple.
    const { resolveUserTimezone } = await import('@plexo/agent/user-timezone-port')
    const userTimezone = (await resolveUserTimezone(workspaceId)) ?? undefined
    return buildConversationSystemPrompt(channel, extraContext, { ...opts, userTimezone })
}

// ── Shared error translation (P9: errors translated, not relayed) ────────────

/**
 * Translate a raw AI provider / internal error into a user-facing message.
 *
 * States: what happened, whether it's temporary, what the user can do.
 * The raw error is NOT included — callers must log it separately for diagnostics.
 */
export interface TranslatedError {
    message: string
    code: string
    category: 'auth' | 'billing' | 'rate_limit' | 'network' | 'timeout' | 'model' | 'context' | 'content_policy' | 'parse' | 'schema' | 'cost_ceiling' | 'unknown'
    recoverable: boolean
}

/**
 * Classify and translate a raw error. Returns structured error with code,
 * plain-English message, and category for the quality/learning loop.
 */
export function classifyError(raw: string, provider?: string): TranslatedError {
    const lower = raw.toLowerCase()
    const who = provider ? `Your ${provider} provider` : 'The AI provider'

    // ── Auth / key issues ───────────────────────────────────────────────────
    if (lower.includes('api key') || lower.includes('invalid_api_key') || lower.includes('invalid api key') ||
        lower.includes('incorrect api key') || lower.includes('unauthorized') || lower.includes('401')) {
        return { message: `${who} rejected the API key. Update it in Settings → AI Providers.`, code: 'E_AUTH_KEY_REJECTED', category: 'auth', recoverable: false }
    }
    if (lower.includes('credential') || lower.includes('no ai') || lower.includes('not configured')) {
        return { message: 'No AI provider configured. Add your API key in Settings → AI Providers.', code: 'E_AUTH_NOT_CONFIGURED', category: 'auth', recoverable: false }
    }
    if (lower.includes('403') || lower.includes('forbidden') || lower.includes('permission denied') || lower.includes('access denied')) {
        return { message: `${who} denied access. Check API key permissions in Settings → AI Providers.`, code: 'E_AUTH_FORBIDDEN', category: 'auth', recoverable: false }
    }

    // ── Billing / credits ───────────────────────────────────────────────────
    if (lower.includes('insufficient_quota') || lower.includes('exceeded your current quota') ||
        lower.includes('billing') || lower.includes('payment') || lower.includes('delinquent')) {
        return { message: `${who} has a billing issue. Fix it at the provider's dashboard, or switch to a different provider in Settings → AI Providers.`, code: 'E_BILLING_QUOTA', category: 'billing', recoverable: true }
    }
    if (lower.includes('credit') || lower.includes('balance') || lower.includes('funds') || lower.includes('prepaid')) {
        return { message: `${who} credits are depleted. Top up at the provider's billing page, or switch providers in Settings → AI Providers.`, code: 'E_BILLING_CREDITS', category: 'billing', recoverable: true }
    }

    // ── Rate limiting ───────────────────────────────────────────────────────
    if (lower.includes('rate limit') || lower.includes('rate_limit') || lower.includes('429') || lower.includes('too many requests')) {
        return { message: `${who} is rate-limited. Try again in a few seconds.`, code: 'E_RATE_LIMITED', category: 'rate_limit', recoverable: true }
    }

    // ── Network / connectivity ──────────────────────────────────────────────
    if (lower.includes('econnrefused') || lower.includes('econnreset') || lower.includes('unreachable') ||
        lower.includes('fetch failed') || lower.includes('network') || lower.includes('dns')) {
        return { message: `Couldn't reach ${who.toLowerCase()}. Check connectivity or try again.`, code: 'E_NETWORK_UNREACHABLE', category: 'network', recoverable: true }
    }

    // ── Timeouts / abort ────────────────────────────────────────────────────
    if (lower.includes('timeout') || lower.includes('etimedout') || lower.includes('aborted') || lower.includes('abort')) {
        return { message: `The request to ${who.toLowerCase()} timed out. Try a shorter message or try again.`, code: 'E_TIMEOUT', category: 'timeout', recoverable: true }
    }

    // ── Model issues ────────────────────────────────────────────────────────
    if ((lower.includes('model') || lower.includes('engine')) && (lower.includes('not found') || lower.includes('does not exist') || lower.includes('invalid model') || lower.includes('no such model') || lower.includes('deprecated'))) {
        return { message: `The selected model is unavailable or deprecated. Change it in Settings → AI Providers.`, code: 'E_MODEL_NOT_FOUND', category: 'model', recoverable: false }
    }

    // ── Context length / token limit ────────────────────────────────────────
    if (lower.includes('context length') || lower.includes('token limit') || lower.includes('maximum context') ||
        lower.includes('too many tokens') || lower.includes('max_tokens') || lower.includes('context_length_exceeded') ||
        lower.includes('input too long')) {
        return { message: `Message too long for the model's context window. Try a shorter message.`, code: 'E_CONTEXT_TOO_LONG', category: 'context', recoverable: true }
    }

    // ── Content policy ──────────────────────────────────────────────────────
    if (lower.includes('content') && (lower.includes('policy') || lower.includes('filter') || lower.includes('safety'))) {
        return { message: `The request was blocked by the provider's content policy. Try rephrasing.`, code: 'E_CONTENT_POLICY', category: 'content_policy', recoverable: true }
    }

    // ── JSON parse errors (malformed provider response) ─────────────────────
    if (lower.includes('json') && (lower.includes('parse') || lower.includes('unexpected token') || lower.includes('syntax'))) {
        return { message: `${who} returned a malformed response. This is a provider issue — try again.`, code: 'E_PARSE_MALFORMED', category: 'parse', recoverable: true }
    }

    // ── Schema / validation errors (Zod, AI SDK) ───────────────────────────
    if (lower.includes('invalid_union') || lower.includes('unionerrors') || lower.includes('zodissue') ||
        lower.includes('invalid_type') || lower.includes('unrecognized_keys') ||
        lower.includes('"issues"') || lower.includes('"code":')) {
        return { message: `${who} returned a response in an unexpected format. The system will auto-retry with a different provider if available.`, code: 'E_SCHEMA_VALIDATION', category: 'schema', recoverable: true }
    }

    // ── Cost ceiling ────────────────────────────────────────────────────────
    if (lower.includes('cost ceiling') || lower.includes('budget') ||
        lower.includes('monthly ceiling') || lower.includes('new tasks are blocked') ||
        lower.includes('cost_ceiling_exceeded') || lower.includes('workspace_cost_ceiling')) {
        return { message: 'Daily usage limit reached. Resets automatically — or raise it in Settings → Intelligence.', code: 'E_COST_CEILING', category: 'cost_ceiling', recoverable: false }
    }

    // ── Fallback: classify as unknown but still describe plainly ────────────
    // Extract the most useful fragment from the raw error for the user
    const firstLine = raw.split('\n')[0]?.slice(0, 120) ?? raw.slice(0, 120)
    const sanitized = firstLine.replace(/[{}\[\]"]/g, '').trim()
    return { message: `${who} encountered an issue: ${sanitized || 'unexpected error'}. Try again — check Settings → Intelligence if this persists.`, code: 'E_UNKNOWN', category: 'unknown', recoverable: true }
}

/**
 * Backward-compatible wrapper — returns just the user-facing message string.
 * Callers that need the full structured error should use classifyError() directly.
 */
export function translateErrorForUser(raw: string, provider?: string): string {
    const classified = classifyError(raw, provider)
    return `${classified.message} [${classified.code}]`
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface ChatMessage {
    role: 'user' | 'assistant'
    content: string
    /** Optional image URLs to include as multimodal content (user messages only) */
    imageUrls?: string[]
}

export interface AiResult {
    text: string | null
    error: string | null
}

export type IntentLabel = 'TASK' | 'PROJECT' | 'CONVERSATION'

export interface ClassifyResult {
    intent: IntentLabel
    /** True when classification fell back to CONVERSATION but the message looks like it might be a task request. */
    suggestTask: boolean
    /** True when the message is an explicit memory instruction ("remember X", "always Y", "never Z"). Channel adapters should call rememberInstruction and skip chatWithAI / task routing. */
    isMemoryInstruction?: boolean
}

const ACTION_WORDS_RE = /\b(build|create|fix|deploy|write|update|change|set\s+up|install)\b/i

/** Hint appended to conversational replies when classification is uncertain and message looks task-like. */
export const TASK_SUGGEST_HINT = '\n\n---\nDid you want me to do this as a task? Say "yes, as a task" to confirm.'

// ── Conversational tool set ───────────────────────────────────────────────────

/**
 * Minimal tool set for conversational AI calls.
 * Gives the model real web access so it searches instead of hallucinating.
 * Uses Brave Search (full index) when BRAVE_SEARCH_API_KEY is set,
 * falls back to DuckDuckGo Instant Answer for zero-config installs.
 */
async function buildConversationalTools(workspaceId: string) {
    // Resolve Brave key: workspace DB key > env fallback
    const resolvedBraveKey = await getDecryptedBraveKey(workspaceId)
    return {
        web_search: tool({
            description: 'Search the web for current information about any person, product, show, event, or topic. Always use this before answering questions about specific real-world entities.',
            inputSchema: z.object({
                query: z.string().describe('Search query'),
                count: z.number().optional().default(5).describe('Number of results (1-10)'),
            }),
            execute: async ({ query, count = 5 }): Promise<string> => {
                const braveKey = resolvedBraveKey
                if (braveKey) {
                    try {
                        const params = new URLSearchParams({ q: query, count: String(Math.min(count, 10)) })
                        const res = await fetch(`https://api.search.brave.com/res/v1/web/search?${params}`, {
                            headers: {
                                'Accept': 'application/json',
                                'Accept-Encoding': 'gzip',
                                'X-Subscription-Token': braveKey,
                            },
                            signal: AbortSignal.timeout(10_000),
                        })
                        if (!res.ok) throw new Error(`Brave Search HTTP ${res.status}`)
                        const data = await res.json() as {
                            web?: { results?: Array<{ title: string; url: string; description?: string; age?: string }> }
                        }
                        const results = data.web?.results ?? []
                        if (results.length === 0) return 'No results found for this query.'
                        return results.map((r, i) =>
                            `${i + 1}. ${r.title}\n   ${r.url}${r.description ? '\n   ' + r.description : ''}${r.age ? ' (' + r.age + ')' : ''}`
                        ).join('\n\n')
                    } catch (err) {
                        logger.warn({ query, err }, 'channel-ai: Brave Search failed, falling back to DuckDuckGo')
                    }
                }
                try {
                    const params = new URLSearchParams({ q: query, format: 'json', no_redirect: '1', no_html: '1', skip_disambig: '1' })
                    const res = await fetch(`https://api.duckduckgo.com/?${params}`, {
                        headers: { 'User-Agent': 'Plexo-Agent/1.0' },
                        signal: AbortSignal.timeout(10_000),
                    })
                    const data = await res.json() as {
                        Heading?: string; AbstractText?: string; AbstractURL?: string; Answer?: string
                        RelatedTopics?: Array<{ Text?: string; FirstURL?: string } | { Topics?: Array<{ Text?: string; FirstURL?: string }> }>
                    }
                    const lines: string[] = []
                    if (data.Answer) lines.push(`Answer: ${data.Answer}`)
                    if (data.Heading) lines.push(`Topic: ${data.Heading}`)
                    if (data.AbstractText) lines.push(`Summary: ${data.AbstractText}`)
                    if (data.AbstractURL) lines.push(`Source: ${data.AbstractURL}`)
                    if (lines.length > 0) return lines.join('\n')
                    return braveKey
                        ? 'No results found for this query.'
                        : 'No results found. For full web search coverage set BRAVE_SEARCH_API_KEY in your environment.'
                } catch (err) {
                    return `Search error: ${err instanceof Error ? err.message : String(err)}`
                }
            },
        }),
        web_fetch: tool({
            description: 'Fetch and read the content of a specific URL.',
            inputSchema: z.object({
                url: z.string().describe('URL to fetch'),
            }),
            execute: async ({ url }): Promise<string> => {
                if (isSsrfTarget(url)) {
                    return 'Error: URL targets a restricted or private address'
                }
                try {
                    const res = await fetch(url, {
                        headers: { 'User-Agent': 'Plexo-Agent/1.0' },
                        signal: AbortSignal.timeout(10_000),
                    })
                    const raw = await res.text()
                    const contentType = res.headers.get('content-type') ?? ''
                    const isHtml = contentType.includes('text/html') || /^\s*<!DOCTYPE\s|^\s*<html/i.test(raw)
                    const text = isHtml
                        ? raw
                            .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
                            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
                            .replace(/<[^>]+>/g, ' ')
                            .replace(/&nbsp;/g, ' ')
                            .replace(/&amp;/g, '&')
                            .replace(/&lt;/g, '<')
                            .replace(/&gt;/g, '>')
                            .replace(/&quot;/g, '"')
                            .replace(/&#x27;/g, "'")
                            .replace(/\s{2,}/g, ' ')
                            .trim()
                        : raw
                    return text.length > 20_000 ? text.slice(0, 20_000) + '\n\n[Truncated at 20k chars]' : text
                } catch (err) {
                    return `Fetch error: ${err instanceof Error ? err.message : String(err)}`
                }
            },
        }),
        memory_query: tool({
            description: 'Search your own conversation history and memory entries. Use this to recall prior conversations, find what was discussed before, look up learned preferences, or check what you remember about a topic. For "first/oldest/earliest" questions, use oldest_first=true to retrieve the oldest conversations.',
            inputSchema: z.object({
                query: z.string().describe('What to search for in memory (keywords, topic, or question)'),
                source: z.enum(['conversations', 'memory', 'all']).optional().default('all').describe('Where to search: conversations (chat history), memory (learned entries), or all'),
                limit: z.number().optional().default(10).describe('Max results to return'),
                oldest_first: z.boolean().optional().default(false).describe('Return oldest conversations first — use true for "when did we first talk", "our earliest conversation", etc.'),
            }),
            execute: async ({ query, source = 'all', limit = 10, oldest_first = false }): Promise<string> => {
                try {
                    const { db } = await import('@plexo/db')
                    const { conversations } = await import('@plexo/db')
                    const { sql, desc, asc } = await import('@plexo/db')

                    // Auto-detect "first/oldest/earliest" queries even if oldest_first wasn't set explicitly
                    const autoOldest = oldest_first || isFirstConversationQuery(query)
                    const orderBy = autoOldest ? asc(conversations.createdAt) : desc(conversations.createdAt)

                    const keywords = query.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 2).slice(0, 10)
                    // For oldest-first queries with no useful keywords, still run an unfiltered search
                    if (keywords.length === 0 && !autoOldest) return 'No meaningful search terms found. Try more specific keywords.'

                    const sections: string[] = []

                    if (source === 'conversations' || source === 'all') {
                        let rows: { message: string | null; reply: string | null; source: string | null; createdAt: Date | null }[]

                        if (keywords.length > 0) {
                            const keywordConditions = keywords.map(kw => {
                                const pattern = `%${kw}%`
                                return sql`(${conversations.message} ILIKE ${pattern} OR ${conversations.reply} ILIKE ${pattern})`
                            })
                            const keywordFilter = keywordConditions.length === 1
                                ? keywordConditions[0]!
                                : sql.join(keywordConditions, sql` OR `)

                            rows = await db.select({
                                message: conversations.message,
                                reply: conversations.reply,
                                source: conversations.source,
                                createdAt: conversations.createdAt,
                            })
                                .from(conversations)
                                .where(sql`${conversations.workspaceId} = ${workspaceId} AND (${keywordFilter})`)
                                .orderBy(orderBy)
                                .limit(limit)
                        } else {
                            // No keywords but oldest_first requested — return oldest conversations unfiltered
                            rows = await db.select({
                                message: conversations.message,
                                reply: conversations.reply,
                                source: conversations.source,
                                createdAt: conversations.createdAt,
                            })
                                .from(conversations)
                                .where(sql`${conversations.workspaceId} = ${workspaceId}`)
                                .orderBy(orderBy)
                                .limit(limit)
                        }

                        if (rows.length > 0) {
                            const lines = rows.map(r => {
                                const ts = r.createdAt instanceof Date
                                    ? r.createdAt.toISOString().replace('T', ' ').slice(0, 19)
                                    : String(r.createdAt)
                                const replySnippet = r.reply ? r.reply.slice(0, 200) : '(no reply)'
                                return `[${ts}] (${r.source}) User: ${String(r.message ?? '').slice(0, 200)}\nAssistant: ${replySnippet}`
                            })
                            const label = autoOldest ? 'OLDEST CONVERSATIONS' : 'CONVERSATION HISTORY'
                            sections.push(`=== ${label} (${rows.length} matches) ===\n${lines.join('\n---\n')}`)
                        }
                    }

                    if (source === 'memory' || source === 'all') {
                        const { searchMemory } = await import('@plexo/agent/memory/store')
                        const memResults = await searchMemory({
                            workspaceId,
                            query,
                            limit,
                            useCache: true,
                        })

                        if (memResults.length > 0) {
                            const lines = memResults.map(r => {
                                const ts = r.createdAt instanceof Date
                                    ? r.createdAt.toISOString().replace('T', ' ').slice(0, 19)
                                    : String(r.createdAt)
                                return `[${ts}] (${r.type}/${r.tier}) ${r.shorthand ?? r.content.slice(0, 300)}`
                            })
                            sections.push(`=== MEMORY ENTRIES (${memResults.length} matches) ===\n${lines.join('\n')}`)
                        }
                    }

                    if (sections.length === 0) return `No results found for "${query}" in ${source === 'all' ? 'conversations or memory' : source}.`
                    return sections.join('\n\n')
                } catch (err) {
                    logger.warn({ err, workspaceId, query }, 'memory_query tool failed')
                    return `Memory search error: ${err instanceof Error ? err.message : String(err)}`
                }
            },
        }),
        setup_ssh_connection: tool({
            description: 'Set up an SSH integration to a remote server so you can execute commands and manage it. Use this when the user asks you to connect to a server, VPS, or remote machine. You must collect all required details from the user first.',
            inputSchema: z.object({
                host: z.string().describe('Server hostname or IP address'),
                port: z.number().optional().default(22).describe('SSH port (default 22)'),
                username: z.string().describe('SSH username'),
                authMethod: z.enum(['key', 'password']).describe('Authentication method'),
                credential: z.string().describe('Private key (PEM format) or password'),
                nickname: z.string().optional().describe('Friendly name for this connection (e.g., "Production VPS")'),
                mode: z.enum(['full', 'readonly']).optional().default('full').describe('Access level: full or readonly'),
            }),
            execute: async ({ host, port = 22, username, authMethod, credential, nickname, mode = 'full' }): Promise<string> => {
                try {
                    // Test the connection first
                    const { sshTest } = await import('@plexo/agent/ssh/client')
                    const testResult = await sshTest({
                        host,
                        port,
                        username,
                        privateKey: authMethod === 'key' ? credential : undefined,
                        password: authMethod === 'password' ? credential : undefined,
                    })

                    if (!testResult.ok) {
                        return `Integration test failed: ${testResult.message}\n\nPlease check the host, username, and credentials and try again.`
                    }

                    // Install via the connections API
                    const apiBase = process.env.INTERNAL_API_URL ?? 'http://localhost:3001'
                    const creds: Record<string, string> = {
                        host,
                        port: String(port),
                        username,
                        auth_method: authMethod === 'key' ? 'Private Key' : 'Password',
                        mode: mode === 'readonly' ? 'Read Only' : 'Full Access',
                    }
                    if (authMethod === 'key') creds.private_key = credential
                    else creds.password = credential

                    const installRes = await fetch(`${apiBase}/api/v1/connections/install`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            workspaceId,
                            registryId: 'ssh',
                            name: nickname ?? `${username}@${host}`,
                            credentials: creds,
                        }),
                    })

                    if (!installRes.ok) {
                        const errData = await installRes.json().catch(() => ({})) as { error?: { message?: string } }
                        return `Integration tested OK but installation failed: ${errData.error?.message ?? 'Unknown error'}. Try again or set it up manually in Settings → Integrations.`
                    }

                    return `SSH integration established to ${host} as ${username} (${testResult.durationMs}ms). I now have access to run commands, transfer files, and manage this server. The integration is saved as "${nickname ?? `${username}@${host}`}".`
                } catch (err) {
                    return `SSH setup failed: ${err instanceof Error ? err.message : String(err)}`
                }
            },
        }),
    }
}

// ── chatWithAI ───────────────────────────────────────────────────────────────

/**
 * Fire a single-turn AI call using the workspace's configured provider.
 *
 * @param includeSnapshot  When true, appends the full introspection snapshot
 *   so the model can answer "what model are you?" accurately.
 */
export interface ChannelContext {
    channel: 'telegram' | 'slack' | 'discord'
    chatId?: string | number
    messageId?: number | string
    botToken?: string
}

export async function chatWithAI(
    workspaceId: string,
    messages: ChatMessage[],
    system?: string,
    includeSnapshot = false,
    timeoutMs = 120_000,
    channelContext?: ChannelContext,
): Promise<AiResult> {
    const { credential, aiSettings } = await loadWorkspaceAISettings(workspaceId)
    if (!credential || !aiSettings) {
        return { text: null, error: 'No AI provider configured. Add your API key in Settings → AI Providers.' }
    }

    logger.info({ workspaceId, historyMessages: messages.length }, 'channel-ai: chatWithAI history size')

    try {
        let finalSystem = system ?? 'You are Plexo — a personal AI agent for this workspace owner. Act first, report results. Answer from knowledge when you have it, say honestly when you don\'t. Be direct. No disclaimers, no safety theater, no filler. Match the register of the question.'

        // Environment awareness hint — point the agent at the introspection
        // tools so it can self-inspect instead of hallucinating infrastructure.
        finalSystem += '\n\nYou can call get_runtime_environment(), get_infrastructure(), get_repository_info(), get_deployment_context(), and get_self_modification_scope() to inspect what you are running on.'

        if (includeSnapshot) {
            const providerKey = aiSettings.primaryProvider
            const config = aiSettings.providers[providerKey]
            const { buildIntrospectionSnapshot, toConversationSnapshot } = await import('@plexo/agent/introspection')
            const resolvedModel = config?.model ?? '(unknown)'
            const snapshot = await buildIntrospectionSnapshot(workspaceId, providerKey, resolvedModel)
            const conversationSafe = toConversationSnapshot(snapshot)
            finalSystem += `\n\nYour identity: you are Plexo, running on provider "${providerKey}", model "${resolvedModel}". If asked what model, AI, or system you are, answer truthfully using this information. Never claim to be a different model or say you don't know.\n\nHere is your state and self-awareness snapshot (tools, agents, skills, memory, integrations, channels, exact model, provider, and workspace):\n${JSON.stringify(conversationSafe)}`
        }

        // Phase 3 — always inject a compact live capability summary, regardless
        // of includeSnapshot. This is the minimum the model needs to know which
        // self-knowledge tools exist so it calls them instead of hallucinating.
        try {
            const { buildCompactCapabilitySummary } = await import('@plexo/agent/tools/self-knowledge-tools')
            const capSummary = await buildCompactCapabilitySummary(workspaceId)
            finalSystem += `\n\n${capSummary}`
        } catch {
            // Non-fatal — fall back to the existing prompt if the helper breaks.
        }

        // Proactive memory recall — inject relevant stored facts into the prompt
        // so personal questions ("where do I live?", "what's my role?") get answered
        // without the model needing to call memory_query explicitly.
        const lastUserMsg = [...messages].reverse().find(m => m.role === 'user')?.content ?? ''
        const msgText = typeof lastUserMsg === 'string' ? lastUserMsg : ''
        if (msgText.length >= 10) {
            // Hard budget — same head-of-line block as the webchat path. Graphiti
            // is best-effort context; never stall the channel reply on it.
            const MEMORY_RECALL_BUDGET_MS = Number(process.env.PLEXO_MEMORY_RECALL_BUDGET_MS) || 1500
            try {
                const { readFromGraphiti } = await import('@plexo/agent/memory/read-backend')
                const hits = await Promise.race([
                    readFromGraphiti({ workspaceId, queryText: msgText, limit: 5 }),
                    new Promise<null>(resolve => setTimeout(() => resolve(null), MEMORY_RECALL_BUDGET_MS)),
                ])
                if (hits && hits.length > 0) {
                    const memBlock = hits.map(h => `- ${h.shorthand || h.content.slice(0, 200)}`).join('\n')
                    finalSystem += `\n\n=== RELEVANT MEMORY ===\n${memBlock}\n=== END MEMORY ===`
                    logger.info({ workspaceId, hits: hits.length, query: msgText.slice(0, 60) }, 'channel-ai: injected proactive memory context')
                } else if (hits === null) {
                    logger.debug({ workspaceId, budgetMs: MEMORY_RECALL_BUDGET_MS }, 'channel-ai: memory recall over budget — proceeding without')
                }
            } catch (err) {
                logger.debug({ err, workspaceId }, 'channel-ai: proactive memory search failed')
            }
        }


        // Vision gate: resolve the model to check vision support before building messages
        const providerKey = aiSettings.primaryProvider
        const providerConfig = aiSettings.providers[providerKey]
        const resolvedModelId = providerConfig?.model ?? PROVIDER_DEFAULT_MODELS[providerKey] ?? '(unknown)'
        const supportsVision = modelSupportsVision(resolvedModelId, providerKey)

        // Check if any message has images and the primary model can't handle them
        const hasImageMessages = messages.some(m => m.role === 'user' && m.imageUrls?.length)
        let visionFallback: ReturnType<typeof buildModel> | null = null
        let visionFallbackModelId: string | null = null
        let visionFallbackProvider: string | null = null
        if (hasImageMessages && !supportsVision) {
            const visionAlt = findVisionCapableModel(aiSettings, PROVIDER_DEFAULT_MODELS, providerKey)
            if (visionAlt) {
                const altConfig = aiSettings.providers[visionAlt.providerKey as keyof typeof aiSettings.providers]
                if (altConfig) {
                    visionFallback = buildModel(visionAlt.providerKey as any, altConfig, 'conversation', aiSettings)
                    visionFallbackModelId = visionAlt.modelId
                    visionFallbackProvider = visionAlt.providerKey
                    logger.info({ workspaceId, primary: resolvedModelId, fallback: visionAlt.modelId, fallbackProvider: visionAlt.providerKey }, 'channel-ai: routing images to vision fallback')
                }
            }
        }

        // Find the index of the LAST user message with images — only that
        // message gets full multimodal image parts.  Older images are replaced
        // with a compact text placeholder so the payload stays within provider
        // context / size limits (Groq in particular rejects large payloads).
        let lastImageMsgIdx = -1
        for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i]!.role === 'user' && messages[i]!.imageUrls?.length) {
                lastImageMsgIdx = i
                break
            }
        }

        const buildMessages = (useVision: boolean) => messages.map((m, idx) => {
            if (m.role === 'user' && m.imageUrls?.length) {
                if (!useVision) {
                    // Use the real failure reason if we had a vision fallback that failed,
                    // otherwise show the generic "no vision model" message.
                    const reason = visionFailureReason
                        ?? `your current model can't process images. Add a vision-capable provider (Claude, GPT-4o, or Gemini) in Settings.`
                    const note = ` [${m.imageUrls.length} image${m.imageUrls.length > 1 ? 's' : ''} attached — ${reason}]`
                    return { role: m.role, content: (m.content || '') + note }
                }
                // Only send actual image data for the latest image message.
                // Historical images are compacted to a text note so they don't
                // bloat the payload or confuse the vision model.
                if (idx !== lastImageMsgIdx) {
                    const note = ` [${m.imageUrls.length} image${m.imageUrls.length > 1 ? 's' : ''} previously shared]`
                    return { role: m.role, content: (m.content || '') + note }
                }
                const parts: Array<{ type: 'text'; text: string } | { type: 'image'; image: URL }> = []
                if (m.content) parts.push({ type: 'text', text: m.content })
                for (const url of m.imageUrls) {
                    try { parts.push({ type: 'image', image: new URL(url) }) } catch { /* skip invalid URLs */ }
                }
                return { role: m.role, content: parts }
            }
            return { role: m.role, content: m.content }
        })

        const fallbackOpts = {
            workspaceId,
            onAuthFailure: (provider: string, error: unknown) => {
                logger.warn({ workspaceId, provider, error }, 'Provider auth failed — removed from fallback chain')
                emitToWorkspace(workspaceId, {
                    type: 'provider_auth_error',
                    provider,
                    message: `API key for "${provider}" is invalid or expired. Update it in Settings → AI Providers.`,
                })
            },
        }

        // Unified workspace tools — available from every channel.
        // Pre-resolve web-search keys here so the agent package stays secret-free.
        const { getDecryptedBraveKey } = await import('./routes/search.js')
        const braveKey = await getDecryptedBraveKey(workspaceId).catch(() => null)
        const tavilyKey = process.env.TAVILY_API_KEY ?? null
        const { buildWorkspaceTools } = await import('@plexo/agent/tools/workspace-tools')
        const workspaceTools = await buildWorkspaceTools(workspaceId, { braveKey, tavilyKey })

        // ── Channel-scoped tools (react_to_message, etc.) ─────────────────
        // Only present when the caller passed a live channel context with a
        // message id the agent can target.
        let channelTools: Record<string, unknown> = {}
        if (channelContext) {
            try {
                const { buildChannelTools } = await import('@plexo/agent/channels/channel-tools')
                channelTools = buildChannelTools({
                    channel: channelContext.channel,
                    workspaceId,
                    chatId: channelContext.chatId,
                    messageId: channelContext.messageId,
                    botToken: channelContext.botToken,
                })
            } catch (err) {
                logger.warn({ err, workspaceId }, 'channel-ai: failed to build channel tools — proceeding without')
            }
        }

        const conversationalTools = { ...workspaceTools, ...channelTools } as typeof workspaceTools

        // ── Levio routing hint ──────────────────────────────────────────────
        // When Levio tools are loaded for the workspace, steer user-facing
        // task creation to `levio__create_task` so it lands in the Levio
        // inbox instead of any native/ad-hoc task path.
        const levioToolsLoaded = Object.keys(conversationalTools).some(k => k.startsWith('levio__'))
        if (levioToolsLoaded) {
            finalSystem += `\n\n=== LEVIO ROUTING ===\nLevio is connected for this workspace. For any user-facing task creation (anything the user is tracking as a to-do), call \`levio__create_task\` — do not create tasks through any other path. This ensures tasks land in the user's Levio inbox.\n=== END LEVIO ROUTING ===`
        }

        let result: Awaited<ReturnType<typeof generateText>>
        // Track vision fallback failure reason so the injected note is accurate
        let visionFailureReason: string | null = null
        if (visionFallback) {
            // When routing to a vision fallback, correct the identity in the
            // system prompt so the model doesn't falsely claim it's the primary
            // (text-only) model and refuse to describe images it CAN see.
            const visionSystem = visionFallbackModelId
                ? finalSystem.replace(
                    `model "${resolvedModelId}"`,
                    `model "${visionFallbackModelId}" (vision-capable, routed from ${resolvedModelId})`,
                )
                : finalSystem

            try {
                result = await generateText({
                    model: visionFallback,
                    system: visionSystem,
                    messages: buildMessages(true),
                    tools: conversationalTools,
                    stopWhen: stepCountIs(3),
                    abortSignal: AbortSignal.timeout(timeoutMs),
                })
            } catch (visionErr) {
                // Vision fallback failed — degrade gracefully to the primary
                // model with images stripped (user gets a text response instead
                // of a hard error).
                // Extract the real error reason so the user sees what actually
                // went wrong instead of a generic "add Groq key" message.
                const errMsg = visionErr instanceof Error ? visionErr.message : String(visionErr)
                const providerLabel = `${visionFallbackProvider ?? 'unknown'} / ${visionFallbackModelId ?? 'unknown'}`
                if (errMsg.includes('credit balance') || errMsg.includes('billing') || errMsg.includes('402')) {
                    visionFailureReason = `Vision provider ${providerLabel} has no credits remaining. Top up at the provider's billing page or add another vision-capable provider in Settings.`
                } else if (errMsg.includes('401') || errMsg.includes('403') || errMsg.includes('invalid') || errMsg.includes('expired')) {
                    visionFailureReason = `Vision provider ${providerLabel} API key is invalid or expired. Update it in Settings → AI Providers.`
                } else if (errMsg.includes('rate') || errMsg.includes('429')) {
                    visionFailureReason = `Vision provider ${providerLabel} is rate-limited. Try again in a moment.`
                } else {
                    visionFailureReason = `Vision provider ${providerLabel} failed: ${errMsg.slice(0, 120)}`
                }
                logger.warn({ err: visionErr, workspaceId, fallbackModel: visionFallbackModelId, reason: visionFailureReason }, 'channel-ai: vision fallback failed — degrading to primary without images')
                result = await routeAndCall({
                    workspaceId,
                    taskType: 'conversation',
                    settings: aiSettings,
                    doCall: async (model) => generateText({
                        model,
                        system: finalSystem,
                        messages: buildMessages(false),
                        tools: conversationalTools,
                        stopWhen: stepCountIs(3),
                        abortSignal: AbortSignal.timeout(timeoutMs),
                    }),
                    opts: fallbackOpts,
                })
            }
        } else {
            result = await routeAndCall({
                workspaceId,
                taskType: 'conversation',
                settings: aiSettings,
                doCall: async (model) => generateText({
                    model,
                    system: finalSystem,
                    messages: buildMessages(supportsVision),
                    tools: conversationalTools,
                    stopWhen: stepCountIs(3),
                    abortSignal: AbortSignal.timeout(timeoutMs),
                }),
                opts: fallbackOpts,
            })
        }

        let cleaned = stripDisclaimers(result.text ?? null)

        // ── Response quality self-check ─────────────────────────────────
        if (cleaned) {
            const { checkResponseQuality } = await import('./lib/response-quality.js')
            const qualityCheck = checkResponseQuality(cleaned, workspaceId)
            cleaned = qualityCheck.text
            if (qualityCheck.issues.length > 0) {
                logger.warn({ workspaceId, issues: qualityCheck.issues }, 'Response quality issues detected')
            }
        }

        // ── Empty-response recovery ─────────────────────────────────────
        // The model completed without error but produced no text — this can
        // happen when it only invoked tools and never generated a final
        // reply, or when the provider returned an empty completion.
        // Strategy: single retry with the fallback chain. If still empty,
        // return a graceful fallback message so the user never sees an
        // "empty response" error.
        if (!cleaned || !cleaned.trim()) {
            logger.warn({ workspaceId }, 'channel-ai: model returned empty text — attempting retry')
            try {
                const retryResult = await routeAndCall({
                    workspaceId,
                    taskType: 'conversation',
                    settings: aiSettings,
                    doCall: async (model) => generateText({
                        model,
                        system: finalSystem,
                        messages: buildMessages(supportsVision),
                        tools: conversationalTools,
                        stopWhen: stepCountIs(3),
                        abortSignal: AbortSignal.timeout(timeoutMs),
                    }),
                    opts: fallbackOpts,
                })
                cleaned = stripDisclaimers(retryResult.text ?? null)
            } catch (retryErr) {
                logger.warn({ err: retryErr, workspaceId }, 'channel-ai: empty-response retry also failed')
            }
        }

        // If still empty after retry, return a friendly fallback instead of null/null
        if (!cleaned || !cleaned.trim()) {
            logger.warn({ workspaceId }, 'channel-ai: empty text persisted after retry — returning graceful fallback')
            return { text: "I wasn't able to generate a response for that. Could you rephrase or try again?", error: 'EMPTY_RESPONSE_AFTER_RETRY' }
        }

        // ── Conversation-path quality flag: acknowledgment without action ──
        // Catches the "Got it." pattern — user asked for an action, tools were
        // available, the model called none, and the reply is a bare ack.
        try {
            const steps: any[] = Array.isArray((result as any).steps) ? (result as any).steps : []
            const toolsCalled = steps.flatMap((s: any) => s?.toolCalls ?? []).length
            const toolsAvailable = Object.keys(conversationalTools).length > 0
            const userAskedForAction = ACTION_WORDS_RE.test(msgText)
            const ackRe = /^\s*(got it|done|ok(ay)?|sure|roger|will do|on it|acknowledged|yep|yes)[\s.!,—-]*$/i
            const isBareAck = cleaned.length <= 40 && ackRe.test(cleaned.trim())
            if (userAskedForAction && toolsAvailable && toolsCalled === 0 && isBareAck) {
                logger.warn({
                    workspaceId,
                    errorCode: 'E_CONV_NO_TOOL_CALLED',
                    errorCategory: 'quality',
                    providerKey,
                    userMessage: msgText.slice(0, 200),
                    response: cleaned.slice(0, 200),
                }, 'Conversation quality flag: E_CONV_NO_TOOL_CALLED (quality)')
            }
        } catch (qerr) {
            logger.debug({ err: qerr, workspaceId }, 'channel-ai: conversation quality check errored (non-fatal)')
        }

        return { text: cleaned, error: null }
    } catch (err) {
        const raw = err instanceof Error ? err.message : String(err)
        const providerKey = aiSettings.primaryProvider

        // Structured error classification — feeds the quality/learning loop
        const classified = classifyError(raw, providerKey ?? undefined)
        logger.warn({
            workspaceId,
            providerKey,
            errorCode: classified.code,
            errorCategory: classified.category,
            recoverable: classified.recoverable,
            rawError: raw.slice(0, 300),
        }, `Channel AI error: ${classified.code} (${classified.category})`)

        // Fire-and-forget flag creation in Command Engine for the remediation
        // loop. 3s timeout — never blocks the user-facing error path.
        void postErrorFlagToCommandEngine({ workspaceId, providerKey, classified, raw })

        const userMsg = `${classified.message} [${classified.code}]`
        return { text: null, error: userMsg }
    }
}

// ── Command Engine remediation loop ──────────────────────────────────────────

/**
 * Map a TranslatedError category to a Command Engine issue_flag category.
 * CE valid categories: delivery_failure, service_outage, error_spike,
 * empty_response, duplicate_response, timeout, disk_alert, webhook_failure.
 */
function mapErrorCategoryToCEFlag(category: TranslatedError['category']): 'timeout' | 'service_outage' | 'error_spike' {
    if (category === 'timeout') return 'timeout'
    if (category === 'network') return 'service_outage'
    return 'error_spike'
}

async function postErrorFlagToCommandEngine(args: {
    workspaceId: string
    providerKey: string | null
    classified: TranslatedError
    raw: string
}): Promise<void> {
    try {
        const url = (process.env.COMMAND_ENGINE_URL ?? 'http://infra-command-engine:3001').replace(/\/+$/, '')
            + '/api/v1/cmd-center/flags/ingest'
        const instanceId = process.env.PLEXO_INSTANCE_ID ?? args.workspaceId
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            'X-Instance-Id': instanceId,
        }
        const serviceKey = process.env.TELEMETRY_SERVICE_KEY
        if (serviceKey) headers['X-Service-Key'] = serviceKey

        const severity = args.classified.recoverable ? 'warning' : 'critical'
        const category = mapErrorCategoryToCEFlag(args.classified.category)
        const body = {
            severity,
            category,
            title: `Plexo API: ${args.classified.code}`,
            detail: `${args.classified.message}\n\nRaw: ${args.raw.slice(0, 400)}`,
            source_service: 'plexo-api',
            source_id: args.workspaceId,
            metadata: {
                provider: args.providerKey,
                error_code: args.classified.code,
                error_category: args.classified.category,
                recoverable: args.classified.recoverable,
            },
        }
        await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(3_000),
        }).catch(() => { /* fire-and-forget */ })
    } catch (err) {
        logger.debug({ err, workspaceId: args.workspaceId }, 'command-engine flag post failed (non-fatal)')
    }
}

// ── Project naming ───────────────────────────────────────────────────────────

/**
 * Generate a short, official project name for a sprint request via the
 * workspace's configured AI provider (routed through Plexo). Returns a clean
 * 2–6 word title. Used by every project-creation path so projects get real
 * names instead of the raw request sentence.
 *
 * Deliberately uses a focused, tool-free routed call — NOT chatWithAI — because
 * chatWithAI injects the full workspace context (tools, memory, capability
 * summary, introspection) which derails small models into echoing the request.
 * A tight prompt + small token cap keeps the output to a real title; the
 * fallback derives a short name from the request's leading words and is never
 * the full sentence.
 */
const NAME_PROJECT_SYSTEM =
    'You name work/software projects. Given a request, reply with ONLY a concise Title Case project name of 2 to 6 words. '
    + 'No quotes, no punctuation, no explanation, and never restate the full request. '
    + 'Examples: "Q2 Social Media Campaign", "HTML Snake Game", "Landing Page Build".'

function fallbackProjectName(request: string): string {
    const cleaned = request.replace(/[\s.]+$/, '').trim()
    const words = cleaned.split(/\s+/).slice(0, 6).join(' ')
    return words.slice(0, 60) || 'Untitled Project'
}

export async function nameProject(workspaceId: string, request: string): Promise<string> {
    const fallback = fallbackProjectName(request)
    try {
        const { aiSettings } = await loadWorkspaceAISettings(workspaceId)
        if (!aiSettings) return fallback
        const result = await routeAndCall({
            workspaceId,
            taskType: 'conversation',
            settings: aiSettings,
            doCall: (model) => callModel({
                model,
                workspaceId,
                taskType: 'project-naming',
                maxTokens: 16,
                system: NAME_PROJECT_SYSTEM,
                prompt: request,
            }),
        })
        const name = (result.text ?? '').replace(/["']/g, '').replace(/[\s.]+$/, '').trim()
        const wordCount = name ? name.split(/\s+/).length : 0
        const echoed = name.toLowerCase() === request.replace(/[\s.]+$/, '').trim().toLowerCase()
        if (name.length >= 3 && name.length <= 60 && wordCount <= 8 && !echoed) return name
    } catch { /* fall through to derived fallback */ }
    return fallback
}

// ── Intent classification ────────────────────────────────────────────────────

/**
 * System prompt shared by all channel adapters for 3-way intent classification.
 *
 * Kept deliberately small. The Groq free tier (llama-3.1-8b-instant) has a
 * 6000 TPM budget — every extra token in this prompt increases the chance
 * of a rate-limit failure. The pre-classifier in principles.ts handles the
 * obvious cases; the LLM only sees ambiguous ones.
 */
// Classifier prompt lives in the unified builder. Kept as a re-exported
// constant so existing imports stay compatible with tests and any external
// probe code that used it directly.
export const CHANNEL_CLASSIFY_SYSTEM = buildClassifierPrompt()

/**
 * Circuit breaker for the LLM classifier. After N consecutive failures we
 * skip the LLM call entirely for COOLDOWN_MS and rely on the rule-based
 * fallback. This prevents 5-minute cascades when every provider in the
 * fallback chain is rate-limited or down.
 *
 * State is per-workspace so a noisy provider in one workspace doesn't degrade
 * classification for all others.
 */
const CLASSIFIER_BREAKER_THRESHOLD = 3
const CLASSIFIER_BREAKER_COOLDOWN_MS = 5 * 60 * 1000 // 5 minutes

interface BreakerState {
    consecutiveFailures: number
    openedAt: number
}

const classifierBreakerMap = new Map<string, BreakerState>()

function getBreakerState(workspaceId: string): BreakerState {
    let state = classifierBreakerMap.get(workspaceId)
    if (!state) {
        state = { consecutiveFailures: 0, openedAt: 0 }
        classifierBreakerMap.set(workspaceId, state)
    }
    return state
}

function classifierBreakerOpen(workspaceId: string): boolean {
    const state = getBreakerState(workspaceId)
    if (state.consecutiveFailures < CLASSIFIER_BREAKER_THRESHOLD) return false
    if (Date.now() - state.openedAt > CLASSIFIER_BREAKER_COOLDOWN_MS) {
        // Cooldown elapsed — allow one probe attempt
        state.consecutiveFailures = 0
        state.openedAt = 0
        return false
    }
    return true
}

function recordClassifierFailure(workspaceId: string): void {
    const state = getBreakerState(workspaceId)
    state.consecutiveFailures++
    if (state.consecutiveFailures === CLASSIFIER_BREAKER_THRESHOLD) {
        state.openedAt = Date.now()
    }
}

function recordClassifierSuccess(workspaceId: string): void {
    const state = getBreakerState(workspaceId)
    state.consecutiveFailures = 0
    state.openedAt = 0
}

/**
 * Rule-based fallback classification. Used when the LLM classifier fails
 * or is skipped by the circuit breaker. Errs toward CONVERSATION to avoid
 * the "You there? → 25-step task" disaster.
 */
function ruleBasedClassify(message: string): IntentLabel {
    const trimmed = message.trim()
    if (!trimmed) return 'CONVERSATION'

    // Obvious task with concrete target (file path, URL, etc.)
    if (isObviousTaskRequest(trimmed)) return 'TASK'

    // Very short (no action verb) → conversational
    if (trimmed.length < 50) {
        const lower = trimmed.toLowerCase()
        const hasTaskVerb = /\b(deploy|build|create|write|fix|update|install|configure|implement|migrate|generate|run|execute|push|merge|commit|delete|remove|add|connect|refactor|optimize|research|investigate|search|find)\b/.test(lower)
        if (!hasTaskVerb) return 'CONVERSATION'
    }

    // Interrogative sentence → conversational
    if (/^(what|who|why|how|when|where|which|tell\s+me|explain|describe)\b/i.test(trimmed)) {
        return 'CONVERSATION'
    }

    // Default: conversation (safer than creating a runaway task)
    return 'CONVERSATION'
}

/** Check if a message that defaulted to CONVERSATION might actually be a task request. */
function looksLikeTask(message: string): boolean {
    return message.length > 100 || ACTION_WORDS_RE.test(message)
}

/**
 * Trim history for the classifier LLM call. We only need the last few turns
 * of context to disambiguate follow-ups, and each message is capped at 400
 * chars. This keeps total tokens well under Groq's 6000 TPM budget.
 */
function trimHistoryForClassifier(history: ChatMessage[]): ChatMessage[] {
    const last = history.slice(-4)
    return last.map((m) => ({
        role: m.role,
        content: m.content.length > 400
            ? m.content.slice(0, 200) + ' … ' + m.content.slice(-150)
            : m.content,
    }))
}

/**
 * Parse a classifier LLM response into an IntentLabel. Handles both the
 * JSON format and the legacy single-word format. Returns null on parse
 * failure so the caller can distinguish "no usable response" from
 * "successfully parsed CONVERSATION".
 */
function parseClassifierResponse(
    resText: string,
    workspaceId: string,
): { intent: IntentLabel; confidence: number } | null {
    if (!resText) return null
    // Pull the first JSON object out of the response — many small models
    // wrap their JSON in prose even when told not to.
    const jsonMatch = resText.match(/\{[\s\S]*?\}/)
    if (jsonMatch) {
        try {
            const parsed = JSON.parse(jsonMatch[0]) as { classification?: string; confidence?: number }
            const classification = parsed.classification?.toUpperCase()
            const confidence = parsed.confidence ?? 0
            if (confidence < 0.72 && classification !== 'CONVERSATION') {
                logger.info({ workspaceId, classification, confidence }, 'Intent below confidence threshold — defaulting to CONVERSATION')
                return { intent: 'CONVERSATION', confidence }
            }
            let intent: IntentLabel = 'CONVERSATION'
            if (classification === 'TASK') intent = 'TASK'
            else if (classification === 'PROJECT') intent = 'PROJECT'
            return { intent, confidence }
        } catch {
            // fall through to legacy parse
        }
    }
    const upper = resText.toUpperCase()
    if (upper.startsWith('TASK')) return { intent: 'TASK', confidence: 0.8 }
    if (upper.startsWith('PROJECT')) return { intent: 'PROJECT', confidence: 0.8 }
    if (upper.startsWith('CONVERSATION')) return { intent: 'CONVERSATION', confidence: 0.8 }
    return null
}

/**
 * Classify the last user message in a conversation history as TASK / PROJECT / CONVERSATION.
 *
 * Pipeline:
 *   1. Rule-based pre-classifier (greetings, short knowledge questions,
 *      conversational continuations) — zero LLM cost, zero latency.
 *   2. Obvious-task fast-path (task verb + file/URL reference).
 *   3. Circuit breaker check — if the LLM classifier has failed 3x in a
 *      row, skip straight to the rule-based fallback for 5 minutes.
 *   4. LLM classifier with trimmed history, lean system prompt, 5s
 *      timeout, tools disabled, fallback chain via withFallback().
 *   5. On any LLM failure → rule-based fallback (which errs toward
 *      CONVERSATION).
 *
 * The critical invariant: this function NEVER lets a simple "You there?"
 * message become a 25-step runaway task. When in doubt, CONVERSATION.
 */
export async function classifyIntent(
    workspaceId: string,
    history: ChatMessage[],
): Promise<ClassifyResult> {
    const lastMessage = history[history.length - 1]?.content ?? ''
    const hasHistory = history.length > 1

    // ── 1. Rule-based pre-classifier ──────────────────────────────────
    if (forceConversationOverrideWithContext(lastMessage, hasHistory)) {
        logger.info({ workspaceId, message: lastMessage.slice(0, 60) }, 'Intent forced to CONVERSATION by principle override')
        emitClassifierDecision({ intent: 'CONVERSATION', confidence: 1.0, source: 'channel', overridden: true, modelFamily: 'none' })
        return { intent: 'CONVERSATION', suggestTask: false }
    }

    // ── 2. Obvious-task fast-path ─────────────────────────────────────
    if (isObviousTaskRequest(lastMessage)) {
        logger.info({ workspaceId, message: lastMessage.slice(0, 60) }, 'Intent forced to TASK by obvious-task fast-path')
        const intent = enforceSmallestAction('TASK', lastMessage)
        emitClassifierDecision({ intent, confidence: 0.95, source: 'channel', overridden: true, modelFamily: 'rule' })
        return { intent, suggestTask: false }
    }

    // ── 2.5. Memory instruction pre-classifier ────────────────────────
    // Mirrors the isObviousMemory check in chat.ts. When the user opens
    // with "remember", "always", "never", or "don't", the message is a
    // persistent behavioral instruction, not a task or conversational
    // request. We return CONVERSATION + isMemoryInstruction so channel
    // adapters can persist it via rememberInstruction without routing to
    // chatWithAI or the task queue.
    if (/^(remember|always|never|don'?t|dont)\s/i.test(lastMessage.trim())) {
        logger.info({ workspaceId, message: lastMessage.slice(0, 60) }, 'Intent identified as MEMORY instruction by pre-classifier')
        emitClassifierDecision({ intent: 'CONVERSATION', confidence: 1.0, source: 'channel', overridden: true, modelFamily: 'none' })
        return { intent: 'CONVERSATION', suggestTask: false, isMemoryInstruction: true }
    }

    // ── 3. Circuit breaker ────────────────────────────────────────────
    if (classifierBreakerOpen(workspaceId)) {
        const fallbackIntent = ruleBasedClassify(lastMessage)
        logger.warn({ workspaceId, fallbackIntent, message: lastMessage.slice(0, 60) }, 'Classifier circuit breaker OPEN — using rule-based fallback')
        const intent = enforceSmallestAction(fallbackIntent, lastMessage)
        emitClassifierDecision({ intent, confidence: 0.6, source: 'channel', overridden: true, modelFamily: 'rule-breaker' })
        return { intent, suggestTask: intent === 'CONVERSATION' && looksLikeTask(lastMessage) }
    }

    // ── 4. LLM classifier (lean path) ─────────────────────────────────
    const { credential, aiSettings } = await loadWorkspaceAISettings(workspaceId)
    if (!credential || !aiSettings) {
        const fallbackIntent = ruleBasedClassify(lastMessage)
        const intent = enforceSmallestAction(fallbackIntent, lastMessage)
        emitClassifierDecision({ intent, confidence: 0.5, source: 'channel', overridden: true, modelFamily: 'rule-no-provider' })
        return { intent, suggestTask: intent === 'CONVERSATION' && looksLikeTask(lastMessage) }
    }

    const trimmedHistory = trimHistoryForClassifier(history)
    const classifyMessages = trimmedHistory.map((m) => ({ role: m.role, content: m.content }))

    try {
        const result = await routeAndCall({
            workspaceId,
            taskType: 'classification',
            settings: aiSettings,
            doCall: async (model) => generateText({
                model,
                system: CHANNEL_CLASSIFY_SYSTEM,
                messages: classifyMessages,
                // NO tools — classification is a pure text task. Passing
                // workspace tools here is what blew past the 6000 TPM cap.
                // Max output is small: {"classification":"...","confidence":0.95}
                abortSignal: AbortSignal.timeout(5_000),
            }),
        })
        const resText = result.text?.trim() ?? ''
        const parsed = parseClassifierResponse(resText, workspaceId)
        if (!parsed) {
            recordClassifierFailure(workspaceId)
            const fallbackIntent = ruleBasedClassify(lastMessage)
            logger.warn({ workspaceId, resText: resText.slice(0, 120), looksLikeTask: looksLikeTask(lastMessage) }, 'Classifier returned unparseable response — using rule-based fallback')
            const intent = enforceSmallestAction(fallbackIntent, lastMessage)
            emitClassifierDecision({ intent, confidence: 0.5, source: 'channel', overridden: true, modelFamily: 'rule-parse-fail' })
            return { intent, suggestTask: intent === 'CONVERSATION' && looksLikeTask(lastMessage) }
        }
        recordClassifierSuccess(workspaceId)
        const preOverride = parsed.intent
        const intent = enforceSmallestAction(parsed.intent, lastMessage)
        emitClassifierDecision({ intent, confidence: parsed.confidence, source: 'channel', overridden: preOverride !== intent, modelFamily: 'unknown' })
        return { intent, suggestTask: false }
    } catch (err) {
        recordClassifierFailure(workspaceId)
        const raw = err instanceof Error ? err.message : String(err)
        const isRateLimit = /rate limit|429|too many requests|request too large|tpm/i.test(raw)
        logger.warn(
            { workspaceId, err: raw.slice(0, 200), isRateLimit, consecutiveFailures: getBreakerState(workspaceId).consecutiveFailures, looksLikeTask: looksLikeTask(lastMessage) },
            'Classifier LLM call failed — using rule-based fallback',
        )
        const fallbackIntent = ruleBasedClassify(lastMessage)
        const intent = enforceSmallestAction(fallbackIntent, lastMessage)
        emitClassifierDecision({
            intent,
            confidence: 0.5,
            source: 'channel',
            overridden: true,
            modelFamily: isRateLimit ? 'rule-ratelimit' : 'rule-error',
        })
        return { intent, suggestTask: intent === 'CONVERSATION' && looksLikeTask(lastMessage) }
    }
}

// ── Cross-session memory recall ──────────────────────────────────────────────

/** Recall patterns that signal the user wants to resume a prior conversation. */
export const RECALL_PATTERNS = [
    /continue\s+where/i,
    /pick\s+up\s+where/i,
    /\bresume\b/i,
    /we\s+were\s+talking\s+about/i,
    /earlier\s+conversation/i,
    /previous\s+conversation/i,
    /go\s+back\s+to/i,
    /that\s+conversation\s+about/i,
    /where\s+I\s+asked\s+about/i,
    /where\s+I\s+requested/i,
    // Casual recall references
    /\bremember\b/i,
    /you\s+(didn'?t|never)\s+(answer|respond|reply|finish)/i,
    /what\s+happened\s+to/i,
    /you\s+were\s+(going\s+to|supposed\s+to|working\s+on)/i,
    /what\s+about\s+(that|the)\b/i,
    /try\s+again/i,
    /last\s+time/i,
    /before\s+(you|we)\s+(stopped|left\s+off)/i,
]

/** Check whether a message signals recall intent. */
export function hasRecallIntent(text: string): boolean {
    return RECALL_PATTERNS.some(p => p.test(text))
}

/** Detect "when was the first / what was our earliest / since the beginning" queries. */
function isFirstConversationQuery(query: string): boolean {
    return /\b(first|earliest|oldest|very\s+first|when\s+did\s+we\s+(first|start|begin|meet)|when\s+was\s+(the\s+)?first|beginning|initially|original|origin|how\s+long\s+(have\s+we|ago))\b/i.test(query)
}

// ── Chat history helper ──────────────────────────────────────────────────────

/** Maximum TURNS (user+assistant pairs) kept per conversation thread. */
const MAX_HISTORY_TURNS = 20
/**
 * Maximum individual messages per thread (2 per turn).
 * The DB hydration limit is MAX_HISTORY_TURNS (rows); this constant governs
 * the in-memory trim so exactly 20 full turns (40 messages) are kept.
 */
const MAX_HISTORY = MAX_HISTORY_TURNS * 2

/** Remove consecutive same-role messages by merging them. DeepSeek and some providers reject these. */
function dedupeRoles(messages: ChatMessage[]): ChatMessage[] {
    const result: ChatMessage[] = []
    for (const m of messages) {
        if (result.length > 0 && result[result.length - 1]!.role === m.role) {
            result[result.length - 1]!.content += '\n' + m.content
        } else {
            result.push({ ...m })
        }
    }
    return result
}

/**
 * Chat history with DB-backed hydration on first access.
 *
 * Each channel adapter composes its own key (e.g. `slack:team:channel:ts`,
 * `discord:guild:channel`, `telegram:channelId:chatId`) but the storage
 * mechanics are identical and shared here.
 *
 * On process restart the in-memory store is empty. When `getOrHydrate()`
 * is called with a sessionId, it loads the most recent turns from the
 * conversations table so multi-turn context survives restarts.
 */
export class ChannelChatHistory {
    private store = new Map<string, ChatMessage[]>()
    private hydrated = new Set<string>()

    get(key: string): ChatMessage[] | undefined {
        return this.store.get(key)
    }

    /**
     * Return cached history, or hydrate from DB if this is the first access
     * after a restart. `sessionPrefix` is the prefix before the epoch
     * (e.g. `telegram:ch:chat:` — note trailing colon). Hydration loads
     * the most recent session matching this prefix so epoch resets on
     * restart don't lose context.
     */
    async getOrHydrate(key: string, workspaceId: string, sessionPrefix: string): Promise<ChatMessage[]> {
        // Guard on `hydrated` (not `store.has`) — addToHistory may seed the store
        // before we get here, which would cause the old store.has() check to skip
        // DB hydration entirely. After a restart mid-conversation the store holds
        // only the current user message (length 1), so history.length guards that
        // depend on conversation depth would fire incorrectly (ghost responses).
        if (this.hydrated.has(key)) return this.store.get(key) ?? []

        this.hydrated.add(key)
        // Capture any messages already in the store (e.g. the current user message
        // added by addToHistory before hydration), so we can append them after loading
        // prior turns from the DB.
        const preSeeded = this.store.get(key) ?? []
        try {
            const { db } = await import('@plexo/db')
            const { conversations } = await import('@plexo/db')
            const { desc, sql } = await import('@plexo/db')
            const rows = await db.select({ message: conversations.message, reply: conversations.reply })
                .from(conversations)
                .where(sql`${conversations.workspaceId} = ${workspaceId} AND ${conversations.sessionId} LIKE ${sessionPrefix + '%'}`)
                .orderBy(desc(conversations.createdAt))
                .limit(MAX_HISTORY_TURNS)

            const hist: ChatMessage[] = []
            for (const r of rows.reverse()) {
                if (r.message) hist.push({ role: 'user', content: r.message })
                if (r.reply) hist.push({ role: 'assistant', content: r.reply })
            }
            // Merge: DB history (older turns) followed by any pre-seeded messages
            // (the current in-flight user message). Dedupe roles for provider compat.
            const merged = dedupeRoles([...hist, ...preSeeded])
            if (merged.length > MAX_HISTORY) merged.splice(0, merged.length - MAX_HISTORY)
            this.store.set(key, merged)
            logger.info({ key, turns: merged.length, fromDb: hist.length, preSeeded: preSeeded.length }, 'Hydrated chat history from DB')
            return merged
        } catch (err) {
            logger.warn({ err, key }, 'Failed to hydrate chat history from DB — starting fresh')
            return preSeeded
        }
    }

    add(key: string, role: 'user' | 'assistant', content: string, imageUrls?: string[]): void {
        const hist = this.store.get(key) ?? []
        // Prevent consecutive same-role messages (DeepSeek and some providers reject these)
        if (hist.length > 0 && hist[hist.length - 1]!.role === role) {
            // Merge into the last message of the same role
            hist[hist.length - 1]!.content += '\n' + content
            if (imageUrls?.length) {
                const existing = hist[hist.length - 1]!.imageUrls ?? []
                hist[hist.length - 1]!.imageUrls = [...existing, ...imageUrls]
            }
        } else {
            hist.push({ role, content, ...(imageUrls?.length ? { imageUrls } : {}) })
        }
        if (hist.length > MAX_HISTORY) hist.splice(0, hist.length - MAX_HISTORY)
        this.store.set(key, hist)
    }

    delete(key: string): void {
        this.store.delete(key)
        this.hydrated.delete(key)
    }
}
