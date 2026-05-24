// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * OCR loader — RapidOCR (PP-OCRv5) ONNX pipeline.
 *
 * Three-stage pipeline matching the upstream RapidOCR Node bindings:
 *   - det: text-region detection (rapidocr_det.onnx)
 *   - cls: orientation classifier (rapidocr_cls.onnx)
 *   - rec: text recognizer (rapidocr_rec.onnx) — language selected via the
 *     dictionary file (latin / cyrillic / chinese / japanese / korean / arabic).
 *
 * BOOTSTRAP STATUS (Phase 4.1): the loader fast-fails with "model not
 * configured". Phase 4.2 will wire real artifacts.
 */

import { childLogger } from '../lib/logger.js'

const logger = childLogger('ocr')

export const OCR_MODEL_ID = 'rapidocr-ppocrv5'

export interface OcrLine {
    text: string
    /** [x, y, w, h] in source-image pixel space. */
    bbox: [number, number, number, number]
    /** 0..1 recognizer confidence. */
    confidence: number
}

interface OcrEngine {
    recognize(image: string, lang: string): Promise<OcrLine[]>
}

let engine: OcrEngine | null = null

function notConfigured(): never {
    throw new Error(
        `OCR model "${OCR_MODEL_ID}" not configured — Phase 4.1 ships the route ` +
            `surface only. Populate models/ocr artifacts and SHA-256s in Phase 4.2 ` +
            `to enable OCR.`,
    )
}

async function loadEngine(): Promise<OcrEngine> {
    if (engine) return engine
    logger.info({ modelId: OCR_MODEL_ID }, 'Initializing OCR engine (stub)')
    engine = {
        async recognize(_image, _lang) {
            notConfigured()
        },
    }
    return engine
}

export async function recognize(
    image: string,
    lang = 'en',
): Promise<{ lines: OcrLine[]; modelId: string }> {
    const e = await loadEngine()
    const lines = await e.recognize(image, lang)
    return { lines, modelId: OCR_MODEL_ID }
}

export function status(): { ocr: 'loaded' | 'pending' } {
    return { ocr: engine ? 'loaded' : 'pending' }
}
