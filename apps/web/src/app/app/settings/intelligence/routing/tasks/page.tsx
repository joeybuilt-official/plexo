// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

'use client'

export const dynamic = 'force-dynamic'

/**
 * Per-task chain editor sub-page.
 *
 * Wraps the existing TaskTypeChainEditor. Each task type has its own
 * ordered fallback chain that overrides the default provider priority.
 */

import { ListOrdered } from 'lucide-react'
import { useWorkspace } from '@web/context/workspace'
import { TaskTypeChainEditor } from '../task-type-chain-editor'

export default function RoutingTasksPage() {
    const { workspaceId: wsId } = useWorkspace()
    const workspaceId = wsId || null

    return (
        <div className="flex flex-col h-full overflow-y-auto">
            <div className="flex items-start justify-between gap-4 border-b border-border p-4">
                <div className="flex items-start gap-3 min-w-0">
                    <div className="h-10 w-10 rounded-sm bg-surface-1 flex items-center justify-center shrink-0">
                        <ListOrdered className="h-5 w-5 text-azure" />
                    </div>
                    <div>
                        <h2 className="text-base font-medium text-text-primary">Per-task chains</h2>
                        <p className="text-xs text-text-muted mt-0.5">
                            Override the default provider priority for specific task types
                            (planning, code generation, summarization, etc.). Chains are
                            tried top-to-bottom until one succeeds.
                        </p>
                    </div>
                </div>
            </div>

            <div className="p-4">
                {!workspaceId ? (
                    <div className="rounded-sm border border-border bg-surface-1 p-3 text-xs text-text-muted">
                        Pick a workspace from the sidebar to edit per-task chains.
                    </div>
                ) : (
                    <TaskTypeChainEditor workspaceId={workspaceId} />
                )}
            </div>
        </div>
    )
}
