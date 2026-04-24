// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

export const dynamic = 'force-dynamic'

/**
 * Self-hosted servers sub-page.
 *
 * List of user-configured self-hosted provider instances (rows with an
 * endpointUrl set) + an add-form for a new one. Managed rows are hidden
 * (they live in Embeddings → Bundled services when healthy).
 */

import { useState } from 'react'
import useSWR from 'swr'
import { Server, Loader2, Trash2, ExternalLink } from 'lucide-react'
import { toast } from 'sonner'
import { useWorkspace } from '@web/context/workspace'
import { jsonFetcher } from '@web/lib/swr'

interface ProviderCapabilities {
    supportsChat: boolean
    supportsEmbeddings: boolean
    chatModels: string[]
    embeddingModels: string[]
    discoveryError: string | null
}

interface ProviderInstance {
    id: string
    workspaceId: string
    nickname: string
    providerType: string
    endpointUrl: string | null
    capabilities: ProviderCapabilities
    managed: boolean
    enabled: boolean
    selectedModel: string | null
    createdAt: string
    updatedAt: string
    lastDiscoveredAt: string | null
}

function extractErrorMessage(err: unknown): string {
    if (!err) return 'Unknown error'
    if (typeof err === 'string') return err
    if (typeof err === 'object') {
        const obj = err as Record<string, unknown>
        if (typeof obj.message === 'string') return obj.message
        if (typeof obj.error === 'string') return obj.error
    }
    return 'Unknown error'
}

export default function SelfHostedPage() {
    const { workspaceId: wsId } = useWorkspace()
    const workspaceId = wsId || null

    const providersKey = workspaceId
        ? `/api/v1/workspaces/${workspaceId}/providers`
        : null
    const { data, mutate, isLoading } = useSWR<{ providers?: ProviderInstance[]; items?: ProviderInstance[] }>(
        providersKey,
        jsonFetcher,
        { refreshInterval: 60_000, revalidateOnFocus: true, dedupingInterval: 10_000 },
    )

    const allProviders = data?.providers ?? data?.items ?? []
    const selfHosted = allProviders.filter((p) => !!p.endpointUrl && !p.managed)

    // Add-form state
    const [serverUrl, setServerUrl] = useState('')
    const [serverNickname, setServerNickname] = useState('')
    const [serverAuth, setServerAuth] = useState('')
    const [serverTesting, setServerTesting] = useState(false)
    const [serverError, setServerError] = useState<string | null>(null)

    // Delete state
    const [removingId, setRemovingId] = useState<string | null>(null)

    async function handleSave() {
        if (!workspaceId || !serverUrl.trim()) return
        setServerTesting(true)
        setServerError(null)
        try {
            const testRes = await fetch(`/api/v1/workspaces/${workspaceId}/providers/test`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ providerType: 'ollama', endpointUrl: serverUrl.trim() }),
            })
            const testData = await testRes.json()
            if (!testData.ok) {
                setServerError(extractErrorMessage(testData.error) || 'Connection test failed.')
                setServerTesting(false)
                return
            }

            const saveRes = await fetch(`/api/v1/workspaces/${workspaceId}/providers`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    nickname: serverNickname.trim() || 'My Server',
                    providerType: 'ollama',
                    endpointUrl: serverUrl.trim(),
                    apiKey: serverAuth.trim() || undefined,
                }),
            })
            if (!saveRes.ok) {
                const saveData = await saveRes.json().catch(() => ({}))
                setServerError(extractErrorMessage(saveData.error) || 'Failed to save.')
                setServerTesting(false)
                return
            }

            toast.success(`Added ${serverNickname.trim() || 'My Server'}`)
            setServerUrl('')
            setServerNickname('')
            setServerAuth('')
            await mutate()
        } catch {
            setServerError('Something went wrong.')
        } finally {
            setServerTesting(false)
        }
    }

    async function handleRemove(id: string, nickname: string) {
        if (!workspaceId) return
        setRemovingId(id)
        try {
            await fetch(`/api/v1/workspaces/${workspaceId}/providers/${id}`, { method: 'DELETE' })
            toast(`Removed ${nickname}`)
            await mutate()
        } catch {
            toast.error('Failed to remove.')
        } finally {
            setRemovingId(null)
        }
    }

    return (
        <div className="flex flex-col h-full overflow-y-auto">
            <div className="flex items-start justify-between gap-4 border-b border-border p-4">
                <div className="flex items-start gap-3 min-w-0">
                    <div className="h-10 w-10 rounded-lg bg-surface-1 flex items-center justify-center shrink-0">
                        <Server className="h-5 w-5 text-azure" />
                    </div>
                    <div>
                        <h2 className="text-base font-semibold text-text-primary">Self-hosted servers</h2>
                        <p className="text-xs text-text-muted mt-0.5">
                            Point Plexo at a local Ollama or LM Studio server you control.
                        </p>
                    </div>
                </div>
            </div>

            <div className="p-4 space-y-6 max-w-3xl">
                {!workspaceId ? (
                    <div className="rounded-xl border border-border bg-surface-1 p-3 text-xs text-text-muted">
                        Pick a workspace from the sidebar to configure self-hosted servers.
                    </div>
                ) : (
                    <>
                        {/* Existing servers */}
                        <section className="space-y-2">
                            <h3 className="text-sm font-semibold text-text-primary">Configured servers</h3>
                            {isLoading ? (
                                <div className="rounded-xl border border-border bg-surface-1 p-3 text-xs text-text-muted">
                                    Loading…
                                </div>
                            ) : selfHosted.length === 0 ? (
                                <div className="rounded-xl border border-border bg-surface-1 p-3 text-xs text-text-muted">
                                    No self-hosted servers configured.
                                </div>
                            ) : (
                                <div className="space-y-2">
                                    {selfHosted.map((p) => (
                                        <div
                                            key={p.id}
                                            className="rounded-xl border border-border bg-surface-1 p-3 flex items-start gap-3"
                                        >
                                            <Server className="h-4 w-4 text-text-muted shrink-0 mt-0.5" />
                                            <div className="min-w-0 flex-1">
                                                <p className="text-sm font-medium text-text-primary truncate">
                                                    {p.nickname}
                                                </p>
                                                <p className="text-[11px] text-text-muted font-mono truncate">
                                                    {p.endpointUrl}
                                                </p>
                                                <p className="text-[11px] text-text-muted mt-0.5">
                                                    last discovered{' '}
                                                    {p.lastDiscoveredAt
                                                        ? new Date(p.lastDiscoveredAt).toLocaleString()
                                                        : 'never'}
                                                </p>
                                            </div>
                                            <button
                                                onClick={() => void handleRemove(p.id, p.nickname)}
                                                disabled={removingId === p.id}
                                                className="flex items-center gap-1 rounded-md border border-red-800/40 bg-red-dim px-2 py-1 text-[11px] text-red hover:border-red-700 disabled:opacity-50"
                                            >
                                                {removingId === p.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                                                Remove
                                            </button>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </section>

                        {/* Add form */}
                        <section className="rounded-xl border border-border bg-surface-1 p-4 space-y-3">
                            <div>
                                <h3 className="text-sm font-semibold text-text-primary">Add a server</h3>
                                <p className="text-[11px] text-text-muted">
                                    Point to a local Ollama or LM Studio server you control.
                                </p>
                            </div>

                            <div className="space-y-3">
                                <div>
                                    <label className="block text-xs font-medium text-text-primary mb-1">Nickname</label>
                                    <input
                                        value={serverNickname}
                                        onChange={(e) => setServerNickname(e.target.value)}
                                        className="w-full rounded-lg border border-border bg-surface-1 px-3 py-2 text-sm text-text-primary placeholder-muted focus:border-azure focus-ring"
                                        placeholder="My Home Server"
                                    />
                                </div>
                                <div>
                                    <label className="block text-xs font-medium text-text-primary mb-1">Server address</label>
                                    <input
                                        value={serverUrl}
                                        onChange={(e) => { setServerUrl(e.target.value); setServerError(null) }}
                                        className="w-full rounded-lg border border-border bg-surface-1 px-3 py-2 text-sm text-text-primary font-mono placeholder-muted focus:border-azure focus-ring"
                                        placeholder="http://localhost:11434"
                                    />
                                </div>
                                <div>
                                    <label className="block text-xs font-medium text-text-primary mb-1">Access password (optional)</label>
                                    <input
                                        type="password"
                                        value={serverAuth}
                                        onChange={(e) => setServerAuth(e.target.value)}
                                        className="w-full rounded-lg border border-border bg-surface-1 px-3 py-2 text-sm text-text-primary placeholder-muted focus:border-azure focus-ring"
                                        placeholder="Leave blank if not required"
                                        autoComplete="off"
                                    />
                                </div>
                                {serverError && <p className="text-xs text-red">{serverError}</p>}
                                <div className="flex justify-end">
                                    <button
                                        onClick={() => void handleSave()}
                                        disabled={serverTesting || !serverUrl.trim()}
                                        className="flex items-center gap-1.5 rounded-lg bg-azure px-4 py-2 text-sm font-medium text-text-primary hover:bg-azure/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                                    >
                                        {serverTesting ? <><Loader2 className="h-3 w-3 animate-spin" /> Testing…</> : (
                                            <>
                                                <ExternalLink className="h-3 w-3" /> Test &amp; Save
                                            </>
                                        )}
                                    </button>
                                </div>
                            </div>
                        </section>
                    </>
                )}
            </div>
        </div>
    )
}
