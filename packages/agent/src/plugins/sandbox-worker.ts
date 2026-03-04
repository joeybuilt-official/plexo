/**
 * Plugin sandbox worker
 *
 * Receives a message from the main thread with:
 *   { pluginName, toolName, args, permissions, settings }
 *
 * Runs the tool logic with permission-gated capabilities.
 * Responds with { result } or { error }.
 *
 * Permission enforcement is capability-based at the API surface:
 *   'storage'    — allows reading/writing plugin-scoped key pairs (via messages back to main)
 *   'agent.tools'— tool is registered in the executor (checked at registration, not here)
 *
 * We intentionally do NOT use vm.runInContext here — it's not a security boundary.
 * Real isolation requires a subprocess or Deno worker. This worker_threads approach
 * prevents accidental blocking of the main thread and provides a clean kill path.
 */
import { parentPort, workerData } from 'worker_threads'

interface WorkerInput {
    pluginName: string
    toolName: string
    args: Record<string, unknown>
    permissions: string[]
    settings: Record<string, unknown>
}

async function run() {
    const { pluginName, toolName, args, permissions, settings } = workerData as WorkerInput

    try {
        // Permission check helpers
        const can = (perm: string) => permissions.includes(perm)

        // Placeholder execution — in production this loads the plugin's handler module
        // Plugin handlers would be resolved from packages/plugins/{pluginName}/handler.js
        // For now return structured context that the agent can reason with
        const result = {
            plugin: pluginName,
            tool: toolName,
            status: 'executed',
            permissions: {
                storage: can('storage'),
                agentTools: can('agent.tools'),
                events: can('events'),
            },
            settings: Object.keys(settings),
            args,
            note: 'Plugin executed in worker_threads sandbox. Install a handler package for real execution.',
        }

        parentPort?.postMessage({ ok: true, result })
    } catch (err) {
        parentPort?.postMessage({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
        })
    }
}

void run()
