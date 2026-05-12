// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { PlexoApiError, PlexoAuthError, PlexoRateLimitedError, PlexoUnreachableError } from './errors.js'
import { createInboundRouter } from './inbound.js'
import { register } from './registration.js'
import type {
    AddEpisodeOptions,
    AddEpisodeResult,
    AiCompleteOptions,
    AppProfile,
    ChatOptions,
    ChatReply,
    DispatchContext,
    DispatchOptions,
    DispatchResult,
    FactSearchResult,
    GmessagesListThreadsOptions,
    GmessagesSendOptions,
    GmessagesSendResult,
    GmessagesThread,
    InboundHandlers,
    InstallConnectionOptions,
    MemorySearchResult,
    OcrResult,
    PlexoClientOptions,
    PlexoConnection,
    PlexoConversation,
    PlexoTask,
    PlexoToken,
    PlexoTokenWithConnection,
    PublishEventOptions,
    StoreMemoryOptions,
    TestConnectionResult,
} from './types.js'

export class PlexoClient {
    readonly #opts: PlexoClientOptions
    readonly #base: string

    constructor(opts: PlexoClientOptions) {
        this.#opts = opts
        this.#base = opts.plexoUrl.replace(/\/$/, '')
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
    // Graph (SDK 1.1.0 — Plexo Graphiti integration)
    // -----------------------------------------------------------------------
    //
    // Two methods land in 1.1.0; `searchNodes` and `getCommunity` are
    // deferred to 1.2.0. graphiti-core 0.29 has no `search_nodes` method
    // and no community accessor (only `build_communities` as a builder),
    // so cleanly typed wrappers wait until upstream surface lands or the
    // sidecar grows custom Cypher/Kuzu queries.

    /** Add a knowledge-graph episode. Returns null on any failure. */
    async addEpisode(
        workspaceId: string,
        opts: AddEpisodeOptions,
    ): Promise<AddEpisodeResult | null> {
        try {
            return await this.#post<AddEpisodeResult>('/api/v1/graph/episodes', { workspaceId, ...opts })
        } catch {
            return null
        }
    }

    /** Hybrid-search facts in the workspace's knowledge graph. Returns [] on any failure. */
    async searchFacts(
        workspaceId: string,
        query: string,
        limit = 10,
    ): Promise<FactSearchResult[]> {
        try {
            const params = new URLSearchParams({ workspaceId, q: query, limit: String(limit) })
            const data = await this.#get<{ results?: Array<{ uuid: string | null; fact: string | null; source_node_uuid: string | null; target_node_uuid: string | null; valid_at: string | null; invalid_at: string | null; created_at: string | null }> }>(
                `/api/v1/graph/facts/search?${params}`,
            )
            return (data.results ?? []).map((edge) => ({
                uuid: edge.uuid,
                fact: edge.fact,
                sourceNodeUuid: edge.source_node_uuid,
                targetNodeUuid: edge.target_node_uuid,
                validAt: edge.valid_at,
                invalidAt: edge.invalid_at,
                createdAt: edge.created_at,
            }))
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
    async visionOcr(workspaceId: string, imageUrl: string): Promise<OcrResult | null> {
        try {
            const data = await this.#post<Partial<OcrResult>>(
                '/api/v1/vision/ocr',
                { workspaceId, imageUrl },
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
        const fetchImpl = this.#opts.fetchImpl ?? fetch
        const timeout = this.#opts.resilience?.timeoutMs ?? 15_000
        let res: Response
        try {
            res = await fetchImpl(`${this.#base}${path}`, {
                headers: this.#headers(),
                signal: AbortSignal.timeout(timeout),
            })
        } catch (err) {
            throw new PlexoUnreachableError(this.#base, err)
        }
        return this.#parse<T>(res, path)
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
        const fetchImpl = this.#opts.fetchImpl ?? fetch
        const timeout = timeoutMs ?? this.#opts.resilience?.timeoutMs ?? 15_000
        let res: Response
        try {
            res = await fetchImpl(`${this.#base}${path}`, {
                method: 'POST',
                headers: this.#headers(extra),
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(timeout),
            })
        } catch (err) {
            throw new PlexoUnreachableError(this.#base, err)
        }
        return this.#parse<T>(res, path)
    }

    async #delete(path: string): Promise<void> {
        const fetchImpl = this.#opts.fetchImpl ?? fetch
        const timeout = this.#opts.resilience?.timeoutMs ?? 15_000
        let res: Response
        try {
            res = await fetchImpl(`${this.#base}${path}`, {
                method: 'DELETE',
                headers: this.#headers(),
                signal: AbortSignal.timeout(timeout),
            })
        } catch (err) {
            throw new PlexoUnreachableError(this.#base, err)
        }
        if (!res.ok && res.status !== 404) {
            await this.#parse<void>(res, path)
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
