// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

export const dynamic = 'force-dynamic'

/**
 * Routing sub-page — inference mode picker + cost-ceiling slider.
 *
 * The per-task fallback chain editor lives at
 * /app/settings/intelligence/routing/tasks so the two concerns stay
 * focused. This page is the high-level "how is routing wired" surface.
 */

import Link from 'next/link'
import { Route, ListOrdered } from 'lucide-react'
import { useWorkspace } from '@web/context/workspace'
import { InferenceModePicker } from '../inference-mode-picker'
import { CostCeilingSlider } from '../cost-ceiling-slider'
import { StepBudgetPicker } from '../step-budget-picker'

export default function RoutingPage() {
    const { workspaceId: wsId } = useWorkspace()
    const workspaceId = wsId || null

    return (
        <div className="flex flex-col h-full overflow-y-auto">
            <div className="flex items-start justify-between gap-4 border-b border-border p-4">
                <div className="flex items-start gap-3 min-w-0">
                    <div className="h-10 w-10 rounded-lg bg-surface-1 flex items-center justify-center shrink-0">
                        <Route className="h-5 w-5 text-azure" />
                    </div>
                    <div>
                        <h2 className="text-base font-semibold text-text-primary">Inference mode &amp; cost</h2>
                        <p className="text-xs text-text-muted mt-0.5">
                            How Plexo picks a provider and how much it&apos;s allowed to spend each month.
                        </p>
                    </div>
                </div>
            </div>

            <div className="p-4 space-y-6 max-w-3xl">
                {!workspaceId ? (
                    <div className="rounded-xl border border-border bg-surface-1 p-3 text-xs text-text-muted">
                        Pick a workspace from the sidebar to configure routing.
                    </div>
                ) : (
                    <>
                        <InferenceModePicker workspaceId={workspaceId} />
                        <CostCeilingSlider workspaceId={workspaceId} />
                        <StepBudgetPicker workspaceId={workspaceId} />

                        <div className="rounded-xl border border-border bg-surface-1 p-3">
                            <div className="flex items-start gap-2.5">
                                <ListOrdered className="h-4 w-4 text-text-muted shrink-0 mt-0.5" />
                                <div className="text-xs text-text-muted leading-relaxed">
                                    <span className="text-text-primary font-medium">Pro tip:</span>{' '}
                                    override which model Plexo picks per task-type (planning, codegen,
                                    classification, etc.) at{' '}
                                    <Link
                                        href="/app/settings/intelligence/routing/tasks"
                                        className="text-azure hover:underline"
                                    >
                                        Per-task chains
                                    </Link>
                                    .
                                </div>
                            </div>
                        </div>
                    </>
                )}
            </div>
        </div>
    )
}
