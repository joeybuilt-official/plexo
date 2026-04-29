// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Vision endpoints.
 *
 * GET  /api/v1/vision/status?workspaceId=...
 *   Returns whether the workspace has any vision-capable model available.
 *   Used by the IntegrationsNudgeModal and Telegram adapter to prompt users
 *   to set up a free vision provider (like Groq) if none exists.
 *
 * POST /api/v1/vision/ocr
 *   Service-key authed. Extracts text from a publicly-fetchable image URL
 *   using the workspace's vision-capable model (with fallback). Used by
 *   Fonto and other Joeybuilt apps for OCR-only search indexing.
 *   Body: { workspaceId, imageUrl }
 *   Returns: { text, confidence, model }
 */

import { Router, type Router as RouterType } from 'express'
import { generateText } from 'ai'
import { UUID_RE } from '../validation.js'
import { ensureWorkspaceAccess } from '../middleware/workspace-access.js'
import { requireServiceKey } from '../middleware/service-key-auth.js'
import { loadWorkspaceAISettings } from '../agent-loop.js'
import { findVisionCapableModel, modelSupportsVision } from '@plexo/agent/providers/vision'
import { PROVIDER_DEFAULT_MODELS, withFallback } from '@plexo/agent/providers/registry'
import { logger } from '../logger.js'

export const visionRouter: RouterType = Router()

visionRouter.get('/status', async (req, res) => {
    const { workspaceId } = req.query as { workspaceId?: string }
    if (!workspaceId || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_ID', message: 'Valid workspaceId required' } })
        return
    }
    if (!await ensureWorkspaceAccess(req, res, workspaceId)) return

    try {
        const { aiSettings } = await loadWorkspaceAISettings(workspaceId)
        if (!aiSettings) {
            res.json({ configured: false, reason: 'no_providers' })
            return
        }

        // Check if primary model has vision
        const primaryKey = aiSettings.primaryProvider
        const primaryConfig = aiSettings.providers[primaryKey]
        const primaryModel = primaryConfig?.model ?? PROVIDER_DEFAULT_MODELS[primaryKey] ?? ''
        const primaryHasVision = modelSupportsVision(primaryModel, primaryKey)

        if (primaryHasVision) {
            res.json({ configured: true, provider: primaryKey, model: primaryModel, isPrimary: true })
            return
        }

        // Check fallback chain
        const fallback = findVisionCapableModel(aiSettings, PROVIDER_DEFAULT_MODELS, primaryKey)
        if (fallback) {
            res.json({ configured: true, provider: fallback.providerKey, model: fallback.modelId, isPrimary: false })
            return
        }

        res.json({ configured: false, reason: 'no_vision_model' })
    } catch (err) {
        logger.error({ err, workspaceId }, 'GET vision/status failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to check vision status' } })
    }
})

/* ── POST /vision/ocr ─────────────────────────────────────────────────── */

const OCR_SYSTEM_PROMPT = `You are an OCR engine. Extract ALL readable text from the image, preserving line breaks and reading order. Output ONLY the extracted text — no commentary, no markdown fences, no explanations. If no text is visible, output exactly: NO_TEXT_FOUND`

const OCR_USER_PROMPT = 'Extract all text from this image. Output only the text content, preserving line breaks.'

const MAX_OCR_OUTPUT_TOKENS = 2048

visionRouter.post('/ocr', requireServiceKey, async (req, res) => {
    const body = (req.body ?? {}) as { workspaceId?: unknown; imageUrl?: unknown }
    const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId : ''
    const imageUrl = typeof body.imageUrl === 'string' ? body.imageUrl : ''

    if (!workspaceId || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE', message: 'Valid workspaceId UUID required' } })
        return
    }
    if (!imageUrl) {
        res.status(400).json({ error: { code: 'INVALID_IMAGE_URL', message: 'imageUrl required' } })
        return
    }
    let parsedUrl: URL
    try { parsedUrl = new URL(imageUrl) }
    catch {
        res.status(400).json({ error: { code: 'INVALID_IMAGE_URL', message: 'imageUrl must be a valid URL' } })
        return
    }
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
        res.status(400).json({ error: { code: 'INVALID_IMAGE_URL', message: 'imageUrl protocol must be http or https' } })
        return
    }

    try {
        const { aiSettings } = await loadWorkspaceAISettings(workspaceId)
        if (!aiSettings) {
            res.status(422).json({ error: { code: 'NO_AI_CONFIGURED', message: 'No AI provider configured for this workspace' } })
            return
        }

        // Pick a vision-capable model: primary if it supports vision, else fallback chain.
        const primaryKey = aiSettings.primaryProvider
        const primaryConfig = aiSettings.providers[primaryKey]
        const primaryModel = primaryConfig?.model ?? PROVIDER_DEFAULT_MODELS[primaryKey] ?? ''
        const primaryHasVision = modelSupportsVision(primaryModel, primaryKey)
        const visionPick = primaryHasVision
            ? { providerKey: primaryKey, modelId: primaryModel }
            : findVisionCapableModel(aiSettings, PROVIDER_DEFAULT_MODELS, primaryKey)

        if (!visionPick) {
            res.status(422).json({ error: { code: 'NO_VISION_MODEL', message: 'No vision-capable model configured for this workspace' } })
            return
        }

        // Build a single-shot vision request via withFallback. The fallback layer
        // honours the workspace's provider chain; we narrow tasktype to 'summarization'
        // since OCR is a one-shot text-out call.
        const messages = [
            {
                role: 'user' as const,
                content: [
                    { type: 'text' as const, text: OCR_USER_PROMPT },
                    { type: 'image' as const, image: parsedUrl },
                ],
            },
        ]

        const result = await withFallback(
            aiSettings,
            'summarization',
            (model) => generateText({
                model,
                system: OCR_SYSTEM_PROMPT,
                messages,
                maxOutputTokens: MAX_OCR_OUTPUT_TOKENS,
                abortSignal: AbortSignal.timeout(45_000),
            }),
            { workspaceId },
        )

        const raw = (result.text ?? '').trim()
        const noText = raw === 'NO_TEXT_FOUND' || raw === ''
        const text = noText ? '' : raw
        // Coarse confidence proxy: short outputs are likely high-precision OCR;
        // long outputs may include hallucinated commentary. We don't expose
        // model-level token logprobs across providers, so this is a heuristic only.
        const confidence = noText ? 0 : (text.length > 0 && text.length < 16 ? 0.4 : 0.85)

        res.json({
            text,
            confidence,
            model: visionPick.modelId,
            provider: visionPick.providerKey,
        })
    } catch (err) {
        logger.error({ err, workspaceId }, 'POST vision/ocr failed')
        const isTimeout = err instanceof Error && (err.name === 'AbortError' || err.message.includes('timeout'))
        const code = isTimeout ? 'OCR_TIMEOUT' : 'OCR_FAILED'
        const message = isTimeout ? 'OCR request timed out' : 'OCR extraction failed'
        res.status(500).json({ error: { code, message } })
    }
})
