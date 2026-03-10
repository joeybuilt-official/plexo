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
import { withFallback, resolveModel } from '@plexo/agent/providers/registry'
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
import { getTelegramToken } from './telegram.js'
import { captureException } from '../sentry.js'

export const chatRouter: RouterType = Router()

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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

const CLASSIFY_SYSTEM = `You are an intent classifier for an AI agent called Plexo.
Decide if the user's message is a TASK, PROJECT, MEMORY, or CONVERSATION.

CONVERSATION: Use this as the default. Questions, queries, troubleshooting help, greetings, status checks, information requests ("what is X", "show me", "list", "how do I"), small talk, vague or ambiguous messages, or any message where the user is asking FOR information rather than asking the agent TO DO something. Also use this when the user is rejecting or dismissing a prior proposal.

TASK: The user is EXPLICITLY and unambiguously asking the agent to perform a specific, distinct, actionable operation — e.g. "create X", "fix Y", "deploy Z", "send an email to", "run the migration". There must be a clear deliverable or outcome. Pure questions, lookups, and summaries are NOT tasks — those are CONVERSATION. Also use TASK when the user is confirming ("yes", "go ahead", "do it") a previous explicit task proposal.

PROJECT: The user is explicitly asking to start a large, multi-step goal requiring coordinated planning across multiple files/systems — e.g. "build a new feature", "refactor the entire auth system", "launch a new product". Also use PROJECT when the user confirms a prior project proposal. Single-step actions are TASK not PROJECT.

MEMORY: The user wants the agent to remember something or follow a behavioral rule going forward. Examples: "remember to always use TypeScript", "don't use semicolons", "always respond in bullet points", "prefer tabs over spaces", "never deploy on Fridays".

Also determine the complexity: SIMPLE or COMPLEX.
COMPLEX means the task requires reasoning, complex coding, architecture, or multi-step logic.
SIMPLE means it's a routine task, summary, reading, file editing, or basic query.

For PROJECT intent, also determine the best category from: code, research, writing, ops, data, marketing, general.
- code: software development, coding, building apps, APIs, refactoring
- research: investigation, analysis, competitive research, synthesis
- writing: content creation, blog posts, documentation, copywriting
- ops: infrastructure, deployment, DevOps, system operations
- data: data analysis, queries, transformations, datasets
- marketing: campaigns, social copy, launch plans, go-to-market
- general: anything else

For TASK or CONVERSATION: Reply with EXACTLY two words separated by a space:
[INTENT] [COMPLEXITY]
Example: TASK COMPLEX
Example: CONVERSATION SIMPLE

For MEMORY: Reply with EXACTLY two words:
MEMORY SIMPLE

For PROJECT: Reply with EXACTLY three words separated by spaces:
PROJECT [COMPLEXITY] [CATEGORY]
Example: PROJECT COMPLEX marketing
Example: PROJECT SIMPLE general

When in doubt, use CONVERSATION. Only classify as TASK or PROJECT when the user's intent to have the agent perform work is unmistakable.`

// Per-session conversation history now fetched dynamically per request from DB
// to ensure persistence and full context even if the agent server restarts.
// ── POST /api/chat/message ────────────────────────────────────────────────────

chatRouter.post('/message', async (req, res) => {
    const { workspaceId, message, sessionId, forceConversation, images, files } = req.body as {
        workspaceId?: string
        message?: string
        sessionId?: string
        forceConversation?: boolean
        images?: Array<{ data: string; mimeType: string; name: string }>
        /** PDF files as base64 data URLs */
        files?: Array<{ data: string; mimeType: string; name: string }>
    }

    if (!workspaceId || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE', message: 'Valid workspaceId required' } })
        return
    }

    // Validate images (raster only — SVG is handled client-side as text)
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

    // Validate files (PDF)
    const ALLOWED_FILE_MIME = new Set(['application/pdf'])
    const validFiles: Array<{ data: string; mimeType: string; name: string }> = []
    if (Array.isArray(files)) {
        if (files.length > 3) {
            res.status(400).json({ error: { code: 'TOO_MANY_FILES', message: 'Maximum 3 files per message' } })
            return
        }
        for (const f of files) {
            if (typeof f.data !== 'string' || !f.data.startsWith('data:')) {
                res.status(400).json({ error: { code: 'INVALID_FILE', message: 'Files must be base64 data URLs' } })
                return
            }
            if (!ALLOWED_FILE_MIME.has(f.mimeType)) {
                res.status(400).json({ error: { code: 'UNSUPPORTED_FILE_TYPE', message: `Unsupported file type: ${f.mimeType}. Supported: PDF` } })
                return
            }
            validFiles.push(f)
        }
    }

    const hasImages = validImages.length > 0
    const hasFiles = validFiles.length > 0
    const textMessage = (message ?? '').trim()

    if (!hasImages && !hasFiles && textMessage.length === 0) {
        res.status(400).json({ error: { code: 'MISSING_MESSAGE', message: 'message or images required' } })
        return
    }
    if (textMessage.length > 4000) {
        res.status(400).json({ error: { code: 'MESSAGE_TOO_LONG', message: 'Max 4000 characters' } })
        return
    }

    try {
        // Verify workspace exists
        const [ws] = await db.select({ id: workspaces.id }).from(workspaces)
            .where(eq(workspaces.id, workspaceId)).limit(1)
        if (!ws) {
            res.status(404).json({ error: { code: 'WORKSPACE_NOT_FOUND', message: 'Workspace not found' } })
            return
        }

        // Load AI settings
        const { credential, aiSettings } = await loadWorkspaceAISettings(workspaceId)
        if (!credential || !aiSettings) {
            res.status(503).json({ error: { code: 'NO_AI_PROVIDER', message: 'No AI provider configured. Go to Settings → AI Providers.' } })
            return
        }

        // Build model lazily — withFallback will walk the chain if primary fails
        const providerKey = aiSettings.primaryProvider
        const config = aiSettings.providers[providerKey]
        if (!config) {
            res.status(503).json({ error: { code: 'NO_AI_PROVIDER', message: `No config for provider ${providerKey}` } })
            return
        }


        // Load workspace persona + identity for system prompt
        let agentName = 'Plexo'
        let agentPersona = ''
        let agentTagline = ''
        try {
            const [wsRow] = await db
                .select({ name: workspaces.name, settings: workspaces.settings })
                .from(workspaces)
                .where(eq(workspaces.id, workspaceId))
                .limit(1)
            if (wsRow) {
                const s = (wsRow.settings ?? {}) as Record<string, unknown>
                if (typeof s.agentName === 'string' && s.agentName) agentName = s.agentName
                if (typeof s.agentPersona === 'string' && s.agentPersona) agentPersona = s.agentPersona
                if (typeof s.agentTagline === 'string' && s.agentTagline) agentTagline = s.agentTagline
            }
        } catch { /* non-fatal */ }

        // Resolve the actual active model ID for identity injection
        const resolvedModel = config.model ?? 'your configured model'
        const resolvedProvider = String(providerKey)
        const identityLine = `Your identity: you are running on provider "${resolvedProvider}", model "${resolvedModel}". If asked what model or system you are, answer truthfully with this information — do not guess or claim to be a different model.`
        const personaPrefix = agentPersona ? agentPersona + '\n\n' : ''
        const taglineHint = agentTagline ? ` (${agentTagline})` : ''

        // Classify intent — skip if caller forced CONVERSATION (e.g. "Just answer" button)
        // Default to CONVERSATION — tasks only get proposed when classifier explicitly says so.
        let intent: 'TASK' | 'PROJECT' | 'MEMORY' | 'CONVERSATION' = 'CONVERSATION'
        const sid = sessionId ?? 'default'
        
        // Fetch full chat history reliably from the database instead of in-memory caching
        const dbTurns = await getSessionTurns(workspaceId, sid, 50)
        // Reconstruct messages array from the log
        const history: Array<{ role: 'user' | 'assistant'; content: string }> = []
        for (const t of dbTurns) {
            if (t.message) history.push({ role: 'user', content: t.message })
            if (t.reply) history.push({ role: 'assistant', content: t.reply })
        }

        const trimmedMsg = textMessage || (hasImages ? `[Image${validImages.length > 1 ? 's' : ''} attached]` : hasFiles ? `[File${validFiles.length > 1 ? 's' : ''} attached]` : '')

        // Build multimodal user content for AI SDK v6
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        type ContentPart =
            | { type: 'text'; text: string }
            | { type: 'image'; image: string; mimeType: string }
            | { type: 'file'; data: string; mediaType: string }
        const userContent: ContentPart[] = hasImages || hasFiles
            ? [
                { type: 'text', text: trimmedMsg },
                ...validImages.map((img) => ({
                    type: 'image' as const,
                    // strip the data URL prefix — AI SDK expects raw base64
                    image: img.data.replace(/^data:image\/[^;]+;base64,/, ''),
                    mimeType: img.mimeType,
                })),
                ...validFiles.map((f) => ({
                    type: 'file' as const,
                    // strip the data URL prefix — AI SDK expects raw base64
                    data: f.data.replace(/^data:[^;]+;base64,/, ''),
                    mediaType: f.mimeType,
                })),
              ]
            : [{ type: 'text', text: trimmedMsg }]

        let isComplex = false
        let suggestedCategory = 'general'

        if (!forceConversation) {
            try {
                // For classification we always use text-only (images don't affect intent)
                const classifyMessages = [
                    ...history.map(m => ({ role: m.role, content: m.content })),
                    { role: 'user' as const, content: trimmedMsg }
                ]

                const classifyResult = await withFallback(aiSettings, 'classification', async (model) =>
                    generateText({
                        model,
                        system: CLASSIFY_SYSTEM,
                        messages: classifyMessages,
                        abortSignal: AbortSignal.timeout(10_000),
                    })
                )
                const text = classifyResult.text?.trim() ?? ''
                const upperText = text.toUpperCase()
                const parts = text.split(/\s+/)
                if (upperText.startsWith('TASK')) intent = 'TASK'
                else if (upperText.startsWith('PROJECT')) intent = 'PROJECT'
                else if (upperText.startsWith('MEMORY')) intent = 'MEMORY'
                else intent = 'CONVERSATION'

                if (parts[1]?.toUpperCase().startsWith('COMPLEX')) isComplex = true

                // Extract suggested category for PROJECT (3rd word, lowercase)
                if (intent === 'PROJECT' && parts[2]) {
                    const cat = parts[2].toLowerCase()
                    const validCats = ['code', 'research', 'writing', 'ops', 'data', 'marketing', 'general']
                    if (validCats.includes(cat)) suggestedCategory = cat
                }
            } catch {
                // On classification failure, default to CONVERSATION
                intent = 'CONVERSATION'
            }
        }


        // Consultative routing: Check for recommended model
        let recommendedSwitch = ''
        if (isComplex && (intent === 'TASK' || intent === 'PROJECT')) {
            const currentModelId = config.model ?? 'default'

            // Check if current is reasoning capable using knowledge base
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
                    .where(sql`${modelsKnowledge.strengths} ? 'reasoning'`)
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
                // Store as a high-confidence pattern in memory_entries
                await rememberInstruction({ workspaceId, instruction: trimmedMsg, source: 'chat' })

                // Also write to workspace_preferences under a unique key per instruction
                // so multiple "remember X" instructions accumulate rather than overwrite
                const sanitized = trimmedMsg.replace(/^(remember|always|never|don't|dont|please|make sure)\s+/i, '').trim()
                const instrKey = `user_instruction:${Date.now()}`
                await setPreference({ workspaceId, key: instrKey, value: sanitized, source: 'chat' })

                const reply = `Got it — I'll remember that and apply it going forward.`

                try {
                    await recordConversation({ workspaceId, sessionId, source: 'dashboard', message: trimmedMsg, reply, status: 'complete', intent })
                } catch { /* non-fatal */ }

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

            try {
                logger.info({ workspaceId, providerKey, modelId: config.model }, 'Webchat: generating conversational reply')
                const result = await withFallback(aiSettings, 'summarization', async (model) =>
                    generateText({
                        model,
                        system: `${personaPrefix}You are ${agentName}${taglineHint}, an AI agent. ${identityLine}

Keep replies concise and friendly. If the user proposes a single distinct action, tell them you can execute it as a task and ask for confirmation. If the user proposes a large conceptual goal, tell them you can create a Project for it and ask for confirmation. If they ask for troubleshooting, help, or advice, ask clarifying questions first and do not rush to create tasks. Only agree to start a task or project when the scope is clear.`,
                        messages: [
                            ...history.map((m) => ({ role: m.role, content: m.content })),
                            // Last message may include images as multimodal content
                            { role: 'user' as const, content: userContent },
                        ],
                        abortSignal: AbortSignal.timeout(30_000),
                    })
                )
                const replyText = result.text
                if (!replyText) {
                    logger.warn({ workspaceId, providerKey }, 'Webchat: empty response from model')
                    const classified = classifyAIError(new Error('Empty response from model — the model returned no text.'))
                    try {
                        await recordConversation({ workspaceId, sessionId, source: conversationSource, message: trimmedMsg, errorMsg: classified.message, status: 'failed', intent })
                    } catch { /* non-fatal */ }
                    res.json({ status: 'error', reply: classified.message, fixUrl: classified.fixUrl, fixLabel: classified.fixLabel, technicalDetail: classified.technical })
                    return
                }

                // Record the conversation turn
                try {
                    await recordConversation({ workspaceId, sessionId, source: conversationSource, message: trimmedMsg, reply: replyText, status: 'complete', intent })
                } catch { /* non-fatal */ }

                // Relay reply back to the originating channel (e.g. Telegram)
                if (externalChannelRef) {
                    const token = externalChannelRef.channel === 'telegram'
                        ? getTelegramToken(externalChannelRef.channelId)
                        : null
                    replyToChannel(externalChannelRef, replyText, token ?? undefined).catch(
                        (err: Error) => logger.warn({ err, channelRef: externalChannelRef }, 'Failed to relay web reply to source channel')
                    )
                }

                // Write to semantic memory so this chat exchange is retrievable
                storeMemory({
                    workspaceId,
                    type: 'session',
                    content: `User: ${trimmedMsg}\nAssistant: ${replyText}`,
                    metadata: { source: 'chat', sessionId: sessionId ?? null, intent },
                }).catch(() => { /* never fatal */ })

                res.json({ status: 'complete', reply: replyText })
            } catch (err) {
                const classified = classifyAIError(err)
                logger.error({ err, workspaceId, errorType: classified.type }, 'Webchat conversational reply failed')
                try {
                    await recordConversation({ workspaceId, sessionId, source: conversationSource, message: trimmedMsg, errorMsg: classified.message, status: 'failed', intent })
                } catch { /* non-fatal */ }
                res.json({ status: 'error', reply: classified.message, fixUrl: classified.fixUrl, fixLabel: classified.fixLabel, technicalDetail: classified.technical })
            }
            return
        }


        // TASK or PROJECT — Record the conversation exchange, no task yet (user must confirm)
        const confirmReply = intent === 'TASK'
            ? 'I can execute this as an automated task. Ready to start?' + recommendedSwitch
            : `I can set up a **${suggestedCategory}** project to coordinate this work. Want me to create it?` + recommendedSwitch
        try {
            await recordConversation({ workspaceId, sessionId, source: 'dashboard', message: trimmedMsg, reply: confirmReply, status: 'complete', intent })
        } catch (err) {
            logger.error({ err, workspaceId }, 'Webchat: failed to record pre-confirmation conversation')
        }

        res.json({
            status: 'confirm_action',
            intent,
            description: trimmedMsg,
            suggestedCategory: intent === 'PROJECT' ? suggestedCategory : undefined,
        })
    } catch (err) {
        logger.error({ err }, 'POST /api/chat/message failed')
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
            let aiSettings: any
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
                captureException(err, { sprintId: sprint.id, workspaceId, category: resolvedCategory })

                // Report the failure back to the originating conversation/session
                // so the user isn't left staring at a silent "Created" status.
                const errMsg = err instanceof Error ? err.message : String(err)
                const userFacingReply = `The project failed to start: ${errMsg}. Check Settings → AI Providers if a provider is not configured, or verify the repo field is set for code projects.`

                recordConversation({
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
