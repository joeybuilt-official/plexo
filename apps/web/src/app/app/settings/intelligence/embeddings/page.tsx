// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

'use client'

export const dynamic = 'force-dynamic'

/**
 * Embeddings sub-page — collapsed 2026-06-27 (operator panel 5/5).
 *
 * After the BYOK collapse the workspace embedder is locked to the bundled
 * Plexo Inference Gateway. The picker UI (Section B — BYO fallback
 * providers + per-row model selector + re-embed modal) has been removed
 * because there is nothing to pick. The page now surfaces the bundled
 * service's health + active model only.
 */

import { Sparkles, Server, CheckCircle2 } from 'lucide-react'
import { useWorkspace } from '@web/context/workspace'
import { LocalEmbeddingsPanel } from '../local-embeddings-panel'
import { useDetect } from '@web/lib/intelligence-dashboard-client'

export default function EmbeddingsPage() {
    const { workspaceId: wsId } = useWorkspace()
    const workspaceId = wsId || null
    const { data: detectData } = useDetect(workspaceId)
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
                            Memory recall, SCL expansion, and any RAG flow run through the bundled embeddings gateway (384-d).
                        </p>
                    </div>
                </div>
            </div>

            <div className="p-4 space-y-8 max-w-4xl">
                {!workspaceId ? (
                    <div className="rounded-sm border border-border bg-surface-1 p-3 text-xs text-text-muted">
                        Pick a workspace from the sidebar to see embeddings status.
                    </div>
                ) : (
                    <section className="space-y-3">
                        <div className="flex items-start gap-2">
                            <Server className="h-4 w-4 text-text-muted shrink-0 mt-0.5" />
                            <div>
                                <h3 className="text-sm font-medium text-text-primary">Bundled embeddings gateway</h3>
                                <p className="text-[11px] text-text-muted">
                                    The Plexo Inference Gateway ships with Plexo and runs locally.
                                    All workspaces use this single 384-d path.
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
                    </section>
                )}
            </div>
        </div>
    )
}
