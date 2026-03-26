// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * ToolWorker: manages a worker_thread for isolated tool execution.
 * When a tool hangs, worker.terminate() kills just the thread.
 * The agent process is unaffected.
 */

import { Worker } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const TOOL_TIMEOUT_MS = 90_000

type SettleFn = (value: string) => void
type RejectFn = (reason: Error) => void

interface PendingCall {
    resolve: SettleFn
    reject: RejectFn
    timer: ReturnType<typeof setTimeout>
}

interface WorkerResult {
    id: string
    output: string
    error?: string
}

export class ToolWorker {
    private worker: Worker
    private pending = new Map<string, PendingCall>()
    private terminated = false

    constructor(workDir: string) {
        const __dirname = dirname(fileURLToPath(import.meta.url))
        this.worker = new Worker(join(__dirname, 'tool-runner.js'), {
            workerData: { workDir },
        })
        this.worker.on('message', (msg: WorkerResult) => this.settle(msg))
        this.worker.on('error', (err) => {
            // Worker crashed — reject all pending calls
            for (const [id, call] of this.pending) {
                clearTimeout(call.timer)
                call.reject(new Error(`WORKER_CRASH: ${err.message}`))
            }
            this.pending.clear()
        })
        this.worker.on('exit', () => {
            this.terminated = true
        })
    }

    /**
     * Execute a tool in the worker thread with a timeout.
     * Returns the tool output string, or rejects with TOOL_TIMEOUT.
     */
    execute(id: string, tool: string, input: Record<string, unknown>): Promise<string> {
        if (this.terminated) {
            return Promise.reject(new Error('WORKER_TERMINATED'))
        }

        return new Promise<string>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id)
                void this.worker.terminate()
                this.terminated = true
                reject(new Error(`TOOL_TIMEOUT:${tool}`))
            }, TOOL_TIMEOUT_MS)

            this.pending.set(id, { resolve, reject, timer })
            this.worker.postMessage({ id, tool, input })
        })
    }

    private settle(msg: WorkerResult): void {
        const call = this.pending.get(msg.id)
        if (!call) return
        this.pending.delete(msg.id)
        clearTimeout(call.timer)
        call.resolve(msg.output)
    }

    async destroy(): Promise<void> {
        if (!this.terminated) {
            await this.worker.terminate()
            this.terminated = true
        }
    }
}
