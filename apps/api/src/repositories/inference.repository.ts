// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Inference-proxy data-access repository (write-only).
 *
 * owns the per-app inference_logs attribution write. The
 * route keeps sampling, rounding, and fire-and-forget error swallowing.
 */
import { sql } from 'drizzle-orm'
import { db } from '@plexo/db'

/** Attribution-only inference log row (app_id set, never trips the ceiling). */
export async function insertAppInferenceLog(args: {
    workspaceId: string
    appId: string
    model: string
    provider: string
    inputTokens: number
    outputTokens: number
    latencyMs: number
    taskType: string
    success: boolean
}): Promise<void> {
    await db.execute(sql`
        INSERT INTO inference_logs
            (instance_uuid, workspace_id, model, provider, input_tokens, output_tokens, latency_ms, task_type, app_id, success)
        VALUES (
            ${process.env.PLEXO_INSTANCE_ID ?? 'unknown'},
            ${args.workspaceId}::uuid,
            ${args.model}, ${args.provider},
            ${Math.round(args.inputTokens)}, ${Math.round(args.outputTokens)}, ${Math.round(args.latencyMs)},
            ${args.taskType}, ${args.appId}, ${args.success}
        )
    `)
}
