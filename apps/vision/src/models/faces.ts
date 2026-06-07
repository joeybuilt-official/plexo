// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Face detection + embedding loaders.
 *
 * Default bundle: InsightFace **buffalo_l** ONNX pack (mirror at
 * `immich-app/buffalo_l` on HuggingFace, matching what Immich's ML server
 * ships so face vectors remain comparable across services):
 *
 *   - detection.onnx (SCRFD-10G)  — bboxes, confidences, 5-point landmarks.
 *   - recognition.onnx (ArcFace) — 512-dim L2-normalised face embedding.
 *
 * The two models run serially: detect → align (5-pt similarity transform
 * to the canonical ArcFace template) → embed. The public surface exposes
 * both a combined call (`detectAndEmbed` — what Fonto uses today) and the
 * fine-grained `detect` / `embed` calls (in case future callers want to
 * route a known bbox through ArcFace directly).
 */

import sharp from 'sharp'
import * as ort from 'onnxruntime-node'
import { childLogger } from '../lib/logger.js'
import { decodeBase64Input } from '../lib/image.js'
import { ensureArtifact, registerArtifact } from '../lib/download.js'
import { decodeStride, nms, type RawFaceDetection } from '../lib/face-detect.js'
import {
    ARC_TEMPLATE,
    ARC_INPUT_SIZE,
    similarityTransform,
    applyAffineRGB,
} from '../lib/face-align.js'

const logger = childLogger('faces')

export const FACE_EMBED_DIM = 512
export const FACES_MODEL_ID = 'insightface-buffalo_l'

// Letterboxed detector input — buffalo_l detection.onnx expects 640×640.
const DET_INPUT_SIZE = 640
// SCRFD score threshold — InsightFace's reference default is 0.5; we drop
// to 0.4 to surface low-confidence faces (downstream clustering will gate
// final acceptance via confidence + cluster cohesion).
const DET_SCORE_THRESHOLD = 0.4
const DET_NMS_IOU = 0.4
// SCRFD-10G anchors-per-position. Matches the per-stride row count
// produced by buffalo_l's detection.onnx export (12800 / 3200 / 800 at
// 640×640 input = side² × 2).
const NUM_ANCHORS_PER_POSITION = 2
// SCRFD mean/std (BGR — the input order InsightFace's reference assumes).
const DET_NORMALIZE_MEAN = 127.5
const DET_NORMALIZE_STD = 128.0
// ArcFace normalisation matches recognition input distribution.
const ARC_NORMALIZE_MEAN = 127.5
const ARC_NORMALIZE_STD = 127.5

// Register artifacts so /vision/models reports the registry and
// `pnpm download-models` can pre-warm the cache.
registerArtifact({
    modelId: 'buffalo_l',
    filename: 'detection.onnx',
    sha256: '5838f7fe053675b1c7a08b633df49e7af5495cee0493c7dcf6697200b85b5b91',
    cdnPath: 'buffalo_l/detection.onnx',
    fallbackUrl: 'https://huggingface.co/immich-app/buffalo_l/resolve/main/detection/model.onnx',
})
registerArtifact({
    modelId: 'buffalo_l',
    filename: 'recognition.onnx',
    sha256: '4c06341c33c2ca1f86781dab0e829f88ad5b64be9fba56e56bc9ebdefc619e43',
    cdnPath: 'buffalo_l/recognition.onnx',
    fallbackUrl: 'https://huggingface.co/immich-app/buffalo_l/resolve/main/recognition/model.onnx',
})

export interface FaceBBox {
    /** [x, y, w, h] in source-image pixel space. */
    bbox: [number, number, number, number]
    /** 0..1 detector confidence. */
    confidence: number
    /** 5-point landmarks [x, y] × 5 in source-image pixel space. */
    landmarks: Array<[number, number]>
}

export interface FaceWithEmbedding extends FaceBBox {
    /** 512-dim L2-normalised ArcFace embedding. */
    embedding: number[]
}

interface FacesEngine {
    detSession: ort.InferenceSession
    recSession: ort.InferenceSession
    detOutputNames: string[]
    detInputName: string
    recInputName: string
    recOutputName: string
}

let engine: FacesEngine | null = null
let loadingPromise: Promise<FacesEngine> | null = null

async function loadEngine(): Promise<FacesEngine> {
    if (engine) return engine
    if (loadingPromise) return loadingPromise
    loadingPromise = (async () => {
        const detPath = await ensureArtifact({
            modelId: 'buffalo_l',
            filename: 'detection.onnx',
            sha256: '5838f7fe053675b1c7a08b633df49e7af5495cee0493c7dcf6697200b85b5b91',
            cdnPath: 'buffalo_l/detection.onnx',
            fallbackUrl:
                'https://huggingface.co/immich-app/buffalo_l/resolve/main/detection/model.onnx',
        })
        const recPath = await ensureArtifact({
            modelId: 'buffalo_l',
            filename: 'recognition.onnx',
            sha256: '4c06341c33c2ca1f86781dab0e829f88ad5b64be9fba56e56bc9ebdefc619e43',
            cdnPath: 'buffalo_l/recognition.onnx',
            fallbackUrl:
                'https://huggingface.co/immich-app/buffalo_l/resolve/main/recognition/model.onnx',
        })
        // GPU opt-in: VISION_ORT_EP=cuda runs the ONNX sessions on the CUDA
        // execution provider (needs a CUDA-12 + cuDNN-9 image — see the
        // Dockerfile.vision GPU variant), with per-op CPU fallback. Default
        // stays CPU so CPU-only hosts keep working unchanged.
        const ortEp: string[] =
            process.env.VISION_ORT_EP === 'cuda' ? ['cuda', 'cpu'] : ['cpu']
        logger.info({ detPath, recPath, ortEp }, 'Initializing buffalo_l ONNX sessions')
        const t0 = performance.now()
        const [detSession, recSession] = await Promise.all([
            ort.InferenceSession.create(detPath, {
                executionProviders: ortEp,
                graphOptimizationLevel: 'all',
            }),
            ort.InferenceSession.create(recPath, {
                executionProviders: ortEp,
                graphOptimizationLevel: 'all',
            }),
        ])
        const built: FacesEngine = {
            detSession,
            recSession,
            detOutputNames: [...detSession.outputNames],
            detInputName: detSession.inputNames[0]!,
            recInputName: recSession.inputNames[0]!,
            recOutputName: recSession.outputNames[0]!,
        }
        engine = built
        loadingPromise = null
        logger.info(
            {
                modelId: FACES_MODEL_ID,
                loadMs: Math.round(performance.now() - t0),
                detInputs: detSession.inputNames,
                detOutputs: detSession.outputNames,
            },
            'Faces engine ready',
        )
        return built
    })()
    return loadingPromise
}

/**
 * Letterbox-resize an arbitrary-aspect-ratio image to 640×640 while
 * preserving aspect ratio, padding the short side with black. Returns the
 * raw RGB pixels (HWC) plus the scale + pad offsets needed to map
 * detection coords back to the original image.
 */
async function letterboxToDet(imageBase64: string): Promise<{
    pixels: Buffer
    scale: number
    padX: number
    padY: number
    origW: number
    origH: number
}> {
    const bytes = decodeBase64Input(imageBase64)
    const meta = await sharp(bytes, { failOn: 'error' }).metadata()
    const origW = meta.width ?? 0
    const origH = meta.height ?? 0
    if (origW <= 0 || origH <= 0) throw new Error('faces: invalid image dimensions')
    const scale = Math.min(DET_INPUT_SIZE / origW, DET_INPUT_SIZE / origH)
    const newW = Math.round(origW * scale)
    const newH = Math.round(origH * scale)
    const padX = Math.floor((DET_INPUT_SIZE - newW) / 2)
    const padY = Math.floor((DET_INPUT_SIZE - newH) / 2)
    const resized = await sharp(bytes)
        .removeAlpha()
        .toColorspace('srgb')
        .resize(newW, newH, { kernel: 'linear' })
        .extend({
            top: padY,
            bottom: DET_INPUT_SIZE - newH - padY,
            left: padX,
            right: DET_INPUT_SIZE - newW - padX,
            background: { r: 0, g: 0, b: 0 },
        })
        .raw()
        .toBuffer()
    return { pixels: resized, scale, padX, padY, origW, origH }
}

/**
 * Convert HWC RGB pixels (uint8) to CHW float32 in BGR order, normalized
 * for SCRFD. The detector was trained with OpenCV-style BGR input
 * normalized as (pix - 127.5) / 128.0.
 */
function rgbHwcToScrfdInput(pixels: Buffer, size: number): Float32Array {
    const out = new Float32Array(3 * size * size)
    const plane = size * size
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const hwc = (y * size + x) * 3
            const idx = y * size + x
            // Source is RGB; SCRFD expects BGR (cv2 convention).
            const r = pixels[hwc]!
            const g = pixels[hwc + 1]!
            const b = pixels[hwc + 2]!
            out[0 * plane + idx] = (b - DET_NORMALIZE_MEAN) / DET_NORMALIZE_STD
            out[1 * plane + idx] = (g - DET_NORMALIZE_MEAN) / DET_NORMALIZE_STD
            out[2 * plane + idx] = (r - DET_NORMALIZE_MEAN) / DET_NORMALIZE_STD
        }
    }
    return out
}

/** Same RGB-HWC → CHW-BGR conversion but for ArcFace's 112×112 input. */
function rgbHwcToArcInput(pixels: Buffer, size: number): Float32Array {
    const out = new Float32Array(3 * size * size)
    const plane = size * size
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const hwc = (y * size + x) * 3
            const idx = y * size + x
            const r = pixels[hwc]!
            const g = pixels[hwc + 1]!
            const b = pixels[hwc + 2]!
            out[0 * plane + idx] = (b - ARC_NORMALIZE_MEAN) / ARC_NORMALIZE_STD
            out[1 * plane + idx] = (g - ARC_NORMALIZE_MEAN) / ARC_NORMALIZE_STD
            out[2 * plane + idx] = (r - ARC_NORMALIZE_MEAN) / ARC_NORMALIZE_STD
        }
    }
    return out
}

/**
 * Parse the 9 detection-output tensors into a per-stride bundle.
 *
 * The buffalo_l export emits flat 2-D outputs `[N, C]` already reshaped
 * by the exporter — no NCHW, no batch dim. We classify each tensor by
 * its second dimension (C ∈ {1, 4, 10}) and by row count to infer the
 * stride: rows = (inputSize/stride)² × NUM_ANCHORS_PER_POSITION.
 *
 * Output names in the immich-app/buffalo_l export are numeric strings
 * like "448" / "471" / "494" with no semantic ordering — we rely on
 * shape introspection rather than names.
 */
function partitionDetOutputs(
    feeds: Record<string, ort.Tensor>,
    inputSize: number,
): Array<{
    stride: number
    score: Float32Array
    bbox: Float32Array
    kps: Float32Array
}> {
    type Triple = { score?: ort.Tensor; bbox?: ort.Tensor; kps?: ort.Tensor }
    const levels = new Map<number, Triple>()
    for (const t of Object.values(feeds)) {
        const dims = t.dims
        if (dims.length !== 2) continue
        const rows = dims[0]!
        const cols = dims[1]!
        const cells = rows / NUM_ANCHORS_PER_POSITION
        const side = Math.round(Math.sqrt(cells))
        if (side * side !== cells) continue
        const stride = Math.round(inputSize / side)
        if (![8, 16, 32].includes(stride)) continue
        const slot = levels.get(stride) ?? {}
        if (cols === 1) slot.score = t
        else if (cols === 4) slot.bbox = t
        else if (cols === 10) slot.kps = t
        levels.set(stride, slot)
    }
    const out: Array<{
        stride: number
        score: Float32Array
        bbox: Float32Array
        kps: Float32Array
    }> = []
    for (const stride of [8, 16, 32]) {
        const slot = levels.get(stride)
        if (!slot?.score || !slot.bbox || !slot.kps) {
            throw new Error(`buffalo_l: missing detection outputs for stride ${stride}`)
        }
        out.push({
            stride,
            score: slot.score.data as Float32Array,
            bbox: slot.bbox.data as Float32Array,
            kps: slot.kps.data as Float32Array,
        })
    }
    return out
}

/**
 * Run SCRFD on a base64-encoded image. Returns face detections in the
 * SOURCE-IMAGE pixel space (the letterbox + scale is unwound before
 * returning). The internal `RawFaceDetection` type uses [x1,y1,x2,y2];
 * callers receive the public `FaceBBox` shape with [x,y,w,h].
 */
async function runDetect(imageBase64: string): Promise<{
    faces: FaceBBox[]
    origW: number
    origH: number
    sourceRgb: Buffer
    sourceWidth: number
    sourceHeight: number
}> {
    const eng = await loadEngine()
    const { pixels, scale, padX, padY, origW, origH } = await letterboxToDet(imageBase64)
    const inputData = rgbHwcToScrfdInput(pixels, DET_INPUT_SIZE)
    const inputTensor = new ort.Tensor('float32', inputData, [1, 3, DET_INPUT_SIZE, DET_INPUT_SIZE])
    const feeds: Record<string, ort.Tensor> = { [eng.detInputName]: inputTensor }
    const outputs = await eng.detSession.run(feeds)
    const levels = partitionDetOutputs(outputs, DET_INPUT_SIZE)
    const rawDets: RawFaceDetection[] = []
    for (const lvl of levels) {
        rawDets.push(
            ...decodeStride(lvl.stride, lvl.score, lvl.bbox, lvl.kps, DET_INPUT_SIZE, DET_SCORE_THRESHOLD),
        )
    }
    const kept = nms(rawDets, DET_NMS_IOU)
    // Map letterbox-coords back to source-image coords.
    const faces: FaceBBox[] = kept.map((d) => {
        const [x1, y1, x2, y2] = d.bbox
        const sx1 = Math.max(0, Math.min(origW, (x1 - padX) / scale))
        const sy1 = Math.max(0, Math.min(origH, (y1 - padY) / scale))
        const sx2 = Math.max(0, Math.min(origW, (x2 - padX) / scale))
        const sy2 = Math.max(0, Math.min(origH, (y2 - padY) / scale))
        const lms: Array<[number, number]> = d.landmarks.map((p) => [
            Math.max(0, Math.min(origW, (p[0] - padX) / scale)),
            Math.max(0, Math.min(origH, (p[1] - padY) / scale)),
        ])
        return {
            bbox: [sx1, sy1, Math.max(0, sx2 - sx1), Math.max(0, sy2 - sy1)],
            confidence: d.confidence,
            landmarks: lms,
        }
    })
    // Decode original-resolution RGB once so the alignment step can reuse it.
    const decoded = await sharp(decodeBase64Input(imageBase64))
        .removeAlpha()
        .toColorspace('srgb')
        .raw()
        .toBuffer({ resolveWithObject: true })
    return {
        faces,
        origW,
        origH,
        sourceRgb: decoded.data,
        sourceWidth: decoded.info.width,
        sourceHeight: decoded.info.height,
    }
}

function l2Normalize(arr: Float32Array | number[]): number[] {
    let s = 0
    for (let i = 0; i < arr.length; i++) s += (arr[i] as number) * (arr[i] as number)
    s = Math.sqrt(s) || 1
    const out = new Array<number>(arr.length)
    for (let i = 0; i < arr.length; i++) out[i] = (arr[i] as number) / s
    return out
}

async function embedAligned(
    eng: FacesEngine,
    sourceRgb: Buffer,
    sourceWidth: number,
    sourceHeight: number,
    landmarks: Array<[number, number]>,
): Promise<number[]> {
    const affine = similarityTransform(landmarks, ARC_TEMPLATE)
    const aligned = applyAffineRGB(sourceRgb, sourceWidth, sourceHeight, affine)
    const input = rgbHwcToArcInput(aligned, ARC_INPUT_SIZE)
    const tensor = new ort.Tensor('float32', input, [1, 3, ARC_INPUT_SIZE, ARC_INPUT_SIZE])
    const outputs = await eng.recSession.run({ [eng.recInputName]: tensor })
    const out = outputs[eng.recOutputName]!
    const data = out.data as Float32Array
    if (data.length !== FACE_EMBED_DIM) {
        throw new Error(`ArcFace output dim ${data.length} != expected ${FACE_EMBED_DIM}`)
    }
    return l2Normalize(data)
}

export async function detect(image: string): Promise<{ faces: FaceBBox[]; modelId: string }> {
    const { faces } = await runDetect(image)
    return { faces, modelId: FACES_MODEL_ID }
}

export async function embed(
    image: string,
    bbox?: [number, number, number, number],
): Promise<{ vector: number[]; modelId: string }> {
    // If no bbox is supplied, run detect and pick the largest face — same
    // behaviour InsightFace's `app.get(...)` exposes by default.
    const eng = await loadEngine()
    if (!bbox) {
        const det = await runDetect(image)
        if (det.faces.length === 0) {
            throw new Error('faces.embed: no faces detected')
        }
        const largest = det.faces.reduce((a, b) =>
            a.bbox[2] * a.bbox[3] >= b.bbox[2] * b.bbox[3] ? a : b,
        )
        const v = await embedAligned(
            eng,
            det.sourceRgb,
            det.sourceWidth,
            det.sourceHeight,
            largest.landmarks,
        )
        return { vector: v, modelId: FACES_MODEL_ID }
    }
    // With a caller-supplied bbox we don't have landmarks → fall back to a
    // bbox-centered crop without similarity-transform alignment. Quality is
    // measurably worse but the contract permits it.
    const bytes = decodeBase64Input(image)
    const cropBuf = await sharp(bytes)
        .removeAlpha()
        .extract({
            left: Math.round(bbox[0]),
            top: Math.round(bbox[1]),
            width: Math.round(bbox[2]),
            height: Math.round(bbox[3]),
        })
        .resize(ARC_INPUT_SIZE, ARC_INPUT_SIZE, { fit: 'fill' })
        .raw()
        .toBuffer()
    const input = rgbHwcToArcInput(cropBuf, ARC_INPUT_SIZE)
    const tensor = new ort.Tensor('float32', input, [1, 3, ARC_INPUT_SIZE, ARC_INPUT_SIZE])
    const outputs = await eng.recSession.run({ [eng.recInputName]: tensor })
    const data = outputs[eng.recOutputName]!.data as Float32Array
    return { vector: l2Normalize(data), modelId: FACES_MODEL_ID }
}

/**
 * Combined detect + embed call — the high-throughput path Fonto uses.
 * One image in, an array of `{bbox, confidence, embedding}` out. Detection
 * decode is shared with `detect()`; embedding loops the same source pixels
 * through the canonical alignment transform per face.
 */
export async function detectAndEmbed(
    image: string,
): Promise<{ faces: FaceWithEmbedding[]; modelId: string }> {
    const eng = await loadEngine()
    const det = await runDetect(image)
    const out: FaceWithEmbedding[] = []
    for (const f of det.faces) {
        try {
            const embedding = await embedAligned(
                eng,
                det.sourceRgb,
                det.sourceWidth,
                det.sourceHeight,
                f.landmarks,
            )
            out.push({ ...f, embedding })
        } catch (err) {
            logger.warn({ err, bbox: f.bbox }, 'face alignment/embed failed; dropping face')
        }
    }
    return { faces: out, modelId: FACES_MODEL_ID }
}

export function status(): { detect: 'loaded' | 'loading' | 'pending'; embed: 'loaded' | 'loading' | 'pending' } {
    const s: 'loaded' | 'loading' | 'pending' = engine ? 'loaded' : loadingPromise ? 'loading' : 'pending'
    return { detect: s, embed: s }
}
