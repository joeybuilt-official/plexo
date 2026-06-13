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
 *
 * POST /api/v1/vision/analyze-image
 *   Service-key authed. UNIFIED multimodal analysis — collapses 5 LLM calls
 *   (classify + label + ocr + describe + suggest-tags) into ONE call against
 *   a local Ollama vision model. Used by Fonto's worker to ~4× speed up the
 *   per-asset classification pipeline. See ADR 0002 (fonto-taxonomy-standard
 *   /0002-analyze-image-api.md).
 */

import { Router, type Router as RouterType } from 'express'
import { generateText } from 'ai'
import { z } from 'zod'
import { UUID_RE } from '../validation.js'
import { ensureWorkspaceAccess } from '../middleware/workspace-access.js'
import { requireServiceKey } from '../middleware/service-key-auth.js'
import { loadWorkspaceAISettings } from '../agent-loop.js'
import { findVisionCapableModel, modelSupportsVision } from '@plexo/agent/providers/vision'
import { PROVIDER_DEFAULT_MODELS, buildOllamaModel } from '@plexo/agent/providers/registry'
import { routeAndCall } from '@plexo/agent/providers/router-v2'
import { CallModelError } from '@plexo/agent/providers/call-model'
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

        // Build a single-shot vision request via router-v2. The selector
        // honours the workspace's provider chain; we narrow tasktype to
        // 'summarization' since OCR is a one-shot text-out call.
        const messages = [
            {
                role: 'user' as const,
                content: [
                    { type: 'text' as const, text: OCR_USER_PROMPT },
                    { type: 'image' as const, image: parsedUrl },
                ],
            },
        ]

        const result = await routeAndCall({
            workspaceId,
            taskType: 'summarization',
            settings: aiSettings,
            doCall: (model) => generateText({
                model,
                system: OCR_SYSTEM_PROMPT,
                messages,
                maxOutputTokens: MAX_OCR_OUTPUT_TOKENS,
                abortSignal: AbortSignal.timeout(45_000),
            }),
        })

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

/* ── POST /vision/analyze-image ───────────────────────────────────────── */
//
// Unified multimodal analysis. ONE call into a vision-capable LLM returns
// the structured payload that previously required 5 separate LLM round-trips
// (plexoClassifyAsset + labelImageUrl + plexoVisionOcr + plexoDescribeImage
// + plexoSuggestTags). ~4× faster end-to-end on the per-asset pipeline.
//
// Routes through router-v2 — same pattern as /vision/ocr — so the workspace's
// primary vision-capable provider is used (today: ollama_cloud/gpt-oss:120b
// in production; falls through to local Ollama when the cloud is unavailable).
// Pinning to local Ollama was tried first and turned out to be unworkable:
// the structured-output schema mode against qwen2.5vl through the
// @ai-sdk/openai-compatible /v1/chat/completions path hangs under contention
// with plexo-vision's /api/generate label calls.
//
// See ADR 0002 (workspace fonto-taxonomy-standard/0002-analyze-image-api.md).

const TAXONOMY_TOP_KEYS = [
    'photo', 'document', 'screenshot', 'logo', 'mockup', 'icon', 'sticker',
    'clipart', 'meme', 'art', 'cover-art', 'wallpaper', 'diagram', 'whiteboard',
] as const

// Zod schema is the source of truth. callModel routes structured-output
// through generateObject and the AI-SDK runs its parse + retry-on-malformed-
// output loop (already battle-hardened by quality-judge + planner).
const AnalyzeImageSchema = z.object({
    classification: z.enum(TAXONOMY_TOP_KEYS),
    // Slug-cased child label, persisted into assets.sub_classification. The
    // model MUST emit this field (even as empty string) — `.optional()` would
    // generate JSON Schema that drops the field from `required`, which Groq's
    // structured-output validator rejects with
    // "required is required to be supplied and to be an array including every key in properties".
    subClassification: z.string().max(64),
    // .refine instead of .min/.max — Anthropic structured-output rejects
    // {minimum, maximum} on number-typed JSON Schema fields. Same trick
    // quality-judge uses.
    confidence: z.number().refine((n) => n >= 0 && n <= 1, { message: 'confidence must be 0..1' }),
    description: z.string().min(1).max(600),
    // Empty string when the image has no readable text. Same .optional() →
    // required-array issue applies; force the model to always emit this key.
    ocrText: z.string(),
    labels: z.array(z.string().min(1).max(48)).max(20),
    suggestedTags: z.array(z.string().min(1).max(48)).max(8),
})

type AnalyzeImageResult = z.infer<typeof AnalyzeImageSchema>

// Per-call wall clock. The composed AbortSignal in callModel + the workspace
// router's own retry budget combine; this is the outer ceiling.
const ANALYZE_TIMEOUT_MS = Number(process.env.PLEXO_ANALYZE_IMAGE_TIMEOUT_MS) || 180_000
// ADR 0002 §5 — model is fixed to local Ollama; we DO NOT route through
// router-v2 to avoid workspace-provider selection variance. Override via env
// only for ops (e.g. swap to qwen2.5vl:3b for a fallback test).
const ANALYZE_PRIMARY_MODEL = process.env.PLEXO_ANALYZE_IMAGE_MODEL ?? 'qwen2.5vl:7b-fonto'
const ANALYZE_MAX_OUTPUT_TOKENS = 2048

const ANALYZE_SYSTEM_PROMPT = `You are an image-analysis engine for a personal photo and document library. Given ONE image, you return ONE structured JSON object describing it.

Decision rules:
1. classification — pick the single top-key that best matches what this image fundamentally IS. Allowed values:
   - photo         (a CAMERA capture of a real, physical 3-D scene — people, places, food, pets, events, selfies)
   - document      (paper, receipt, handwritten note, form — printed/written content matters)
   - screenshot    (a CAPTURE OF A SCREEN — phone/computer/web/app UI, a chat, a web page, app receipts, even a screenshot OF a photo or video)
   - logo, mockup, icon, sticker, clipart  (designed marks / flat digital graphics)
   - meme          (template image + caption text)
   - art           (painting, illustration, drawing, sculpture, AI-generated image)
   - cover-art     (book/album/movie cover, promotional poster)
   - wallpaper     (decorative phone/desktop background)
   - diagram       (chart, blueprint, circuit, flowchart, infographic)
   - whiteboard    (whiteboard/chalkboard photographed flat-on — more specific than document)

   DISAMBIGUATION (critical — the library is full of saved/downloaded images, not just camera photos): only choose \`photo\` if the image could have come straight out of a phone or camera pointed at the real world. If it instead shows app/browser/phone UI chrome or a status bar, is a screen capture of ANY kind (including a screenshotted photo or video), is a meme, a flat designed graphic, a product/marketing/promotional image, a logo, an icon, a sticker, a wallpaper, or AI-generated artwork, choose the matching screenshot / graphic / art category — NOT photo. A screenshot of a photo is a \`screenshot\`. A downloaded meme is a \`meme\`. A product image with price text is a \`screenshot\` or \`mockup\`, not a photo. A perfectly rectangular flat-color or UI composition with no real-world depth is a strong signal it is NOT a camera photo.
2. subClassification — a slug-cased child label (e.g. portrait, receipt, webpage, chat, food, contract). Empty string "" if no clear sub-class.
3. confidence — overall confidence in steps 1+2, in [0, 1].
4. description — ONE caption. 1-3 sentences, max 60 words. Name concrete subjects (people, objects, scene). Quote visible short text verbatim. No filler verbs (captures / depicts / showcases / a photo of).
5. ocrText — every readable word visible in the image, in reading order, with line breaks preserved. Empty string if no readable text. Do NOT invent text.
6. labels — 4-12 short lowercase nouns for the salient objects/scenes. No anatomy fragments, no abstract visual properties.
7. suggestedTags — 2-5 user-facing tag names. Title-case nouns from the library taxonomy (Portraits, Pets, Food, Receipts, Travel, Architecture, Documents, Screenshots, etc.). At most 5.

Output ONLY the JSON object. No markdown fences, no commentary, no preamble.`

interface AnalyzeImageHints {
    topClipClass?: string
    clipConfidence?: number
    cameraMake?: string
    hasExposureExif?: boolean
    widthPx?: number
    heightPx?: number
}

/**
 * Extract the first JSON object from a model's text response, stripping
 * markdown fences and any prose-preamble/-postamble the model added.
 * Mirrors `stripCodeFence` in call-model.ts but inlined here so we don't
 * depend on package-private helpers.
 */
function stripJsonFromText(text: string): string {
    const trimmed = text.trim()
    // Whole string is a single fenced block.
    const whole = trimmed.match(/^```(?:json|javascript|js)?\s*\n?([\s\S]*?)\n?```$/)
    if (whole?.[1] !== undefined) return whole[1].trim()
    // First fenced block anywhere.
    const inner = text.match(/```(?:json|javascript|js)?\s*\n?([\s\S]*?)\n?```/)
    if (inner?.[1] !== undefined) return inner[1].trim()
    // Unclosed fence (model ran into max_tokens before emitting the closing
    // ``` — common with smaller VLMs). Strip the opening fence so the JSON
    // extractor below has a chance.
    const openFence = trimmed.match(/^```(?:json|javascript|js)?\s*\n?([\s\S]*)$/)
    const stripped = openFence?.[1] ?? trimmed
    // First balanced JSON object.
    const firstObj = stripped.indexOf('{')
    const lastObj = stripped.lastIndexOf('}')
    if (firstObj !== -1 && lastObj > firstObj) return stripped.slice(firstObj, lastObj + 1).trim()
    return stripped.trim()
}

/**
 * Escape raw control characters (newlines/tabs/etc.) that appear INSIDE a
 * JSON string literal. qwen2.5vl:3b frequently emits a literal newline in
 * `description`/`ocrText`, which makes `JSON.parse` throw "Bad control
 * character in string literal". Walks the text tracking string state +
 * backslash escapes so structural whitespace (between tokens) is untouched.
 */
function escapeControlInStrings(s: string): string {
    let out = ''
    let inStr = false
    let esc = false
    for (const ch of s) {
        if (esc) { out += ch; esc = false; continue }
        if (ch === '\\') { out += ch; esc = true; continue }
        if (ch === '"') { inStr = !inStr; out += ch; continue }
        if (inStr && ch.charCodeAt(0) < 0x20) {
            out += ch === '\n' ? '\\n' : ch === '\t' ? '\\t' : ch === '\r' ? '\\r' : ' '
            continue
        }
        out += ch
    }
    return out
}

/**
 * Best-effort JSON parse that repairs the two malformations small VLMs
 * produce most: raw control chars inside strings, and trailing commas.
 * Returns `undefined` only when the text is genuinely broken (truncation,
 * structural garbage) — those go to a retry, not a repair.
 */
function tolerantJsonParse(s: string): unknown | undefined {
    try { return JSON.parse(s) } catch { /* fall through to repairs */ }
    const ctrlFixed = escapeControlInStrings(s)
    try { return JSON.parse(ctrlFixed) } catch { /* next */ }
    const commaFixed = ctrlFixed.replace(/,(\s*[}\]])/g, '$1')
    try { return JSON.parse(commaFixed) } catch { /* give up */ }
    return undefined
}

/**
 * Coerce the common shape errors qwen2.5vl:3b makes so they pass the zod
 * schema without a re-roll: comma-joined enum/array strings, string-typed
 * confidence, over-long / over-count fields. Latency-free — runs on the
 * already-parsed object. Genuine misses (empty description) still fail and
 * fall to retry.
 */
function coerceAnalyzeShape(v: unknown): unknown {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return v
    const o: Record<string, unknown> = { ...(v as Record<string, unknown>) }
    // classification: lowercase + first comma-token (model sometimes returns a
    // CSV of candidates, e.g. "logo, mockup, icon") + trim.
    if (typeof o.classification === 'string') {
        o.classification = o.classification.toLowerCase().split(',')[0]?.trim()
    }
    // confidence: string → number; clamp to [0,1]; non-finite → 0.5.
    if (typeof o.confidence === 'string') {
        const n = Number(o.confidence.trim())
        o.confidence = Number.isFinite(n) ? n : 0.5
    }
    if (typeof o.confidence === 'number') {
        o.confidence = Math.min(1, Math.max(0, o.confidence))
    }
    // labels / suggestedTags: comma-joined string → array; cap count + item len.
    const caps: Record<string, number> = { labels: 20, suggestedTags: 8 }
    for (const k of ['labels', 'suggestedTags']) {
        let arr: unknown = o[k]
        if (typeof arr === 'string') arr = arr.split(',')
        if (Array.isArray(arr)) {
            o[k] = arr
                .map((x) => (typeof x === 'string' ? x : String(x)).trim().slice(0, 48))
                .filter((x) => x.length > 0)
                .slice(0, caps[k])
        }
    }
    // subClassification / ocrText: required strings — default missing/non-string.
    o.subClassification = (typeof o.subClassification === 'string'
        ? o.subClassification
        : o.subClassification == null ? '' : String(o.subClassification)).slice(0, 64)
    o.ocrText = typeof o.ocrText === 'string'
        ? o.ocrText
        : o.ocrText == null ? '' : String(o.ocrText)
    // description: trim over-long captions to the schema ceiling.
    if (typeof o.description === 'string' && o.description.length > 600) {
        o.description = o.description.slice(0, 600)
    }
    return o
}

function buildAnalyzeUserPrompt(opts: {
    filename?: string
    mimeType?: string
    hints?: AnalyzeImageHints
}): string {
    const h = opts.hints ?? {}
    const filename = (opts.filename ?? '').slice(0, 120) || 'unknown'
    const mimeType = (opts.mimeType ?? '').slice(0, 64) || 'unknown'
    const topClip = h.topClipClass ? `${h.topClipClass}${typeof h.clipConfidence === 'number' ? ` (CLIP conf ${h.clipConfidence.toFixed(2)})` : ''}` : 'unknown'
    const cameraMake = h.cameraMake ?? 'unknown'
    const hasExif = typeof h.hasExposureExif === 'boolean' ? (h.hasExposureExif ? 'yes' : 'no') : 'unknown'
    const dims = (typeof h.widthPx === 'number' && typeof h.heightPx === 'number')
        ? `${h.widthPx}x${h.heightPx}`
        : 'unknown'
    return [
        'Analyze the attached image and return the structured JSON.',
        '',
        'Hints (may be empty / unknown — use them only as priors, not as ground truth):',
        `  filename:         ${filename}`,
        `  mimeType:         ${mimeType}`,
        `  topClipClass:     ${topClip}`,
        `  cameraMake:       ${cameraMake}`,
        `  hasExposureExif:  ${hasExif}`,
        `  widthPx x heightPx: ${dims}`,
    ].join('\n')
}

visionRouter.post('/analyze-image', requireServiceKey, async (req, res) => {
    const body = (req.body ?? {}) as {
        workspaceId?: unknown
        imageUrl?: unknown
        mimeType?: unknown
        filename?: unknown
        hints?: unknown
    }
    const workspaceId = typeof body.workspaceId === 'string' ? body.workspaceId : ''
    const imageUrl = typeof body.imageUrl === 'string' ? body.imageUrl : ''
    const mimeType = typeof body.mimeType === 'string' ? body.mimeType : ''
    const filename = typeof body.filename === 'string' ? body.filename : ''
    const hints = (body.hints && typeof body.hints === 'object') ? body.hints as AnalyzeImageHints : undefined

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

    // Build the multimodal user message. The AI-SDK's `content: [text, image]`
    // shape is exactly what `POST /vision/ocr` already uses upstream.
    const userPrompt = buildAnalyzeUserPrompt({ filename, mimeType, hints })
    const messages = [
        {
            role: 'user' as const,
            content: [
                { type: 'text' as const, text: userPrompt },
                { type: 'image' as const, image: parsedUrl },
            ],
        },
    ]

    const startedAt = Date.now()
    let modelUsed = ANALYZE_PRIMARY_MODEL
    try {
        // ADR 0002 §5 — direct local-Ollama call. Bypass router-v2 to avoid
        // workspace-router selection variance + cross-provider VLM compat
        // failures (ollama_cloud/qwen3-vl rejects multipart image content;
        // groq json_schema mode rejects vision; etc). The platform-owned
        // local Ollama is the only provider we trust for this hot path.
        //
        // generateText is the path /vision/ocr already uses against the same
        // qwen2.5vl family — we leverage it the same way and JSON.parse the
        // response ourselves. Schema validation runs against the parsed
        // object below.
        const model = buildOllamaModel(ANALYZE_PRIMARY_MODEL)
        // qwen2.5vl:3b emits structurally-invalid JSON on a meaningful
        // minority of calls (comma-joined enums, string-typed confidence, raw
        // newlines in strings, bare truncation). We deliberately do NOT use
        // Ollama constrained-decoding `format` here — measured 2026-06-08 it
        // ~2.5×'d per-call latency (≈50s vs ≈20s) and, on the single-slot
        // 3060, halved drain throughput. Instead: tolerant-parse + coerce the
        // common shape errors (latency-free), and retry the whole call ONCE on
        // a genuine miss. Only the failing minority pays the retry.
        const ANALYZE_ATTEMPTS = 2
        let object: AnalyzeImageResult | undefined
        let lastErr: CallModelError | undefined
        for (let attempt = 1; attempt <= ANALYZE_ATTEMPTS; attempt++) {
            const routed = await generateText({
                model,
                system: ANALYZE_SYSTEM_PROMPT + '\n\nYou MUST output a single JSON object — no markdown fences, no commentary, no preamble. The object MUST have ALL of these keys: classification, subClassification, confidence, description, ocrText, labels, suggestedTags.',
                messages,
                maxOutputTokens: ANALYZE_MAX_OUTPUT_TOKENS,
                abortSignal: AbortSignal.timeout(ANALYZE_TIMEOUT_MS),
            })
            const rawText = (routed.text ?? '').trim()
            // Strip markdown fences + extract the first JSON object.
            const stripped = stripJsonFromText(rawText)
            const parsed = tolerantJsonParse(stripped)
            if (parsed === undefined) {
                lastErr = new CallModelError(
                    `analyze-image response was not valid JSON (attempt ${attempt}/${ANALYZE_ATTEMPTS}); raw: ${stripped.slice(0, 200)}`,
                    'CALL_MODEL_PARSE',
                )
                continue
            }
            const validated = AnalyzeImageSchema.safeParse(coerceAnalyzeShape(parsed))
            if (!validated.success) {
                lastErr = new CallModelError(
                    `analyze-image response failed schema validation (attempt ${attempt}/${ANALYZE_ATTEMPTS}): ${validated.error.message.slice(0, 160)}; raw: ${stripped.slice(0, 200)}`,
                    'CALL_MODEL_PARSE',
                    validated.error,
                )
                continue
            }
            object = validated.data
            break
        }
        if (!object) {
            throw lastErr ?? new CallModelError('analyze-image produced no valid output', 'CALL_MODEL_PARSE')
        }

        // Normalise: callers expect null (not empty string) for absent
        // sub-class and OCR text. The schema accepts only strings (groq's
        // structured-output rejects nullable fields in required-array), so we
        // collapse empty strings → null here before sending to the caller.
        const result = {
            ...object,
            subClassification: object.subClassification.trim().length > 0 ? object.subClassification : null,
            ocrText: object.ocrText.length > 0 ? object.ocrText : null,
        } as Omit<AnalyzeImageResult, 'subClassification' | 'ocrText'> & {
            subClassification: string | null
            ocrText: string | null
        }

        const latencyMs = Date.now() - startedAt
        logger.info({
            event: 'vision.analyze_image.success',
            workspaceId,
            model: modelUsed,
            latencyMs,
            classification: result.classification,
            subClassification: result.subClassification,
            ocrTextLen: result.ocrText?.length ?? 0,
            labelsCount: result.labels.length,
            tagsCount: result.suggestedTags.length,
        }, 'POST /vision/analyze-image succeeded')

        res.json({
            ...result,
            model: modelUsed,
            latencyMs,
        })
    } catch (err) {
        const latencyMs = Date.now() - startedAt
        // CallModelError carries one of 6 sentinel codes — map them to HTTP.
        if (err instanceof CallModelError) {
            const status =
                err.code === 'CALL_MODEL_PARSE' ? 502 :
                err.code === 'CALL_MODEL_TIMEOUT' ? 504 :
                err.code === 'CALL_MODEL_5XX' ? 503 :
                err.code === 'CALL_MODEL_4XX' ? 502 :
                err.code === 'CALL_MODEL_ABORTED' ? 499 :
                502
            const errorCode =
                err.code === 'CALL_MODEL_PARSE' ? 'MODEL_PARSE_ERROR' :
                err.code === 'CALL_MODEL_TIMEOUT' ? 'MODEL_TIMEOUT' :
                err.code === 'CALL_MODEL_5XX' ? 'MODEL_UNAVAILABLE' :
                'MODEL_FAILED'
            logger.warn({
                event: 'vision.analyze_image.failure',
                workspaceId,
                model: modelUsed,
                latencyMs,
                callModelCode: err.code,
                message: err.message.slice(0, 200),
            }, 'POST /vision/analyze-image failed (CallModelError)')
            // For parse errors, surface the raw text (truncated) so the
            // caller can decide whether to retry or fall back to the legacy
            // 5-call path. Hidden behind a feature flag to avoid leaking
            // model output by default.
            const rawText = (err.cause && typeof err.cause === 'object' && 'text' in err.cause && typeof (err.cause as { text: unknown }).text === 'string')
                ? ((err.cause as { text: string }).text).slice(0, 1024)
                : undefined
            res.status(status).json({
                error: {
                    code: errorCode,
                    message: err.message.slice(0, 300),
                    ...(rawText && process.env.PLEXO_ANALYZE_DEBUG_RAW === '1' ? { raw: rawText } : {}),
                },
            })
            return
        }
        logger.error({
            event: 'vision.analyze_image.failure',
            workspaceId,
            model: modelUsed,
            latencyMs,
            err,
        }, 'POST /vision/analyze-image failed (unexpected)')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'analyze-image failed' } })
    }
})
