// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Inference shim — exposes Plexo's per-workspace LLM provider router
 * as an OpenAI-compatible HTTP endpoint so the Graphiti Python sidecar
 * (ADR 0011) can use it as its `base_url` without ever holding workspace
 * LLM credentials.
 *
 * Phase 3a: /v1/embeddings.
 * Phase 3b (this file): /v1/chat/completions w/ response_format=json_schema
 *   translated through callModel({schema}). Tool-calling is rejected (501)
 *   because callModel forbids the schema+tools combo and Graphiti's primary
 *   extraction path is json_schema; if tool-mode becomes needed, wire in 3c.
 *
 * Auth: `requireServiceKey` (Bearer PLEXO_SERVICE_KEY + X-App-Id) — same
 * surface used by the existing service-key endpoints. Workspace routing
 * lives in `X-Plexo-Workspace-Id` because the OpenAI request body has no
 * workspace concept.
 */

import { Router } from 'express'
import pino from 'pino'
import { ulid } from 'ulid'
import { jsonSchemaToZod, type JSONSchema } from './json-schema-to-zod.js'
import { requireServiceKey } from '../middleware/service-key-auth.js'
import { embed } from '@plexo/agent/memory/store'
import { callModel, CallModelError } from '@plexo/agent/providers/call-model'
import { resolveModel, resolveModelFromEnv } from '@plexo/agent/providers/registry'
import { loadSettingsFromInstances } from '@plexo/agent/providers/settings-from-instances'

const logger = pino({ name: 'inference-routes' })
const router: import('express').Router = Router()

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

router.use(requireServiceKey)

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

/* ---------- /v1/chat/completions (Phase 3b) ---------- */

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

router.post('/v1/chat/completions', async (req, res) => {
    const workspaceId = req.headers['x-plexo-workspace-id']
    if (typeof workspaceId !== 'string' || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'MISSING_WORKSPACE_ID', message: 'X-Plexo-Workspace-Id header must be a valid UUID' } })
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
    const system = systemParts.length > 0 ? systemParts.join('\n\n') : undefined

    let model: ReturnType<typeof resolveModelFromEnv>
    let provider = 'env-fallback'
    try {
        const aiSettings = await loadSettingsFromInstances(workspaceId)
        if (aiSettings) {
            const resolved = await resolveModel('summarization', aiSettings, workspaceId)
            model = resolved.model
            provider = resolved.meta.provider
        } else {
            model = resolveModelFromEnv()
        }
    } catch (err) {
        logger.warn({ err, workspaceId }, 'inference.chat: resolveModel fell through to env')
        model = resolveModelFromEnv()
    }

    const maxTokens = body.max_completion_tokens ?? body.max_tokens

    try {
        const result = useSchema
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- runtime Zod schema produced by jsonSchemaToZod
            ? await callModel<any>({
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
            : await callModel({
                model,
                provider,
                workspaceId,
                taskType: 'inference.chat.completions',
                system,
                messages: conversational,
                maxTokens,
            })

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
})

router.post('/v1/embeddings', async (req, res) => {
    const workspaceId = req.headers['x-plexo-workspace-id']
    if (typeof workspaceId !== 'string' || !UUID_RE.test(workspaceId)) {
        res.status(400).json({
            error: { code: 'MISSING_WORKSPACE_ID', message: 'X-Plexo-Workspace-Id header must be a valid UUID' },
        })
        return
    }

    const body = req.body as OpenAIEmbeddingsRequest | undefined
    if (!body || body.input === undefined) {
        res.status(400).json({
            error: { code: 'MISSING_INPUT', message: 'request body must include `input`' },
        })
        return
    }

    const inputs = typeof body.input === 'string' ? [body.input] : body.input
    if (!Array.isArray(inputs) || inputs.length === 0) {
        res.status(400).json({
            error: { code: 'EMPTY_INPUT', message: '`input` must be a string or non-empty array' },
        })
        return
    }

    try {
        const vectors = await Promise.all(inputs.map((text) => embed(text, workspaceId)))
        const failedIdx = vectors.findIndex((v) => v === null)
        if (failedIdx !== -1) {
            logger.warn({ workspaceId, failedIdx, totalInputs: inputs.length }, 'inference.embeddings: provider returned null')
            res.status(502).json({
                error: { code: 'EMBEDDING_PROVIDER_ERROR', message: `embedding adapter unavailable for input #${failedIdx}` },
            })
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
        res.status(500).json({
            error: { code: 'INTERNAL_ERROR', message: 'embeddings call failed' },
        })
    }
})

export const inferenceRouter = router
