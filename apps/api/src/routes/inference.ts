// SPDX-License-Identifier: AGPL-3.0-only
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
import { resolveModelFromEnv, withFallback } from '@plexo/agent/providers/registry'
import { loadSettingsFromInstances } from '@plexo/agent/providers/settings-from-instances'

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
        case 'CALL_MODEL_PARSE': return 502
        case 'CALL_MODEL_4XX': return 502
        case 'CALL_MODEL_5XX': return 502
        case 'CALL_MODEL_TIMEOUT': return 504
        case 'CALL_MODEL_ABORTED': return 499
        case 'CALL_MODEL_UNKNOWN': return 500
    }
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

    try {
        let result: Awaited<ReturnType<typeof doCall>>
        if (aiSettings) {
            // Walk the workspace's full provider chain — primary first, then
            // each fallback in preference_order. Billing/quota/auth/rate-limit
            // failures advance to the next provider automatically.
            result = await withFallback(
                aiSettings,
                taskType,
                async (model) => {
                    // The provider that built this model is what we're trying — derive it
                    // from the model object so the callModel telemetry stays accurate.
                    const provider = (model as { provider?: string }).provider ?? 'unknown'
                    return doCall(model, provider)
                },
                {
                    workspaceId,
                    onFallbackEngaged: (info) => {
                        logger.warn({ event: 'inference.chat.fallback', ...info }, 'inference.chat: primary provider failed; served by fallback')
                    },
                },
            )
        } else {
            // No workspace settings — env-var fallback path (dev / self-host)
            try {
                const envModel = resolveModelFromEnv()
                result = await doCall(envModel, 'env-fallback')
            } catch (envErr) {
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
    } catch (err) {
        if (err instanceof CallModelError) {
            const status = mapCallModelErrorStatus(err.code)
            logger.warn({ err, workspaceId, code: err.code }, 'inference.chat: callModel error')
            res.status(status).json({ error: { code: err.code, message: err.message } })
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
