// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * PEX Persistent Sandbox Worker (§5.4) — v2 with host bridge
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
import { createContext, Script } from 'node:vm'
import { readFileSync } from 'node:fs'
import { createActivationSDK } from './activation-sdk.js'
import type { HostBridge } from './activation-sdk.js'
import type { SandboxInput } from './pool.js'
import type { ToolRegistration } from '@joeybuilt/plexo-sdk'

// Phase P (ADR 0011 — Option B). isolated-vm is a native addon; it may fail
// to load on dev machines without the build toolchain. Loaded eagerly so any
// load failure surfaces at worker activation rather than mid-tool-call.
let _ivm: typeof import('isolated-vm') | null = null
try {
    const mod = await import('isolated-vm') as typeof import('isolated-vm') & { default?: typeof import('isolated-vm') }
    _ivm = mod.default ?? mod
} catch {
    _ivm = null
}

interface ActivateMsg { type: 'activate'; callId: string; input: SandboxInput }
interface InvokeMsg { type: 'invoke'; callId: string; toolName: string; args: Record<string, unknown>; workspaceId: string }
interface BridgeReply { type: 'bridge_reply'; callId: string; result?: unknown; error?: string }
interface TerminateMsg { type: 'terminate' }
interface EventDispatchMsg { type: 'event_dispatch'; topic: string; payload: unknown }
type HostMsg = ActivateMsg | InvokeMsg | BridgeReply | TerminateMsg | EventDispatchMsg

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
const _eventHandlers = new Map<string, (payload: unknown) => void>()

function reply(msg: Record<string, unknown>) {
    parentPort?.postMessage(msg)
}

// ── Handlers ──────────────────────────────────────────────────────────────────

/**
 * SEC-017: Load extension in a restricted sandbox.
 *
 * Phase P (ADR 0011 Option B): when `isolated-vm` is available AND
 * `PLEXO_USE_ISOLATED_VM` is not explicitly disabled, run synthesizer-generated
 * extension code inside a real V8 isolate. This closes the historical
 * `this.constructor.constructor('return process')()` escape that vm.createContext
 * leaves open. Cold-start adds ~10-60ms vs the legacy path.
 *
 * Fallback path: vm.createContext (legacy). Used when:
 *   - `isolated-vm` failed to load (missing native addon — dev machine without build toolchain)
 *   - PLEXO_USE_ISOLATED_VM=false explicitly set
 *   - The extension uses ESM `import` statements that can't be statically rewritten
 *     into `__exports.X = ...` form (we still fall through to `await import()`).
 *
 * Bundled (`extensions/core/*`) extensions go through `await import()` regardless —
 * they are trusted-as-code-review and may legitimately use Node builtins. Only
 * synthesizer-generated extensions hit the sandbox.
 */
function isolatedVMEnabled(): boolean {
    if (_ivm === null) return false
    const v = (process.env.PLEXO_USE_ISOLATED_VM ?? '').toLowerCase()
    if (v === 'false' || v === '0' || v === 'no') return false
    return true
}

async function loadExtensionViaIsolatedVM(
    entry: string,
    sdk: unknown,
): Promise<{ activate?: (sdk: unknown) => Promise<void> }> {
    if (!_ivm) throw new Error('isolated-vm not available')
    const code = readFileSync(entry, 'utf-8')

    // Same ESM → __exports rewrite as the legacy path.
    const wrappedCode = code
        .replace(/^export\s+async\s+function\s+(\w+)/gm, '__exports.$1 = async function $1')
        .replace(/^export\s+function\s+(\w+)/gm, '__exports.$1 = function $1')
        .replace(/^export\s+const\s+(\w+)\s*=/gm, '__exports.$1 =')
        .replace(/^export\s+let\s+(\w+)\s*=/gm, '__exports.$1 =')
        .replace(/^export\s+default\s+/gm, '__exports.default = ')

    const isolate = new _ivm.Isolate({ memoryLimit: 256 })
    const context = await isolate.createContext()
    const jail = context.global

    // Mirror the curated globals from the legacy path. `setSync('foo', ...)`
    // copies primitives by value; functions need to be wrapped as references
    // so they can be called from inside the isolate.
    await jail.set('global', jail.derefInto())
    await jail.set('__exports', new _ivm.ExternalCopy({} as Record<string, unknown>).copyInto())

    // Synthesizer-generated code is constrained by AST validation upstream
    // (synthesizer.ts CAPABILITY_DENYLIST). It typically uses sdk.* + console
    // + JSON / Math / Date — all already in the V8 isolate's global by default.
    // We don't expose `fetch` directly here; if a future synthesizer manifest
    // requires fetch, add a host-bridged async function via Reference.

    // SDK access goes through the host bridge by closure capture; the
    // activate(sdk) callsite is invoked OUTSIDE the isolate, with sdk being
    // the host-side object. The isolate-side __exports.activate function
    // gets called from outside-the-isolate via Reference.

    const script = await isolate.compileScript(wrappedCode, { filename: entry })
    await script.run(context, { timeout: 5000 })

    // Extract __exports back across the boundary as a Reference.
    const exportsRef = await jail.get('__exports', { reference: true })

    // Wrap exports.activate so the host can call it from outside the isolate.
    return {
        activate: async (hostSdk: unknown) => {
            const activateRef = await exportsRef.get('activate', { reference: true })
            if (typeof activateRef === 'undefined') return
            // Pass the SDK as an external-copy of a host-bridge proxy. The
            // synthesizer-generated extension calls sdk.X() which the bridge
            // forwards back to the host. Simplest path: copy the SDK shape
            // into the isolate as a plain object whose methods are References.
            // For MVP, we evaluate the activate function in the isolate
            // context with a host-side proxy passed in via ExternalCopy.
            await activateRef.apply(undefined, [new _ivm!.ExternalCopy(hostSdk).copyInto()], { timeout: 30_000 })
        },
    }
}

async function loadExtensionInSandbox(
    entry: string,
    sdk: unknown,
): Promise<{ activate?: (sdk: unknown) => Promise<void> }> {
    // Phase P: prefer isolated-vm for synthesizer-generated extensions.
    if (isolatedVMEnabled()) {
        try {
            return await loadExtensionViaIsolatedVM(entry, sdk)
        } catch {
            // Fall through to legacy vm.createContext, then to import().
        }
    }
    // Legacy path — vm.createContext sandbox.
    try {
        const code = readFileSync(entry, 'utf-8')

        // Create restricted context — no Node.js builtins exposed
        const sandbox = createContext({
            console: Object.freeze({
                log: console.log.bind(console),
                warn: console.warn.bind(console),
                error: console.error.bind(console),
                info: console.info.bind(console),
                debug: () => {},
            }),
            setTimeout,
            clearTimeout,
            setInterval,
            clearInterval,
            fetch: globalThis.fetch,
            URL: globalThis.URL,
            URLSearchParams: globalThis.URLSearchParams,
            TextEncoder: globalThis.TextEncoder,
            TextDecoder: globalThis.TextDecoder,
            AbortController: globalThis.AbortController,
            AbortSignal: globalThis.AbortSignal,
            JSON,
            Math,
            Date,
            Promise,
            Map,
            Set,
            WeakMap,
            WeakSet,
            Array,
            Object,
            String,
            Number,
            Boolean,
            RegExp,
            Error,
            TypeError,
            RangeError,
            // Module-like exports object for the extension to populate
            __exports: {} as Record<string, unknown>,
        })

        // Wrap code to capture exports — ESM `export` becomes assignment
        const wrappedCode = code
            .replace(/^export\s+async\s+function\s+(\w+)/gm, '__exports.$1 = async function $1')
            .replace(/^export\s+function\s+(\w+)/gm, '__exports.$1 = function $1')
            .replace(/^export\s+const\s+(\w+)\s*=/gm, '__exports.$1 =')
            .replace(/^export\s+let\s+(\w+)\s*=/gm, '__exports.$1 =')
            .replace(/^export\s+default\s+/gm, '__exports.default = ')

        const script = new Script(wrappedCode, { filename: entry })
        script.runInContext(sandbox, { timeout: 5000 }) // 5s execution timeout

        return sandbox.__exports as { activate?: (sdk: unknown) => Promise<void> }
    } catch {
        // Fallback to import() for npm-installed / non-generated extensions
        return await import(entry) as { activate?: (sdk: unknown) => Promise<void> }
    }
}

async function handleActivate(msg: ActivateMsg): Promise<void> {
    _input = msg.input

    try {
        const { sdk, getResult } = createActivationSDK(
            msg.input.pluginName,
            msg.input.permissions,
            msg.input.settings,
            msg.input.workspaceId ?? 'sandbox',
            makeMessageBridge(),
            (topic, handler) => { _eventHandlers.set(topic, handler) },
        )

        const extModule = await loadExtensionInSandbox(msg.input.entry, sdk)

        if (typeof extModule.activate !== 'function') {
            reply({ type: 'error', callId: msg.callId, error: `Tool "${msg.input.pluginName}" does not export activate()` })
            return
        }

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
        const requestId = randomUUID()
        const result = await toolDef.handler(msg.args, {
            workspaceId: msg.workspaceId,
            requestId,
            tenantId: 'default',
            userId: 'system',
            traceId: requestId,
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

function handleEventDispatch(msg: EventDispatchMsg): void {
    const handler = _eventHandlers.get(msg.topic)
    if (handler) {
        try { handler(msg.payload) } catch { /* handlers must not crash the worker */ }
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
        } else if (msg.type === 'event_dispatch') {
            handleEventDispatch(msg as EventDispatchMsg)
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
        const extModule = await loadExtensionInSandbox(input.entry, sdk)
        if (typeof extModule.activate === 'function') await extModule.activate(sdk)
        const { tools } = getResult()
        if (input.toolName === '__activate__') {
            port?.postMessage({ ok: true, result: { registeredTools: tools } })
        } else {
            const toolDef = tools.find((t) => t.name === input.toolName)
            if (toolDef) {
                const ephRequestId = randomUUID()
                const result = await toolDef.handler(input.args, {
                    workspaceId: input.workspaceId ?? 'sandbox',
                    requestId: ephRequestId,
                    tenantId: 'default',
                    userId: 'system',
                    traceId: ephRequestId,
                })
                port?.postMessage({ ok: true, result })
            } else {
                port?.postMessage({ ok: false, error: `Tool "${input.toolName}" not found` })
            }
        }
    })()
}
