// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Inference shim — exposes Plexo's per-workspace LLM provider router as an
 * OpenAI-compatible HTTP endpoint so the Graphiti Python sidecar (ADR 0011)
 * can use it as its `base_url` without ever holding workspace LLM credentials.
 *
 * Phase 3a: /v1/embeddings.
 * Phase 3b: /v1/chat/completions w/ response_format=json_schema translated
 *   through callModel({schema}). Tools + streaming → 501.
 * Phase 3c: URL-routed `/ws/:workspaceId/v1/...` variants. Why: Graphiti's
 *   `OpenAIEmbedderConfig` and `LLMConfig` only forward `api_key` + `base_url`
 *   to AsyncOpenAI as of graphiti-core 0.29 — `default_headers` is not plumbed
 *   through their public surface, so per-request `X-Plexo-Workspace-Id` /
 *   `X-App-Id` headers can't ride on Graphiti calls. Each per-workspace
 *   Graphiti instance therefore points its base_url at `/api/inference/ws/:ws/v1`
 *   and the workspace ID rides in the URL.
 *
 * Auth: `requireServiceKey` (Bearer PLEXO_SERVICE_KEY + X-App-Id) on both
 * routing styles. URL-routed requests synthesize `X-App-Id: graphiti-sidecar`
 * if absent, so Graphiti's locked client surface satisfies auth.
 */

import { Router, type Request, type Response } from 'express'
import pino from 'pino'
import { ulid } from 'ulid'
import { jsonSchemaToZod, type JSONSchema } from './json-schema-to-zod.js'
import { requireServiceKey } from '../middleware/service-key-auth.js'
import { embed } from '@plexo/agent/memory/store'
import { callModel, CallModelError } from '@plexo/agent/providers/call-model'
import { resolveModelFromEnv, type FallbackOptions } from '@plexo/agent/providers/registry'
import { routeAndCall, RouterV2NoCandidateError } from '@plexo/agent/providers/router-v2'
import { loadSettingsFromInstances } from '@plexo/agent/providers/settings-from-instances'
import { maybeShadowExtraction } from './shadow-extraction.js'
import * as inferenceRepo from '../repositories/inference.repository.js'

const logger = pino({ name: 'inference-routes' })

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function resolveWorkspaceId(req: Request): string | null {
    const fromParams = (req.params as { workspaceId?: string }).workspaceId
    if (typeof fromParams === 'string' && UUID_RE.test(fromParams)) return fromParams
    const fromHeader = req.headers['x-plexo-workspace-id']
    if (typeof fromHeader === 'string' && UUID_RE.test(fromHeader)) return fromHeader
    return null
}

interface OpenAIEmbeddingsRequest {
    input: string | string[]
    model?: string
    encoding_format?: 'float' | 'base64'
    dimensions?: number
    user?: string
}

interface OpenAIEmbeddingsResponse {
    object: 'list'
    data: Array<{ object: 'embedding'; index: number; embedding: number[] }>
    model: string
    usage: { prompt_tokens: number; total_tokens: number }
}

interface OAIMessage {
    role: 'system' | 'user' | 'assistant' | 'tool'
    content: string | Array<{ type: string; text?: string }>
    name?: string
}

interface OAIJsonSchemaFormat {
    type: 'json_schema'
    json_schema: {
        name: string
        description?: string
        schema: Record<string, unknown>
        strict?: boolean
    }
}

interface OAIChatCompletionsRequest {
    model?: string
    messages: OAIMessage[]
    response_format?: OAIJsonSchemaFormat | { type: 'text' } | { type: 'json_object' }
    tools?: unknown[]
    tool_choice?: unknown
    max_tokens?: number
    max_completion_tokens?: number
    temperature?: number
    stream?: boolean
}

function flattenContent(content: OAIMessage['content']): string {
    if (typeof content === 'string') return content
    return content
        .filter((p) => p.type === 'text' && typeof p.text === 'string')
        .map((p) => p.text!)
        .join('\n')
}

function mapCallModelErrorStatus(code: CallModelError['code']): number {
    switch (code) {
        case 'CALL_MODEL_RATE_LIMIT': return 429
        case 'CALL_MODEL_PARSE': return 502
        case 'CALL_MODEL_4XX': return 502
        case 'CALL_MODEL_5XX': return 502
        case 'CALL_MODEL_TIMEOUT': return 504
        case 'CALL_MODEL_ABORTED': return 499
        case 'CALL_MODEL_UNKNOWN': return 500
    }
}

/**
 * Round-4: background-app lane override. The inference proxy serves trusted
 * internal callers (notably the graphiti sidecar, whose episode extraction is
 * fire-and-forget background work). Their schema-mode calls classify as
 * `extraction` = interactive lane, so they ride uncapped and compete with
 * interactive planning. When the caller's `X-App-Id` is in the background
 * allowlist (`PLEXO_INFERENCE_BG_APPS`, default `graphiti-sidecar`), force the
 * background lane — caps them via PLEXO_BG_AI_MAX_CONCURRENT without globally
 * reclassifying `extraction` (preserves the Phase L taskType-only decision).
 * Lane gating only; manifest scoring still uses the real taskType.
 */
export function backgroundLaneOverrideForAppId(appId: string | undefined): 'background' | undefined {
    if (typeof appId !== 'string' || !appId) return undefined
    const raw = process.env.PLEXO_INFERENCE_BG_APPS ?? 'graphiti-sidecar'
    const allow = new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))
    return allow.has(appId) ? 'background' : undefined
}

function backgroundLaneOverride(req: Request): 'background' | undefined {
    const appId = req.headers['x-app-id']
    return backgroundLaneOverrideForAppId(typeof appId === 'string' ? appId : undefined)
}

/**
 * Round-4 D2 (operator opt-in, default OFF): when the caller is a background
 * app AND `PLEXO_INFERENCE_BG_MODEL` is set, force that model (`provider/model`
 * or bare `model`) for the call so background graphiti extraction can run on a
 * fast provider instead of the workspace's deepseek cascade. Unset/empty = no
 * override (today's behaviour). The router cascades to normal selection if the
 * forced model's provider is absent or the call fails.
 */
export function backgroundModelForAppId(appId: string | undefined): string | undefined {
    if (backgroundLaneOverrideForAppId(appId) !== 'background') return undefined
    const m = process.env.PLEXO_INFERENCE_BG_MODEL
    return typeof m === 'string' && m.trim() !== '' ? m.trim() : undefined
}

function backgroundModelOverride(req: Request): string | undefined {
    const appId = req.headers['x-app-id']
    return backgroundModelForAppId(typeof appId === 'string' ? appId : undefined)
}

/**
 * Round-5 Phase 6: fire-and-forget per-app inference_logs write. The proxy
 * (graphiti/Fonto/...) previously logged nothing, so app spend was invisible.
 * Tagged with app_id; the cost-enforcement gate (getWorkspaceSpend) skips
 * app_id IS NOT NULL rows, so this is attribution-only and can't trip the
 * ceiling. Never blocks or fails the response.
 */
function logAppInference(args: {
    workspaceId: string
    appId: string
    model: string
    provider: string
    inputTokens: number
    outputTokens: number
    latencyMs: number
    taskType: string
    success: boolean
}): void {
    void (async () => {
        try {
            await inferenceRepo.insertAppInferenceLog(args)
        } catch (err) {
            logger.warn({ err, workspaceId: args.workspaceId, appId: args.appId }, 'inference.chat: app inference_logs write failed (non-fatal)')
        }
    })()
}

async function embeddingsHandler(req: Request, res: Response): Promise<void> {
    const workspaceId = resolveWorkspaceId(req)
    if (!workspaceId) {
        res.status(400).json({
            error: { code: 'MISSING_WORKSPACE_ID', message: 'workspace ID must be supplied via /ws/:workspaceId/ path or X-Plexo-Workspace-Id header (UUID)' },
        })
        return
    }

    const body = req.body as OpenAIEmbeddingsRequest | undefined
    if (!body || body.input === undefined) {
        res.status(400).json({ error: { code: 'MISSING_INPUT', message: 'request body must include `input`' } })
        return
    }

    const inputs = typeof body.input === 'string' ? [body.input] : body.input
    if (!Array.isArray(inputs) || inputs.length === 0) {
        res.status(400).json({ error: { code: 'EMPTY_INPUT', message: '`input` must be a string or non-empty array' } })
        return
    }
    // Round-5 Phase 2: cap batch size. embed() fans out via Promise.all below,
    // so an unbounded input[] = unbounded concurrent provider calls → OOM.
    // PLEXO_EMBEDDINGS_MAX_BATCH (default 256, 0 = unbounded).
    const maxBatch = Number(process.env.PLEXO_EMBEDDINGS_MAX_BATCH ?? 256)
    if (maxBatch > 0 && inputs.length > maxBatch) {
        res.status(413).json({ error: { code: 'BATCH_TOO_LARGE', message: `input batch of ${inputs.length} exceeds max ${maxBatch}` } })
        return
    }

    try {
        const vectors = await Promise.all(inputs.map((text) => embed(text, workspaceId)))
        const failedIdx = vectors.findIndex((v) => v === null)
        if (failedIdx !== -1) {
            logger.warn({ workspaceId, failedIdx, totalInputs: inputs.length }, 'inference.embeddings: provider returned null')
            res.status(502).json({ error: { code: 'EMBEDDING_PROVIDER_ERROR', message: `embedding adapter unavailable for input #${failedIdx}` } })
            return
        }

        const dims = vectors[0]!.length
        const totalTokens = inputs.reduce((sum, t) => sum + Math.ceil(t.length / 4), 0)
        const response: OpenAIEmbeddingsResponse = {
            object: 'list',
            data: vectors.map((vec, idx) => ({ object: 'embedding', index: idx, embedding: vec! })),
            model: body.model ?? `plexo-embeddings/${dims}`,
            usage: { prompt_tokens: totalTokens, total_tokens: totalTokens },
        }
        res.json(response)
    } catch (err) {
        logger.error({ err, workspaceId, inputCount: inputs.length }, 'inference.embeddings: unexpected error')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'embeddings call failed' } })
    }
}

async function chatCompletionsHandler(req: Request, res: Response): Promise<void> {
    const workspaceId = resolveWorkspaceId(req)
    if (!workspaceId) {
        res.status(400).json({
            error: { code: 'MISSING_WORKSPACE_ID', message: 'workspace ID must be supplied via /ws/:workspaceId/ path or X-Plexo-Workspace-Id header (UUID)' },
        })
        return
    }

    const body = req.body as OAIChatCompletionsRequest | undefined
    if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
        res.status(400).json({ error: { code: 'MISSING_MESSAGES', message: 'request body must include a non-empty `messages` array' } })
        return
    }

    if (body.stream) {
        res.status(501).json({ error: { code: 'STREAMING_NOT_SUPPORTED', message: 'streaming is not implemented; set stream=false' } })
        return
    }

    if (Array.isArray(body.tools) && body.tools.length > 0) {
        res.status(501).json({ error: { code: 'TOOLS_NOT_SUPPORTED', message: 'tool-calling is not implemented in Phase 3b; use response_format=json_schema for structured output' } })
        return
    }

    const useSchema = body.response_format?.type === 'json_schema'

    let zodSchema: unknown = undefined
    let schemaName: string | undefined
    let schemaDescription: string | undefined
    if (useSchema) {
        const fmt = body.response_format as OAIJsonSchemaFormat
        if (!fmt.json_schema?.schema || typeof fmt.json_schema.name !== 'string') {
            res.status(400).json({ error: { code: 'INVALID_RESPONSE_FORMAT', message: 'response_format.json_schema must include `name` and `schema`' } })
            return
        }
        try {
            zodSchema = jsonSchemaToZod(fmt.json_schema.schema as JSONSchema)
        } catch (err) {
            logger.warn({ err, workspaceId, schemaName: fmt.json_schema.name }, 'inference.chat: json-schema-to-zod failed')
            res.status(400).json({ error: { code: 'SCHEMA_TRANSLATION_FAILED', message: 'response_format.json_schema.schema could not be converted to Zod' } })
            return
        }
        schemaName = fmt.json_schema.name
        schemaDescription = fmt.json_schema.description
    }

    const systemParts: string[] = []
    const conversational: Array<{ role: 'user' | 'assistant'; content: string }> = []
    for (const m of body.messages) {
        if (m.role === 'system') {
            systemParts.push(flattenContent(m.content))
        } else if (m.role === 'user' || m.role === 'assistant') {
            conversational.push({ role: m.role, content: flattenContent(m.content) })
        } else {
            res.status(400).json({ error: { code: 'UNSUPPORTED_ROLE', message: `message role '${m.role}' is not supported in Phase 3b` } })
            return
        }
    }
    if (conversational.length === 0) {
        res.status(400).json({ error: { code: 'MISSING_USER_MESSAGE', message: '`messages` must include at least one user/assistant turn' } })
        return
    }
    const baseSystem = systemParts.length > 0 ? systemParts.join('\n\n') : undefined
    let system = baseSystem
    if (useSchema) {
        const schemaJson = JSON.stringify((body.response_format as OAIJsonSchemaFormat).json_schema.schema, null, 2)
        const directive =
            'CRITICAL OUTPUT REQUIREMENT: You MUST respond with ONLY valid JSON matching this exact schema. ' +
            'No prose, no markdown fences, no commentary. Your response must start with { and end with }. ' +
            'Use the EXACT property names shown in the schema (e.g. if the schema has "extracted_entities", do NOT use "entities" or "items"). ' +
            'Even if the natural answer is a single value, you MUST wrap it in the schema\'s object structure.\n\n' +
            'JSON Schema:\n' + schemaJson
        system = baseSystem ? `${baseSystem}\n\n${directive}` : directive
    }

    const aiSettings = await loadSettingsFromInstances(workspaceId).catch((err) => {
        logger.warn({ err, workspaceId }, 'inference.chat: loadSettings failed; will try env fallback')
        return null
    })

    const maxTokens = body.max_completion_tokens ?? body.max_tokens
    // Use a TaskType that exists in the routing table. The inference shim
    // serves both schema-mode (extraction) and free-text (summarization)
    // shapes; pick the one matching the request.
    const taskType = useSchema ? 'extraction' as const : 'summarization' as const

    const doCall = async (model: import('ai').LanguageModel, provider: string) => {
        return useSchema
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- runtime Zod schema produced by jsonSchemaToZod
            ? callModel<any>({
                model,
                provider,
                workspaceId,
                taskType: 'inference.chat.completions',
                system,
                messages: conversational,
                maxTokens,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                schema: zodSchema as any,
                schemaName,
                schemaDescription,
            })
            : callModel({
                model,
                provider,
                workspaceId,
                taskType: 'inference.chat.completions',
                system,
                messages: conversational,
                maxTokens,
            })
    }

    const reqStartMs = Date.now()
    let servedProvider = 'unknown'
    try {
        let result: Awaited<ReturnType<typeof doCall>>
        if (aiSettings) {
            // Walk the workspace's full provider chain via router-v2's
            // task-routed selector. Billing/quota/auth/rate-limit failures
            // advance to the next provider automatically.
            const dispatch = async (model: import('ai').LanguageModel): Promise<Awaited<ReturnType<typeof doCall>>> => {
                const provider = (model as { provider?: string }).provider ?? 'unknown'
                servedProvider = provider
                return doCall(model, provider)
            }
            const fallbackOpts: FallbackOptions = {
                workspaceId,
                onFallbackEngaged: (info) => {
                    logger.warn({ event: 'inference.chat.fallback', ...info }, 'inference.chat: primary provider failed; served by fallback')
                },
            }
            result = await routeAndCall({
                workspaceId,
                taskType,
                settings: aiSettings,
                doCall: dispatch,
                opts: fallbackOpts,
                laneOverride: backgroundLaneOverride(req),
                modelIdOverride: backgroundModelOverride(req),
            })
        } else {
            // No workspace settings — env-var fallback path (dev / self-host)
            try {
                const envModel = resolveModelFromEnv()
                servedProvider = 'env-fallback'
                result = await doCall(envModel, 'env-fallback')
            } catch (envErr) {
                // CallModelError surfaces parse/timeout/etc — let the outer
                // handler map it to the appropriate HTTP status (502/504/...).
                // Only "no provider configured" failures (ProviderResolutionError
                // and friends) should return 503 NO_PROVIDER_AVAILABLE here.
                if (envErr instanceof CallModelError) throw envErr
                const message = envErr instanceof Error ? envErr.message : String(envErr)
                logger.warn({ workspaceId, message }, 'inference.chat: no provider available — refusing call')
                res.status(503).json({
                    error: {
                        code: 'NO_PROVIDER_AVAILABLE',
                        message: `Workspace ${workspaceId} has no LLM provider configured. Add a provider in workspace settings or set a system-wide provider env var (OPENAI_API_KEY/GEMINI/OPENROUTER/GROQ).`,
                    },
                })
                return
            }
        }

        const content = 'object' in result ? JSON.stringify(result.object) : result.text

        res.json({
            id: `chatcmpl-${ulid().toLowerCase()}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: result.model || body.model || 'plexo-router',
            choices: [
                {
                    index: 0,
                    message: { role: 'assistant', content },
                    finish_reason: 'stop',
                },
            ],
            usage: {
                prompt_tokens: result.inputTokens,
                completion_tokens: result.outputTokens,
                total_tokens: result.inputTokens + result.outputTokens,
            },
        })

        // Round-5 Phase 6 (WS E): per-app cost attribution. Log the proxy call
        // tagged with X-App-Id so app spend (graphiti/Fonto/...) is attributable.
        // Attribution-only — excluded from the enforcement gate. Fire-and-forget.
        {
            const appIdHdr = req.headers['x-app-id']
            const appId = typeof appIdHdr === 'string' && appIdHdr ? appIdHdr : undefined
            if (appId) {
                logAppInference({
                    workspaceId,
                    appId,
                    model: result.model || 'unknown',
                    provider: servedProvider,
                    inputTokens: result.inputTokens,
                    outputTokens: result.outputTokens,
                    latencyMs: Date.now() - reqStartMs,
                    taskType,
                    success: true,
                })
            }
        }

        // Round-5 Phase 3 (ADR 0001): graphiti shadow re-extraction. After the
        // response is sent, sampled background-app extraction calls re-run the
        // same episode on the D2 candidate model to measure quality drift.
        // Default OFF (PLEXO_SHADOW_EXTRACTION_RATE=0); fire-and-forget.
        if (aiSettings && useSchema && 'object' in result && backgroundLaneOverride(req) === 'background') {
            const appIdHdr = req.headers['x-app-id']
            maybeShadowExtraction({
                appId: typeof appIdHdr === 'string' ? appIdHdr : undefined,
                workspaceId,
                aiSettings,
                system,
                conversational,
                zodSchema,
                schemaName,
                schemaDescription,
                maxTokens,
                primaryModel: result.model,
                primaryObject: result.object,
            })
        }
    } catch (err) {
        if (err instanceof CallModelError) {
            const status = mapCallModelErrorStatus(err.code)
            logger.warn({ err, workspaceId, code: err.code }, 'inference.chat: callModel error')
            res.status(status).json({ error: { code: err.code, message: err.message } })
            return
        }
        if (err instanceof RouterV2NoCandidateError) {
            // Expected, operator-actionable condition: the workspace has no
            // provider meeting the quality bar for this task. Not an internal
            // error — return a clear 422 and log at warn so it doesn't
            // masquerade as a code bug (this path was spamming level-50 logs).
            logger.warn(
                { err, workspaceId, taskType, code: 'ROUTER_V2_NO_CANDIDATE' },
                'inference.chat: no qualifying provider for task — operator action required',
            )
            res.status(422).json({ error: { code: 'ROUTER_V2_NO_CANDIDATE', message: err.message } })
            return
        }
        logger.error({ err, workspaceId }, 'inference.chat: unexpected error')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'chat completions call failed' } })
    }
}

const router: import('express').Router = Router()

const headerRouter = Router()
headerRouter.use(requireServiceKey)
headerRouter.post('/embeddings', embeddingsHandler)
headerRouter.post('/chat/completions', chatCompletionsHandler)

const wsRouter = Router({ mergeParams: true })
wsRouter.use((req, _res, next) => {
    if (!req.headers['x-app-id']) req.headers['x-app-id'] = 'graphiti-sidecar'
    next()
})
wsRouter.use(requireServiceKey)
wsRouter.post('/embeddings', embeddingsHandler)
wsRouter.post('/chat/completions', chatCompletionsHandler)

router.use('/v1', headerRouter)
router.use('/ws/:workspaceId/v1', wsRouter)

export const inferenceRouter = router
