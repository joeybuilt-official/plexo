// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

import { PlexoApiError, PlexoAuthError, PlexoProtocolError, PlexoRateLimitedError, PlexoUnreachableError } from './errors.js'
import { createInboundRouter } from './inbound.js'
import { register } from './registration.js'
import { PEX_CONTRACT_VERSION, isContractCompatible } from '../contract.js'
import type {
    AiCompleteOptions,
    AnalyzeImageOptions,
    AnalyzeImageResult,
    AppProfile,
    ChatOptions,
    ChatReply,
    ConnectOptions,
    ConnectProfile,
    DispatchContext,
    DispatchOptions,
    DispatchResult,
    GmessagesListThreadsOptions,
    GmessagesSendOptions,
    GmessagesSendResult,
    GmessagesThread,
    InboundHandlers,
    InstallConnectionOptions,
    LocalInstanceDescriptor,
    MemorySearchResult,
    NegotiatedSession,
    OcrResult,
    PlexoClientOptions,
    PlexoConnection,
    PlexoConversation,
    PlexoTask,
    PlexoToken,
    PlexoTokenWithConnection,
    PublishEventOptions,
    RunCustomOptions,
    RunCustomResult,
    StoreMemoryOptions,
    TestConnectionResult,
} from './types.js'

export class PlexoClient {
    readonly #opts: PlexoClientOptions
    // Mutable: connect()'s resolution ladder may attach to a reused/launched
    // local instance whose URL differs from the configured one.
    #base: string
    // The last negotiated session (null until connect() succeeds). autoReconnect
    // only engages once this is set — a plain remote client that never calls
    // connect() keeps the exact pre-Phase-4e behavior.
    #session: NegotiatedSession | null = null
    // Args of the most recent connect(), replayed by reconnect().
    #lastConnectOpts: ConnectOptions = {}

    /** Agent-loop operations. EP1: caller-provided systemPrompt + tools via HTTP callback. */
    readonly agents: {
        runCustom: (workspaceId: string, opts: RunCustomOptions) => Promise<RunCustomResult>
    }

    constructor(opts: PlexoClientOptions) {
        this.#opts = opts
        this.#base = opts.plexoUrl.replace(/\/$/, '')
        this.agents = {
            runCustom: (workspaceId, runOpts) =>
                this.#post<RunCustomResult>(
                    '/api/v1/agents/run-custom',
                    { workspaceId, ...runOpts },
                    {},
                    120_000,
                ),
        }
    }

    get appId(): string { return this.#opts.appId }

    get isConfigured(): boolean {
        return !!(this.#opts.plexoUrl && this.#opts.serviceKey)
    }

    // -----------------------------------------------------------------------
    // Registration
    // -----------------------------------------------------------------------

    async register(): Promise<void> {
        if (!this.isConfigured) return

        let domain = ''
        try { domain = new URL(this.#opts.plexoUrl).host } catch {}

        const profile: AppProfile = {
            appId: this.#opts.appId,
            schemaNamespace: this.#opts.schemaNamespace ?? this.#opts.appId,
            displayName: this.#opts.displayName ?? this.#opts.appId,
            domain,
            extensions: this.#opts.extensions ?? [],
            eventContracts: this.#opts.eventContracts ?? [],
        }
        await register(this.#opts, profile)
    }

    // -----------------------------------------------------------------------
    // Connection & Profile Standard (ADR 0001) — connect() handshake
    // -----------------------------------------------------------------------

    /**
     * Run the resolution ladder (configured → reuse-running → launch-local),
     * then handshake with the server: negotiate a common contract MAJOR and (when
     * a workspaceId is given) the effective profile. Returns the NegotiatedSession.
     *
     * Throws PlexoUnreachableError when no instance can be resolved, and
     * PlexoProtocolError when the server's contract major is incompatible.
     */
    async connect(opts: ConnectOptions = {}): Promise<NegotiatedSession> {
        this.#lastConnectOpts = opts
        return this.#handshake(opts)
    }

    /**
     * Re-establish a long-lived connection after the attached instance restarted
     * (ADR 0001 §1 + Phase 4e). Re-runs the resolution ladder + version/profile
     * handshake using the last connect() args, then re-runs register() so a
     * restarted local instance re-learns this app's toolset. Returns the fresh
     * NegotiatedSession. Throws if no instance can be resolved (PlexoUnreachableError)
     * or the server major is now incompatible (PlexoProtocolError).
     *
     * Safe to call explicitly from a host that detects a restart; also invoked
     * automatically (once, then retry) when `autoReconnect` is enabled.
     */
    async reconnect(): Promise<NegotiatedSession> {
        const session = await this.#handshake(this.#lastConnectOpts)
        // Re-register the app profile/toolset on the (possibly restarted) instance.
        // Best-effort: a registration hiccup must not mask a recovered data path.
        try { await this.register() } catch { /* non-fatal — handshake already succeeded */ }
        return session
    }

    /**
     * Shared connect/reconnect core: resolve the base, POST the handshake (via the
     * RAW layer so a reconnect-triggered handshake can never recurse), verify the
     * contract major, and cache the session. Does NOT register() — connect()
     * leaves registration to the caller; reconnect() adds it.
     */
    async #handshake(opts: ConnectOptions): Promise<NegotiatedSession> {
        const via = await this.#resolveBase()
        const clientVersion = this.#opts.contractVersion ?? PEX_CONTRACT_VERSION
        const requestedProfile = opts.requestedProfile ?? this.#opts.requestedProfile

        const resp = await this.#raw<{
            serverContractVersion: string
            status?: NegotiatedSession['status']
            effectiveProfile?: ConnectProfile
        }>(
            'POST',
            '/api/v1/profiles/connect',
            {
                body: { contractVersion: clientVersion, workspaceId: opts.workspaceId, requestedProfile },
                extra: opts.workspaceId ? { workspaceId: opts.workspaceId } : {},
            },
        )

        if (!isContractCompatible(clientVersion, resp.serverContractVersion)) {
            throw new PlexoProtocolError(clientVersion, resp.serverContractVersion)
        }

        const session: NegotiatedSession = {
            url: this.#base,
            via,
            serverContractVersion: resp.serverContractVersion,
            status: resp.status ?? 'unscoped',
            effectiveProfile: resp.effectiveProfile ?? { connectors: [], capabilities: [] },
        }
        this.#session = session
        return session
    }

    /**
     * Negotiate (or re-negotiate) the effective profile for a specific workspace
     * (ADR 0001 §3). When no operator grant exists yet, the request is captured
     * as a pending proposal and an empty profile is returned (default-deny).
     */
    async negotiateProfile(workspaceId: string, requestedProfile?: ConnectProfile): Promise<{
        status: 'granted' | 'pending' | 'revoked'
        effectiveProfile: ConnectProfile
    }> {
        const data = await this.#post<{
            status: 'granted' | 'pending' | 'revoked'
            effectiveProfile: ConnectProfile
        }>(
            '/api/v1/profiles/negotiate',
            { workspaceId, requestedProfile: requestedProfile ?? this.#opts.requestedProfile },
            { workspaceId },
        )
        return data
    }

    /**
     * Resolution ladder (ADR 0001 §1). Sets #base and returns which rung resolved.
     *   1. configured  — plexoUrl + serviceKey present → use it.
     *   2. reuse-running — read the local instance descriptor lockfile, health-check, attach.
     *   3. launch-local — call the opts.launchLocal seam, health-check, attach.
     * Fails loud (PlexoUnreachableError) when none resolve.
     */
    async #resolveBase(): Promise<NegotiatedSession['via']> {
        if (this.#opts.plexoUrl && this.#opts.serviceKey) {
            this.#base = this.#opts.plexoUrl.replace(/\/$/, '')
            return 'configured'
        }

        // rung 2 — reuse a running local instance via its descriptor lockfile
        const descriptor = await this.#readInstanceDescriptor()
        if (descriptor?.url && await this.#healthy(descriptor.url)) {
            this.#base = descriptor.url.replace(/\/$/, '')
            return 'reuse-running'
        }

        // rung 3 — launch-local seam (host-provided; single-writer guard is the
        // launcher's responsibility, ADR 0001 §1 + pre-mortem #1)
        if (this.#opts.launchLocal) {
            const url = await this.#opts.launchLocal()
            if (url && await this.#healthy(url)) {
                this.#base = url.replace(/\/$/, '')
                return 'launch-local'
            }
            throw new PlexoUnreachableError(url || '(launch-local)')
        }

        throw new PlexoUnreachableError(this.#base || '(unresolved)')
    }

    async #healthy(url: string): Promise<boolean> {
        const fetchImpl = this.#opts.fetchImpl ?? fetch
        try {
            const res = await fetchImpl(`${url.replace(/\/$/, '')}/api/v1/health`, { signal: AbortSignal.timeout(5_000) })
            return res.ok
        } catch {
            return false
        }
    }

    /** Read the rung-2 local instance descriptor lockfile, if present. Node-only. */
    async #readInstanceDescriptor(): Promise<LocalInstanceDescriptor | null> {
        try {
            const { readFile } = await import('node:fs/promises')
            const path = this.#opts.instanceDescriptorPath
                ?? `${process.env.XDG_RUNTIME_DIR ?? '/tmp'}/plexo/instance.json`
            const raw = await readFile(path, 'utf8')
            const d = JSON.parse(raw) as LocalInstanceDescriptor
            return d?.url ? d : null
        } catch {
            return null
        }
    }

    // -----------------------------------------------------------------------
    // Workspace
    // -----------------------------------------------------------------------

    async ensureWorkspace(userId: string, email?: string): Promise<string> {
        const data = await this.#post<{ workspaceId: string }>(
            '/api/v1/auth/workspace/ensure',
            { userId, email, name: this.#opts.displayName ?? this.#opts.appId },
            { userId },
        )
        return data.workspaceId
    }

    /**
     * Idempotent get-or-create + auto-install of this app's connection.
     * Used when an app needs Plexo to know about a user without going
     * through the workspace-ensure → install dance separately.
     */
    async autoAttachUser(userId: string, email?: string): Promise<{ workspaceId: string }> {
        return await this.#post<{ workspaceId: string }>(
            '/api/v1/auth/profiles/auto-attach-user',
            { userId, email, name: this.#opts.displayName ?? this.#opts.appId },
            { userId },
        )
    }

    // -----------------------------------------------------------------------
    // Connections
    // -----------------------------------------------------------------------

    async getInstalledConnections(workspaceId: string): Promise<PlexoConnection[]> {
        try {
            const data = await this.#get<{ items?: PlexoConnection[] }>(
                `/api/v1/connections/installed?workspaceId=${encodeURIComponent(workspaceId)}`,
            )
            return data.items ?? []
        } catch {
            return []
        }
    }

    async getToken(workspaceId: string, registryId: string): Promise<PlexoToken | null> {
        try {
            return await this.#get<PlexoToken>(
                `/api/v1/connections/token?workspaceId=${encodeURIComponent(workspaceId)}&registryId=${encodeURIComponent(registryId)}`,
            )
        } catch (err) {
            if (err instanceof PlexoApiError && err.status === 404) return null
            throw err
        }
    }

    async disconnect(workspaceId: string, connectionId: string): Promise<void> {
        await this.#delete(
            `/api/v1/connections/installed/${encodeURIComponent(connectionId)}?workspaceId=${encodeURIComponent(workspaceId)}`,
        )
    }

    /**
     * Idempotent install. Returns true if already present or newly installed,
     * false on error. Empty `credentials` are valid for app-owned bridges.
     */
    async installConnection(opts: InstallConnectionOptions): Promise<boolean> {
        try {
            const existing = await this.getInstalledConnections(opts.workspaceId)
            if (existing.some((c) => c.registryId === opts.registryId)) return true
            await this.#post('/api/v1/connections/install', opts)
            return true
        } catch {
            return false
        }
    }

    /**
     * Multi-token fetch for a registry (e.g. multi-account Google Workspace).
     * Falls back to per-connection getToken() if the bulk endpoint 404s.
     */
    async getTokens(workspaceId: string, registryId: string): Promise<PlexoTokenWithConnection[]> {
        try {
            const data = await this.#get<PlexoTokenWithConnection[]>(
                `/api/v1/connections/tokens?workspaceId=${encodeURIComponent(workspaceId)}&registryId=${encodeURIComponent(registryId)}`,
            )
            return data
        } catch (err) {
            if (!(err instanceof PlexoApiError) || err.status !== 404) throw err
        }
        const conns = await this.getInstalledConnections(workspaceId)
        const matches = conns.filter((c) => c.registryId === registryId && c.status === 'active')
        const out: PlexoTokenWithConnection[] = []
        for (const c of matches) {
            const t = await this.getToken(workspaceId, c.registryId)
            if (t?.access_token) out.push({ ...t, connectionId: c.id })
        }
        return out
    }

    async getTasks(
        workspaceId: string,
        opts: { status?: string; limit?: number } = {},
    ): Promise<PlexoTask[]> {
        const params = new URLSearchParams({
            workspaceId,
            limit: String(opts.limit ?? 10),
        })
        if (opts.status) params.set('status', opts.status)
        try {
            const data = await this.#get<{ items?: PlexoTask[] }>(`/api/v1/tasks?${params}`)
            return data.items ?? []
        } catch {
            return []
        }
    }

    oauthPopupUrl(provider: string, workspaceId: string): string {
        return `${this.#base}/api/oauth/${encodeURIComponent(provider)}/start?workspaceId=${encodeURIComponent(workspaceId)}`
    }

    // -----------------------------------------------------------------------
    // AI
    // -----------------------------------------------------------------------

    async aiComplete(workspaceId: string, opts: AiCompleteOptions): Promise<string> {
        const data = await this.#post<{ text?: string }>(
            '/api/v1/ai/complete',
            { workspaceId, ...opts },
            {},
            30_000,
        )
        return data.text ?? ''
    }

    async chatMessage(
        workspaceId: string,
        userId: string,
        opts: ChatOptions,
    ): Promise<ChatReply> {
        const data = await this.#post<Partial<ChatReply>>(
            '/api/v1/chat/message',
            { workspaceId, forceConversation: true, ...opts },
            { userId },
            30_000,
        )
        return {
            reply: data.reply ?? '',
            conversationId: data.conversationId,
            sessionId: data.sessionId,
            taskId: data.taskId,
        }
    }

    // -----------------------------------------------------------------------
    // Channel dispatch
    // -----------------------------------------------------------------------

    async dispatch(
        opts: DispatchOptions,
        ctx: DispatchContext = {},
    ): Promise<DispatchResult> {
        const data = await this.#post<DispatchResult>(
            '/api/v1/channel/dispatch',
            opts,
            ctx,
        )
        return { messageId: data.messageId, deliveryStatus: data.deliveryStatus }
    }

    // -----------------------------------------------------------------------
    // Events (node-events stream)
    // -----------------------------------------------------------------------

    /** Best-effort emit. Swallows errors — events are non-critical by design. */
    async publishEvent(opts: PublishEventOptions): Promise<{ eventId?: string } | null> {
        try {
            return await this.#post<{ eventId?: string }>('/api/v1/events', opts)
        } catch {
            return null
        }
    }

    // -----------------------------------------------------------------------
    // Conversations
    // -----------------------------------------------------------------------

    async getConversations(
        workspaceId: string,
        limit = 20,
    ): Promise<PlexoConversation[]> {
        try {
            const data = await this.#get<{ conversations?: PlexoConversation[] }>(
                `/api/v1/conversations?workspaceId=${encodeURIComponent(workspaceId)}&limit=${limit}`,
            )
            return data.conversations ?? []
        } catch {
            return []
        }
    }

    // -----------------------------------------------------------------------
    // Memory
    // -----------------------------------------------------------------------

    /** Best-effort store. Returns null on any failure. */
    async storeMemory(
        workspaceId: string,
        opts: StoreMemoryOptions,
    ): Promise<{ id: string } | null> {
        try {
            return await this.#post<{ id: string }>(
                '/api/v1/memory/entries',
                { workspaceId, ...opts },
            )
        } catch {
            return null
        }
    }

    /** Returns [] on any failure. */
    async searchMemory(
        workspaceId: string,
        query: string,
        limit = 20,
    ): Promise<MemorySearchResult[]> {
        try {
            const params = new URLSearchParams({
                workspaceId,
                q: query,
                limit: String(limit),
            })
            const data = await this.#get<{ results?: MemorySearchResult[] }>(
                `/api/v1/memory/search?${params}`,
            )
            return data.results ?? []
        } catch {
            return []
        }
    }

    // -----------------------------------------------------------------------
    // Tools (SDK 1.2.0 — synchronous tool-invoke surface)
    // -----------------------------------------------------------------------
    //
    // Surface: `client.tools.gmessages.send({...})` and
    // `client.tools.gmessages.listThreads({...})`. Distinct from
    // `dispatch()` (which is the async channel-delivery primitive) — these
    // calls block until the sidecar has accepted (or rejected) the request
    // and surface dispatch errors directly so Levio's chat loop can react.
    //
    // Errors are NOT swallowed here (unlike addEpisode/searchFacts): a Levio
    // user pressing "send" expects to see the failure. Network errors bubble
    // as PlexoUnreachableError; HTTP-level errors bubble as PlexoApiError
    // with the structured `error.code` from the route in the message body.

    get tools(): {
        gmessages: {
            send: (opts: GmessagesSendOptions) => Promise<GmessagesSendResult>
            listThreads: (opts: GmessagesListThreadsOptions) => Promise<GmessagesThread[]>
        }
    } {
        return {
            gmessages: {
                send: (opts) => this.#gmessagesSend(opts),
                listThreads: (opts) => this.#gmessagesListThreads(opts),
            },
        }
    }

    async #gmessagesSend(opts: GmessagesSendOptions): Promise<GmessagesSendResult> {
        const body: Record<string, unknown> = {
            workspaceId: opts.workspaceId,
            text: opts.text,
        }
        if (opts.threadId) body.threadId = opts.threadId
        if (opts.phoneE164) body.phoneE164 = opts.phoneE164
        const data = await this.#post<{ messageId?: string; deliveryStatus?: string }>(
            '/api/v1/tools/gmessages/send',
            body,
            { workspaceId: opts.workspaceId },
        )
        return {
            messageId: data.messageId ?? '',
            deliveryStatus: data.deliveryStatus ?? 'accepted',
        }
    }

    async #gmessagesListThreads(opts: GmessagesListThreadsOptions): Promise<GmessagesThread[]> {
        const params = new URLSearchParams({ workspaceId: opts.workspaceId })
        if (opts.phoneE164) params.set('phoneE164', opts.phoneE164)
        if (typeof opts.limit === 'number') params.set('limit', String(opts.limit))
        const data = await this.#get<{ threads?: GmessagesThread[] }>(
            `/api/v1/tools/gmessages/threads?${params}`,
        )
        return data.threads ?? []
    }

    // -----------------------------------------------------------------------
    // Vision
    // -----------------------------------------------------------------------

    /**
     * OCR an image via Plexo's vision endpoint. The image must be reachable
     * from Plexo (a signed CDN URL works). Returns null on any failure so
     * callers can mark the asset as `failed` and retry later.
     */
    async visionOcr(
        workspaceId: string,
        image: string | { imageBase64: string; mimeType: string },
    ): Promise<OcrResult | null> {
        try {
            // Backward-compatible: a string arg is treated as a fetchable
            // imageUrl (today's contract). An object arg posts inline base64
            // bytes for callers with in-memory Buffers and no public URL.
            const imagePayload = typeof image === 'string'
                ? { imageUrl: image }
                : { imageBase64: image.imageBase64, mimeType: image.mimeType }
            const data = await this.#post<Partial<OcrResult>>(
                '/api/v1/vision/ocr',
                { workspaceId, ...imagePayload },
                {},
                60_000,
            )
            return {
                text: data.text ?? '',
                confidence: typeof data.confidence === 'number' ? data.confidence : 0,
                model: data.model ?? 'unknown',
            }
        } catch {
            return null
        }
    }

    /**
     * Unified per-asset image analysis — ONE multimodal LLM call that
     * returns classification, sub-class, confidence, caption, OCR text,
     * salient labels, and suggested tags. Collapses the legacy 5-call
     * chain (classify + label + ocr + describe + suggest-tags) into a
     * single round-trip against a local Ollama VLM (qwen2.5vl:7b by
     * default). Used by Fonto's worker; see Fonto ADR 0002.
     *
     * Does NOT silently swallow errors (unlike `visionOcr`): callers
     * branching on `USE_UNIFIED_ANALYZE` need to detect failure and
     * fall back to the legacy chain. Throws `PlexoApiError` (with the
     * structured error.code from the route) or `PlexoUnreachableError`.
     *
     * Server-side wall-clock is bounded to 90 s; this client sets a
     * matching 120 s timeout to give headroom for network + parse.
     */
    async visionAnalyzeImage(opts: AnalyzeImageOptions): Promise<AnalyzeImageResult> {
        const data = await this.#post<Partial<AnalyzeImageResult>>(
            '/api/v1/vision/analyze-image',
            {
                workspaceId: opts.workspaceId,
                imageUrl: opts.imageUrl,
                mimeType: opts.mimeType,
                filename: opts.filename,
                hints: opts.hints,
            },
            { workspaceId: opts.workspaceId },
            120_000,
        )
        // Validate the shape minimally — the server already enforced the
        // zod schema, but a defensive cast keeps TS callers honest.
        return {
            classification: (data.classification ?? 'photo') as AnalyzeImageResult['classification'],
            subClassification: data.subClassification ?? null,
            confidence: typeof data.confidence === 'number' ? data.confidence : 0,
            description: typeof data.description === 'string' ? data.description : '',
            ocrText: data.ocrText ?? null,
            labels: Array.isArray(data.labels) ? data.labels.filter((s): s is string => typeof s === 'string') : [],
            suggestedTags: Array.isArray(data.suggestedTags) ? data.suggestedTags.filter((s): s is string => typeof s === 'string') : [],
            model: typeof data.model === 'string' ? data.model : 'unknown',
            latencyMs: typeof data.latencyMs === 'number' ? data.latencyMs : 0,
        }
    }

    // -----------------------------------------------------------------------
    // Inbound
    // -----------------------------------------------------------------------

    /** Returns a framework-agnostic handler for Plexo → app push requests. */
    inbound(handlers: InboundHandlers) {
        return createInboundRouter(this.#opts.serviceKey, handlers)
    }

    // -----------------------------------------------------------------------
    // Utilities
    // -----------------------------------------------------------------------

    async testConnection(): Promise<TestConnectionResult> {
        const start = Date.now()
        try {
            const fetchImpl = this.#opts.fetchImpl ?? fetch
            const res = await fetchImpl(`${this.#base}/api/health`, {
                signal: AbortSignal.timeout(5_000),
            })
            const latencyMs = Date.now() - start
            if (!res.ok) {
                return { ok: false, latencyMs, error: `HTTP ${res.status}` }
            }
            const body = await res.json().catch(() => ({})) as Record<string, unknown>
            return { ok: true, latencyMs, plexoVersion: body['version'] as string | undefined }
        } catch (err) {
            return {
                ok: false,
                latencyMs: Date.now() - start,
                error: err instanceof Error ? err.message : String(err),
            }
        }
    }

    // -----------------------------------------------------------------------
    // HTTP helpers
    // -----------------------------------------------------------------------

    #headers(extra: {
        userId?: string
        tenantId?: string
        workspaceId?: string
        traceId?: string
    } = {}): Record<string, string> {
        const h: Record<string, string> = {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.#opts.serviceKey}`,
            'X-App-Id': this.#opts.appId,
            'X-Service-Key-Version': this.#opts.serviceKeyVersion ?? 'v1',
        }
        if (extra.userId) h['X-User-Id'] = extra.userId
        if (extra.tenantId) h['X-Tenant-Id'] = extra.tenantId
        if (extra.workspaceId) h['X-Workspace-Id'] = extra.workspaceId
        if (extra.traceId) h['X-Trace-Id'] = extra.traceId
        return h
    }

    async #get<T>(path: string): Promise<T> {
        return this.#withReconnect(() => this.#raw<T>('GET', path))
    }

    async #post<T>(
        path: string,
        body: unknown,
        extra: {
            userId?: string
            tenantId?: string
            workspaceId?: string
            traceId?: string
        } = {},
        timeoutMs?: number,
    ): Promise<T> {
        return this.#withReconnect(() => this.#raw<T>('POST', path, { body, extra, timeoutMs }))
    }

    async #delete(path: string): Promise<void> {
        await this.#withReconnect(() => this.#raw<void>('DELETE', path, { tolerate404: true }))
    }

    /**
     * Raw single-shot request: fetch + parse, no reconnect. The handshake during
     * (re)connect() goes through here so a reconnect-triggered handshake cannot
     * recurse into another reconnect.
     */
    async #raw<T>(
        method: 'GET' | 'POST' | 'DELETE',
        path: string,
        opts: {
            body?: unknown
            extra?: { userId?: string; tenantId?: string; workspaceId?: string; traceId?: string }
            timeoutMs?: number
            tolerate404?: boolean
        } = {},
    ): Promise<T> {
        const fetchImpl = this.#opts.fetchImpl ?? fetch
        const timeout = opts.timeoutMs ?? this.#opts.resilience?.timeoutMs ?? 15_000
        let res: Response
        try {
            res = await fetchImpl(`${this.#base}${path}`, {
                method,
                headers: this.#headers(opts.extra),
                ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
                signal: AbortSignal.timeout(timeout),
            })
        } catch (err) {
            throw new PlexoUnreachableError(this.#base, err)
        }
        if (method === 'DELETE' && opts.tolerate404 && (res.ok || res.status === 404)) {
            return undefined as T
        }
        return this.#parse<T>(res, path)
    }

    /**
     * Wrap a request so that, when `autoReconnect` is on and a connect() session
     * exists, a transport failure (PlexoUnreachableError) triggers ONE reconnect()
     * + a single retry. Any other error, or a second failure, propagates (fail-loud).
     */
    async #withReconnect<T>(fn: () => Promise<T>): Promise<T> {
        try {
            return await fn()
        } catch (err) {
            if (!(this.#opts.autoReconnect && this.#session && err instanceof PlexoUnreachableError)) {
                throw err
            }
            await this.reconnect() // re-resolve + handshake + register; throws propagate
            return fn() // retry once — a second failure is not re-reconnected
        }
    }

    async #parse<T>(res: Response, path: string): Promise<T> {
        if (res.status === 401) throw new PlexoAuthError(path)
        if (res.status === 429) {
            const retry = Number(res.headers.get('retry-after'))
            throw new PlexoRateLimitedError(path, Number.isNaN(retry) ? undefined : retry)
        }
        if (!res.ok) {
            const detail = await res.text().catch(() => '')
            throw new PlexoApiError(res.status, path, detail.slice(0, 300))
        }
        if (res.status === 204) return undefined as T
        return res.json() as Promise<T>
    }
}
