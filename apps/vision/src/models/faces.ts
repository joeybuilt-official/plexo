// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Face detection + embedding loaders.
 *
 * Default bundle: InsightFace **buffalo_l** ONNX pack:
 *   - RetinaFace (detect)  — produces bboxes, confidences, 5-point landmarks.
 *   - ArcFace (embed)      — 512-dim L2-normalized embedding per face.
 *
 * Same model bundle Immich's machine-learning service uses, which keeps the
 * vector space comparable across services per ADR 0001.
 *
 * BOOTSTRAP STATUS (Phase 4.1): both loaders fast-fail with "model not
 * configured" until Phase 4.2 wires real SHA-256s. The route surface is
 * complete so apps/api can integrate against it now.
 */

import { childLogger } from '../lib/logger.js'

const logger = childLogger('faces')

export const FACE_EMBED_DIM = 512
export const FACES_MODEL_ID = 'insightface-buffalo_l'

export interface FaceBBox {
    /** [x, y, w, h] in source-image pixel space. */
    bbox: [number, number, number, number]
    /** 0..1 detector confidence. */
    confidence: number
    /** Optional 5-point landmarks [x,y]*5, source-image pixel space. */
    landmarks?: Array<[number, number]>
}

interface FacesEngine {
    detect(image: string): Promise<FaceBBox[]>
    embed(image: string, bbox?: FaceBBox['bbox']): Promise<number[]>
}

let engine: FacesEngine | null = null

function notConfigured(task: 'faces-detect' | 'faces-embed'): never {
    throw new Error(
        `Faces model "${FACES_MODEL_ID}" not configured — Phase 4.1 ships the ` +
            `route surface only. Populate models/faces artifacts and SHA-256s in ` +
            `Phase 4.2 to enable ${task}.`,
    )
}

async function loadEngine(): Promise<FacesEngine> {
    if (engine) return engine
    logger.info({ modelId: FACES_MODEL_ID }, 'Initializing faces engine (stub)')
    engine = {
        async detect(_image) {
            notConfigured('faces-detect')
        },
        async embed(_image, _bbox) {
            notConfigured('faces-embed')
        },
    }
    return engine
}

export async function detect(image: string): Promise<{ faces: FaceBBox[]; modelId: string }> {
    const e = await loadEngine()
    const faces = await e.detect(image)
    return { faces, modelId: FACES_MODEL_ID }
}

export async function embed(
    image: string,
    bbox?: FaceBBox['bbox'],
): Promise<{ vector: number[]; modelId: string }> {
    const e = await loadEngine()
    // Caller contract: if no bbox is provided, the embed engine runs detect
    // internally and picks the largest face. The stub still no-ops via
    // notConfigured(); Phase 4.2 implementations will honour this.
    const vector = await e.embed(image, bbox)
    return { vector, modelId: FACES_MODEL_ID }
}

export function status(): { detect: 'loaded' | 'pending'; embed: 'loaded' | 'pending' } {
    return { detect: engine ? 'loaded' : 'pending', embed: engine ? 'loaded' : 'pending' }
}
