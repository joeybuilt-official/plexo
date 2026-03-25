// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Fabric Persistent Sandbox Worker (§5.4) — v2 with host bridge
 *
 * Long-lived worker that stays alive and services multiple tool invocations.
 * SDK capabilities (storage, memory, connections, events) are delegated back
 * to the host process via a message-based bridge.
 *
 * Bridge protocol (worker → host → worker):
 *   Worker: { type: 'sdk_call', callId: uuid, method: string, args: object }
 *   Host:   { type: 'bridge_reply', callId: uuid, result?: any, error?: string }
 *
 * Main protocol:
 *   Host → Worker { type: 'activate', callId, input }
 *   Host → Worker { type: 'invoke', callId, toolName, args, workspaceId }
 *   Host → Worker { type: 'terminate' }
 *   Worker → Host { type: 'activated', callId, tools, schedules, widgets }
 *   Worker → Host { type: 'result', callId, result }
 *   Worker → Host { type: 'error', callId, error }
 */
import { parentPort, workerData } from 'worker_threads'
import { randomUUID } from 'node:crypto'
import { createActivationSDK } from './activation-sdk.js'
import type { HostBridge } from './activation-sdk.js'
import type { SandboxInput } from './pool.js'
import type { ToolRegistration } from '@plexo/sdk'

interface ActivateMsg { type: 'activate'; callId: string; input: SandboxInput }
interface InvokeMsg { type: 'invoke'; callId: string; toolName: string; args: Record<string, unknown>; workspaceId: string }
interface BridgeReply { type: 'bridge_reply'; callId: string; result?: unknown; error?: string }
interface TerminateMsg { type: 'terminate' }
type HostMsg = ActivateMsg | InvokeMsg | BridgeReply | TerminateMsg

// ── Pending bridge calls — awaiting host reply ────────────────────────────────

const _bridgePending = new Map<string, { resolve: (r: unknown) => void; reject: (e: Error) => void }>()

/** Create a host bridge that sends sdk_call messages and awaits bridge_reply */
function makeMessageBridge(): HostBridge {
    return async (method, args) => {
        if (!parentPort) throw new Error('No parentPort — bridge unavailable')
        const callId = randomUUID()
        return new Promise((resolve, reject) => {
            _bridgePending.set(callId, { resolve, reject })
            parentPort!.postMessage({ type: 'sdk_call', callId, method, args })
        })
    }
}

// ── Worker state ──────────────────────────────────────────────────────────────

let _registeredTools: ToolRegistration[] = []
let _input: SandboxInput | null = null

function reply(msg: Record<string, unknown>) {
    parentPort?.postMessage(msg)
}

// ── Handlers ──────────────────────────────────────────────────────────────────

async function handleActivate(msg: ActivateMsg): Promise<void> {
    _input = msg.input

    try {
        const extModule = await import(msg.input.entry) as {
            activate?: (sdk: unknown) => Promise<void>
            [key: string]: unknown
        }

        if (typeof extModule.activate !== 'function') {
            reply({ type: 'error', callId: msg.callId, error: `Extension "${msg.input.pluginName}" does not export activate()` })
            return
        }

        const { sdk, getResult } = createActivationSDK(
            msg.input.pluginName,
            msg.input.permissions,
            msg.input.settings,
            msg.input.workspaceId ?? 'sandbox',
            makeMessageBridge(),
        )

        await extModule.activate(sdk)
        const { tools, schedules, widgets } = getResult()
        _registeredTools = tools

        reply({
            type: 'activated',
            callId: msg.callId,
            tools: tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters, hints: t.hints })),
            schedules: schedules.map((s) => ({ name: s.name, schedule: s.schedule })),
            widgets: widgets.map((w) => ({ name: w.name, displayName: w.displayName, displayType: w.displayType })),
        })
    } catch (err) {
        reply({ type: 'error', callId: msg.callId, error: err instanceof Error ? err.message : String(err) })
    }
}

async function handleInvoke(msg: InvokeMsg): Promise<void> {
    const toolDef = _registeredTools.find((t) => t.name === msg.toolName)
    if (!toolDef) {
        reply({ type: 'error', callId: msg.callId, error: `Tool "${msg.toolName}" not registered in "${_input?.pluginName}"` })
        return
    }

    try {
        const result = await toolDef.handler(msg.args, {
            workspaceId: msg.workspaceId,
            requestId: randomUUID(),
        })
        reply({ type: 'result', callId: msg.callId, result })
    } catch (err) {
        reply({ type: 'error', callId: msg.callId, error: err instanceof Error ? err.message : String(err) })
    }
}

function handleBridgeReply(msg: BridgeReply): void {
    const pending = _bridgePending.get(msg.callId)
    if (!pending) return
    _bridgePending.delete(msg.callId)
    if (msg.error) {
        pending.reject(new Error(msg.error))
    } else {
        pending.resolve(msg.result)
    }
}

// ── Main message loop ─────────────────────────────────────────────────────────

if (parentPort) {
    parentPort.on('message', (msg: HostMsg) => {
        if (msg.type === 'activate') {
            void handleActivate(msg)
        } else if (msg.type === 'invoke') {
            void handleInvoke(msg)
        } else if (msg.type === 'bridge_reply') {
            handleBridgeReply(msg)
        } else if (msg.type === 'terminate') {
            process.exit(0)
        }
    })
} else if (workerData) {
    // Fallback: ephemeral mode (backward compat with pool.ts callers)
    void (async () => {
        const { parentPort: port } = await import('worker_threads')
        const input = workerData as SandboxInput
        // Ephemeral mode has no host bridge — nullBridge throws on capability calls
        const { sdk, getResult } = createActivationSDK(input.pluginName, input.permissions, input.settings, input.workspaceId ?? 'sandbox')
        const extModule = await import(input.entry) as { activate?: (sdk: unknown) => Promise<void>;[key: string]: unknown }
        if (typeof extModule.activate === 'function') await extModule.activate(sdk)
        const { tools } = getResult()
        if (input.toolName === '__activate__') {
            port?.postMessage({ ok: true, result: { registeredTools: tools } })
        } else {
            const toolDef = tools.find((t) => t.name === input.toolName)
            if (toolDef) {
                const result = await toolDef.handler(input.args, { workspaceId: input.workspaceId ?? 'sandbox', requestId: randomUUID() })
                port?.postMessage({ ok: true, result })
            } else {
                port?.postMessage({ ok: false, error: `Tool "${input.toolName}" not found` })
            }
        }
    })()
}
