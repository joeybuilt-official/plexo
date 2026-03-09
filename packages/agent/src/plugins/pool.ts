// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Kapsel sandbox pool
 *
 * Executes extension tool handlers in isolated worker_threads.
 * Implements the Isolation Contract (§5) — one worker per invocation,
 * auto-terminated on timeout or completion.
 *
 * Timeout priority:
 *   1. SandboxInput.timeoutMs (from manifest.resourceHints.maxInvocationMs or tool hints.timeoutMs)
 *   2. DEFAULT_TIMEOUT_MS (10s)
 *
 * The worker receives SandboxInput as workerData and replies with
 * { ok: boolean; result?: unknown; error?: string } via postMessage.
 */
import { Worker } from 'worker_threads'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import pino from 'pino'

const logger = pino({ name: 'kapsel-sandbox' })
const DEFAULT_TIMEOUT_MS = 10_000

const __filename = fileURLToPath(import.meta.url)
const __dir = dirname(__filename)

export interface SandboxInput {
    /** Kapsel scoped extension name e.g. @acme/stripe-monitor */
    pluginName: string
    /** Tool name as declared in kapsel.json tools[] */
    toolName: string
    /** Invocation arguments (validated against parameters schema before reaching here) */
    args: Record<string, unknown>
    /** Capabilities from manifest.capabilities[] — enforced inside worker */
    permissions: string[]
    /** Extension settings (injected as sdk.storage snapshot) */
    settings: Record<string, unknown>
    /** Relative entry point from kapsel.json — resolved by worker */
    entry: string
    /** Workspace context for SDK calls */
    workspaceId?: string
    /** Hard timeout in ms (§5.3) */
    timeoutMs?: number
}

export interface SandboxResult {
    ok: boolean
    result?: unknown
    error?: string
    timedOut?: boolean
    durationMs: number
}

export async function runInSandbox(input: SandboxInput): Promise<SandboxResult> {
    const start = Date.now()
    const timeout = input.timeoutMs ?? DEFAULT_TIMEOUT_MS

    return new Promise((resolve) => {
        const workerPath = join(__dir, 'sandbox-worker.js')

        let worker: Worker
        try {
            worker = new Worker(workerPath, { workerData: input })
        } catch (err) {
            resolve({
                ok: false,
                error: `Failed to spawn worker: ${err instanceof Error ? err.message : String(err)}`,
                durationMs: Date.now() - start,
            })
            return
        }

        const timer = setTimeout(() => {
            void worker.terminate()
            logger.warn({ ext: input.pluginName, tool: input.toolName, timeout }, 'Kapsel worker timed out (§5.4)')
            resolve({
                ok: false,
                error: `Extension tool timed out after ${timeout}ms`,
                timedOut: true,
                durationMs: Date.now() - start,
            })
        }, timeout)

        worker.once('message', (msg: { ok: boolean; result?: unknown; error?: string }) => {
            clearTimeout(timer)
            void worker.terminate()
            resolve({ ...msg, durationMs: Date.now() - start })
        })

        worker.once('error', (err) => {
            clearTimeout(timer)
            logger.error({ err, ext: input.pluginName }, 'Kapsel worker runtime error')
            resolve({
                ok: false,
                error: err.message,
                durationMs: Date.now() - start,
            })
        })
    })
}
