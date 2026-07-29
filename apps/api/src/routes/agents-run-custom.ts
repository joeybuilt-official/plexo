// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

import { Router, type Router as RouterType } from 'express'
import { ulid } from 'ulid'
import { executeCustomTask, type CustomToolSpec } from '@plexo/agent/executor/runCustom'
import { loadWorkspaceAISettings } from '../agent-loop.js'
import { issueRunJwt } from '../middleware/run-jwt.js'
import { logger } from '../logger.js'
import { UUID_RE } from '../validation.js'

export const agentsRunCustomRouter: RouterType = Router()

// ── POST /api/v1/agents/run-custom ───────────────────────────────────────────
// Caller-driven agent loop (EP1 per FF ADR 0035). Runs the Vercel AI SDK loop
// with caller-provided systemPrompt + tools[]; dispatches each LLM tool call
// to tool.callbackUrl as a signed HTTP POST. Synchronous: returns the final
// assistant output when the loop terminates (or maxSteps cap is hit).
//
// Auth:    requireAuth at v1 router level (service key + X-App-Id).
// Body: {
//   workspaceId: uuid,
//   systemPrompt: string,
//   tools: [{ name, description, inputSchema, callbackUrl }, ...],
//   input: string,
//   maxSteps?: number (default 12),
//   enableMemoryTool?: boolean (EP2),
//   model?: string,
// }
// Returns: { runId, output, steps[], truncated }

agentsRunCustomRouter.post('/run-custom', async (req, res) => {
    const body = req.body as {
        workspaceId?: string
        systemPrompt?: string
        tools?: unknown
        input?: string
        maxSteps?: number
        enableMemoryTool?: boolean
        model?: string
    }

    if (!body.workspaceId || !UUID_RE.test(body.workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE_ID', message: 'workspaceId must be a UUID' } })
        return
    }
    if (typeof body.systemPrompt !== 'string' || body.systemPrompt.length === 0) {
        res.status(400).json({ error: { code: 'MISSING_SYSTEM_PROMPT', message: 'systemPrompt is required' } })
        return
    }
    if (typeof body.input !== 'string' || body.input.length === 0) {
        res.status(400).json({ error: { code: 'MISSING_INPUT', message: 'input is required' } })
        return
    }
    if (!Array.isArray(body.tools)) {
        res.status(400).json({ error: { code: 'INVALID_TOOLS', message: 'tools must be an array' } })
        return
    }
    const tools = body.tools as unknown[]
    const parsedTools: CustomToolSpec[] = []
    for (const t of tools) {
        if (!t || typeof t !== 'object') {
            res.status(400).json({ error: { code: 'INVALID_TOOL', message: 'each tool must be an object' } })
            return
        }
        const tt = t as Record<string, unknown>
        if (typeof tt.name !== 'string' || typeof tt.description !== 'string' || typeof tt.callbackUrl !== 'string' || !tt.inputSchema || typeof tt.inputSchema !== 'object') {
            res.status(400).json({ error: { code: 'INVALID_TOOL', message: 'tool needs string name/description/callbackUrl and object inputSchema' } })
            return
        }
        try {
            const url = new URL(tt.callbackUrl)
            if (url.protocol !== 'http:' && url.protocol !== 'https:') {
                throw new Error('protocol')
            }
        } catch {
            res.status(400).json({ error: { code: 'INVALID_TOOL', message: `callbackUrl is not a valid http(s) URL: ${tt.callbackUrl}` } })
            return
        }
        parsedTools.push({
            name: tt.name,
            description: tt.description,
            inputSchema: tt.inputSchema as Record<string, unknown>,
            callbackUrl: tt.callbackUrl,
        })
    }
    if (body.maxSteps !== undefined && (typeof body.maxSteps !== 'number' || body.maxSteps < 1 || body.maxSteps > 50)) {
        res.status(400).json({ error: { code: 'INVALID_MAX_STEPS', message: 'maxSteps must be an integer in [1, 50]' } })
        return
    }

    const workspaceId = body.workspaceId
    const runId = ulid()
    const allowedTools = parsedTools.map(t => t.name)
    if (body.enableMemoryTool) allowedTools.push('read_memory')

    try {
        const { aiSettings } = await loadWorkspaceAISettings(workspaceId)
        if (!aiSettings) {
            res.status(409).json({ error: { code: 'NO_AI_SETTINGS', message: 'workspace has no AI provider configured' } })
            return
        }

        const runJwt = await issueRunJwt({ workspaceId, runId, allowedTools })

        const result = await executeCustomTask({
            workspaceId,
            runId,
            runJwt,
            systemPrompt: body.systemPrompt,
            tools: parsedTools,
            input: body.input,
            maxSteps: body.maxSteps,
            enableMemoryTool: body.enableMemoryTool,
            aiSettings,
            model: body.model,
        })

        res.status(200).json(result)
    } catch (err) {
        logger.error({ err, runId, workspaceId }, 'POST /api/v1/agents/run-custom failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: err instanceof Error ? err.message : 'run-custom failed' } })
    }
})
