// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

export const dynamic = 'force-dynamic'

/**
 * Embeddings sub-page.
 *
 * Two sections:
 *   A. "Bundled services" — the REAL bundled things (the plexo-embeddings
 *      container at apps/embeddings/, plus the managed Ollama sidecar
 *      when actually reachable).
 *   B. "BYO fallback providers" — user-added providers that happen to
 *      have an embedding model configured (Mistral, user-added Ollama…).
 *
 * Managed rows (managed === true) are excluded from Section B so the
 * old "Plexo Built-in AI" zombie row can't leak into the BYO grid. When
 * the managed Ollama sidecar is unreachable it's hidden entirely.
 */

import { useState } from 'react'
import { Sparkles, Server, CheckCircle2, AlertTriangle } from 'lucide-react'
import { toast } from 'sonner'
import { useWorkspace } from '@web/context/workspace'
import { EmbeddingCard } from '../embedding-card'
import { LocalEmbeddingsPanel } from '../local-embeddings-panel'
import { ReembedModal } from '../reembed-modal'
import {
    useEmbeddingProviders,
    patchEmbeddingModel,
    type EmbeddingProviderRow,
} from '@web/lib/embeddings-client'
import { useDetect } from '@web/lib/intelligence-dashboard-client'

export default function EmbeddingsPage() {
    const { workspaceId: wsId } = useWorkspace()
    const workspaceId = wsId || null

    const { data, mutate, isLoading } = useEmbeddingProviders(workspaceId)
    const { data: detectData } = useDetect(workspaceId)

    const [reembedOpen, setReembedOpen] = useState(false)
    const [reembedCtx, setReembedCtx] = useState<{
        previousDimensions: number | null
        nextDimensions: number | null
        nextProvider: string
        nextModel: string
    } | null>(null)

    async function handleModelChange(row: EmbeddingProviderRow, model: string) {
        if (!workspaceId) return
        try {
            const result = await patchEmbeddingModel(workspaceId, row.instanceId, { model })
            await mutate()
            if (
                result.dimensionChanged
                || (result.previousDimensions != null && result.previousDimensions !== row.dimensions)
            ) {
                setReembedCtx({
                    previousDimensions: result.previousDimensions,
                    nextDimensions: result.instance.dimensions,
                    nextProvider: row.providerType,
                    nextModel: model,
                })
                setReembedOpen(true)
            } else {
                toast.success(`Embedding model set to ${model}`)
            }
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Failed to update embedding model')
        }
    }

    const providers = data?.providers ?? []
    // Section B: user-added providers with embeddings, managed rows excluded.
    const byoEmbeddingProviders = providers.filter(
        (p) => !p.managed && p.supportsEmbeddings,
    )

    // Section A: managed rows we should surface. Only when actually healthy —
    // otherwise a dead sidecar row would clutter the UI.
    const managedHealthyRows = providers.filter(
        (p) => p.managed && p.health === 'healthy',
    )

    const localEmbeddingsUp = detectData?.services?.embeddings?.status === 'up'

    return (
        <div className="flex flex-col h-full overflow-y-auto">
            <div className="flex items-start justify-between gap-4 border-b border-border p-4">
                <div className="flex items-start gap-3 min-w-0">
                    <div className="h-10 w-10 rounded-sm bg-surface-1 flex items-center justify-center shrink-0">
                        <Sparkles className="h-5 w-5 text-azure" />
                    </div>
                    <div>
                        <h2 className="text-base font-medium text-text-primary">Embeddings</h2>
                        <p className="text-xs text-text-muted mt-0.5">
                            Memory recall, SCL expansion, and any RAG flow run through the embeddings stack.
                        </p>
                    </div>
                </div>
            </div>

            <div className="p-4 space-y-8 max-w-4xl">
                {!workspaceId ? (
                    <div className="rounded-sm border border-border bg-surface-1 p-3 text-xs text-text-muted">
                        Pick a workspace from the sidebar to configure embeddings.
                    </div>
                ) : (
                    <>
                        {/* ── Section A: Bundled services ───────────────── */}
                        <section className="space-y-3">
                            <div className="flex items-start gap-2">
                                <Server className="h-4 w-4 text-text-muted shrink-0 mt-0.5" />
                                <div>
                                    <h3 className="text-sm font-medium text-text-primary">Bundled services</h3>
                                    <p className="text-[11px] text-text-muted">
                                        Services shipped inside Plexo. The local embeddings
                                        server is the primary path when it&apos;s running.
                                    </p>
                                </div>
                            </div>

                            <LocalEmbeddingsPanel workspaceId={workspaceId} canReload={true} />

                            {localEmbeddingsUp && (
                                <div className="rounded-sm border border-emerald-800/40 bg-emerald-900/10 p-3 flex items-start gap-2">
                                    <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0 mt-0.5" />
                                    <div className="text-xs">
                                        <p className="font-medium text-emerald-400">Active</p>
                                        <p className="text-emerald-400/80 mt-0.5">
                                            snowflake-arctic-embed-s · 384 dim
                                        </p>
                                    </div>
                                </div>
                            )}

                            {managedHealthyRows.length > 0 && (
                                <div className="space-y-2">
                                    {managedHealthyRows.map((row) => (
                                        <div
                                            key={row.instanceId}
                                            className="rounded-sm border border-border bg-surface-1 p-3 flex items-start gap-2"
                                        >
                                            <Server className="h-4 w-4 text-text-muted shrink-0 mt-0.5" />
                                            <div className="min-w-0 flex-1">
                                                <p className="text-sm font-medium text-text-primary">
                                                    Managed Ollama (sidecar)
                                                </p>
                                                <p className="text-[11px] text-text-muted">
                                                    {row.selectedModel ?? row.embeddingModels?.[0] ?? 'ollama'}
                                                    {row.dimensions ? ` · ${row.dimensions} dim` : ''}
                                                </p>
                                            </div>
                                            <span className="inline-flex items-center gap-1 text-[11px] text-emerald-400">
                                                <span className="inline-block h-2 w-2 rounded-full bg-emerald-400" />
                                                Healthy
                                            </span>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </section>

                        {/* ── Section B: BYO fallback providers ─────────── */}
                        <section className="space-y-3">
                            <div className="flex items-start gap-2">
                                <Sparkles className="h-4 w-4 text-text-muted shrink-0 mt-0.5" />
                                <div>
                                    <h3 className="text-sm font-medium text-text-primary">BYO fallback providers</h3>
                                    <p className="text-[11px] text-text-muted">
                                        User-added providers with an embedding model configured.
                                        Used as a fallback when the bundled server is down.
                                    </p>
                                </div>
                            </div>

                            {isLoading ? (
                                <div className="rounded-sm border border-border bg-surface-1 p-3 text-xs text-text-muted">
                                    Loading embedding providers…
                                </div>
                            ) : byoEmbeddingProviders.length === 0 ? (
                                <div className="rounded-sm border border-border bg-surface-1 p-3 flex items-start gap-2">
                                    <AlertTriangle className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" />
                                    <p className="text-xs text-text-muted">
                                        No BYO embedding providers connected. Add OpenAI, Voyage, Cohere, Google,
                                        Mistral, or Ollama to enable a fallback path.
                                    </p>
                                </div>
                            ) : (
                                <div className="flex flex-wrap gap-2">
                                    {byoEmbeddingProviders.map((row) => (
                                        <EmbeddingCard
                                            key={row.instanceId}
                                            row={row}
                                            availableModels={row.embeddingModels}
                                            onModelChange={(m) => handleModelChange(row, m)}
                                        />
                                    ))}
                                </div>
                            )}
                        </section>
                    </>
                )}

                {reembedCtx && workspaceId && (
                    <ReembedModal
                        workspaceId={workspaceId}
                        open={reembedOpen}
                        onClose={() => setReembedOpen(false)}
                        previousDimensions={reembedCtx.previousDimensions}
                        nextDimensions={reembedCtx.nextDimensions}
                        nextProvider={reembedCtx.nextProvider}
                        nextModel={reembedCtx.nextModel}
                    />
                )}
            </div>
        </div>
    )
}
