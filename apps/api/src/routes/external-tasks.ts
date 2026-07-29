// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * POST /api/v1/ai/tasks
 *
 * AI task dispatch endpoint for external Joeybuilt apps (Fylo, etc.).
 * Maps an app's task request onto the workspace's configured LLM provider
 * via router-v2 + Vercel AI SDK `generateText`.
 *
 * Companion to /api/v1/ai/complete: that route is text-only with a minimal
 * `{ text }` response. This route accepts the richer Fylo task envelope
 * (taskType, vision metadata, structured response) so app gateways like
 * Fylo's intelligence/ai/gateway can route every LLM call through Plexo.
 *
 * Auth: PLEXO_SERVICE_KEY via requireServiceKey (Bearer + X-App-Id).
 *
 * Request body:
 *   workspaceId  — Plexo workspace UUID (whose AI creds to use)
 *   appId        — must match X-App-Id (anti-spoof)
 *   taskType     — app-specific task hint, mapped to Plexo's TaskType for routing
 *   model        — optional model id override (informational; router still picks)
 *   systemPrompt — optional system message
 *   messages     — { role, content }[] (content may be string or content blocks)
 *   maxTokens    — optional limit, default 4096
 *   userId       — optional user attribution
 *   metadata     — optional; { base64Data, contentType } promotes the first
 *                  user message to a vision content block
 *
 * Response:
 *   { success: true, data: string, usage: { inputTokens, outputTokens } }
 *   { success: false, error: string }
 */

import { Router, type Router as RouterType } from 'express'
import { z } from 'zod'
import { generateText, type ModelMessage } from 'ai'
import { requireServiceKey } from '../middleware/service-key-auth.js'
import { routeAndCall } from '@plexo/agent/providers/router-v2'
import { loadWorkspaceAISettings } from '../agent-loop.js'
import { logger } from '../logger.js'
import { UUID_RE } from '../validation.js'
import type { TaskType } from '@plexo/agent/providers/registry'

export const externalTasksRouter: RouterType = Router()

// ── Fylo (and similar) task types → Plexo router TaskType ──────────────────
// Apps speak their own taxonomy. The router only knows nine TaskType values,
// so we collapse anything we don't recognize onto the closest match. Unknown
// types fall through to `extraction` (the most general-purpose default).
const TASK_TYPE_MAP: Record<string, TaskType> = {
    categorization: 'classification',
    merchant_resolution: 'classification',
    document_extraction: 'extraction',
    entry_parsing: 'extraction',
    receipt_parsing: 'extraction',
    spreadsheet_column_detection: 'extraction',
    spreadsheet_chunk_extraction: 'extraction',
    chat: 'conversation',
}

function mapTaskType(input: string): TaskType {
    return TASK_TYPE_MAP[input] ?? 'extraction'
}

// ── Request validation ─────────────────────────────────────────────────────

const messageContentBlockSchema = z.object({ type: z.string() }).passthrough()

const messageSchema = z.object({
    role: z.enum(['user', 'assistant', 'system']),
    content: z.union([z.string(), z.array(messageContentBlockSchema)]),
})

const requestSchema = z.object({
    workspaceId: z.string().regex(UUID_RE, 'workspaceId must be a UUID'),
    appId: z.string().min(1),
    taskType: z.string().min(1),
    model: z.string().optional(),
    systemPrompt: z.string().optional(),
    messages: z.array(messageSchema).min(1, 'at least one message required'),
    maxTokens: z.number().int().positive().max(8192).optional(),
    userId: z.string().optional(),
    metadata: z.record(z.unknown()).optional(),
})

const DEFAULT_MAX_TOKENS = 4096
const CALL_TIMEOUT_MS = 60_000

// ── Vision: promote a user message to a vision content block ───────────────

function buildMessagesWithVision(
    messages: z.infer<typeof messageSchema>[],
    systemPrompt: string | undefined,
    base64Data: string | undefined,
    contentType: string | undefined,
): ModelMessage[] {
    const out: ModelMessage[] = []

    if (systemPrompt) {
        out.push({ role: 'system', content: systemPrompt })
    }

    const hasVision = Boolean(base64Data && contentType)

    const firstUserIdx = messages.findIndex(x => x.role === 'user')

    for (let i = 0; i < messages.length; i++) {
        const m = messages[i]
        if (!m) continue

        // Only the first user message gets the image attachment.
        if (hasVision && m.role === 'user' && i === firstUserIdx) {
            const textPart = typeof m.content === 'string'
                ? [{ type: 'text' as const, text: m.content }]
                : (m.content as Array<{ type: string }>)
                    .filter(b => b.type === 'text')
                    .map(b => ({ type: 'text' as const, text: (b as { text?: string }).text ?? '' }))

            out.push({
                role: 'user',
                content: [
                    {
                        type: 'image',
                        image: `data:${contentType};base64,${base64Data}`,
                    },
                    ...textPart,
                ],
            } as ModelMessage)
        } else {
            out.push(m as ModelMessage)
        }
    }

    return out
}

// ── Route handler ──────────────────────────────────────────────────────────

externalTasksRouter.post('/', requireServiceKey, async (req, res) => {
    const parsed = requestSchema.safeParse(req.body)
    if (!parsed.success) {
        res.status(400).json({
            success: false,
            error: 'Invalid request body: ' + JSON.stringify(parsed.error.flatten().fieldErrors),
        })
        return
    }

    const body = parsed.data

    // Anti-spoof: body.appId must match the service-key context.
    if (body.appId !== req.serviceContext!.appId) {
        res.status(403).json({
            success: false,
            error: `appId in body (${body.appId}) does not match X-App-Id (${req.serviceContext!.appId})`,
        })
        return
    }

    try {
        const { aiSettings } = await loadWorkspaceAISettings(body.workspaceId)
        if (!aiSettings) {
            res.status(422).json({
                success: false,
                error: `No AI provider configured for workspace ${body.workspaceId}`,
            })
            return
        }

        const meta = body.metadata as { base64Data?: string; contentType?: string } | undefined
        const finalMessages = buildMessagesWithVision(
            body.messages,
            body.systemPrompt,
            meta?.base64Data,
            meta?.contentType,
        )

        const result = await routeAndCall({
            workspaceId: body.workspaceId,
            taskType: mapTaskType(body.taskType),
            settings: aiSettings,
            doCall: (model) => generateText({
                model,
                messages: finalMessages,
                maxOutputTokens: body.maxTokens ?? DEFAULT_MAX_TOKENS,
                abortSignal: AbortSignal.timeout(CALL_TIMEOUT_MS),
            }),
        })

        res.json({
            success: true,
            data: result.text,
            usage: {
                inputTokens: result.usage?.inputTokens ?? 0,
                outputTokens: result.usage?.outputTokens ?? 0,
            },
        })
    } catch (err) {
        const message = err instanceof Error ? err.message : 'AI task dispatch failed'
        logger.error(
            { err, workspaceId: body.workspaceId, appId: body.appId, taskType: body.taskType },
            'POST /api/v1/ai/tasks failed',
        )
        const isTimeout = err instanceof Error && (err.name === 'AbortError' || message.includes('timeout'))
        res.status(isTimeout ? 504 : 500).json({
            success: false,
            error: isTimeout ? 'AI request timed out' : message,
        })
    }
})
