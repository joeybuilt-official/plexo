// SPDX-License-Identifier: AGPL-3.0-only
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
import { db, eq, desc, sql } from '@plexo/db'
import { workspaces, tasks, taskSteps, sprints, modelsKnowledge } from '@plexo/db'
import { ulid } from 'ulid'
import { logger } from '../logger.js'
import { pushTask } from '@plexo/queue'
import { emitToWorkspace } from '../sse-emitter.js'
import { generateText } from 'ai'
import { withFallback, PROVIDER_DEFAULT_MODELS } from '@plexo/agent/providers/registry'
import { loadWorkspaceAISettings } from '../agent-loop.js'
import { runSprint } from '@plexo/agent/sprint/runner'
import { storeMemory, rememberInstruction } from '@plexo/agent/memory/store'
import { setPreference } from '@plexo/agent/memory/preferences'
import {
    recordConversation,
    getSessionChannelRef,
    replyToChannel,
    getSessionTurns,
} from '../conversation-log.js'
import { hasRecallIntent, recallPriorConversation } from '../channel-ai.js'
import { getTelegramToken } from './telegram.js'
import { captureException, captureLifecycleEvent } from '../sentry.js'
import { UUID_RE } from '../validation.js'
import type { FallbackOptions } from '@plexo/agent/providers/registry'

export const chatRouter: RouterType = Router()

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
    const lower = raw.toLowerCase()
    const technical = raw.slice(0, 300)

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
    if (lower.includes('billing') || lower.includes('payment') || lower.includes('insufficient_quota') || lower.includes('delinquent')) {
        return { type: 'billing', message: "Your AI provider account has a billing issue. Check your billing status on the provider's dashboard.", fixUrl: '/settings/ai-providers', fixLabel: 'Check provider settings', technical }
    }
    if (lower.includes('content') && (lower.includes('filter') || lower.includes('policy') || lower.includes('safety') || lower.includes('moderation'))) {
        return { type: 'content_policy', message: "The request was blocked by the provider's content policy. Try rephrasing.", fixUrl: '/settings/agent', fixLabel: 'Adjust agent settings', technical }
    }

    return { type: 'unknown', message: `The AI provider returned an error. ${raw.slice(0, 120)}`, fixUrl: '/settings/ai-providers', fixLabel: 'Check AI Provider settings', technical }
}


// ── Intent classification ────────────────────────────────────────────────────

const CLASSIFY_SYSTEM = `You are an intent classifier for an AI agent platform.
Classify the user's message into exactly one of: TASK, PROJECT, MEMORY, or CONVERSATION.

────────────────────────────────────────────────────────
CONVERSATION — use this by default. It covers:
- Any question ("what is X", "how does X work", "explain X")
- Jokes, riddles, trivia, fun requests
- Ideas, brainstorming, lists ("give me 5 ideas", "5 post ideas", "a few options")
- Short creative writing: poems, taglines, captions, slogans
- Social media posts (any quantity up to ~10)
- Summaries, quick translations, text edits
- Greetings, small talk, meta-questions ("who are you", "what can you do")
- Anything that a capable assistant could answer in a single reply
- Short confirmations AFTER a CONVERSATION exchange
- Anything where you are unsure
────────────────────────────────────────────────────────
TASK — ONLY when ALL of these are true:
1. The output is too large or complex to deliver in a single chat reply (e.g. a 20-page research report, a full content calendar, a detailed analysis of hundreds of rows of data)
2. OR the task requires running code, searching the web, writing to files, or calling external APIs autonomously
3. AND the user is explicitly requesting this autonomous work, not just asking for quick content
NOT TASK: jokes, questions, ideas, lists, social media posts, short creative content, simple lookups
NOT TASK: ambiguous requests, vague noun phrases like "Wayfinders S2 Campaign" (these need conversation)
────────────────────────────────────────────────────────
PROJECT — ONLY for large multi-step engineering/creative goals spanning days/weeks:
"build a full product feature", "launch a complete marketing campaign", "refactor the auth system"
Always PROJECT when user confirms a prior PROJECT proposal.
NOT PROJECT: vague concepts or campaign names without explicit directives. These require CONVERSATION to scope out strategy, timeline, etc. first.
────────────────────────────────────────────────────────
MEMORY — user wants to set a persistent behavioral rule:
"always use TypeScript", "never deploy on Fridays", "remember that I prefer dark mode"
────────────────────────────────────────────────────────

Examples (follow these exactly):
"Tell me a joke" → CONVERSATION SIMPLE
"Give me ideas for 5 social media posts" → CONVERSATION SIMPLE
"Write me 3 Instagram captions for a coffee shop" → CONVERSATION SIMPLE
"What's the capital of France?" → CONVERSATION SIMPLE
"Who are you?" → CONVERSATION SIMPLE
"What model are you using?" → CONVERSATION SIMPLE
"Explain async/await" → CONVERSATION SIMPLE
"Give me 10 taglines for my SaaS" → CONVERSATION SIMPLE
"Write me a haiku" → CONVERSATION SIMPLE
"Research AI coding tools and create a 30-page market analysis report" → TASK COMPLEX
"Scrape 500 websites and compile a dataset" → TASK COMPLEX
"Optimize this prompt for me" → CONVERSATION COMPLEX
"Rewrite this prompt using first principles" → CONVERSATION COMPLEX
"Remember: always reply in bullet points" → MEMORY SIMPLE
"Build a full marketing plan with competitive analysis and ROI projections" → TASK COMPLEX

Critical: when in doubt, use CONVERSATION. The cost of making something a TASK when it should be CONVERSATION is very high — the user gets a queued task instead of an immediate answer.

Reply with EXACTLY one of:
  CONVERSATION SIMPLE
  CONVERSATION COMPLEX
  TASK SIMPLE
  TASK COMPLEX
  PROJECT SIMPLE [category]
  PROJECT COMPLEX [category]
  MEMORY SIMPLE
(where [category] is one of: code research writing ops data marketing general)`

// Per-session conversation history now fetched dynamically per request from DB
// to ensure persistence and full context even if the agent server restarts.
// ── POST /api/chat/message ────────────────────────────────────────────────────

chatRouter.post('/message', async (req, res) => {
    const { workspaceId, message, sessionId, forceConversation, images, intentOverride, categoryOverride } = req.body as {
        workspaceId?: string
        message?: string
        sessionId?: string
        forceConversation?: boolean
        images?: Array<{ data: string; mimeType: string; name: string }>
        intentOverride?: 'TASK' | 'PROJECT' | 'MEMORY' | 'CONVERSATION'
        categoryOverride?: string
    }

    if (!workspaceId || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE', message: 'Valid workspaceId required' } })
        return
    }

    // Validate images (raster only — SVG and PDF are handled client-side as extracted text)
    const validImages: Array<{ data: string; mimeType: string; name: string }> = []
    if (Array.isArray(images)) {
        if (images.length > 5) {
            res.status(400).json({ error: { code: 'TOO_MANY_IMAGES', message: 'Maximum 5 images per message' } })
            return
        }
        for (const img of images) {
            if (typeof img.data !== 'string' || !img.data.startsWith('data:image/')) {
                res.status(400).json({ error: { code: 'INVALID_IMAGE', message: 'Images must be base64 data URLs (data:image/...)' } })
                return
            }
            // Block SVG from the image path — it must go through the text path
            if (img.mimeType === 'image/svg+xml') {
                res.status(400).json({ error: { code: 'INVALID_IMAGE', message: 'SVG must be sent as a text document, not an image' } })
                return
            }
            validImages.push(img)
        }
    }

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

    try {
        // ── Parallel load: workspace + AI settings + session history ──────────
        // These are all independent — run them concurrently instead of sequentially.
        const sid = sessionId ?? 'default'
        const [wsResult, aiResult, dbTurns] = await Promise.all([
            db.select({ id: workspaces.id, name: workspaces.name, settings: workspaces.settings })
                .from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1),
            loadWorkspaceAISettings(workspaceId),
            getSessionTurns(workspaceId, sid, 50),
        ])

        const [ws] = wsResult
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

        // Slim identity line — skip full introspection snapshot for conversation mode.
        // The snapshot (9 DB queries, ~10KB JSON) is only loaded lazily for TASK/PROJECT paths.
        const identityLine = `Your identity: you are ${agentName}, running on provider "${resolvedProvider}", model "${resolvedModel}". If asked what model, AI, or system you are, answer truthfully.`
        const personaPrefix = agentPersona ? agentPersona + '\n\n' : ''
        const taglineHint = agentTagline ? ` (${agentTagline})` : ''

        // Classify intent — skip if caller forced CONVERSATION (e.g. "Just answer" button)
        // Default to CONVERSATION — tasks only get proposed when classifier explicitly says so.
        let intent: 'TASK' | 'PROJECT' | 'MEMORY' | 'CONVERSATION' = 'CONVERSATION'

        type ContentPart = { type: 'text'; text: string } | { type: 'image'; image: string | URL; mimeType?: string }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- AI SDK message types are complex union types
        const history: any[] = []
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
                        parts.push({ type: 'text', text: match[0] }) // fallback
                    }
                    lastIndex = match.index + match[0].length
                }
                if (lastIndex < t.message.length) {
                    parts.push({ type: 'text', text: t.message.substring(lastIndex) })
                }
                
                // if we only have one text part, just use it to keep API simple, else use parts array
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

        let finalMessageText = textMessage
        const turnId = ulid()

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
                }
            } catch (err) {
                logger.warn({ err }, 'Failed to upload chat images to storage')
            }
        }

        const trimmedMsg = finalMessageText.trim() || (hasImages ? `[Image${validImages.length > 1 ? 's' : ''} attached]` : '')

        const userContent: ContentPart[] = hasImages
            ? [
                { type: 'text', text: trimmedMsg },
                ...validImages.map((img) => ({
                    type: 'image' as const,
                    image: img.data.startsWith('data:')
                        ? img.data  // keep full data URL — AI SDK handles both formats
                        : `data:${img.mimeType};base64,${img.data}`,
                })),
              ]
            : [{ type: 'text', text: trimmedMsg }]

        // ── Cross-session memory recall ──────────────────────────────────────
        const sessionPrefix = `webchat:${workspaceId}:${sid}:`
        let recalledContext: string | null = null
        if (hasRecallIntent(trimmedMsg)) {
            try {
                recalledContext = await recallPriorConversation(workspaceId, trimmedMsg, sessionPrefix)
                if (recalledContext) {
                    logger.info({ workspaceId, sessionId: sid, chars: recalledContext.length }, 'Webchat: recalled prior conversation context')
                }
            } catch (err) {
                logger.warn({ err, workspaceId }, 'Webchat: recall search failed — proceeding without')
            }
        }

        let isComplex = !!intentOverride
        let suggestedCategory = categoryOverride || 'general'

        if (intentOverride) {
            intent = intentOverride
        } else if (!forceConversation) {
            // Fast local heuristic: skip the LLM classifier for messages that are
            // obviously conversational (greetings, questions, short messages, follow-ups).
            // This saves 500ms-2s per message for the common case.
            const lower = trimmedMsg.toLowerCase()
            const wordCount = trimmedMsg.split(/\s+/).length
            const isObviousConversation =
                wordCount <= 5 ||                                                  // very short messages
                /^(hi|hey|hello|yo|sup|what|how|why|when|where|who|can you|do you|are you|tell me|thanks|thank you|ok|okay|sure|yes|no|yeah|nah|again|try again|test)/i.test(lower) ||
                /\?$/.test(trimmedMsg) ||                                          // questions
                /^(remember|always|never|don't|make sure)\s/i.test(lower)           // memory instructions

            const isObviousMemory = /^(remember|always|never|don't|dont)\s/i.test(lower)

            if (isObviousMemory) {
                intent = 'MEMORY'
            } else if (isObviousConversation) {
                intent = 'CONVERSATION'
            } else {
                // Ambiguous — fall back to LLM classifier
                try {
                    const classifyMessages = [
                        ...textHistory,
                        { role: 'user' as const, content: trimmedMsg }
                    ] as any[]

                    const classifyResult = await withFallback(aiSettings, 'classification', async (model) =>
                        generateText({
                            model,
                            system: CLASSIFY_SYSTEM,
                            messages: classifyMessages,
                            abortSignal: AbortSignal.timeout(10_000),
                        }),
                        fallbackOpts(workspaceId),
                    )
                    const text = classifyResult.text?.trim() ?? ''
                    const upperText = text.toUpperCase()
                    const parts = text.split(/\s+/)
                    if (upperText.startsWith('TASK')) intent = 'TASK'
                    else if (upperText.startsWith('PROJECT')) intent = 'PROJECT'
                    else if (upperText.startsWith('MEMORY')) intent = 'MEMORY'
                    else intent = 'CONVERSATION'

                    if (parts[1]?.toUpperCase().startsWith('COMPLEX')) isComplex = true

                    if (intent === 'PROJECT' && parts[2]) {
                        const cat = parts[2].toLowerCase()
                        const validCats = ['code', 'research', 'writing', 'ops', 'data', 'marketing', 'general']
                        if (validCats.includes(cat)) suggestedCategory = cat
                    }
                } catch {
                    intent = 'CONVERSATION'
                }
            }
        }


        // Lazy-load full introspection snapshot only for TASK/PROJECT paths
        // (skipped for CONVERSATION to save 80-150ms of DB queries)
        let fullIdentityLine = identityLine
        if (intent === 'TASK' || intent === 'PROJECT') {
            try {
                const { buildIntrospectionSnapshot } = await import('@plexo/agent/introspection')
                const snapshot = await buildIntrospectionSnapshot(workspaceId, resolvedProvider, resolvedModel)
                fullIdentityLine = `${identityLine}\n\nHere is your full state and self-awareness snapshot:\n${JSON.stringify(snapshot, null, 2)}`
            } catch { /* non-fatal — proceed with slim identity */ }
        }

        // Consultative routing: Check for recommended model
        let recommendedSwitch = ''
        if (isComplex && (intent === 'TASK' || intent === 'PROJECT')) {
            const currentModelId = config.model ?? 'default'

            const [kbEntry] = await db.select().from(modelsKnowledge)
                .where(eq(modelsKnowledge.modelId, currentModelId))
                .limit(1)

            const hasReasoning = kbEntry?.strengths?.includes('reasoning') ||
                currentModelId.includes('sonnet') ||
                currentModelId.includes('gpt-4') ||
                currentModelId.includes('o1')

            if (!hasReasoning) {
                // Find a reasoning model in DB from the same provider if possible, or OpenRouter
                const [betterMatch] = await db.select().from(modelsKnowledge)
                    .where(sql`${modelsKnowledge.strengths} @> '["reasoning"]'::jsonb`)
                    .orderBy(desc(modelsKnowledge.reliabilityScore))
                    .limit(1)

                if (betterMatch && betterMatch.modelId !== currentModelId) {
                    recommendedSwitch = `\n\nFor this complex task, I recommend switching from your default ${currentModelId} to ${betterMatch.modelId} for better logic and reasoning.`
                }
            }
        }

        logger.info({ workspaceId, intent, message: trimmedMsg.slice(0, 80) }, 'Webchat intent classified')

        // ── MEMORY intent: store instruction immediately ───────────────────────────
        if (intent === 'MEMORY') {
            try {
                await rememberInstruction({ workspaceId, instruction: trimmedMsg, source: 'chat', aiSettings: aiSettings ?? undefined })

                // Also write to workspace_preferences under a unique key per instruction
                // so multiple "remember X" instructions accumulate rather than overwrite
                const sanitized = trimmedMsg.replace(/^(remember|always|never|don't|dont|please|make sure)\s+/i, '').trim()
                const instrKey = `user_instruction:${Date.now()}`
                await setPreference({ workspaceId, key: instrKey, value: sanitized, source: 'chat' })

                const reply = `Got it — I'll remember that and apply it going forward.`

                try {
                    await recordConversation({ workspaceId, sessionId, source: 'dashboard', message: trimmedMsg, reply, status: 'complete', intent })
                } catch (err) { logger.error({ err }, "Failed to record conversation") }

                res.json({ status: 'complete', reply })
            } catch (err) {
                logger.error({ err, workspaceId }, 'MEMORY intent storage failed')
                res.json({ status: 'complete', reply: 'I tried to remember that, but ran into an issue. Please try again.' })
            }
            return
        }

        if (intent === 'CONVERSATION') {
            // Detect if this session originated from an external channel (Telegram, etc.)
            // so we (a) record the correct source and (b) relay the reply back
            let externalChannelRef: { channel: string; channelId: string; chatId: string } | null = null
            if (sessionId && sessionId.startsWith('telegram:')) {
                externalChannelRef = await getSessionChannelRef(workspaceId, sessionId).catch(() => null)
            }
            const conversationSource = externalChannelRef ? externalChannelRef.channel : 'dashboard'

            // Build real workspace snapshot for self-awareness (lightweight — 1 query)
            let workspaceSnapshot = ''
            try {
                const statsRes = await fetch(`http://localhost:3001/api/v1/tasks/stats/summary?workspaceId=${workspaceId}`)
                if (statsRes.ok) {
                    const stats = await statsRes.json() as { byStatus?: Record<string, number>; cost?: { total?: number } }
                    const s = stats.byStatus ?? {}
                    workspaceSnapshot = `\nWORKSPACE LIVE DATA (real, not estimated):\n- Tasks: ${s.complete ?? 0} completed, ${s.running ?? 0} running, ${s.blocked ?? 0} blocked, ${s.cancelled ?? 0} cancelled\n- Weekly cost: $${(stats.cost?.total ?? 0).toFixed(2)}`
                }
            } catch { /* non-fatal */ }

            try {
                logger.info({ workspaceId, providerKey, modelId: config.model }, 'Webchat: generating conversational reply')
                const result = await withFallback(aiSettings, 'summarization', async (model) =>
                    generateText({
                        model,
                        system: `${personaPrefix}You are ${agentName}${taglineHint}. ${identityLine}

Personality: Warm, sharp, direct. You get things done. Never hedge, over-explain, or ask unnecessary questions.

Critical rules — follow without exception:
1. NEVER ask for confirmation before answering. Just answer.
2. NEVER ask clarifying questions unless the request is genuinely ambiguous AND a reasonable assumption cannot be made.
3. For jokes — tell the joke immediately. No "Sure, here's a joke:" preamble. Just tell it.
4. For ideas, lists, posts, captions, creative content — produce the content directly here in the reply. Do NOT say "I'll queue a task" or "should I create a task?" — just write it.
5. For social media posts, taglines, slogans, or any creative content — produce them immediately in this reply.
6. Keep replies concise. No filler: no "Certainly!", "Of course!", "Great question!", "I'd be happy to help!".
7. If the user expresses frustration, acknowledge it in one word and get to it.
8. If the user mentions a large initiative (like a "Campaign" or "Project") without supplying details, ALWAYS ask about strategy, timeline, goals/priorities, and channels, and ask if they'd like to start a project.
9. You are the agent. Act like one. Produce results, not process descriptions.
10. PROMPT OPTIMIZER: If the user asks you to optimize, improve, or write a prompt, DO NOT just write the prompt right away. Instead, act as a "first principles prompt optimizer": ask 2-3 specific, clarifying questions about their actual goals, context, target audience, and constraints. Only after they answer should you build the new optimized prompt.
11. PLAIN ENGLISH ONLY: Never list tool names in backticks or code formatting. Describe what you can do in plain language: "I can read and write files, run shell commands, search the web, browse websites, and more" — not "My tools include \`read_file\`, \`write_file\`, \`shell\`". You are talking to a person, not writing documentation.
12. CONNECTIONS: If the user asks to connect to or integrate with a service, provide a direct link: [Connect Gmail](/connections?highlight=google-workspace) or [Connect GitHub](/connections?highlight=github) etc. The link format is /connections?highlight={service-id}. Known service IDs: github, google-workspace (Gmail/Calendar), google-drive, slack, discord, jira, linear, notion, cloudflare, coolify, sentry, posthog, pagerduty, netlify, openai, ovhcloud, datadog. If the service isn't in this list and you have synthesize_extension capability, offer to build a custom connector. Always give a clickable link — never just text directions.

SELF-AWARENESS — What you are:
- You ARE Plexo, a self-hosted AI agent platform. You run tasks, manage projects, and connect to external services.
- You have workspace-level memory that persists between conversations.
- CRITICAL: In conversation mode, you do NOT have live access to internal data (tasks, health, connections). When asked about tasks, system status, or workspace data, be HONEST: say you need to run a task to look that up, or suggest the user check the dashboard. NEVER fabricate task names, statuses, or system metrics. Making up data is worse than admitting you need to look it up.
- If the user asks about specific task details (names, outputs, step logs), offer to look it up.
- The live workspace data below is real — use it when answering questions about task counts, costs, or system status.${workspaceSnapshot}${recalledContext ? `\n\n${recalledContext}` : ''}`,
                        messages: [
                            ...history,
                            { role: 'user' as const, content: userContent as any },
                        ],
                        abortSignal: AbortSignal.timeout(30_000),
                    }),
                    fallbackOpts(workspaceId),
                )
                const replyText = result.text
                if (!replyText) {
                    logger.warn({ workspaceId, providerKey }, 'Webchat: empty response from model')
                    const classified = classifyAIError(new Error('Empty response from model — the model returned no text.'))
                    try {
                        await recordConversation({ workspaceId, sessionId, source: conversationSource, message: trimmedMsg, errorMsg: classified.message, status: 'failed', intent })
                    } catch (err) { logger.error({ err }, "Failed to record conversation") }
                    res.json({ status: 'error', reply: classified.message, fixUrl: classified.fixUrl, fixLabel: classified.fixLabel, technicalDetail: classified.technical })
                    return
                }

                // Record the conversation turn
                try {
                    await recordConversation({ workspaceId, sessionId, source: conversationSource, message: trimmedMsg, reply: replyText, status: 'complete', intent })
                } catch (err) { logger.error({ err }, "Failed to record conversation") }

                // Relay reply back to the originating channel (e.g. Telegram)
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
                }).catch(() => { /* never fatal */ })

                res.json({ status: 'complete', reply: replyText, model: `${resolvedProvider}/${resolvedModel}` })
            } catch (err) {
                const classified = classifyAIError(err)
                logger.error({ err, workspaceId, errorType: classified.type }, 'Webchat conversational reply failed')
                try {
                    await recordConversation({ workspaceId, sessionId, source: conversationSource, message: trimmedMsg, errorMsg: classified.message, status: 'failed', intent })
                } catch (err) { logger.error({ err }, "Failed to record conversation") }
                res.json({ status: 'error', reply: classified.message, fixUrl: classified.fixUrl, fixLabel: classified.fixLabel, technicalDetail: classified.technical, model: `${resolvedProvider}/${resolvedModel}` })
            }
            return
        }


        // TASK: auto-queue immediately — no confirmation step. The user asked, we act.
        // PROJECT: still show one confirm because it spins up a full multi-step sprint.
        if (intent === 'TASK') {
            // Synthesize a clean task description from conversation context
            let cleanDescription = trimmedMsg
            try {
                const synth = await withFallback(aiSettings, 'summarization', async (model) =>
                    generateText({
                        model,
                        system: 'You are a task description synthesizer. Given a conversation, output a single clear, specific, third-person task description in one sentence (max 150 chars) that captures what the user wants the agent to accomplish. No preamble, no quotes, just the description.',
                        messages: [
                            ...textHistory,
                            { role: 'user' as const, content: trimmedMsg },
                        ],
                        abortSignal: AbortSignal.timeout(8_000),
                    }),
                    fallbackOpts(workspaceId),
                )
                if (synth.text?.trim()) cleanDescription = synth.text.trim().replace(/^"|"$/g, '')
            } catch { /* use raw message as fallback */ }

            // When recall found prior context, append it so the executor has it
            const taskDescription = recalledContext
                ? `${cleanDescription}\n\n${recalledContext}`
                : cleanDescription

            const taskId = await pushTask({
                workspaceId,
                type: 'automation',
                source: 'dashboard',
                context: {
                    description: taskDescription,
                    message: taskDescription,
                    sessionId: sid,
                    channel: 'webchat',
                },
                priority: 2,
            })
            logger.info({ workspaceId, taskId, description: cleanDescription }, 'Webchat task auto-queued (no confirm step)')
            emitToWorkspace(workspaceId, { type: 'task_queued', taskId, source: 'dashboard' })

            const confirmReply = `On it.${recommendedSwitch}`
            try {
                await recordConversation({ workspaceId, sessionId, source: 'dashboard', message: trimmedMsg, reply: confirmReply, status: 'complete', intent })
            } catch (err) { logger.error({ err }, "Failed to record conversation") }

            res.json({ status: 'task_queued', taskId, reply: confirmReply, model: `${resolvedProvider}/${resolvedModel}` })
            return
        }

        // PROJECT — one confirm because it creates a full multi-task sprint
        const confirmReply = `I'll set up a **${suggestedCategory}** project for this. Confirm to kick it off.${recommendedSwitch}`
        try {
            await recordConversation({ workspaceId, sessionId, source: 'dashboard', message: trimmedMsg, reply: confirmReply, status: 'complete', intent })
        } catch (err) {
            logger.error({ err, workspaceId }, 'Webchat: failed to record pre-confirmation conversation')
        }

        res.json({
            status: 'confirm_action',
            intent,
            description: recalledContext ? `${trimmedMsg}\n\n${recalledContext}` : trimmedMsg,
            suggestedCategory,
            model: `${resolvedProvider}/${resolvedModel}`,
        })
    } catch (err) {
        logger.error({ err }, 'POST /api/chat/message failed')
        captureLifecycleEvent('channel.error', 'error', { channel: 'webchat', error: 'message_handler_failed' })
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to queue message' } })
    }
})

// ── POST /api/chat/execute-action ──────────────────────────────────────────────

const VALID_CATEGORIES = new Set(['code', 'research', 'writing', 'ops', 'data', 'marketing', 'general'])

chatRouter.post('/execute-action', async (req, res) => {
    const { workspaceId, intent, description, sessionId, category, repo } = req.body as {
        workspaceId?: string
        intent?: 'TASK' | 'PROJECT'
        description?: string
        sessionId?: string
        category?: string
        repo?: string   // owner/repo — required only for code category
    }

    if (!workspaceId || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE', message: 'Valid workspaceId required' } })
        return
    }
    if (!intent || !description) {
        res.status(400).json({ error: { code: 'MISSING_FIELDS', message: 'intent and description required' } })
        return
    }

    // 'code' category requires a repo. If none supplied (chat flow), downgrade to 'general'
    // so the sprint doesn't fail immediately inside the async runner.
    const rawCategory = (category && VALID_CATEGORIES.has(category)) ? category : 'general'
    const resolvedCategory = rawCategory === 'code' && !repo ? 'general' : rawCategory

    try {
        if (intent === 'TASK') {
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
            logger.info({ workspaceId, taskId }, 'Webchat task explicitly confirmed and queued')
            emitToWorkspace(workspaceId, { type: 'task_queued', taskId, source: 'dashboard' })
            res.status(202).json({ taskId, status: 'queued' })
        } else if (intent === 'PROJECT') {
            // Pre-check: verify at least one AI provider is configured before creating the sprint row.
            // This avoids leaving a zombie sprint in 'planning' state when credentials are missing.
            let aiSettings: Awaited<ReturnType<typeof loadWorkspaceAISettings>>['aiSettings'] = null
            let hasCredential = false
            try {
                const loaded = await loadWorkspaceAISettings(workspaceId)
                hasCredential = !!loaded.credential
                if (loaded.aiSettings) aiSettings = loaded.aiSettings
            } catch (err) {
                logger.warn({ err, workspaceId }, 'Could not resolve AI settings for sprint planner — using env fallback')
            }

            if (!hasCredential) {
                res.status(402).json({
                    error: {
                        code: 'NO_AI_CREDENTIAL',
                        message: 'No AI provider is configured for this workspace. Go to Settings → AI Providers and add at least one API key before starting a project.',
                    },
                })
                return
            }

            const id = ulid()
            const [sprint] = await db.insert(sprints).values({
                id,
                workspaceId,
                request: description,
                category: resolvedCategory,
                repo: repo ?? null,
                status: 'planning',
                metadata: {},
            }).returning()
            if (!sprint) throw new Error('Sprint insert returned no rows')
            logger.info({ workspaceId, sprintId: sprint.id, category: resolvedCategory }, 'Webchat project explicitly confirmed and created')

            runSprint({
                sprintId: sprint.id,
                workspaceId,
                category: resolvedCategory,
                repo: repo ?? undefined,
                request: description,
                aiSettings,
            }).catch((err: unknown) => {
                logger.error({ err, sprintId: sprint.id }, 'Sprint run failed')
                captureLifecycleEvent('sprint.failed', 'error', { channel: 'webchat', sprintId: sprint.id, workspaceId })
                captureException(err, { sprintId: sprint.id, workspaceId, category: resolvedCategory })

                // Report the failure back to the originating conversation/session
                // so the user isn't left staring at a silent "Created" status.
                const errMsg = err instanceof Error ? err.message : String(err)
                const userFacingReply = `The project failed to start: ${errMsg}. Check Settings → AI Providers if a provider is not configured, or verify the repo field is set for code projects.`

                void recordConversation({
                    workspaceId,
                    sessionId: sessionId ?? null,
                    source: 'dashboard',
                    message: description,
                    reply: userFacingReply,
                    errorMsg: errMsg,
                    status: 'failed',
                    intent: 'PROJECT',
                }).catch((recErr: unknown) => logger.warn({ recErr }, 'Failed to record sprint error turn'))

                emitToWorkspace(workspaceId, {
                    type: 'chat_error',
                    sessionId: sessionId ?? null,
                    sprintId: sprint.id,
                    message: userFacingReply,
                })
            })

            res.status(201).json({ sprintId: sprint.id, status: 'created', category: resolvedCategory })
        } else {
            res.status(400).json({ error: { code: 'INVALID_INTENT', message: 'intent must be TASK or PROJECT' } })
        }
    } catch (err) {
        logger.error({ err }, 'POST /api/chat/execute-action failed')
        captureLifecycleEvent('channel.error', 'error', { channel: 'webchat', error: 'execute_action_failed' })
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to execute action' } })
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
            const [task] = await db.select({
                status: tasks.status,
                outcomeSummary: tasks.outcomeSummary,
            }).from(tasks).where(eq(tasks.id, taskId!)).limit(1)

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

            if (task.status === 'cancelled' || task.status === 'blocked') {
                const reason = task.outcomeSummary ?? ''
                const isNoCredential = !reason || reason.toLowerCase().includes('credential') || reason.toLowerCase().includes('no ai')
                res.json({
                    taskId,
                    status: task.status,
                    reply: task.status === 'blocked'
                        ? isNoCredential
                            ? 'No AI provider configured. Go to Settings → AI Providers and test your connection.'
                            : `Agent error: ${reason}`
                        : 'Task cancelled.',
                })
                return
            }

            if (Date.now() >= deadline) {
                res.json({ taskId, status: 'pending', reply: "I'm still working on it — check back shortly." })
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

            const [task] = await db.select({
                status: tasks.status,
                outcomeSummary: tasks.outcomeSummary,
            }).from(tasks).where(eq(tasks.id, taskId!)).limit(1)

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

            if (task.status === 'blocked' || task.status === 'cancelled') {
                const reason = task.outcomeSummary ?? ''
                const isNoCredential = !reason || /credential|no ai/i.test(reason)
                finish(task.status, {
                    taskId,
                    reply: task.status === 'blocked'
                        ? isNoCredential
                            ? 'No AI provider configured. Go to Settings → AI Providers.'
                            : `Agent error: ${reason}`
                        : 'Task cancelled.',
                })
                return
            }

            if (elapsed * 1000 >= MAX_MS) {
                finish('timeout', { taskId, reply: 'Task is taking unusually long — check the Tasks page for status.' })
                return
            }

            // Still running — fetch latest step for progress detail
            const [latestStep] = await db.select({
                stepNumber: taskSteps.stepNumber,
                outcome: taskSteps.outcome,
            }).from(taskSteps)
                .where(eq(taskSteps.taskId, taskId!))
                .orderBy(desc(taskSteps.stepNumber))
                .limit(1)

            const stepCount = latestStep?.stepNumber ?? 0
            const lastAction = latestStep?.outcome?.slice(0, 120) ?? null

            send('tick', {
                taskId,
                status: task.status,
                elapsed,
                stepCount,
                lastAction,
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
    panel.innerHTML = '<div id="plexo-widget-header"><div id="plexo-widget-avatar">\ud83e\udd16</div><span>' + siteName + '</span></div><div id="plexo-widget-msgs"></div><div id="plexo-widget-input-row"><input id="plexo-widget-input" placeholder="Ask anything\u2026" /><button id="plexo-widget-send">Send</button></div>';

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
