// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * POST /api/v1/ai/complete
 *
 * Lightweight text-completion proxy for trusted Joeybuilt apps (Levio, etc.).
 * Uses the workspace's configured AI provider credentials so apps don't need
 * their own API keys — all inference routes through Plexo's credential store.
 *
 * Auth: PLEXO_SERVICE_KEY via requireServiceKey middleware.
 *
 * Request body:
 *   workspaceId  — Plexo workspace UUID (whose AI creds to use)
 *   messages     — CoreMessage[] array ({ role, content })
 *   systemPrompt — optional system message prepended before messages
 *   maxTokens    — optional token limit (default 512)
 *   taskType     — optional task hint for model routing (default 'summarization')
 *
 * Response: { text: string }
 */

import { Router, type Router as RouterType } from 'express'
import { generateText } from 'ai'
import { requireServiceKey } from '../middleware/service-key-auth.js'
import { loadDecryptedAIProviders } from './ai-provider-creds.js'
import { withFallback } from '@plexo/agent/providers/registry'
import { loadWorkspaceAISettings } from '../agent-loop.js'
import { logger } from '../logger.js'
import { UUID_RE } from '../validation.js'
import type { TaskType } from '@plexo/agent/providers/registry'

export const aiCompleteRouter: RouterType = Router()

type MessageRole = 'user' | 'assistant' | 'system'
interface InputMessage {
    role: MessageRole
    content: string
}

aiCompleteRouter.post('/complete', requireServiceKey, async (req, res) => {
    const { workspaceId, messages, systemPrompt, maxTokens = 512, taskType = 'summarization' } = req.body as {
        workspaceId?: string
        messages?: InputMessage[]
        systemPrompt?: string
        maxTokens?: number
        taskType?: TaskType
    }

    if (!workspaceId || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE', message: 'Valid workspaceId UUID required' } })
        return
    }

    if (!Array.isArray(messages) || messages.length === 0) {
        res.status(400).json({ error: { code: 'INVALID_MESSAGES', message: 'messages array required' } })
        return
    }

    // Validate message shapes
    const validRoles = new Set(['user', 'assistant', 'system'])
    for (const m of messages) {
        if (!validRoles.has(m.role) || typeof m.content !== 'string') {
            res.status(400).json({ error: { code: 'INVALID_MESSAGE', message: 'Each message needs role (user|assistant|system) and string content' } })
            return
        }
    }

    try {
        const aiSettings = await loadWorkspaceAISettings(workspaceId)
        if (!aiSettings) {
            res.status(422).json({ error: { code: 'NO_AI_CONFIGURED', message: 'No AI provider configured for this workspace' } })
            return
        }

        const allMessages = systemPrompt
            ? [{ role: 'system' as const, content: systemPrompt }, ...messages]
            : messages

        const { text } = await withFallback(
            aiSettings,
            taskType,
            (model) => generateText({ model, messages: allMessages, maxTokens }),
            { workspaceId }
        )

        res.json({ text })
    } catch (err) {
        logger.error({ err, workspaceId }, 'POST /api/v1/ai/complete failed')
        const msg = err instanceof Error ? err.message : 'AI completion failed'
        res.status(500).json({ error: { code: 'COMPLETION_FAILED', message: msg } })
    }
})
