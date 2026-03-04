/**
 * Plugin sandbox pool
 *
 * Wraps worker_threads execution with a timeout and structured error handling.
 * Each tool call gets a fresh worker (no pool re-use yet — Phase 14 target).
 * Workers are killed after TIMEOUT_MS regardless of state.
 */
import { Worker } from 'worker_threads'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import pino from 'pino'

const logger = pino({ name: 'plugin-sandbox' })
const TIMEOUT_MS = 10_000 // 10s max per plugin tool call

const __filename = fileURLToPath(import.meta.url)
const __dir = dirname(__filename)

export interface SandboxInput {
    pluginName: string
    toolName: string
    args: Record<string, unknown>
    permissions: string[]
    settings: Record<string, unknown>
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

    return new Promise((resolve) => {
        // Worker script path — compiled to dist/plugins/sandbox-worker.js
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
            logger.warn({ plugin: input.pluginName, tool: input.toolName }, 'Plugin worker timed out')
            resolve({
                ok: false,
                error: `Plugin tool timed out after ${TIMEOUT_MS}ms`,
                timedOut: true,
                durationMs: Date.now() - start,
            })
        }, TIMEOUT_MS)

        worker.once('message', (msg: { ok: boolean; result?: unknown; error?: string }) => {
            clearTimeout(timer)
            void worker.terminate()
            resolve({ ...msg, durationMs: Date.now() - start })
        })

        worker.once('error', (err) => {
            clearTimeout(timer)
            logger.error({ err, plugin: input.pluginName }, 'Plugin worker error')
            resolve({
                ok: false,
                error: err.message,
                durationMs: Date.now() - start,
            })
        })
    })
}
