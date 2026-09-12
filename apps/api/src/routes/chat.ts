// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Webchat API
 *
 * POST /api/chat/message  — Accept a user message, classify intent:
 *   CONVERSATION → direct AI reply (no task queued)
 *   TASK → queue a task, return taskId for polling
 * GET  /api/chat/reply/:taskId — Poll for agent reply (returns when complete)
 * GET  /api/chat/widget.js — Serve the embeddable chat widget script
 *
 * The widget is injected via:
 *   <script src="https://your-api/api/chat/widget.js"
 *           data-workspace="<wsId>" data-site-name="My App"
 *   ></script>
 */
import { Router, type Router as RouterType } from 'express'
import { ulid } from 'ulid'
import * as chatRepo from '../repositories/chat.repository.js'
import * as workspacesRepo from '../repositories/workspaces.repository.js'
import { logger } from '../logger.js'
import { recordMemoryRecall } from '../lib/metrics.js'
import { trackDelivery } from '../delivery-tracker.js'
import { pushTask } from '@plexo/queue'
import { emitToWorkspace } from '../sse-emitter.js'
import { generateText, streamText, stepCountIs } from 'ai'
import { PROVIDER_DEFAULT_MODELS, buildModel } from '@plexo/agent/providers/registry'
import { routeAndCall } from '@plexo/agent/providers/router-v2'
import { modelSupportsVision, findVisionCapableModel, GROQ_FREE_VISION_MODEL } from '@plexo/agent/providers/vision'
import { loadWorkspaceAISettings } from '../agent-loop.js'
import { storeMemory, rememberInstruction } from '@plexo/agent/memory/store'
import { detectCredentialMessage, autoInstallConnection } from '../credential-setup.js'
import { setPreference } from '@plexo/agent/memory/preferences'
import {
    recordConversation,
    updateConversationById,
    linkTaskToConversation,
    getSessionChannelRef,
    replyToChannel,
    getSessionTurns,
    getCrossSessionTurns,
} from '../conversation-log.js'
import { resolveSessionId as resolveUniversalSession, embedMessage as embedSessionMessage } from '../lib/session-resolver.js'
import { buildConversationSystemPrompt, translateErrorForUser } from '../channel-ai.js'
import { WEBCHAT_CLASSIFY_SYSTEM } from '@plexo/agent/prompts/build-system-prompt'
import { buildTools, wireSubagentRunner } from '@plexo/agent/executor'
import type { ExecutionContext, StepEvent } from '@plexo/agent/types'
import { getTelegramToken } from './telegram.js'
import { preClassifyIntent } from './chat-intent.js'
import { validateImages } from '../application/chat/validateImages.js'
import { resolveHeuristicIntent, parseClassifyResponse } from '../application/chat/classifyIntent.js'
import { persistTurn } from '../application/chat/persistTurn.js'
import { trackError, trackEvent } from '../event-tracker.js'
import { UUID_RE } from '../validation.js'
import { ensureWorkspaceAccess } from '../middleware/workspace-access.js'
import { audit } from '../audit.js'
import { isTrivialMessage, buildTrivialSystemPrompt, FASTPATH_MODEL } from '../lib/trivial-message.js'
import { getCachedToolSet } from '../lib/tool-set-cache.js'
import { describeToolCall } from '../utils/tool-labels.js'
import type { FallbackOptions } from '@plexo/agent/providers/registry'
import { hasInstructionIntent, persistInstruction, extractConversationMemory } from '@plexo/agent/memory/conversation-bridge'
import { resolveModelOverride, composeSystemPrompt } from './chat-overrides.js'
import * as conversationsRepo from '../repositories/conversations.repository.js'

export const chatRouter: RouterType = Router()

// Inline streaming agent-loop step ceiling. The model can call tools and
// continue multi-turn over a single SSE response up to this many steps.
// Configurable via PLEXO_CHAT_INLINE_STEP_LIMIT for operators who want a
// tighter/looser ceiling.
const INLINE_STEP_LIMIT = Math.max(1, Number(process.env.PLEXO_CHAT_INLINE_STEP_LIMIT) || 25)

// Code tools exposed to the inline streaming chat path (mirror of the executor
// task-path toolset, minus task_complete/write_asset/delegate — those are
// queue-specific and don't belong in an inline conversational turn).
const INLINE_CODE_TOOLS = ['read_file', 'write_file', 'edit_file', 'grep', 'glob', 'shell'] as const

// ── Per-session mutex ────────────────────────────────────────────────────────
// Prevents concurrent message processing for the same session, which would
// cause race conditions on session resolution, duplicate provider calls, and
// conversation history corruption (FUN-001). Extracted to
// application/chat/sessionLock.ts so the chain semantics are unit-testable.
import { withSessionLock } from '../application/chat/sessionLock.js'

/** Build fallback options with auth-failure notification for a workspace. */
function fallbackOpts(workspaceId: string): FallbackOptions {
    return {
        workspaceId,
        onAuthFailure: (provider, error) => {
            logger.warn({ workspaceId, provider, error }, 'Provider auth failed — removed from fallback chain')
            emitToWorkspace(workspaceId, {
                type: 'provider_auth_error',
                provider,
                message: `API key for "${provider}" is invalid or expired. Update it in Settings → AI Providers.`,
            })
        },
    }
}

// ── Progress event helpers (for the agent-thinking panel) ────────────────────

/** Keys that should never be leaked to the UI from tool args. */
const REDACT_KEYS = new Set([
    'token', 'access_token', 'refresh_token', 'bearer',
    'api_key', 'apikey', 'secret', 'password', 'passwd',
    'authorization', 'auth', 'credential', 'credentials',
    'private_key', 'client_secret', 'session_token',
])

function redactInput(input: unknown): unknown {
    if (input === null || typeof input !== 'object') return input
    if (Array.isArray(input)) return input.map(redactInput)
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
        if (REDACT_KEYS.has(k.toLowerCase())) {
            out[k] = '[REDACTED]'
        } else if (typeof v === 'object' && v !== null) {
            out[k] = redactInput(v)
        } else if (typeof v === 'string' && v.length > 2_000) {
            out[k] = `${v.slice(0, 2_000)}…`
        } else {
            out[k] = v
        }
    }
    return out
}

function truncate(s: string, n: number): string {
    if (s.length <= n) return s
    return `${s.slice(0, n)}…`
}

function prettyToolTitle(tool: string, input: unknown): string {
    const desc = describeToolCall(tool, (input ?? {}) as Record<string, unknown>)
    return desc.charAt(0).toUpperCase() + desc.slice(1)
}

// ── Error classification ──────────────────────────────────────────────────────

interface ClassifiedError {
    type: string
    message: string        // human-readable, safe to show users
    fixUrl: string         // route inside Plexo that fixes this
    fixLabel: string       // link label
    technical: string      // raw error — shown in collapsible details
}

function classifyAIError(err: unknown): ClassifiedError {
    const raw = err instanceof Error ? err.message : String(err)
    const errName = err instanceof Error ? err.name : ''
    const lower = raw.toLowerCase()
    const technical = raw.slice(0, 300)

    // Router-v2 typed errors — surfaced from routeAndCall when the selector
    // can't find a candidate that meets the quality bar, or the cascade
    // exhausts.
    if (errName === 'RouterV2NoCandidateError') {
        if (lower.includes('high-stakes') || lower.includes('quality bar') || lower.includes('operator action')) {
            return { type: 'no_quality_provider', message: 'No high-quality provider available for this task. Add an OpenAI, Anthropic, or DeepSeek key in Settings → AI Providers, or top up an existing provider that ran out of credit.', fixUrl: '/settings/ai-providers', fixLabel: 'Add or top up provider', technical }
        }
        return { type: 'no_provider', message: 'No AI provider is configured for this workspace task type. Add one in Settings → AI Providers.', fixUrl: '/settings/ai-providers', fixLabel: 'Configure AI provider', technical }
    }
    if (errName === 'RouterV2CascadeExhausted') {
        // The router preserves the most actionable error (auth/quota) across the
        // cascade. Reclassify from it so the user sees "top up balance" / "fix
        // your key" instead of the generic chain-exhausted message.
        const cause = (err as { lastError?: unknown }).lastError
        if (cause instanceof Error) {
            const cMsg = cause.message.toLowerCase()
            if (cMsg.includes('insufficient balance') || cMsg.includes('insufficient_balance') || cMsg.includes('out of credit') || cMsg.includes('credit balance') || cMsg.includes('no credit') || /\b402\b/.test(cMsg)) {
                return { type: 'balance_exhausted', message: "Your AI provider's account balance is empty. Top it up on the provider's dashboard, then retry.", fixUrl: '/settings/ai-providers', fixLabel: 'Top up balance', technical: cause.message.slice(0, 300) }
            }
            if (cMsg.includes('unauthorized') || cMsg.includes('invalid api key') || cMsg.includes('invalid_api_key') || cMsg.includes('authentication') || cMsg.includes('401') || cMsg.includes('403')) {
                return { type: 'invalid_api_key', message: 'Your API key was rejected by the provider. Update it in Settings → AI Providers.', fixUrl: '/settings/ai-providers', fixLabel: 'Update API key', technical: cause.message.slice(0, 300) }
            }
        }
        return { type: 'cascade_exhausted', message: "Every provider in this workspace's chain failed in a row. Try again in a moment, or add a fresh provider in Settings.", fixUrl: '/settings/ai-providers', fixLabel: 'Add another provider', technical }
    }
    if (errName === 'RouterV2CallError' || lower.includes('parse-malformed') || (lower.includes('no object generated') && lower.includes('json'))) {
        return { type: 'parse_malformed', message: "The model returned malformed output and there's no fallback provider to retry on. Add a second provider in Settings so this task can retry on a different model.", fixUrl: '/settings/ai-providers', fixLabel: 'Add fallback provider', technical }
    }

    if (lower.includes('401') || lower.includes('unauthorized') || lower.includes('invalid api key') || lower.includes('invalid_api_key') || lower.includes('authentication failed')) {
        return { type: 'invalid_api_key', message: 'Your API key was rejected. It may be wrong, expired, or for a different provider.', fixUrl: '/settings/ai-providers', fixLabel: 'Update API key', technical }
    }
    if (lower.includes('403') || lower.includes('forbidden') || lower.includes('permission denied') || lower.includes('access denied')) {
        return { type: 'forbidden', message: "Access denied by the provider. Your account may lack access to this model or feature.", fixUrl: '/settings/ai-providers', fixLabel: 'Check provider plan', technical }
    }
    if (lower.includes('429') || lower.includes('rate limit') || lower.includes('too many requests') || lower.includes('quota exceeded') || lower.includes('exceeded your current quota')) {
        return { type: 'rate_limit', message: 'Rate limit or quota reached on your AI provider. Wait a moment or switch to a fallback provider.', fixUrl: '/settings/ai-providers', fixLabel: 'Configure fallback chain', technical }
    }
    if (lower.includes('405') || lower.includes('method not allowed')) {
        return { type: 'method_not_allowed', message: "The provider rejected the request method. This usually means the Base URL is wrong or points to the wrong endpoint.", fixUrl: '/settings/ai-providers', fixLabel: 'Check provider URL', technical }
    }
    if ((lower.includes('model') || lower.includes('engine')) && (lower.includes('not found') || lower.includes('does not exist') || lower.includes('invalid model') || lower.includes('no such model'))) {
        return { type: 'model_not_found', message: "The selected model wasn't found on this provider. It may have been renamed, removed, or your plan doesn't include it.", fixUrl: '/settings/ai-providers', fixLabel: 'Change default model', technical }
    }
    if (lower.includes('timeout') || lower.includes('aborted') || lower.includes('etimedout') || lower.includes('econnreset') || lower.includes('econnrefused')) {
        return { type: 'timeout', message: "The provider didn't respond in time. It may be down, overloaded, or unreachable from your server.", fixUrl: '/settings/ai-providers', fixLabel: 'Check provider or switch', technical }
    }
    if (lower.includes('no ai provider') || lower.includes('not configured') || lower.includes('plexo_encryption_key') || lower.includes('encryption_secret')) {
        return { type: 'no_provider', message: 'No AI provider is configured for this workspace. Add and verify one in Settings → AI Providers.', fixUrl: '/settings/ai-providers', fixLabel: 'Configure AI provider', technical }
    }
    if (lower.includes('insufficient balance') || lower.includes('out of credit') || lower.includes('insufficient_balance') || lower.includes('balance exhausted') || lower.includes('no credit')) {
        return { type: 'balance_exhausted', message: "Your AI provider's account balance is empty. Top it up on the provider's dashboard, then retry.", fixUrl: '/settings/ai-providers', fixLabel: 'Top up balance', technical }
    }
    if (lower.includes('billing') || lower.includes('payment') || lower.includes('insufficient_quota') || lower.includes('delinquent')) {
        return { type: 'billing', message: "Your AI provider account has a billing issue. Check your billing status on the provider's dashboard.", fixUrl: '/settings/ai-providers', fixLabel: 'Check provider settings', technical }
    }
    if (lower.includes('content') && (lower.includes('filter') || lower.includes('policy') || lower.includes('safety') || lower.includes('moderation'))) {
        return { type: 'content_policy', message: "The request was blocked by the provider's content policy. Try rephrasing.", fixUrl: '/settings/agent', fixLabel: 'Adjust agent settings', technical }
    }

    return { type: 'unknown', message: `The AI provider returned an error. ${raw.slice(0, 120)}`, fixUrl: '/settings/ai-providers', fixLabel: 'Check AI Provider settings', technical }
}


// Per-session conversation history now fetched dynamically per request from DB
// to ensure persistence and full context even if the agent server restarts.
// ── POST /api/chat/message ────────────────────────────────────────────────────

chatRouter.post('/message', async (req, res) => {
    const { workspaceId, message, sessionId: clientSessionId, forceConversation, images, newSession, background, modelOverride: bodyModelOverride, systemPromptOverride: bodySystemPromptOverride } = req.body as {
        workspaceId?: string
        message?: string
        sessionId?: string
        forceConversation?: boolean
        images?: Array<{ data: string; mimeType: string; name: string }>
        newSession?: boolean
        background?: boolean
        modelOverride?: string | null
        systemPromptOverride?: string | null
    }
    // Mutable sessionId — starts as what the client sent, gets replaced by
    // the universal resolver once we know the message text. We still load
    // history against the client-supplied value so the UI thread is stable.
    let sessionId: string | undefined = clientSessionId
    // Embedding of the current message, populated by the resolver and passed
    // through to recordConversation so the running session topic is kept fresh.
    let _resolvedEmbedding: number[] | null = null

    if (!workspaceId || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE', message: 'Valid workspaceId required' } })
        return
    }
    if (!await ensureWorkspaceAccess(req, res, workspaceId)) return

    // Validate images (raster only — SVG and PDF are handled client-side as extracted text)
    const imagesResult = validateImages(images)
    if (!imagesResult.ok) {
        res.status(400).json({ error: { code: imagesResult.code, message: imagesResult.message } })
        return
    }
    const validImages = imagesResult.validImages

    const hasImages = validImages.length > 0
    const textMessage = (message ?? '').trim()

    if (!hasImages && textMessage.length === 0) {
        res.status(400).json({ error: { code: 'MISSING_MESSAGE', message: 'message or images required' } })
        return
    }
    if (textMessage.length > 100_000) {
        res.status(400).json({ error: { code: 'MESSAGE_TOO_LONG', message: 'Max 100,000 characters (including attached document text)' } })
        return
    }

    // Lock key uses the client-supplied sessionId (before resolution) so
    // concurrent messages from the same browser tab serialise correctly.
    const lockKey = `${workspaceId}:${clientSessionId || 'new'}`

    await withSessionLock(lockKey, async () => {
    // Persist-pending-then-backfill: one durable row per turn, hoisted so the
    // outer catch can settle it even when a model call throws/aborts.
    let conversationId: string | null = null
    let turnSettled = false
    let intent: 'TASK' | 'PROJECT' | 'MEMORY' | 'CONVERSATION' = 'CONVERSATION'
    let trimmedMsg = ''
    try {
        // ── Parallel load: workspace + AI settings + session history ──────────
        // These are all independent — run them concurrently instead of sequentially.
        const sid = sessionId ?? 'default'
        const [ws, aiResult] = await Promise.all([
            workspacesRepo.getIdNameSettings(workspaceId),
            loadWorkspaceAISettings(workspaceId),
        ])

        if (!ws) {
            res.status(404).json({ error: { code: 'WORKSPACE_NOT_FOUND', message: 'Workspace not found' } })
            return
        }

        const { credential, aiSettings } = aiResult
        if (!credential || !aiSettings) {
            res.status(503).json({ error: { code: 'NO_AI_PROVIDER', message: 'No AI provider configured. Go to Settings → AI Providers.' } })
            return
        }

        const providerKey = aiSettings.primaryProvider
        const config = aiSettings.providers[providerKey]
        if (!config) {
            res.status(503).json({ error: { code: 'NO_AI_PROVIDER', message: `No config for provider ${providerKey}` } })
            return
        }

        // Extract persona from workspace settings (already loaded above — no extra query)
        let agentName = 'Plexo'
        let agentPersona = ''
        let agentTagline = ''
        const s = (ws.settings ?? {}) as Record<string, unknown>
        if (typeof s.agentName === 'string' && s.agentName) agentName = s.agentName
        if (typeof s.agentPersona === 'string' && s.agentPersona) agentPersona = s.agentPersona
        if (typeof s.agentTagline === 'string' && s.agentTagline) agentTagline = s.agentTagline

        const resolvedModel = config.model ?? PROVIDER_DEFAULT_MODELS[providerKey] ?? providerKey
        const resolvedProvider = String(providerKey)

        // Runtime identity (self-awareness): name the provider instance, its
        // endpoint, and the model so the agent can answer "where are you
        // running?" truthfully and exactly. Display name is the configured
        // instance nickname (e.g. "ollama-gpu" on service); baseUrl is
        // the wire endpoint actually hit for inference.
        const runtimeInstance =
            typeof config.displayName === 'string' && config.displayName ? config.displayName : null
        const runtimeEndpoint = typeof config.baseUrl === 'string' && config.baseUrl ? config.baseUrl : null
        const runtimeFacts = [
            `provider "${resolvedProvider}"`,
            runtimeInstance ? `instance "${runtimeInstance}"` : null,
            `model "${resolvedModel}"`,
            runtimeEndpoint ? `endpoint ${runtimeEndpoint}` : null,
        ]
            .filter(Boolean)
            .join(', ')

        // Slim identity line — skip full introspection snapshot for conversation mode.
        // The snapshot (9 DB queries, ~10KB JSON) is only loaded lazily for TASK/PROJECT paths.
        const identityLine = `Your identity: you are ${agentName}, running on provider "${resolvedProvider}", model "${resolvedModel}". Runtime: ${runtimeFacts}. If asked what model, AI, system, or provider/host you are running on, answer truthfully and specifically using these facts (name the provider instance and endpoint when asked WHERE you run — e.g. local machine vs a server).`
        const personaPrefix = agentPersona ? agentPersona + '\n\n' : ''
        const taglineHint = agentTagline ? ` (${agentTagline})` : ''

        // Classify intent — skip if caller forced CONVERSATION (e.g. "Just answer" button)
        // Default to CONVERSATION (declared at handler top) — tasks only get proposed
        // when the classifier explicitly says so.

        type ContentPart = { type: 'text'; text: string } | { type: 'image'; image: string | URL; mimeType?: string }

        let finalMessageText = textMessage
        const turnId = ulid()
        // Captured image URLs for downstream task queuing (TASK intent path).
        // When dashboard chat routes a message with images to the task queue,
        // these public URLs get passed into task.context.imageUrls so the
        // executor can send them to a vision-capable model.
        const uploadedImageUrls: string[] = []

        if (hasImages) {
            try {
                const { uploadContent } = await import('@plexo/storage')
                for (let i = 0; i < validImages.length; i++) {
                    const img = validImages[i]!
                    const b64 = img.data.replace(/^data:image\/[^;]+;base64,/, '')
                    const buffer = Buffer.from(b64, 'base64')
                    const filename = img.name || `image-${i}.png`

                    const res = await uploadContent({
                        taskId: `chat-${sid}`,
                        filename: `${turnId}-${filename}`,
                        content: buffer,
                        contentType: img.mimeType
                    })
                    finalMessageText += `\n\n![${filename}](${res.url})`
                    uploadedImageUrls.push(res.url)
                }
            } catch (err) {
                logger.warn({ err }, 'Failed to upload chat images to storage')
            }
        }

        trimmedMsg = finalMessageText.trim() || (hasImages ? `[Image${validImages.length > 1 ? 's' : ''} attached]` : '')

        // ── Universal session resolution (web chat) ───────────────────────────
        // The client's sessionId is treated as a stable thread seed — the
        // resolver decides if we continue it or split to a fresh id based on
        // time gap, explicit break phrases, task completion, or topic change.
        // External-channel sessions (telegram:*, slack:*, discord:*) are left
        // untouched — those threads own their own session lifecycle.
        //
        // newSession === true BYPASSES the resolver entirely: the client has
        // explicitly asked for a fresh chat (QuickSend, /app/home → /app/chat,
        // or any "new chat" trigger) and we honour that intent literally so
        // topic-similarity can never silently merge into an unrelated thread.
        if (newSession === true && clientSessionId) {
            sessionId = clientSessionId
            // Still compute the embedding so the first turn is searchable for
            // future recall / "related conversations" lookups (Phase 2).
            try {
                _resolvedEmbedding = await embedSessionMessage(workspaceId, trimmedMsg)
            } catch (err) {
                logger.debug({ err }, 'webchat: embedding new session first turn failed (non-fatal)')
            }
            logger.info({ workspaceId, sessionId }, 'webchat: new session (client-minted, resolver bypassed)')
        } else if (clientSessionId && !/^(telegram|slack|discord):/.test(clientSessionId)) {
            try {
                const resolved = await resolveUniversalSession({
                    workspaceId,
                    channel: 'web',
                    channelThreadId: clientSessionId,
                    newMessage: trimmedMsg,
                })
                sessionId = resolved.sessionId
                _resolvedEmbedding = resolved.newMessageEmbedding
                if (resolved.isNewSession) {
                    logger.info({ workspaceId, clientSessionId, sessionId, reason: resolved.reason }, 'webchat: new session started')
                }
            } catch (err) {
                logger.warn({ err, clientSessionId }, 'webchat: session resolver failed, keeping client sessionId')
            }
        }

        // ── Conversation history load (AFTER resolver) ───────────────────────
        const dbTurns = await getSessionTurns(workspaceId, sessionId ?? sid, 30)

        // DD-5: inherit per-conversation model + system-prompt overrides from
        // the latest prior turn in this session (copy-forward). A per-turn
        // value sent in the POST body takes precedence so the UI can change
        // it mid-conversation. Non-fatal: on DB failure we fall back to none.
        let persistedModelOverride: string | null = null
        let persistedSystemPromptOverride: string | null = null
        try {
            if (sessionId) {
                const prev = await conversationsRepo.getLatestSessionOverrides(workspaceId, sessionId)
                if (prev) {
                    persistedModelOverride = prev.modelOverride
                    persistedSystemPromptOverride = prev.systemPromptOverride
                }
            }
        } catch (err) {
            logger.warn({ err, workspaceId, sessionId }, 'webchat: load session overrides failed (non-fatal)')
        }
        const effectiveModelOverride = resolveModelOverride(bodyModelOverride ?? null, persistedModelOverride)
        const effectiveSystemPromptOverride = bodySystemPromptOverride !== undefined
            ? (bodySystemPromptOverride ?? null)
            : persistedSystemPromptOverride

        // Prepend recent turns from prior sessions so the agent retains
        // cross-session memory. The session resolver isolates sessions by design
        // but history should span them for all channels.
        if (
            (sessionId ?? sid).startsWith('web:') || (sessionId ?? sid).startsWith('session-') ||
            (sessionId ?? sid).startsWith('telegram:') || (sessionId ?? sid).startsWith('slack:') || (sessionId ?? sid).startsWith('discord:')
        ) {
            try {
                const crossTurns = await getCrossSessionTurns(workspaceId, sessionId ?? sid, 20)
                const currentIds = new Set(dbTurns.map((t) => t.id))
                const novel = crossTurns.filter((t) => !currentIds.has(t.id))
                if (novel.length > 0) dbTurns.unshift(...novel)
            } catch (err) {
                logger.debug({ err }, 'chat: cross-session history load failed (non-fatal)')
            }
        }

        // Token guard: trim oldest turns if context exceeds ~25k tokens.
        // Keep at least 10 turns so multi-turn context is never lost aggressively.
        const MAX_CONTEXT_CHARS = 100_000
        let contextTotalChars = 0
        for (const t of dbTurns) {
            contextTotalChars += (t.message?.length ?? 0) + (t.reply?.length ?? 0)
        }
        if (contextTotalChars > MAX_CONTEXT_CHARS * 0.8) {
            while (dbTurns.length > 20 && contextTotalChars > MAX_CONTEXT_CHARS * 0.8) {
                const removed = dbTurns.shift()
                if (removed) contextTotalChars -= (removed.message?.length ?? 0) + (removed.reply?.length ?? 0)
            }
        }

        type HistoryMessage = { role: 'user'; content: string | ContentPart[] } | { role: 'assistant'; content: string }
        const history: HistoryMessage[] = []
        for (const t of dbTurns) {
            if (t.message) {
                const parts: ContentPart[] = []
                const imageRegex = /!\[([^\]]*)\]\((https?:\/\/[^\)]+)\)/g
                let match
                let lastIndex = 0
                while ((match = imageRegex.exec(t.message)) !== null) {
                    if (match.index > lastIndex) {
                        parts.push({ type: 'text', text: t.message.substring(lastIndex, match.index) })
                    }
                    try {
                        const url = new URL(match[2]!)
                        parts.push({ type: 'image', image: url })
                    } catch {
                        parts.push({ type: 'text', text: match[0] })
                    }
                    lastIndex = match.index + match[0].length
                }
                if (lastIndex < t.message.length) {
                    parts.push({ type: 'text', text: t.message.substring(lastIndex) })
                }
                const firstPart = parts[0]
                if (parts.length === 1 && firstPart?.type === 'text') {
                    history.push({ role: 'user', content: firstPart.text })
                } else if (parts.length > 0) {
                    history.push({ role: 'user', content: parts })
                }
            }
            if (t.reply) history.push({ role: 'assistant', content: t.reply })
        }

        const textHistory = history.map(m => ({
            role: m.role,
            content: Array.isArray(m.content)
                ? m.content.filter((p: ContentPart) => p.type === 'text').map((p: ContentPart) => (p as { type: 'text'; text: string }).text).join('')
                : m.content
        }))

        // ── Vision gate: route images to a capable model ─────────────────────
        const supportsVision = modelSupportsVision(resolvedModel, providerKey)

        // Build image content parts (reused below regardless of which model handles them)
        const imageParts: ContentPart[] = validImages.map((img) => ({
            type: 'image' as const,
            image: img.data.startsWith('data:')
                ? img.data
                : `data:${img.mimeType};base64,${img.data}`,
        }))

        let userContent: ContentPart[]
        let visionDegraded = false
        // When the primary model lacks vision and we route to a fallback,
        // this holds the fallback model instance and its display name.
        let visionFallbackModel: { model: ReturnType<typeof buildModel>; label: string } | null = null

        if (hasImages && supportsVision) {
            // Primary model supports vision — include image content parts directly
            userContent = [{ type: 'text', text: trimmedMsg }, ...imageParts]
        } else if (hasImages && !supportsVision) {
            // Primary model lacks vision. Try to find a vision-capable fallback.
            const visionAlt = findVisionCapableModel(aiSettings, PROVIDER_DEFAULT_MODELS, providerKey)

            if (visionAlt) {
                // Route image analysis to the fallback model
                const altConfig = aiSettings.providers[visionAlt.providerKey as keyof typeof aiSettings.providers]
                if (altConfig) {
                    visionFallbackModel = {
                        model: buildModel(visionAlt.providerKey as any, altConfig, 'summarization', aiSettings),
                        label: visionAlt.modelId,
                    }
                }
                userContent = [{ type: 'text', text: trimmedMsg }, ...imageParts]
                logger.info({ workspaceId, primary: resolvedModel, fallback: visionAlt.modelId }, 'Vision gate: routing images to fallback vision model')
            } else {
                // No vision-capable model at all — degrade to text with a helpful note
                visionDegraded = true
                const groqSuggestion = `\n\n> **Image recognition unavailable:** Your current model can't process images, and no vision-capable model is configured. To analyze images, add a free [Groq API key](/settings/ai-providers) — Groq offers generous free limits.`
                userContent = [{ type: 'text', text: trimmedMsg + groqSuggestion }]
                logger.info({ workspaceId, model: resolvedModel, provider: providerKey }, 'Vision gate: no vision fallback available, degrading to text')
                trackEvent('vision_fallback_degraded', 'warning', {
                    workspaceId,
                    originalModel: resolvedModel,
                    fallbackModel: 'groq-llama-3-11b-vision (suggested)',
                    reason: 'vision_required',
                    timestamp: new Date().toISOString(),
                })
            }
        } else {
            userContent = [{ type: 'text', text: trimmedMsg }]
        }

        // Strip image parts from conversation history for non-vision model paths
        // to prevent provider errors on prior turns that contained images.
        const activelyUsesVision = hasImages && (supportsVision || visionFallbackModel !== null)
        if (!activelyUsesVision) {
            for (let i = 0; i < history.length; i++) {
                const m = history[i]
                if (m?.role === 'user' && Array.isArray(m.content)) {
                    const textParts = m.content.filter((p: ContentPart) => p.type === 'text')
                    if (textParts.length > 0) {
                        history[i] = { role: 'user', content: textParts.length === 1 ? (textParts[0] as { type: 'text'; text: string }).text : textParts }
                    }
                }
            }
        }

        // ── Fastpath: trivial status/greeting messages ────────────────────────
        // "You working?", "hi", "thanks" — skip classifier + executor + memory
        // recall + introspection + tool loading entirely. One fast LLM call,
        // templated system prompt, no tools. This is the difference between
        // a 42s response and a ~1-2s response on prod.
        //
        // Trivial messages with attached images take the normal path because
        // vision routing requires the full flow.
        const trivialEligible = !hasImages && !forceConversation && isTrivialMessage(trimmedMsg)
        if (trivialEligible) {
            const fastStart = Date.now()
            try {
                const fastSystem = buildTrivialSystemPrompt(agentName)
                // Pin the fastpath model. FASTPATH_MODEL is a deepseek ID, so
                // it's only safe to inject when the workspace actually has a
                // deepseek provider configured. Otherwise we route through
                // the `summarization` tier, which resolves to each provider's
                // fast chat default via PROVIDER_DEFAULT_MODELS (never a
                // reasoning model — registry.ts auto-swaps those out).
                // Either way the workspace can't regress the fastpath to
                // deepseek-reasoner via modelOverrides.
                const deepseekIsPrimary = aiSettings.primaryProvider === 'deepseek'
                    && Boolean(aiSettings.providers?.deepseek?.apiKey)
                const pinnedSettings = deepseekIsPrimary
                    ? {
                        ...aiSettings,
                        modelOverrides: {
                            ...(aiSettings.modelOverrides ?? {}),
                            classification: FASTPATH_MODEL,
                        },
                    }
                    : aiSettings
                // When deepseek isn't primary we route through the
                // `summarization` tier instead — every provider's default
                // model at that tier is a fast chat model, never a reasoner.
                const fastTier = deepseekIsPrimary ? 'classification' : 'summarization'
                const fastResult = await routeAndCall({
                    workspaceId,
                    taskType: fastTier,
                    settings: pinnedSettings,
                    doCall: async (model) => generateText({
                        model,
                        system: fastSystem,
                        messages: [{ role: 'user', content: trimmedMsg }],
                        abortSignal: AbortSignal.timeout(8_000),
                    }),
                    opts: fallbackOpts(workspaceId),
                })
                const replyText = (fastResult.text ?? '').trim()
                if (replyText) {
                    const fastDuration = Date.now() - fastStart
                    logger.info({ workspaceId, durationMs: fastDuration, msg: trimmedMsg.slice(0, 40) }, 'Webchat: trivial fastpath reply')

                    // Record the turn so conversation history stays consistent
                    try {
                        await recordConversation({
                            workspaceId,
                            sessionId,
                            source: 'dashboard',
                            message: trimmedMsg,
                            reply: replyText,
                            status: 'complete',
                            intent: 'CONVERSATION',
                            messageEmbedding: _resolvedEmbedding,
                        })
                    } catch (err) {
                        logger.error({ err }, 'Fastpath: failed to record conversation')
                    }

                    trackDelivery({
                        workspaceId,
                        channel: 'webchat',
                        chatId: sessionId ?? 'unknown',
                        status: 'sent',
                        messageLength: replyText.length,
                    })

                    res.json({
                        status: 'complete',
                        reply: replyText,
                        model: `${resolvedProvider}/${resolvedModel}`,
                        fastpath: true,
                        progressEvents: [
                            {
                                id: 'quick-reply-0',
                                kind: 'status',
                                title: 'Quick reply',
                                startedAt: fastStart,
                                completedAt: Date.now(),
                                status: 'success',
                            },
                        ],
                    })
                    return
                }
                // Empty reply — fall through to the normal path
                logger.warn({ workspaceId }, 'Fastpath: empty reply from model, falling through to normal path')
            } catch (err) {
                logger.warn({ err, workspaceId }, 'Fastpath: failed, falling through to normal path')
                // fall through — the normal path will take over
            }
        }

        // ── Cross-session memory recall (P3: own context continuity) ─────────
        // Two triggers:
        const skipRecallForTrivial = isTrivialMessage(trimmedMsg)

        // Proactive memory recall removed 2026-06-27 — graphiti backend retired.
        // Postgres recall already runs further down in the agent loop via searchMemory.
        const memoryContext: string | null = null

        // ── Self-configuration: detect credentials and auto-install connection ──
        // Works in internal chat exactly like Telegram/Slack/Discord.
        const credMatch = detectCredentialMessage(trimmedMsg)
        if (credMatch) {
            try {
                const reply = await autoInstallConnection(workspaceId, credMatch)
                res.json({ reply, intent: 'CONVERSATION', sessionId: sid })
            } catch (err) {
                logger.error({ err, workspaceId }, 'Chat: auto-install integration failed')
                res.json({ reply: `Failed to connect to ${credMatch.serviceName}. Check that the URL and token are correct.`, intent: 'CONVERSATION', sessionId: sid })
            }
            return
        }

        let isComplex = false

        if (!forceConversation) {
            // Fast local heuristic (pure, unit-tested in chat-intent.ts) — skips
            // the LLM classifier for unambiguous messages. Ambiguous ones defer
            // to the LLM classifier below.
            const pre = preClassifyIntent(trimmedMsg)
            const resolved = resolveHeuristicIntent(pre)
            if (resolved.kind === 'decided') {
                intent = resolved.intent
                isComplex = resolved.isComplex
                if (resolved.intent === 'PROJECT') {
                    logger.info({ workspaceId, message: trimmedMsg.slice(0, 80) }, 'Webchat: explicit project intent detected — skipping LLM classifier')
                }
            } else {
                // Ambiguous — defer to the LLM classifier. On failure or an
                // unrecognized label, fail TOWARD execution when the message
                // carries a task verb (never silently degrade a build request
                // to chat).
                const execDefault = resolved.execDefault
                try {
                    const classifyMessages = [
                        ...textHistory,
                        { role: 'user' as const, content: trimmedMsg }
                    ] as any[]

                    // Hard total budget for classification. The per-call abort
                    // (10s) can stack across cascade + retry-same and blow past
                    // half a minute; cap the whole step so we fail toward
                    // execution fast instead of leaving the user waiting.
                    const classifyResult = await Promise.race([
                        routeAndCall({
                            workspaceId,
                            taskType: 'classification',
                            settings: aiSettings,
                            doCall: async (model) => generateText({
                                model,
                                system: WEBCHAT_CLASSIFY_SYSTEM,
                                messages: classifyMessages,
                                abortSignal: AbortSignal.timeout(10_000),
                            }),
                            opts: fallbackOpts(workspaceId),
                        }),
                        new Promise<never>((_, reject) =>
                            setTimeout(() => reject(new Error('classify-budget-exceeded')), 12_000).unref(),
                        ),
                    ])
                    const parsed = parseClassifyResponse(classifyResult.text, execDefault)
                    intent = parsed.intent
                    isComplex = parsed.isComplex
                } catch {
                    intent = execDefault
                }
            }
        }


        const fullIdentityLine = identityLine

        // Consultative routing: Check for recommended model
        let recommendedSwitch = ''
        if (isComplex && (intent === 'TASK' || intent === 'PROJECT')) {
            const currentModelId = config.model ?? 'default'

            const kbEntry = await chatRepo.getModelKnowledge(currentModelId)

            const hasReasoning = kbEntry?.strengths?.includes('reasoning') ||
                currentModelId.includes('sonnet') ||
                currentModelId.includes('gpt-4') ||
                currentModelId.includes('o1')

            if (!hasReasoning) {
                // Find a reasoning model in DB from the same provider if possible, or OpenRouter
                const betterMatch = await chatRepo.getBestReasoningModel()

                if (betterMatch && betterMatch.modelId !== currentModelId) {
                    recommendedSwitch = `\n\nFor this complex task, I recommend switching from your default ${currentModelId} to ${betterMatch.modelId} for better logic and reasoning.`
                }
            }
        }

        logger.info({ workspaceId, intent, message: trimmedMsg.slice(0, 80) }, 'Webchat intent classified')

        // Persist a pending row BEFORE any heavy model call so a throw/abort mid-turn
        // can never make the conversation vanish. Terminal sites below backfill it in
        // place; the outer catch marks it failed if nothing else settled it. `.catch`
        // so a DB hiccup here never blocks the turn. Source starts 'dashboard' (the
        // channel isn't known yet — conversationSource is computed later, per-branch).
        conversationId = await recordConversation({
            workspaceId,
            sessionId,
            source: 'dashboard',
            message: trimmedMsg,
            status: 'pending',
            intent,
            messageEmbedding: _resolvedEmbedding,
            modelOverride: effectiveModelOverride ?? null,
            systemPromptOverride: effectiveSystemPromptOverride ?? null,
        }).catch(() => null)

        // ── MEMORY intent: store instruction immediately ───────────────────────────
        if (intent === 'MEMORY') {
            try {
                await rememberInstruction({ workspaceId, instruction: trimmedMsg, source: 'chat', aiSettings: aiSettings ?? undefined })

                // Also write to workspace_preferences under a unique key per instruction
                // so multiple "remember X" instructions accumulate rather than overwrite
                try {
                    const sanitized = trimmedMsg.replace(/^(remember|always|never|don't|dont|please|make sure)\s+/i, '').trim()
                    const instrKey = `user_instruction:${Date.now()}`
                    await setPreference({ workspaceId, key: instrKey, value: sanitized, source: 'chat' })
                } catch (prefErr) {
                    logger.warn({ err: prefErr, workspaceId }, 'Failed to store preference copy — instruction still saved')
                }

                const reply = `Got it — I'll remember that and apply it going forward.`

                try {
                    if (conversationId) {
                        await updateConversationById(conversationId, { reply, status: 'complete' })
                        turnSettled = true
                    } else {
                        await recordConversation({ workspaceId, sessionId, source: 'dashboard', message: trimmedMsg, reply, status: 'complete', intent, messageEmbedding: _resolvedEmbedding, modelOverride: effectiveModelOverride ?? null, systemPromptOverride: effectiveSystemPromptOverride ?? null })
                        turnSettled = true
                    }
                } catch (err) { logger.error({ err }, "Failed to record conversation") }

                res.json({ status: 'complete', reply })
            } catch (err) {
                logger.error({ err, workspaceId }, 'MEMORY intent storage failed')
                const reason = err instanceof Error ? err.message.slice(0, 80) : 'Unknown error'
                res.json({ status: 'complete', reply: `I tried to remember that, but ran into an issue — ${reason}. Please try again.` })
            }
            return
        }

        // ── Inline streaming agent loop ──────────────────────────────────────
        // Default path for CONVERSATION *and* TASK-without-background. The model
        // gets the full toolset (code tools + workspace tools + MCP tools) and
        // can multi-turn over a single SSE response up to INLINE_STEP_LIMIT
        // steps. The async task queue is opt-in via `background: true`.
        if (intent === 'CONVERSATION' || (intent === 'TASK' && !background)) {
            // ── Correction feedback loop: detect and record user corrections ──
            try {
                const { hasCorrectionIntent, recordCorrection } = await import('@plexo/agent/memory/corrections')
                if (hasCorrectionIntent(trimmedMsg)) {
                    const lastAssistant = history.filter(m => m.role === 'assistant').pop()?.content
                    if (lastAssistant) {
                        void recordCorrection({
                            workspaceId,
                            originalOutput: typeof lastAssistant === 'string' ? lastAssistant : JSON.stringify(lastAssistant),
                            correctionType: 'explicit_rejection',
                            userMessage: trimmedMsg,
                        }).catch((e: unknown) => logger.error({ err: e }, 'Correction recording failed'))
                        try {
                            trackError(new Error(`User correction: ${trimmedMsg.slice(0, 100)}`), {
                                workspaceId,
                                category: 'user_correction',
                                userMessage: trimmedMsg.slice(0, 300),
                                agentResponse: (typeof lastAssistant === 'string' ? lastAssistant : JSON.stringify(lastAssistant)).slice(0, 300),
                            })
                        } catch { /* non-fatal */ }
                    }
                }
            } catch { /* corrections module not available — non-fatal */ }

            // Detect if this session originated from an external channel (Telegram, etc.)
            // so we (a) record the correct source and (b) relay the reply back
            let externalChannelRef: { channel: string; channelId: string; chatId: string } | null = null
            if (sessionId && (sessionId.startsWith('telegram:') || sessionId.startsWith('slack:') || sessionId.startsWith('discord:'))) {
                externalChannelRef = await getSessionChannelRef(workspaceId, sessionId).catch((err: unknown) => {
                    logger.warn({ err, sessionId, workspaceId }, 'getSessionChannelRef failed — external channel reply disabled')
                    return null
                })
            }
            const conversationSource = externalChannelRef ? externalChannelRef.channel : 'dashboard'

            // Build real workspace snapshot for self-awareness (direct DB query, no HTTP)
            let workspaceSnapshot = ''
            try {
                const statusCounts = await chatRepo.getTaskStatusCounts(workspaceId)
                const counts: Record<string, number> = {}
                let total = 0
                for (const r of statusCounts) { counts[r.status] = r.count; total += r.count }
                workspaceSnapshot = `\nWORKSPACE LIVE DATA (real — from database, not estimated):\n- Tasks: ${counts.complete ?? 0} completed, ${counts.running ?? 0} running, ${counts.blocked ?? 0} blocked, ${counts.queued ?? 0} queued, ${counts.failed ?? 0} failed, ${counts.cancelled ?? 0} cancelled\n- Total tasks ever: ${total}`
                logger.info({ workspaceId, counts, total }, 'Workspace snapshot injected into conversation')
            } catch (snapErr) {
                logger.warn({ snapErr }, 'Failed to build workspace snapshot — proceeding without')
            }

            try {
                logger.info({ workspaceId, providerKey, modelId: config.model, visionFallback: visionFallbackModel?.label ?? null }, 'Webchat: generating conversational reply')

                // FUN-022-SSE: True SSE streaming to frontend for incremental render.
                // Falls back to JSON for non-browser clients that don't Accept event-stream.
                const wantsSSE = (req.headers.accept ?? '').includes('text/event-stream')

                // Append a transparent note when a fallback vision model was used
                const usedModel = visionFallbackModel
                    ? `${resolvedProvider}/${resolvedModel} → ${visionFallbackModel.label}`
                    : `${resolvedProvider}/${resolvedModel}`

                const compiledSystemPrompt = `${personaPrefix}${buildConversationSystemPrompt('webchat', `${identityLine}

For service integrations, provide direct links: [Connect Gmail](/connections?highlight=google-workspace), [Connect GitHub](/connections?highlight=github), etc. Format: /connections?highlight={service-id}. Known IDs: github, google-workspace, google-drive, slack, discord, jira, linear, notion, cloudflare, sentry, posthog, pagerduty, netlify, openai, ovhcloud, datadog.${workspaceSnapshot}${memoryContext ? '\n\n' + memoryContext : ''}`)}`

                // DD-5: prepend the per-conversation system-prompt override (if any).
                const systemPrompt = composeSystemPrompt(compiledSystemPrompt, effectiveSystemPromptOverride)

                const streamMessages = [
                    ...history,
                    { role: 'user' as const, content: userContent as any },
                ]

                logger.info({ workspaceId, historyTurns: history.length, totalMessages: streamMessages.length }, 'webchat: conversation context size')

                // Load workspace tools (web_search, memory_query, MCP connection tools, etc.)
                // PLUS executor code tools (read_file, write_file, edit_file, grep, glob,
                // shell) so the inline streaming path has the full toolset — the model
                // decides whether to use them. Cached per workspace to avoid re-hydrating
                // the bridge on every turn.
                let chatTools: Record<string, unknown> = {}
                try {
                    const { buildWorkspaceTools } = await import('@plexo/agent/tools/workspace-tools')
                    chatTools = await getCachedToolSet(
                        `conv-tools:${workspaceId}`,
                        () => buildWorkspaceTools(workspaceId),
                    )
                } catch (toolErr) {
                    logger.warn({ err: toolErr, workspaceId }, 'webchat: workspace tools load failed — continuing without workspace tools (web_search/memory_query/MCP unavailable this turn)')
                }

                // Code tools — bound to a minimal ExecutionContext so dispatchTool
                // can emit step.file_write / step.shell_line / step.test_result
                // events via emitToWorkspace. The workbench's use-code-stream
                // subscribes to that same workspace SSE channel and renders them
                // in the diff-viewer / terminal-panel exactly as it does for
                // queued tasks — no new event shapes.
                const inlineTaskId = `chat-${turnId}`
                const inlineCtx: ExecutionContext = {
                    taskId: inlineTaskId,
                    workspaceId,
                    userId: (req.user?.id as string) ?? 'chat',
                    credential: credential as unknown as ExecutionContext['credential'],
                    taskType: 'coding',
                    tokenBudget: 0,
                    taskCostCeilingUsd: null,
                    signal: AbortSignal.timeout(120_000),
                    activeProvider: resolvedProvider,
                    activeModel: resolvedModel,
                    emitStepEvent: (event: StepEvent) => {
                        emitToWorkspace(workspaceId, event as unknown as import('../sse-emitter.js').AgentEvent)
                    },
                }
                try {
                    const codeToolsAll = buildTools(inlineCtx, null)
                    const codeTools: Record<string, unknown> = {}
                    for (const name of INLINE_CODE_TOOLS) {
                        const t = (codeToolsAll as Record<string, unknown>)[name]
                        if (t) codeTools[name] = t
                    }
                    chatTools = { ...codeTools, ...chatTools }
                    // DD-4: wire spawn_subagent runner so the inline chat loop
                    // can dispatch forked sub-agents using the resolved settings
                    // + the full chat toolset.
                    if (aiSettings) {
                        wireSubagentRunner(inlineCtx, aiSettings, chatTools)
                    }
                } catch (toolErr) {
                    logger.warn({ err: toolErr, workspaceId }, 'webchat: code tools build failed — continuing with workspace tools only')
                }

                if (wantsSSE) {
                    // ── SSE streaming path ──────────────────────────────────────
                    res.setHeader('Content-Type', 'text/event-stream')
                    res.setHeader('Cache-Control', 'no-cache')
                    res.setHeader('Connection', 'keep-alive')
                    res.setHeader('X-Accel-Buffering', 'no')
                    res.flushHeaders()

                    // Keepalive comment frames while the model works, so the
                    // Cloudflare tunnel / browser don't drop an idle-but-active
                    // SSE connection (the false "Request timed out" cause).
                    // SSE comments (`: ...`) are ignored by the EventSource client.
                    // Cleared in the finally below. Kill switch: PLEXO_CHAT_HEARTBEAT=false.
                    const heartbeat = process.env.PLEXO_CHAT_HEARTBEAT !== 'false'
                        ? setInterval(() => {
                            if (!res.writableEnded) { try { res.write(': keepalive\n\n') } catch { /* ignore */ } }
                        }, 15_000)
                        : null
                    heartbeat?.unref?.()

                    let fullText = ''
                    try {
                        const streamFn = async (model: ReturnType<typeof buildModel>) => {
                            const stream = streamText({
                                model,
                                system: systemPrompt,
                                messages: streamMessages,
                                tools: chatTools as any,
                                stopWhen: stepCountIs(INLINE_STEP_LIMIT),
                                abortSignal: AbortSignal.timeout(120_000),
                            })
                            let attemptText = ''
                            let hasWritten = false
                            const safeErrorString = (e: unknown): string => {
                                if (e instanceof Error) return e.message
                                if (typeof e === 'string') return e
                                try { return JSON.stringify(e) } catch { return String(e) }
                            }
                            const emitFrame = (obj: unknown) => {
                                try { res.write('data: ' + JSON.stringify(obj) + '\n\n') } catch { /* ignore */ }
                            }
                            try {
                                for await (const part of stream.fullStream) {
                                    if (part.type === 'text-delta') {
                                        attemptText += part.text
                                        fullText += part.text
                                        emitFrame({ chunk: part.text })
                                        hasWritten = true
                                    } else if (part.type === 'reasoning-delta') {
                                        emitFrame({ reasoning: part.text })
                                    } else if (part.type === 'tool-call') {
                                        emitFrame({ toolCall: { toolCallId: part.toolCallId, toolName: part.toolName, input: part.input } })
                                    } else if (part.type === 'tool-result') {
                                        emitFrame({ toolResult: { toolCallId: part.toolCallId, toolName: part.toolName, output: part.output } })
                                    } else if (part.type === 'tool-error') {
                                        emitFrame({ toolError: { toolCallId: part.toolCallId, toolName: part.toolName, error: safeErrorString(part.error) } })
                                    }
                                }
                                // Ensure the full text promise resolves (side effects)
                                await stream.text
                            } catch (streamErr) {
                                if (hasWritten) {
                                    // Partial output already delivered to the client. Do NOT
                                    // let the router cascade to another provider — it would
                                    // re-stream from the start and duplicate what the client
                                    // already received. Throw a sentinel the classifier treats
                                    // as non-fallback so routeAndCall stops here; the outer
                                    // streamErr handler surfaces the error to the client.
                                    const sentinel = new Error('partial stream already delivered; not retryable to avoid duplicate output')
                                    sentinel.name = 'StreamPartialAbortError'
                                    throw sentinel
                                }
                                throw streamErr
                            }
                            // Surface an empty stream as an error so router-v2 sees it
                            // (classifyError -> 'empty-output') and runs the
                            // retry-same-then-fallback cascade, instead of the silent
                            // { text: '' } that recorded a false success and stranded the
                            // turn on the same do-nothing provider. Guard on THIS
                            // attempt's output so a partial reply already streamed to the
                            // client is never dropped or re-sent on a retry.
                            if (!attemptText.trim()) {
                                throw new Error('No output generated: the model returned an empty stream')
                            }
                            return { text: attemptText }
                        }

                        const result = visionFallbackModel
                            ? await routeAndCall({
                                workspaceId,
                                taskType: 'conversation',
                                settings: aiSettings,
                                doCall: streamFn,
                                opts: fallbackOpts(workspaceId),
                                modelIdOverride: visionFallbackModel.label,
                            })
                            : await routeAndCall({
                                workspaceId,
                                taskType: 'conversation',
                                settings: aiSettings,
                                doCall: streamFn,
                                opts: fallbackOpts(workspaceId),
                                ...(effectiveModelOverride ? { modelIdOverride: effectiveModelOverride } : {}),
                            })

                        fullText = result.text

                        if (!fullText) {
                            // Single retry before giving up — matches the retry logic in channel-ai.ts chatWithAI.
                            logger.warn({ workspaceId }, 'Webchat SSE: empty response — attempting single retry')
                            try {
                                const retryResult = await routeAndCall({
                                    workspaceId,
                                    taskType: 'conversation',
                                    settings: aiSettings,
                                    doCall: async (model) => generateText({
                                        model,
                                        system: systemPrompt,
                                        messages: streamMessages,
                                        tools: chatTools as any,
                                        abortSignal: AbortSignal.timeout(120_000),
                                    }),
                                    opts: fallbackOpts(workspaceId),
                                    ...(effectiveModelOverride ? { modelIdOverride: effectiveModelOverride } : {}),
                                })
                                const retryText = (retryResult.text ?? '').trim()
                                if (retryText) {
                                    fullText = retryText
                                    res.write(`data: ${JSON.stringify({ chunk: retryText })}\n\n`)
                                }
                            } catch (retryErr) {
                                logger.warn({ err: retryErr, workspaceId }, 'Webchat SSE: retry also failed')
                            }
                        }

                        const EMPTY_RESPONSE_MSG = "I wasn't able to generate a response for that. Could you rephrase or try again?"
                        if (!fullText) {
                            res.write(`data: ${JSON.stringify({ error: EMPTY_RESPONSE_MSG })}\n\n`)
                            res.end()
                            try {
                                const persistedId = await persistTurn({
                                    conversationId,
                                    create: { workspaceId, sessionId, source: conversationSource, message: trimmedMsg, intent, messageEmbedding: _resolvedEmbedding, modelOverride: effectiveModelOverride ?? null, systemPromptOverride: effectiveSystemPromptOverride ?? null },
                                    status: 'failed',
                                    errorMsg: EMPTY_RESPONSE_MSG,
                                })
                                conversationId = persistedId
                                turnSettled = true
                            } catch (err) { logger.error({ err }, "Failed to record conversation") }
                            trackDelivery({ workspaceId, channel: 'webchat', chatId: sessionId ?? 'unknown', status: 'empty_response', messageLength: 0 })
                            return
                        }

                        // Signal completion with model info
                        res.write(`data: ${JSON.stringify({ done: true, model: usedModel, conversationId: conversationId ?? undefined, ...(visionDegraded ? { visionDegraded: true } : {}) })}\n\n`)
                        res.end()
                    } catch (streamErr) {
                        const classified = classifyAIError(streamErr)
                        logger.error({ err: streamErr, workspaceId, errorType: classified.type }, 'Webchat SSE stream failed')
                        // If headers already sent, write error event
                        if (!res.writableEnded) {
                            res.write(`data: ${JSON.stringify({ error: classified.message, fixUrl: classified.fixUrl, fixLabel: classified.fixLabel })}\n\n`)
                            res.end()
                        }
                        try {
                            const persistedId = await persistTurn({
                                conversationId,
                                create: { workspaceId, sessionId, source: conversationSource, message: trimmedMsg, intent, messageEmbedding: _resolvedEmbedding, modelOverride: effectiveModelOverride ?? null, systemPromptOverride: effectiveSystemPromptOverride ?? null },
                                status: 'failed',
                                errorMsg: classified.message,
                            })
                            conversationId = persistedId
                            turnSettled = true
                        } catch (err) { logger.error({ err }, "Failed to record conversation") }
                        trackDelivery({ workspaceId, channel: 'webchat', chatId: sessionId ?? 'unknown', status: 'failed', messageLength: 0, errorMessage: classified.message })
                        // Still run post-stream persistence with whatever we got
                        if (!fullText) return
                    } finally {
                        if (heartbeat) clearInterval(heartbeat)
                    }

                    // ── Post-stream quality check (can't unwrite chunks already sent, but
                    //    strip artifacts from the stored record so history stays clean) ──
                    let replyText = fullText
                    if (fullText) {
                        try {
                            const { checkResponseQuality } = await import('../lib/response-quality.js')
                            const qualityCheck = checkResponseQuality(fullText, workspaceId)
                            if (qualityCheck.issues.length > 0) {
                                logger.warn({ workspaceId, issues: qualityCheck.issues }, 'SSE response quality issues detected')
                                replyText = qualityCheck.text
                            }
                        } catch { /* non-fatal */ }
                    }

                    // ── Post-stream persistence (runs inside session lock) ──────
                    try {
                        const persistedId = await persistTurn({
                            conversationId,
                            create: { workspaceId, sessionId, source: conversationSource, message: trimmedMsg, intent, messageEmbedding: _resolvedEmbedding, modelOverride: effectiveModelOverride ?? null, systemPromptOverride: effectiveSystemPromptOverride ?? null },
                            status: 'complete',
                            reply: replyText,
                        })
                        conversationId = persistedId
                        turnSettled = true
                    } catch (err) { logger.error({ err }, "Failed to record conversation") }

                    if (externalChannelRef) {
                        const token = externalChannelRef.channel === 'telegram'
                            ? getTelegramToken(externalChannelRef.channelId)
                            : null
                        replyToChannel(externalChannelRef, replyText, token ?? undefined).catch(
                            (err: Error) => logger.warn({ err, channelRef: externalChannelRef }, 'Failed to relay web reply to source channel')
                        )
                    }

                    storeMemory({
                        workspaceId,
                        type: 'session',
                        content: `User: ${trimmedMsg}\nAssistant: ${replyText}`,
                        metadata: { source: 'chat', sessionId: sessionId ?? null, intent },
                    }).catch((err: unknown) => logger.debug({ err, workspaceId }, 'storeMemory failed (non-fatal)'))

                    if (hasInstructionIntent(trimmedMsg)) {
                        void persistInstruction({ workspaceId, userMessage: trimmedMsg, assistantReply: replyText, sessionId: sessionId ?? '' })
                            .catch((err: unknown) => logger.debug({ err, workspaceId }, 'persistInstruction failed (non-fatal)'))
                    }
                    void extractConversationMemory({
                        workspaceId,
                        userMessage: trimmedMsg,
                        assistantReply: replyText,
                        sessionId: sessionId ?? '',
                        source: 'chat',
                    }).catch((err: unknown) => logger.debug({ err, workspaceId }, 'extractConversationMemory failed (non-fatal)'))

                    trackDelivery({ workspaceId, channel: 'webchat', chatId: sessionId ?? 'unknown', status: 'sent', messageLength: replyText.length })
                } else {
                    // ── Legacy JSON path (non-SSE clients) ──────────────────────
                    const streamFn = async (model: ReturnType<typeof buildModel>) => {
                        const stream = streamText({
                            model,
                            system: systemPrompt,
                            messages: streamMessages,
                            tools: chatTools as any,
                            stopWhen: stepCountIs(INLINE_STEP_LIMIT),
                            // No SSE heartbeat on this buffered path, so keep the
                            // request under the ~100s upstream tunnel idle window.
                            abortSignal: AbortSignal.timeout(90_000),
                        })
                        const text = await stream.text
                        // Empty completion -> throw so router-v2 cascades to another
                        // provider instead of returning a silent blank (mirrors the
                        // SSE path above).
                        if (!text.trim()) {
                            throw new Error('No output generated: the model returned an empty completion')
                        }
                        return { text }
                    }

                    const result = visionFallbackModel
                        ? await routeAndCall({
                            workspaceId,
                            taskType: 'summarization',
                            settings: aiSettings,
                            doCall: streamFn,
                            opts: fallbackOpts(workspaceId),
                            modelIdOverride: visionFallbackModel.label,
                        })
                        : await routeAndCall({
                            workspaceId,
                            taskType: 'summarization',
                            settings: aiSettings,
                            doCall: streamFn,
                            opts: fallbackOpts(workspaceId),
                            ...(effectiveModelOverride ? { modelIdOverride: effectiveModelOverride } : {}),
                        })

                    let replyText = result.text

                    // ── Response quality check (legacy JSON path) ──────────────
                    if (replyText) {
                        try {
                            const { checkResponseQuality } = await import('../lib/response-quality.js')
                            const qualityCheck = checkResponseQuality(replyText, workspaceId)
                            replyText = qualityCheck.text
                            if (qualityCheck.issues.length > 0) {
                                logger.warn({ workspaceId, issues: qualityCheck.issues }, 'Webchat response quality issues detected')
                            }
                        } catch { /* non-fatal */ }
                    }

                    if (!replyText) {
                        logger.warn({ workspaceId, providerKey }, 'Webchat: empty response from model')
                        const classified = classifyAIError(new Error('Empty response from model — the model returned no text.'))
                        try {
                            if (conversationId) {
                                await updateConversationById(conversationId, { errorMsg: classified.message, status: 'failed' })
                                turnSettled = true
                            } else {
                                await recordConversation({ workspaceId, sessionId, source: conversationSource, message: trimmedMsg, errorMsg: classified.message, status: 'failed', intent, messageEmbedding: _resolvedEmbedding, modelOverride: effectiveModelOverride ?? null, systemPromptOverride: effectiveSystemPromptOverride ?? null })
                                turnSettled = true
                            }
                        } catch (err) { logger.error({ err }, "Failed to record conversation") }
                        trackDelivery({ workspaceId, channel: 'webchat', chatId: sessionId ?? 'unknown', status: 'empty_response', messageLength: 0 })
                        res.json({ status: 'error', reply: classified.message, fixUrl: classified.fixUrl, fixLabel: classified.fixLabel, technicalDetail: classified.technical })
                        return
                    }

                    try {
                        if (conversationId) {
                            await updateConversationById(conversationId, { reply: replyText, status: 'complete' })
                            turnSettled = true
                        } else {
                            await recordConversation({ workspaceId, sessionId, source: conversationSource, message: trimmedMsg, reply: replyText, status: 'complete', intent, messageEmbedding: _resolvedEmbedding, modelOverride: effectiveModelOverride ?? null, systemPromptOverride: effectiveSystemPromptOverride ?? null })
                            turnSettled = true
                        }
                    } catch (err) { logger.error({ err }, "Failed to record conversation") }

                    if (externalChannelRef) {
                        const token = externalChannelRef.channel === 'telegram'
                            ? getTelegramToken(externalChannelRef.channelId)
                            : null
                        replyToChannel(externalChannelRef, replyText, token ?? undefined).catch(
                            (err: Error) => logger.warn({ err, channelRef: externalChannelRef }, 'Failed to relay web reply to source channel')
                        )
                    }

                    storeMemory({
                        workspaceId,
                        type: 'session',
                        content: `User: ${trimmedMsg}\nAssistant: ${replyText}`,
                        metadata: { source: 'chat', sessionId: sessionId ?? null, intent },
                    }).catch((err: unknown) => logger.debug({ err, workspaceId }, 'storeMemory failed (non-fatal)'))

                    if (hasInstructionIntent(trimmedMsg)) {
                        void persistInstruction({ workspaceId, userMessage: trimmedMsg, assistantReply: replyText, sessionId: sessionId ?? '' })
                            .catch((err: unknown) => logger.debug({ err, workspaceId }, 'persistInstruction failed (non-fatal)'))
                    }
                    void extractConversationMemory({
                        workspaceId,
                        userMessage: trimmedMsg,
                        assistantReply: replyText,
                        sessionId: sessionId ?? '',
                        source: 'chat',
                    }).catch((err: unknown) => logger.debug({ err, workspaceId }, 'extractConversationMemory failed (non-fatal)'))

                    trackDelivery({ workspaceId, channel: 'webchat', chatId: sessionId ?? 'unknown', status: 'sent', messageLength: replyText.length })
                    res.json({ status: 'complete', reply: replyText, model: usedModel, conversationId: conversationId ?? undefined, ...(visionDegraded ? { visionDegraded: true } : {}) })
                }
            } catch (err) {
                const classified = classifyAIError(err)
                logger.error({ err, workspaceId, errorType: classified.type }, 'Webchat conversational reply failed')
                trackDelivery({ workspaceId, channel: 'webchat', chatId: sessionId ?? 'unknown', status: 'failed', messageLength: 0, errorMessage: classified.message })
                try {
                    if (conversationId) {
                        await updateConversationById(conversationId, { errorMsg: classified.message, status: 'failed' })
                        turnSettled = true
                    } else {
                        await recordConversation({ workspaceId, sessionId, source: conversationSource, message: trimmedMsg, errorMsg: classified.message, status: 'failed', intent, messageEmbedding: _resolvedEmbedding, modelOverride: effectiveModelOverride ?? null, systemPromptOverride: effectiveSystemPromptOverride ?? null })
                        turnSettled = true
                    }
                } catch (err) { logger.error({ err }, "Failed to record conversation") }
                res.json({ status: 'error', reply: classified.message, fixUrl: classified.fixUrl, fixLabel: classified.fixLabel, technicalDetail: classified.technical, model: `${resolvedProvider}/${resolvedModel}` })
            }
            return
        }


        // Background task queue: OPT-IN only (background: true). The default
        // coding path is the inline streaming loop above. When the caller asks
        // for background, queue to the async executor and return a taskId for
        // polling via /api/chat/reply/:taskId.
        // PROJECT: still show one confirm because it spins up a full multi-step sprint.
        if (intent === 'TASK' && background) {
            // Synthesize a clean task description from conversation context
            let cleanDescription = trimmedMsg
            try {
                const synth = await routeAndCall({
                    workspaceId,
                    taskType: 'summarization',
                    settings: aiSettings,
                    doCall: async (model) => generateText({
                        model,
                        system: 'You are a task description synthesizer. Given a conversation, output a single clear, specific, third-person task description in one sentence (max 150 chars) that captures what the user wants the agent to accomplish. No preamble, no quotes, just the description.',
                        messages: [
                            ...textHistory,
                            { role: 'user' as const, content: trimmedMsg },
                        ],
                        abortSignal: AbortSignal.timeout(8_000),
                    }),
                    opts: fallbackOpts(workspaceId),
                })
                if (synth.text?.trim()) cleanDescription = synth.text.trim().replace(/^"|"$/g, '')
            } catch { /* use raw message as fallback */ }

            // Store the user's CLEAN request in description/message so the
            // task page renders just the ask. The executor loads SCL context
            // via agent-loop.ts → expandForTask and recall via
            // ctx.sclContext, so we don't pre-bake either into the row.
            // Recalled prior-session context is kept on a sibling field so
            // the executor can opt into reading it without it tainting the
            // user-visible Request column.
            const taskId = await pushTask({
                workspaceId,
                type: 'automation',
                source: 'dashboard',
                context: {
                    description: cleanDescription,
                    message: cleanDescription,
                    sessionId: sid,
                    channel: 'webchat',
                    ...(uploadedImageUrls.length > 0 ? { imageUrls: uploadedImageUrls } : {}),
                },
                priority: 2,
            })
            logger.info({ workspaceId, taskId, description: cleanDescription, images: uploadedImageUrls.length }, 'Webchat task auto-queued (no confirm step)')
            emitToWorkspace(workspaceId, { type: 'task_queued', taskId, source: 'dashboard' })
            audit(req, { workspaceId, userId: req.user?.id, action: 'task.create', resource: 'tasks', resourceId: taskId, metadata: { source: 'dashboard', via: 'chat' } })

            const confirmReply = recommendedSwitch.trim() || null
            try {
                if (conversationId) {
                    await updateConversationById(conversationId, { reply: confirmReply, status: 'complete' })
                    await linkTaskToConversation(conversationId, taskId)
                    turnSettled = true
                } else {
                    await recordConversation({ workspaceId, sessionId, source: 'dashboard', message: trimmedMsg, reply: confirmReply, status: 'complete', intent, taskId, messageEmbedding: _resolvedEmbedding })
                    turnSettled = true
                }
            } catch (err) { logger.error({ err }, "Failed to record conversation") }

            // Apr-14: chat-to-task UX — return a structured task summary so the
            // dashboard can render a chip ("Task created: …") instead of just
            // "task_queued". Frontend can read displayName / description and
            // link to /app/tasks/<taskId> directly.
            res.json({
                status: 'task_queued',
                taskId,
                task: {
                    id: taskId,
                    displayName: cleanDescription.slice(0, 80),
                    description: cleanDescription,
                    source: 'dashboard',
                    href: `/app/tasks/${taskId}`,
                },
                ...(confirmReply ? { reply: confirmReply } : {}),
                model: `${resolvedProvider}/${resolvedModel}`,
            })
            return
        }

        // PROJECT — one confirm because it creates a full multi-task sprint
        const confirmReply = `This is a multi-step effort. Confirm to get started.${recommendedSwitch}`
        try {
            if (conversationId) {
                await updateConversationById(conversationId, { reply: confirmReply, status: 'complete' })
                turnSettled = true
            } else {
                await recordConversation({ workspaceId, sessionId, source: 'dashboard', message: trimmedMsg, reply: confirmReply, status: 'complete', intent, messageEmbedding: _resolvedEmbedding })
                turnSettled = true
            }
        } catch (err) {
            logger.error({ err, workspaceId }, 'Webchat: failed to record pre-confirmation conversation')
        }

        // Multi-step confirm-prompt: surface ONLY the user's clean message
        // to the confirm dialog.
        res.json({
            status: 'confirm_action',
            intent,
            description: trimmedMsg,
            model: `${resolvedProvider}/${resolvedModel}`,
        })
    } catch (err) {
        logger.error({ err }, 'POST /api/chat/message failed')
        trackEvent('channel.error', 'error', { channel: 'webchat', error: 'message_handler_failed' })
        if (conversationId && !turnSettled) {
            try { await updateConversationById(conversationId, { errorMsg: err instanceof Error ? err.message.slice(0, 500) : 'chat handler failed', status: 'failed' }) } catch { /* best-effort */ }
        } else if (!conversationId && !turnSettled) {
            try { await recordConversation({ workspaceId, sessionId, source: 'dashboard', message: trimmedMsg, errorMsg: 'chat handler failed', status: 'failed', intent, messageEmbedding: _resolvedEmbedding }) } catch { /* best-effort */ }
        }
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: "Couldn't queue your message. Try again — if it keeps happening, check Settings → AI Providers." } })
    }
    }) // end withSessionLock
})

// ── POST /api/chat/execute-action ──────────────────────────────────────────────

chatRouter.post('/execute-action', async (req, res) => {
    const { workspaceId, intent, description, sessionId: clientSessionId, newSession } = req.body as {
        workspaceId?: string
        intent?: 'TASK' | 'PROJECT'
        description?: string
        sessionId?: string
        newSession?: boolean
    }
    let sessionId: string | undefined = clientSessionId
    let _executeActionEmbedding: number[] | null = null

    if (!workspaceId || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE', message: 'Valid workspaceId required' } })
        return
    }
    if (!await ensureWorkspaceAccess(req, res, workspaceId)) return
    if (!intent || !description) {
        res.status(400).json({ error: { code: 'MISSING_FIELDS', message: 'intent and description required' } })
        return
    }

    // Apply the universal session resolver so task-triggered conversations
    // land in the same session rules as other channels.
    //
    // newSession === true BYPASSES the resolver so an explicitly fresh chat
    // never silently merges into an unrelated session.
    if (newSession === true && clientSessionId) {
        sessionId = clientSessionId
        try {
            _executeActionEmbedding = await embedSessionMessage(workspaceId, description)
        } catch (err) {
            logger.debug({ err }, 'execute-action: embedding new session first turn failed (non-fatal)')
        }
        logger.info({ workspaceId, sessionId }, 'execute-action: new session (client-minted, resolver bypassed)')
    } else if (clientSessionId && !/^(telegram|slack|discord):/.test(clientSessionId)) {
        try {
            const resolved = await resolveUniversalSession({
                workspaceId,
                channel: 'web',
                channelThreadId: clientSessionId,
                newMessage: description,
            })
            sessionId = resolved.sessionId
            _executeActionEmbedding = resolved.newMessageEmbedding
        } catch (err) {
            logger.warn({ err, clientSessionId }, 'execute-action: session resolver failed')
        }
    }

    try {
        if (intent === 'TASK' || intent === 'PROJECT') {
            // Both confirm-chip intents queue a background task. PROJECT used to
            // create a `planning` sprint, but the sprint orchestrator was deleted
            // in DD-6 (`packages/agent/src/sprint`), so a sprint now advances
            // nothing — it would be a silent no-op. The executor plans multi-step
            // work itself, so both intents go through the task queue, and the
            // PROJECT branch previously 400'd ("intent must be TASK") because it
            // was never implemented at all.
            const taskId = await pushTask({
                workspaceId,
                type: 'automation',
                source: 'dashboard',
                context: {
                    description: description,
                    message: description,
                    sessionId: sessionId ?? null,
                    channel: 'web',
                },
                priority: 2,
            })
            logger.info({ workspaceId, taskId, intent }, 'Webchat task explicitly confirmed and queued')
            // Every task must have an associated conversation row so the /app/conversations
            // view shows task-triggered interactions alongside chat turns.
            try {
                await recordConversation({
                    workspaceId,
                    sessionId: sessionId ?? null,
                    source: 'dashboard',
                    message: description,
                    reply: null,
                    status: 'complete',
                    intent,
                    taskId,
                    messageEmbedding: _executeActionEmbedding,
                })
            } catch (err) {
                logger.warn({ err, taskId }, 'execute-action: failed to record task conversation')
            }
            emitToWorkspace(workspaceId, { type: 'task_queued', taskId, source: 'dashboard' })
            audit(req, { workspaceId, userId: req.user?.id, action: 'task.create', resource: 'tasks', resourceId: taskId, metadata: { source: 'dashboard', via: 'chat' } })
            res.status(202).json({ taskId, status: 'queued' })
        } else {
            res.status(400).json({ error: { code: 'INVALID_INTENT', message: 'intent must be TASK or PROJECT' } })
        }
    } catch (err) {
        logger.error({ err }, 'POST /api/chat/execute-action failed')
        trackEvent('channel.error', 'error', { channel: 'webchat', error: 'execute_action_failed' })
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: "Couldn't create the task. If this persists, check workspace quota and provider status in Settings." } })
    }
})

// ── GET /api/chat/reply/:taskId ───────────────────────────────────────────────
// Long-poll: waits up to 25s for the task to complete, then returns outcome

chatRouter.get('/reply/:taskId', async (req, res) => {
    const { taskId } = req.params
    const deadline = Date.now() + 25_000
    const interval = 1_000

    const poll = async (): Promise<void> => {
        try {
            const task = await chatRepo.getTaskReplyStatus(taskId!)

            if (!task) {
                res.status(404).json({ error: { code: 'TASK_NOT_FOUND' } })
                return
            }

            if (task.status === 'complete') {
                res.json({
                    taskId,
                    status: task.status,
                    reply: task.outcomeSummary ?? 'Done.',
                })
                return
            }

            if (task.status === 'cancelled' || task.status === 'blocked' || task.status === 'failed') {
                const userReply = task.status === 'cancelled'
                    ? 'Cancelled.'
                    : translateErrorForUser(task.outcomeSummary ?? '')
                res.json({ taskId, status: task.status, reply: userReply })
                return
            }

            if (Date.now() >= deadline) {
                res.json({ taskId, status: 'pending', reply: 'Task is running. Check back in a few seconds for results.' })
                return
            }

            await new Promise<void>((resolve) => setTimeout(resolve, interval))
            await poll()
        } catch (err) {
            logger.error({ err, taskId }, 'Webchat poll failed')
            res.status(500).json({ error: { code: 'POLL_FAILED' } })
        }
    }

    await poll()
})

// ── GET /api/chat/reply-stream/:taskId ───────────────────────────────────────
// SSE stream: fires a `tick` event every 3 s with step count + latest action.
// Fires a terminal event (`complete`, `blocked`, `cancelled`, `timeout`) then closes.
// Max duration: 5 min. Used by the web chat UI for live progress updates.

chatRouter.get('/reply-stream/:taskId', async (req, res) => {
    const { taskId } = req.params
    const startedAt = Date.now()
    const MAX_MS = 5 * 60 * 1000
    const TICK_MS = 3_000

    // SSE headers
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no') // disable nginx buffering
    res.flushHeaders()

    const send = (event: string, data: unknown) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    }

    let intervalId: ReturnType<typeof setInterval> | null = null
    let closed = false

    const finish = (event: string, data: unknown) => {
        if (closed) return
        closed = true
        if (intervalId) clearInterval(intervalId)
        send(event, data)
        res.end()
    }

    req.on('close', () => {
        closed = true
        if (intervalId) clearInterval(intervalId)
    })

    const tick = async () => {
        if (closed) return
        try {
            const elapsed = Math.round((Date.now() - startedAt) / 1000)

            const task = await chatRepo.getTaskTickFields(taskId!)

            if (!task) {
                finish('error', { code: 'TASK_NOT_FOUND' })
                return
            }

            if (task.status === 'complete') {
                finish('complete', {
                    taskId,
                    reply: task.outcomeSummary ?? 'Done.',
                })
                return
            }

            if (task.status === 'blocked' || task.status === 'cancelled' || task.status === 'failed') {
                const userReply = task.status === 'cancelled'
                    ? 'Cancelled.'
                    : translateErrorForUser(task.outcomeSummary ?? '')
                finish(task.status, { taskId, reply: userReply })
                return
            }

            if (elapsed * 1000 >= MAX_MS) {
                finish('timeout', { taskId, reply: `Task running for ${Math.round(elapsed)}s. Still processing — results will appear when complete.` })
                return
            }

            // Accepted plan (persisted at agent-loop after planning) — used to
            // surface "what is being built" while a single long step runs, and
            // to send a compact plan summary on the tick for the chat header.
            const planObj = task.plan as {
                goal?: string
                confidenceScore?: number
                steps?: Array<{ stepNumber: number; description: string; toolsRequired?: string[] }>
            } | null

            // Still running — fetch latest step for progress detail
            const latestStep = await chatRepo.getLatestStep(taskId!)

            const stepCount = latestStep?.stepNumber ?? 0
            const lastAction = latestStep?.outcome?.slice(0, 120) ?? null

            // Query persisted phase events AND tool-call history for the
            // agent-thinking panel. Each taskSteps row can carry either:
            //   - a legacy progress-event wrapper ({ progressEvent: {...} })
            //     written by emitter.persistProgressEvent
            //   - an array of tool calls ({ tool, input, output }) written by
            //     the executor checkpoint on every outer loop iteration
            let phases: Array<{ index: number; total: number; label: string; status: 'pending' | 'running' | 'complete' }> | undefined
            let currentPhase: string | undefined
            let progressEvents: Array<{
                id: string
                kind: 'phase' | 'tool_call' | 'reasoning' | 'memory' | 'learning' | 'error' | 'status'
                title: string
                toolName?: string
                input?: unknown
                output?: unknown
                error?: string
                startedAt: number
                completedAt?: number
                status: 'running' | 'success' | 'error'
            }> = []

            try {
                const allRows = await chatRepo.getStepRows(taskId!)

                const phaseEvents: Array<{ type: string; phase?: { index: number; total: number; label: string } }> = []

                // Per-step timing: a step's createdAt is when the step FINISHED
                // (that's when the executor writes the checkpoint). A step's
                // START is the previous step's createdAt, or the task's
                // createdAt for step 0. The executor also writes precise
                // wall-clock startedAt/completedAt/durationMs into
                // stepState — we prefer those when present. This fixes the
                // "0ms on every step" bug in the thinking panel.
                const taskStartTs = task.createdAt instanceof Date
                    ? task.createdAt.getTime()
                    : (allRows[0]?.createdAt instanceof Date
                        ? allRows[0].createdAt.getTime()
                        : startedAt)

                for (let rowIdx = 0; rowIdx < allRows.length; rowIdx++) {
                    const row = allRows[rowIdx]!
                    const rowEndTs = row.createdAt instanceof Date
                        ? row.createdAt.getTime()
                        : Date.now()
                    const prevRow = allRows[rowIdx - 1]
                    const rowStartTs = prevRow?.createdAt instanceof Date
                        ? prevRow.createdAt.getTime()
                        : taskStartTs
                    // Executor may stamp its own precise timings in stepState.
                    // Prefer those when present, fall back to the adjacent-row
                    // approximation above.
                    const state = row.stepState as Record<string, unknown> | null
                    const stateStart = (state && typeof state === 'object' && 'startedAt' in state && typeof state.startedAt === 'number')
                        ? state.startedAt as number
                        : null
                    const stateEnd = (state && typeof state === 'object' && 'completedAt' in state && typeof state.completedAt === 'number')
                        ? state.completedAt as number
                        : null
                    const startedAt = stateStart ?? rowStartTs
                    const completedAt = stateEnd ?? rowEndTs

                    // Legacy progress-event wrapper — feeds existing phases
                    const wrapper = row.toolCalls as null | {
                        progressEvent?: { type: string; phase?: { index: number; total: number; label: string } }
                    }
                    if (wrapper && !Array.isArray(wrapper) && wrapper.progressEvent) {
                        const pe = wrapper.progressEvent
                        if (pe.phase) {
                            phaseEvents.push(pe)
                            progressEvents.push({
                                id: `phase-${pe.phase.index}-${pe.type}-${rowEndTs}`,
                                kind: 'phase',
                                title: pe.phase.label,
                                startedAt,
                                completedAt: pe.type === 'phase_complete' ? completedAt : undefined,
                                status: pe.type === 'phase_complete' ? 'success' as const : 'running' as const,
                            })
                        } else if (pe.type === 'memory_commit' || pe.type === 'learning' || pe.type === 'error') {
                            progressEvents.push({
                                id: `meta-${row.stepNumber}-${pe.type}`,
                                kind: pe.type === 'memory_commit' ? 'memory' as const
                                    : pe.type === 'learning' ? 'learning' as const
                                    : 'error' as const,
                                title: row.outcome ?? pe.type,
                                startedAt,
                                completedAt,
                                status: pe.type === 'error' ? 'error' as const : 'success' as const,
                            })
                        }
                        continue
                    }

                    // Executor checkpoint — an array of tool calls made in this step.
                    // We only have per-STEP timing (not per-TOOL-CALL timing) so
                    // distribute the step window across the calls evenly. This
                    // gives non-zero durations in the thinking panel without
                    // requiring an executor-side schema change.
                    if (Array.isArray(row.toolCalls)) {
                        const calls = row.toolCalls
                        const n = calls.length || 1
                        const stepSpan = Math.max(0, completedAt - startedAt)
                        const slice = Math.floor(stepSpan / n)
                        for (let i = 0; i < calls.length; i++) {
                            const call = calls[i] as { tool?: string; input?: unknown; output?: unknown } | null
                            if (!call || typeof call !== 'object') continue
                            const toolName = typeof call.tool === 'string' ? call.tool : 'unknown'
                            const output = call.output
                            const outputStr = typeof output === 'string' ? output : JSON.stringify(output ?? '')
                            const isError = typeof outputStr === 'string' && outputStr.startsWith('ERROR:')
                            const hasOutput = output !== undefined && output !== null && outputStr !== ''
                            const callStartedAt = startedAt + (i * slice)
                            const callCompletedAt = i === calls.length - 1
                                ? completedAt
                                : startedAt + ((i + 1) * slice)
                            progressEvents.push({
                                id: `tc-${row.stepNumber}-${i}`,
                                kind: 'tool_call',
                                title: prettyToolTitle(toolName, call.input),
                                toolName,
                                input: redactInput(call.input),
                                output: hasOutput ? truncate(outputStr, 4_000) : undefined,
                                error: isError ? outputStr : undefined,
                                startedAt: callStartedAt,
                                completedAt: hasOutput ? callCompletedAt : undefined,
                                status: isError ? 'error' as const
                                    : hasOutput ? 'success' as const
                                    : 'running' as const,
                            })
                        }
                    }

                    // Bare running step from the executor's pre-step insert:
                    // model generation is in flight but no tool calls have been
                    // checkpointed yet. Surface a "Generating (model)" event so a
                    // single long step (1-step plans for simple builds) streams
                    // activity instead of a silent pulse. Suppressed once the
                    // end-of-step update stamps stepState.completedAt.
                    if (!Array.isArray(row.toolCalls) && row.state === 'running'
                        && state && typeof state === 'object' && state.phase === 'generating' && !stateEnd) {
                        const model = typeof state.model === 'string' ? state.model.split('/').pop() : undefined
                        progressEvents.push({
                            id: `gen-${row.stepNumber}`,
                            kind: 'status',
                            title: model ? `Generating response (${model})` : 'Generating response',
                            startedAt,
                            status: 'running',
                        })
                    }
                }

                if (phaseEvents.length > 0) {
                    // Determine total from first event that has it
                    const total = phaseEvents[0]!.phase!.total
                    const completedIndices = new Set(phaseEvents.filter(e => e.type === 'phase_complete').map(e => e.phase!.index))
                    const startedIndices = new Set(phaseEvents.filter(e => e.type === 'phase_start').map(e => e.phase!.index))

                    // Build unique phases from all events
                    const seen = new Map<number, string>()
                    for (const e of phaseEvents) {
                        if (e.phase && !seen.has(e.phase.index)) seen.set(e.phase.index, e.phase.label)
                    }

                    phases = Array.from(seen.entries()).map(([idx, label]) => ({
                        index: idx,
                        total,
                        label,
                        status: completedIndices.has(idx) ? 'complete' as const
                            : startedIndices.has(idx) ? 'running' as const
                            : 'pending' as const,
                    })).sort((a, b) => a.index - b.index)

                    const active = phases.find(p => p.status === 'running')
                    currentPhase = active?.label
                }

                // Mark the last progress event as still-running if the task itself
                // is still running and that event has no explicit completion marker.
                // This drives the pulsing indicator in the UI.
                if (progressEvents.length > 0 && task.status === 'running') {
                    const last = progressEvents[progressEvents.length - 1]!
                    if (!last.completedAt && last.status !== 'error') {
                        last.status = 'running'
                    }
                }
            } catch (err) {
                logger.debug({ err, taskId }, 'Webchat SSE progress projection failed')
                /* non-fatal — phases/events are optional */
            }

            // Pre-step fallback: when the task is running but NO progress
            // events have been projected yet (deepseek-reasoner typically
            // takes 30-90s for its first generateText to return, so no
            // task_steps row exists yet), synthesize a single "Calling
            // model" event so the chat thinking panel has something to
            // show other than an empty pulse. The executor's real events
            // overwrite this as soon as the first step is checkpointed.
            // Fixes the "Thinking… 0ms" silent-wait class complementing
            // commit 1c95ee2's runStartedAtRef timer anchor.
            if (progressEvents.length === 0 && task.status === 'running') {
                const taskCreatedMs = task.createdAt instanceof Date
                    ? task.createdAt.getTime()
                    : startedAt
                const planSteps = planObj?.steps
                if (planSteps && planSteps.length > 0) {
                    const first = planSteps[0]!
                    const cap = first.toolsRequired?.[0] ? describeToolCall(first.toolsRequired[0]) : undefined
                    progressEvents.push({
                        id: `plan-step-${first.stepNumber}`,
                        kind: 'status',
                        title: cap ? `${first.description} \u2014 ${cap}` : first.description,
                        startedAt: taskCreatedMs,
                        status: 'running',
                    })
                    if (!currentPhase) currentPhase = first.description
                } else {
                    progressEvents.push({
                        id: 'pre-step-thinking',
                        kind: 'phase',
                        title: 'Planning\u2026',
                        startedAt: taskCreatedMs,
                        status: 'running',
                    })
                }
            }

            // Sprint/sub-agent activity: when this chat task spawned a sprint
            // (projectId set), project its current wave + sub-agent states so the
            // chat can render the multi-agent "Agent Activity" panel. Single-agent
            // tasks have no projectId and this stays undefined (panel hidden).
            let sprint: {
                id: string
                request: string
                totalTasks: number
                completedTasks: number
                failedTasks: number
                currentWave?: { index: number; total: number }
                subAgents: Array<{ id: string; description: string; branch: string; status: string; priority: number }>
            } | undefined
            if (task.projectId) {
                try {
                    const sp = await chatRepo.getSprintProjection(task.projectId)

                    if (sp) {
                        const subRows = await chatRepo.getSprintSubTasks(sp.id)

                        const lastWave = await chatRepo.getLastWaveLog(sp.id)
                        const wm = (lastWave?.metadata ?? {}) as { wave?: number; totalWaves?: number }

                        sprint = {
                            id: sp.id,
                            request: (sp.request ?? '').slice(0, 200),
                            totalTasks: sp.totalTasks,
                            completedTasks: sp.completedTasks,
                            failedTasks: sp.failedTasks,
                            ...(typeof wm.wave === 'number' && typeof wm.totalWaves === 'number'
                                ? { currentWave: { index: wm.wave, total: wm.totalWaves } }
                                : {}),
                            subAgents: subRows.map((r) => ({
                                id: r.id,
                                description: (r.description ?? '').slice(0, 160),
                                branch: r.branch ?? '',
                                status: r.status,
                                priority: r.priority,
                            })),
                        }
                    }
                } catch (err) {
                    logger.debug({ err, taskId }, 'Webchat SSE sprint projection failed')
                }
            }

            // Compact plan summary so the chat can render a "Here's the plan"
            // header while the task runs — the data the user was missing during
            // the bare "Thinking…" wait. Capability tag derived from each step's
            // first required tool.
            const planSummary = (planObj?.steps && planObj.steps.length > 0)
                ? {
                    goal: planObj.goal,
                    confidenceScore: planObj.confidenceScore,
                    steps: planObj.steps.map((s) => ({
                        n: s.stepNumber,
                        description: s.description,
                        capability: s.toolsRequired?.[0] ? describeToolCall(s.toolsRequired[0]) : undefined,
                    })),
                }
                : undefined

            send('tick', {
                taskId,
                status: task.status,
                elapsed,
                stepCount,
                lastAction,
                progressEvents,
                ...(phases ? { phases } : {}),
                ...(currentPhase ? { currentPhase } : {}),
                ...(planSummary ? { plan: planSummary } : {}),
                ...(sprint ? { sprint } : {}),
            })
        } catch (err) {
            logger.error({ err, taskId }, 'Webchat SSE tick failed')
            // Don't close on a transient DB error — try again next tick
        }
    }

    // Fire immediately then every TICK_MS
    await tick()
    intervalId = setInterval(() => { void tick() }, TICK_MS)
})

// ── GET /api/chat/widget.js ───────────────────────────────────────────────────
// Embeddable chat widget — vanilla JS, no framework needed

chatRouter.get('/widget.js', (req, res) => {
    const apiBase = process.env.PUBLIC_URL ?? 'http://localhost:3001'

    const script = `
(function() {
    var cfg = document.currentScript;
    var wsId = cfg && cfg.getAttribute('data-workspace') || '';
    var siteName = cfg && cfg.getAttribute('data-site-name') || 'Plexo';
    var apiBase = cfg && cfg.getAttribute('data-api') || '${apiBase}';
    if (!wsId) { console.warn('[Plexo] data-workspace attribute required'); return; }

    // Inject styles
    var style = document.createElement('style');
    style.textContent = [
        '#plexo-widget-btn{position:fixed;bottom:24px;right:24px;width:56px;height:56px;border-radius:50%;background:linear-gradient(135deg,#6366f1,#8b5cf6);border:none;cursor:pointer;box-shadow:0 4px 24px rgba(99,102,241,.4);display:flex;align-items:center;justify-content:center;z-index:9999;transition:transform .2s}',
        '#plexo-widget-btn:hover{transform:scale(1.08)}',
        '#plexo-widget-panel{position:fixed;bottom:96px;right:24px;width:360px;height:480px;border-radius:16px;background:#18181b;border:1px solid #3f3f46;box-shadow:0 24px 64px rgba(0,0,0,.6);display:flex;flex-direction:column;z-index:9998;overflow:hidden;opacity:0;transform:translateY(16px) scale(.96);transition:opacity .2s,transform .2s;pointer-events:none}',
        '#plexo-widget-panel.open{opacity:1;transform:translateY(0) scale(1);pointer-events:all}',
        '#plexo-widget-header{display:flex;align-items:center;gap:10px;padding:14px 16px;border-bottom:1px solid #3f3f46;background:#09090b}',
        '#plexo-widget-header span{font-size:14px;font-weight:600;color:#f4f4f5;font-family:system-ui,sans-serif}',
        '#plexo-widget-avatar{width:32px;height:32px;border-radius:50%;background:linear-gradient(135deg,#6366f1,#8b5cf6);display:flex;align-items:center;justify-content:center;font-size:16px}',
        '#plexo-widget-msgs{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px;scroll-behavior:smooth}',
        '.plexo-msg{max-width:80%;padding:8px 12px;border-radius:12px;font-size:13px;line-height:1.5;font-family:system-ui,sans-serif;word-break:break-word}',
        '.plexo-msg.user{align-self:flex-end;background:#6366f1;color:#fff;border-bottom-right-radius:4px}',
        '.plexo-msg.agent{align-self:flex-start;background:#27272a;color:#e4e4e7;border-bottom-left-radius:4px}',
        '.plexo-msg.typing{color:#71717a;font-style:italic;background:#27272a}',
        '#plexo-widget-input-row{display:flex;gap:8px;padding:10px;border-top:1px solid #3f3f46;background:#09090b}',
        '#plexo-widget-input{flex:1;border:1px solid #3f3f46;background:#18181b;color:#f4f4f5;border-radius:8px;padding:8px 12px;font-size:13px;outline:none;font-family:system-ui,sans-serif}',
        '#plexo-widget-input:focus{border-color:#6366f1}',
        '#plexo-widget-send{background:#6366f1;color:#fff;border:none;border-radius:8px;padding:8px 14px;font-size:13px;font-weight:600;cursor:pointer;font-family:system-ui,sans-serif}',
        '#plexo-widget-send:disabled{opacity:.5;cursor:not-allowed}',
    ].join('');
    document.head.appendChild(style);

    // Build DOM
    var btn = document.createElement('button');
    btn.id = 'plexo-widget-btn';
    btn.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
    btn.setAttribute('aria-label', 'Open chat');

    var panel = document.createElement('div');
    panel.id = 'plexo-widget-panel';
    panel.innerHTML = '<div id="plexo-widget-header"><div id="plexo-widget-avatar">\ud83e\udd16</div><span id="plexo-widget-title"></span></div><div id="plexo-widget-msgs"></div><div id="plexo-widget-input-row"><input id="plexo-widget-input" placeholder="Ask anything\u2026" /><button id="plexo-widget-send">Send</button></div>';
    document.getElementById('plexo-widget-title').textContent = siteName;

    document.body.appendChild(btn);
    document.body.appendChild(panel);

    var msgs = document.getElementById('plexo-widget-msgs');
    var input = document.getElementById('plexo-widget-input');
    var send = document.getElementById('plexo-widget-send');
    var open = false;
    var sessionId = 'ws-' + Math.random().toString(36).slice(2);

    btn.onclick = function() {
        open = !open;
        panel.classList.toggle('open', open);
        if (open && msgs.children.length === 0) addMsg('agent', 'Hi! I\\'m ' + siteName + '. How can I help you today?');
        if (open) setTimeout(function(){ input.focus(); }, 200);
    };

    function addMsg(role, text) {
        var d = document.createElement('div');
        d.className = 'plexo-msg ' + role;
        d.textContent = text;
        msgs.appendChild(d);
        msgs.scrollTop = msgs.scrollHeight;
        return d;
    }

    async function sendMsg() {
        var text = input.value.trim();
        if (!text) return;
        input.value = '';
        send.disabled = true;
        addMsg('user', text);
        var typing = addMsg('typing', 'Thinking\u2026');
        try {
            var r = await fetch(apiBase + '/api/chat/message', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ workspaceId: wsId, message: text, sessionId: sessionId }),
            });
            if (!r.ok) { typing.textContent = 'Error sending message.'; return; }
            var d = await r.json();
            var taskId = d.taskId;
            var reply = await fetch(apiBase + '/api/chat/reply/' + taskId);
            var rd = await reply.json();
            typing.textContent = rd.reply || 'Done.';
            typing.className = 'plexo-msg agent';
        } catch(e) {
            typing.textContent = 'Connection error. Please try again.';
        } finally {
            send.disabled = false;
            input.focus();
        }
    }

    send.onclick = sendMsg;
    input.onkeydown = function(e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMsg(); } };
})();
`.trim()

    res.setHeader('Content-Type', 'application/javascript; charset=utf-8')
    res.setHeader('Cache-Control', 'public, max-age=300')
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.send(script)
})
