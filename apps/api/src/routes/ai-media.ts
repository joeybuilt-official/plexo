// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * POST /api/v1/ai/image  and  POST /api/v1/ai/video
 *
 * Media-generation broker. Mirrors ai-complete.ts: a trusted app calls with
 * a workspaceId + prompt; Plexo resolves the workspace's fal.ai (default for
 * image + video) or Google (gemini-2.5-flash-image) credentials, hits the
 * provider, then hands the bytes off to the asset platform configured via
 * FONTO_URL + FONTO_SERVICE_KEY. The asset platform owns durable storage
 * and serves the public read URL we return to the caller.
 *
 * The response shape is `{ url, storageKey, width, height, provider }` —
 * `storageKey` is now the asset-platform asset ID, not an S3 key.
 *
 * Auth: PLEXO_SERVICE_KEY via requireServiceKey middleware.
 */

import { Router, type Router as RouterType } from 'express'
import { requireServiceKey } from '../middleware/service-key-auth.js'
import { loadWorkspaceAISettings } from '../agent-loop.js'
import { logger } from '../logger.js'
import { UUID_RE } from '../validation.js'

export const aiMediaRouter: RouterType = Router()

// ── Asset-platform bridge ──────────────────────────────────────────────────

interface FontoUploadResult {
    assetId: string
    blobUrl: string
}

// Hand bytes off to the configured asset platform. Workspace UUIDs are
// shared 1:1 between Plexo and the asset platform, so we forward the
// caller's workspaceId verbatim.
async function uploadToAssetPlatform(
    workspaceId: string,
    filename: string,
    contentType: string,
    bytes: Buffer
): Promise<FontoUploadResult> {
    const base = (process.env.FONTO_URL ?? '').replace(/\/$/, '')
    const key = process.env.FONTO_SERVICE_KEY ?? ''
    if (!base || !key) {
        throw new Error('FONTO_URL / FONTO_SERVICE_KEY not configured')
    }

    const form = new FormData()
    const blob = new Blob([new Uint8Array(bytes)], { type: contentType })
    form.append('file', blob, filename)
    form.append('workspaceId', workspaceId)
    form.append('source', 'ai-generated')
    form.append('filename', filename)

    const res = await fetch(`${base}/api/v1/server/assets`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}` },
        body: form,
        signal: AbortSignal.timeout(60_000),
    })
    if (!res.ok) {
        const body = await res.text().catch(() => '')
        throw new Error(`asset-platform upload ${res.status}: ${body.slice(0, 200)}`)
    }
    const data = await res.json() as {
        asset?: { id?: string }
        blobUrl?: string
    }
    if (!data.asset?.id || !data.blobUrl) {
        throw new Error('asset-platform response missing asset.id or blobUrl')
    }
    return { assetId: data.asset.id, blobUrl: data.blobUrl }
}

// ── Shared helpers ─────────────────────────────────────────────────────────

interface FalQueueSubmit {
    request_id: string
    status_url?: string
    response_url?: string
    cancel_url?: string
}

async function pollFalQueue(statusUrl: string, responseUrl: string, apiKey: string, deadlineMs: number): Promise<unknown> {
    while (Date.now() < deadlineMs) {
        const remaining = Math.max(1_000, deadlineMs - Date.now())
        const statusRes = await fetch(statusUrl, {
            headers: { Authorization: `Key ${apiKey}` },
            signal: AbortSignal.timeout(Math.min(remaining, 15_000)),
        })
        if (!statusRes.ok) {
            const body = await statusRes.text().catch(() => '')
            throw new Error(`fal status ${statusRes.status}: ${body.slice(0, 200)}`)
        }
        const status = await statusRes.json() as { status?: string; logs?: unknown }
        if (status.status === 'COMPLETED') {
            const finalRes = await fetch(responseUrl, {
                headers: { Authorization: `Key ${apiKey}` },
                signal: AbortSignal.timeout(15_000),
            })
            if (!finalRes.ok) {
                const body = await finalRes.text().catch(() => '')
                throw new Error(`fal response ${finalRes.status}: ${body.slice(0, 200)}`)
            }
            return await finalRes.json()
        }
        if (status.status === 'FAILED') {
            throw new Error(`fal job failed: ${JSON.stringify(status).slice(0, 200)}`)
        }
        await new Promise((r) => setTimeout(r, 1500))
    }
    throw Object.assign(new Error('fal job timed out'), { name: 'AbortError' })
}

async function downloadBytes(url: string): Promise<Buffer> {
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) })
    if (!res.ok) throw new Error(`download failed: ${res.status}`)
    const ab = await res.arrayBuffer()
    return Buffer.from(ab)
}

function inferExt(contentType: string | null, fallback: string): string {
    if (!contentType) return fallback
    if (contentType.includes('png')) return 'png'
    if (contentType.includes('jpeg') || contentType.includes('jpg')) return 'jpg'
    if (contentType.includes('webp')) return 'webp'
    if (contentType.includes('mp4')) return 'mp4'
    if (contentType.includes('webm')) return 'webm'
    return fallback
}

// ── Image route ────────────────────────────────────────────────────────────

aiMediaRouter.post('/image', requireServiceKey, async (req, res) => {
    const { workspaceId, prompt, negativePrompt, width = 1024, height = 1024, style, provider } = req.body as {
        workspaceId?: string
        prompt?: string
        negativePrompt?: string
        width?: number
        height?: number
        style?: string
        provider?: string
    }

    if (!workspaceId || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE', message: 'Valid workspaceId UUID required' } })
        return
    }
    if (!prompt || typeof prompt !== 'string') {
        res.status(400).json({ error: { code: 'INVALID_PROMPT', message: 'prompt string required' } })
        return
    }

    try {
        const { aiSettings } = await loadWorkspaceAISettings(workspaceId)
        if (!aiSettings) {
            res.status(422).json({ error: { code: 'NO_AI_CONFIGURED', message: 'No AI provider configured for this workspace' } })
            return
        }

        // Provider selection: explicit `provider` wins, otherwise fal default.
        // "google" is canonical; "nanobanana2" is a legacy alias for Google's
        // gemini-2.5-flash-image (industry shorthand "nano-banana").
        const useGoogle = provider === 'google' || provider === 'nanobanana2'
        const finalPrompt = style ? `${prompt}, style: ${style}` : prompt

        let bytes: Buffer
        let contentType = 'image/png'
        let resolvedProvider: string
        let outWidth = width
        let outHeight = height

        if (useGoogle) {
            const googleKey = aiSettings.providers?.google?.apiKey
            if (!googleKey) {
                res.status(422).json({ error: { code: 'NO_IMAGE_PROVIDER', message: 'Google API key required for gemini-2.5-flash-image' } })
                return
            }
            resolvedProvider = 'google/gemini-2.5-flash-image'
            const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${encodeURIComponent(googleKey)}`
            const body = {
                contents: [{ parts: [{ text: finalPrompt }] }],
                generationConfig: { responseModalities: ['IMAGE'] },
            }
            const r = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(60_000),
            })
            if (!r.ok) {
                const errBody = await r.text().catch(() => '')
                throw new Error(`google image ${r.status}: ${errBody.slice(0, 200)}`)
            }
            const data = await r.json() as {
                candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { data?: string; mimeType?: string } }> } }>
            }
            const part = data.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)
            const inline = part?.inlineData
            if (!inline?.data) throw new Error('google response had no inline image data')
            bytes = Buffer.from(inline.data, 'base64')
            if (inline.mimeType) contentType = inline.mimeType
        } else {
            const falKey = aiSettings.providers?.fal?.apiKey
            if (!falKey) {
                res.status(422).json({ error: { code: 'NO_IMAGE_PROVIDER', message: 'No image-capable provider configured (fal.ai or Google)' } })
                return
            }
            resolvedProvider = 'fal/flux-schnell'
            const submitRes = await fetch('https://queue.fal.run/fal-ai/flux/schnell', {
                method: 'POST',
                headers: { Authorization: `Key ${falKey}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    prompt: finalPrompt,
                    negative_prompt: negativePrompt,
                    image_size: { width, height },
                    num_images: 1,
                    enable_safety_checker: true,
                }),
                signal: AbortSignal.timeout(15_000),
            })
            if (!submitRes.ok) {
                const errBody = await submitRes.text().catch(() => '')
                throw new Error(`fal submit ${submitRes.status}: ${errBody.slice(0, 200)}`)
            }
            const submit = await submitRes.json() as FalQueueSubmit
            const statusUrl = submit.status_url ?? `https://queue.fal.run/fal-ai/flux/schnell/requests/${submit.request_id}/status`
            const responseUrl = submit.response_url ?? `https://queue.fal.run/fal-ai/flux/schnell/requests/${submit.request_id}`
            const result = await pollFalQueue(statusUrl, responseUrl, falKey, Date.now() + 60_000) as {
                images?: Array<{ url: string; width?: number; height?: number; content_type?: string }>
            }
            const first = result.images?.[0]
            if (!first?.url) throw new Error('fal response had no image url')
            bytes = await downloadBytes(first.url)
            if (first.content_type) contentType = first.content_type
            if (first.width) outWidth = first.width
            if (first.height) outHeight = first.height
        }

        const ext = inferExt(contentType, 'png')
        const filename = `image.${ext}`
        const { assetId, blobUrl } = await uploadToAssetPlatform(workspaceId, filename, contentType, bytes)

        logger.info({ workspaceId, provider: resolvedProvider, bytes: bytes.byteLength, assetId }, 'ai/image generated')
        res.json({ url: blobUrl, storageKey: assetId, width: outWidth, height: outHeight, provider: resolvedProvider })
    } catch (err) {
        logger.error({ err, workspaceId }, 'POST /api/v1/ai/image failed')
        const isTimeout = err instanceof Error && (err.name === 'AbortError' || err.message.includes('timeout') || err.message.includes('timed out'))
        const msg = isTimeout ? 'Image generation timed out — try again' : 'Image generation failed'
        res.status(500).json({ error: { code: 'IMAGE_FAILED', message: msg } })
    }
})

// ── Video route ────────────────────────────────────────────────────────────

aiMediaRouter.post('/video', requireServiceKey, async (req, res) => {
    const { workspaceId, prompt, sourceImageUrl, durationMs, width = 1280, height = 720, style } = req.body as {
        workspaceId?: string
        prompt?: string
        sourceImageUrl?: string
        durationMs?: number
        width?: number
        height?: number
        style?: string
        provider?: string
    }

    if (!workspaceId || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE', message: 'Valid workspaceId UUID required' } })
        return
    }
    if (!prompt || typeof prompt !== 'string') {
        res.status(400).json({ error: { code: 'INVALID_PROMPT', message: 'prompt string required' } })
        return
    }

    try {
        const { aiSettings } = await loadWorkspaceAISettings(workspaceId)
        if (!aiSettings) {
            res.status(422).json({ error: { code: 'NO_AI_CONFIGURED', message: 'No AI provider configured for this workspace' } })
            return
        }
        const falKey = aiSettings.providers?.fal?.apiKey
        if (!falKey) {
            res.status(422).json({ error: { code: 'NO_IMAGE_PROVIDER', message: 'No video-capable provider configured (fal.ai required)' } })
            return
        }

        const finalPrompt = style ? `${prompt}, style: ${style}` : prompt
        const model = sourceImageUrl
            ? 'bytedance/seedance-2.0/image-to-video'
            : 'bytedance/seedance-2.0/text-to-video'
        const resolvedProvider = `fal/${model}`

        // seedance accepts '480p' | '720p' | '1080p' — pick by max(width,height)
        const longSide = Math.max(width, height)
        const resolution = longSide >= 1500 ? '1080p' : longSide >= 1000 ? '720p' : '480p'
        const payload: Record<string, unknown> = {
            prompt: finalPrompt,
            resolution,
        }
        if (sourceImageUrl) payload.image_url = sourceImageUrl
        if (durationMs) payload.duration = Math.round(durationMs / 1000)

        const submitRes = await fetch(`https://queue.fal.run/${model}`, {
            method: 'POST',
            headers: { Authorization: `Key ${falKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(15_000),
        })
        if (!submitRes.ok) {
            const errBody = await submitRes.text().catch(() => '')
            throw new Error(`fal submit ${submitRes.status}: ${errBody.slice(0, 200)}`)
        }
        const submit = await submitRes.json() as FalQueueSubmit
        const statusUrl = submit.status_url ?? `https://queue.fal.run/${model}/requests/${submit.request_id}/status`
        const responseUrl = submit.response_url ?? `https://queue.fal.run/${model}/requests/${submit.request_id}`
        const result = await pollFalQueue(statusUrl, responseUrl, falKey, Date.now() + 180_000) as {
            video?: { url: string; content_type?: string }
            duration?: number
        }
        const videoUrl = result.video?.url
        if (!videoUrl) throw new Error('fal response had no video url')

        const bytes = await downloadBytes(videoUrl)
        const contentType = result.video?.content_type ?? 'video/mp4'
        const ext = inferExt(contentType, 'mp4')
        const filename = `video.${ext}`
        const { assetId, blobUrl } = await uploadToAssetPlatform(workspaceId, filename, contentType, bytes)

        const outDurationMs = typeof result.duration === 'number' ? Math.round(result.duration * 1000) : (durationMs ?? 0)

        logger.info({ workspaceId, provider: resolvedProvider, bytes: bytes.byteLength, assetId }, 'ai/video generated')
        res.json({ url: blobUrl, storageKey: assetId, width, height, provider: resolvedProvider, durationMs: outDurationMs })
    } catch (err) {
        logger.error({ err, workspaceId }, 'POST /api/v1/ai/video failed')
        const isTimeout = err instanceof Error && (err.name === 'AbortError' || err.message.includes('timeout') || err.message.includes('timed out'))
        const msg = isTimeout ? 'Video generation timed out — try again' : 'Video generation failed'
        res.status(500).json({ error: { code: 'VIDEO_FAILED', message: msg } })
    }
})

// TODO: cost accounting (deferred for v1)
// TODO: async/queue path for video > 90s ceiling (deferred for v1)
