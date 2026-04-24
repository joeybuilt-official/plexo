// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

export const dynamic = 'force-dynamic'

/**
 * SCL controls page — Phase 3a sub-page.
 *
 * Lives at /app/settings/intelligence/scl. Two-column layout: settings
 * form on the left, PII preview on the right. Same back-link pattern as
 * the Phase 2b model catalog page.
 */

import { BrainCircuit } from 'lucide-react'
import { useWorkspace } from '@web/context/workspace'
import { SclSettingsForm } from './settings-form'
import { PiiPreview } from './pii-preview'

export default function SclControlsPage() {
    const { workspaceId: wsId } = useWorkspace()
    const workspaceId = wsId || null

    return (
        <div className="flex h-full flex-col overflow-y-auto">
            <div className="flex items-start justify-between gap-4 border-b border-border p-4">
                <div className="flex items-start gap-3 min-w-0">
                    <div className="h-10 w-10 rounded-lg bg-surface-1 flex items-center justify-center shrink-0">
                        <BrainCircuit className="h-5 w-5 text-azure" />
                    </div>
                    <div>
                        <h2 className="text-base font-semibold text-text-primary">Semantic Concept Lattice</h2>
                        <p className="text-xs text-text-muted mt-0.5">
                            Workspace memory organized as concept attractors. Toggle, tune drift, scope regions, verify scrubbing.
                        </p>
                    </div>
                </div>
            </div>

            <div className="p-4">
                {!workspaceId ? (
                    <div className="rounded-xl border border-border bg-surface-1 p-3 text-xs text-text-muted">
                        Pick a workspace from the sidebar to configure SCL.
                    </div>
                ) : (
                    <div className="grid gap-4 lg:grid-cols-2">
                        <div>
                            <SclSettingsForm workspaceId={workspaceId} />
                        </div>
                        <div>
                            <PiiPreview workspaceId={workspaceId} />
                        </div>
                    </div>
                )}
            </div>
        </div>
    )
}
