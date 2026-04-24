// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

/**
 * Local embeddings server panel — Phase 1.
 *
 * Surfaces the bundled `apps/embeddings` server (formerly inference-gateway)
 * for self-hosters: detects whether it's reachable, displays current model
 * and dimensions, and offers a hot-reload button (admin) when it is.
 *
 * When NOT detected, the panel renders the documented enable steps so a
 * self-hoster can turn it on without leaving the UI.
 */

import { useState } from 'react'
import { Loader2, Server, RefreshCw } from 'lucide-react'
import { useLocalEmbeddingsHealth, reloadLocalEmbeddings } from '@web/lib/embeddings-client'
import { toast } from 'sonner'

interface LocalEmbeddingsPanelProps {
    workspaceId: string | null | undefined
    /** Admin gating for the reload button. */
    canReload: boolean
}

function statusPillClass(status: string): string {
    if (status === 'healthy') return 'bg-emerald-400'
    if (status === 'starting') return 'bg-amber-400'
    if (status === 'degraded') return 'bg-amber-400'
    if (status === 'unreachable') return 'bg-red-500'
    return 'bg-muted'
}

function statusLabel(status: string): string {
    if (status === 'healthy') return 'Healthy'
    if (status === 'starting') return 'Starting'
    if (status === 'degraded') return 'Degraded'
    if (status === 'unreachable') return 'Unreachable'
    if (status === 'not-detected') return 'Not detected'
    return status
}

export function LocalEmbeddingsPanel({ workspaceId, canReload }: LocalEmbeddingsPanelProps) {
    const { data, mutate, isLoading } = useLocalEmbeddingsHealth(workspaceId)
    const [reloading, setReloading] = useState(false)

    async function handleReload() {
        if (!workspaceId) return
        setReloading(true)
        try {
            await reloadLocalEmbeddings(workspaceId)
            await mutate()
            toast.success('Local embeddings model reloaded')
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Reload failed')
        } finally {
            setReloading(false)
        }
    }

    if (isLoading) {
        return (
            <div className="rounded-xl border border-border bg-surface-1 p-4 flex items-center gap-2 text-sm text-text-muted">
                <Loader2 className="h-4 w-4 animate-spin" />
                Probing local embeddings server…
            </div>
        )
    }

    if (!data) return null

    if (!data.installed) {
        return (
            <div className="rounded-xl border border-border bg-surface-1 p-4 space-y-3">
                <div className="flex items-center gap-2">
                    <Server className="h-4 w-4 text-text-muted" />
                    <h3 className="text-sm font-medium text-text-primary">Local embeddings server</h3>
                    <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-text-muted">
                        <span className="inline-block h-2 w-2 rounded-full bg-muted" />
                        Not detected
                    </span>
                </div>
                <p className="text-xs text-text-muted">
                    The bundled embeddings server isn&apos;t running. Self-hosters can enable it with:
                </p>
                <pre className="rounded-md border border-border bg-surface-1 p-2 text-[11px] text-text-primary overflow-x-auto">
docker compose --profile local-embeddings up -d
                </pre>
                <p className="text-xs text-text-muted">
                    Or set <code className="font-mono text-text-primary">EMBEDDINGS_URL</code> in your <code className="font-mono text-text-primary">.env</code> to point at an existing OpenAI-compatible embeddings endpoint.
                </p>
            </div>
        )
    }

    return (
        <div className="rounded-xl border border-border bg-surface-1 p-4 space-y-3">
            <div className="flex items-center gap-2">
                <Server className="h-4 w-4 text-text-muted" />
                <h3 className="text-sm font-medium text-text-primary">Local embeddings server</h3>
                <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-text-muted">
                    <span className={`inline-block h-2 w-2 rounded-full ${statusPillClass(data.status)}`} />
                    {statusLabel(data.status)}
                </span>
            </div>

            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                <dt className="text-text-muted">URL</dt>
                <dd className="font-mono text-text-primary truncate">{data.url ?? '—'}</dd>

                <dt className="text-text-muted">Model</dt>
                <dd className="font-mono text-text-primary">{data.model ?? '—'}</dd>

                <dt className="text-text-muted">Dimensions</dt>
                <dd className="text-text-primary">{data.dimensions ?? '—'}</dd>

                {data.loadTimeMs != null && (
                    <>
                        <dt className="text-text-muted">Load time</dt>
                        <dd className="text-text-primary">{Math.round(data.loadTimeMs)} ms</dd>
                    </>
                )}
            </dl>

            {data.message && (
                <p className="text-xs text-text-muted">{data.message}</p>
            )}

            {canReload && data.status === 'healthy' && (
                <button
                    onClick={() => void handleReload()}
                    disabled={reloading}
                    className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1 text-xs font-medium text-text-primary hover:bg-surface-1 focus-ring focus:ring-2 focus:ring-azure disabled:opacity-50"
                >
                    {reloading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                    Hot-reload model
                </button>
            )}
        </div>
    )
}
