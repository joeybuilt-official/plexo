// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Telemetry stub — exports the `plexo_vision_inference_duration_seconds`
 * histogram and a simple `recordInference()` helper.
 *
 * If `OTEL_EXPORTER_OTLP_ENDPOINT` is set we lazy-load `@opentelemetry/*`
 * and push real OTLP metrics. Without it (the default in dev / CI) we keep
 * an in-process ring buffer that /vision/health and /vision/models can
 * surface for debugging — no OTel deps required to typecheck.
 *
 * The OTel imports are intentionally dynamic so the package doesn't fail
 * to compile or boot when the (optional) OTel packages aren't installed.
 */

import { childLogger } from './logger.js'

const logger = childLogger('telemetry')

export type VisionTask =
    | 'clip-image'
    | 'clip-text'
    | 'faces-detect'
    | 'faces-embed'
    | 'ocr'
    | 'label'

interface InferenceRecord {
    task: VisionTask
    modelId: string
    durationMs: number
    timestamp: number
}

const MAX_BUFFER = 500
const buffer: InferenceRecord[] = []

let otlpRecord: ((r: InferenceRecord) => void) | null = null

if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
    initOtel().catch((err) => {
        logger.warn({ err }, 'OTel init failed — falling back to in-memory metrics only')
    })
}

async function initOtel(): Promise<void> {
    // Soft import — only resolves at runtime when the operator opted in.
    try {
        // Indirect specifier defeats TypeScript's module resolution so the
        // optional `@opentelemetry/api` dep doesn't need to be in
        // package.json. Resolved at runtime; absence is fine.
        const otelSpec = '@opentelemetry/api'
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const api: any = await import(/* @vite-ignore */ otelSpec).catch(() => null)
        if (!api) {
            logger.info('@opentelemetry/api not installed; OTel disabled')
            return
        }
        const meter = api.metrics.getMeter('plexo-vision', '0.1.0')
        const histogram = meter.createHistogram('plexo_vision_inference_duration_seconds', {
            description: 'Inference duration in seconds for vision tasks',
            unit: 's',
        })
        otlpRecord = (r) => {
            histogram.record(r.durationMs / 1000, { task: r.task, model_id: r.modelId })
        }
        logger.info({ endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT }, 'OTel histogram registered')
    } catch (err) {
        logger.warn({ err }, 'OTel histogram registration failed')
    }
}

export function recordInference(
    task: VisionTask,
    modelId: string,
    durationMs: number,
): void {
    const rec: InferenceRecord = { task, modelId, durationMs, timestamp: Date.now() }
    if (buffer.length >= MAX_BUFFER) buffer.shift()
    buffer.push(rec)
    if (otlpRecord) otlpRecord(rec)
}

export interface TaskMetrics {
    count: number
    avgMs: number
    p50Ms: number
    p95Ms: number
    p99Ms: number
}

export function summarize(): Record<VisionTask, TaskMetrics> {
    const tasks: VisionTask[] = ['clip-image', 'clip-text', 'faces-detect', 'faces-embed', 'ocr', 'label']
    const out = {} as Record<VisionTask, TaskMetrics>
    for (const task of tasks) {
        const durations = buffer
            .filter((r) => r.task === task)
            .map((r) => r.durationMs)
            .sort((a, b) => a - b)
        const count = durations.length
        if (count === 0) {
            out[task] = { count: 0, avgMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0 }
            continue
        }
        const sum = durations.reduce((a, b) => a + b, 0)
        const pct = (p: number): number => {
            const idx = Math.min(count - 1, Math.max(0, Math.ceil((count * p) / 100) - 1))
            return durations[idx] ?? 0
        }
        out[task] = {
            count,
            avgMs: sum / count,
            p50Ms: pct(50),
            p95Ms: pct(95),
            p99Ms: pct(99),
        }
    }
    return out
}

/** Convenience wrapper — measures a callback and records the duration. */
export async function measure<T>(
    task: VisionTask,
    modelId: string,
    fn: () => Promise<T>,
): Promise<T> {
    const start = performance.now()
    try {
        return await fn()
    } finally {
        recordInference(task, modelId, performance.now() - start)
    }
}
