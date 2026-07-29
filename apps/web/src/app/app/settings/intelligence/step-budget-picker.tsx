// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { Gauge, Loader2 } from 'lucide-react'
import {
    useIntelligenceSettings,
    patchStepBudget,
    type StepBudget,
} from '@web/lib/intelligence-client'

interface BudgetOption {
    value: StepBudget
    label: string
    steps: number
    summary: string
}

const BUDGET_OPTIONS: BudgetOption[] = [
    {
        value: 'conservative',
        label: 'Conservative',
        steps: 10,
        summary: 'Faster, cheaper tasks. Good for well-scoped requests that need 3–5 tool calls.',
    },
    {
        value: 'normal',
        label: 'Normal',
        steps: 20,
        summary: 'Balanced default. Handles most tasks including multi-file changes and research.',
    },
    {
        value: 'thorough',
        label: 'Thorough',
        steps: 40,
        summary: 'Deep work. Use for large refactors, complex debugging, or multi-step investigations.',
    },
]

export function StepBudgetPicker({ workspaceId }: { workspaceId: string }) {
    const { data, mutate, isLoading } = useIntelligenceSettings(workspaceId)
    const [pending, setPending] = useState<StepBudget | null>(null)

    const current = data?.settings.stepBudget ?? 'normal'

    async function handlePick(budget: StepBudget) {
        if (budget === current || pending) return
        setPending(budget)
        try {
            await patchStepBudget(workspaceId, budget)
            await mutate()
            toast.success(`Step budget set to ${budget}`)
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Failed to update step budget')
        } finally {
            setPending(null)
        }
    }

    return (
        <div className="space-y-3">
            <div>
                <h3 className="text-sm font-medium text-text-primary flex items-center gap-2">
                    <Gauge className="h-4 w-4 text-text-muted" />
                    Step budget
                </h3>
                <p className="text-xs text-text-muted mt-0.5">
                    Maximum tool calls the agent may make per task. Conversational tasks use half this value.
                </p>
            </div>

            <div className="grid gap-2 sm:grid-cols-3">
                {BUDGET_OPTIONS.map(opt => {
                    const active = current === opt.value
                    const busy = pending === opt.value
                    return (
                        <button
                            key={opt.value}
                            type="button"
                            disabled={isLoading || pending !== null}
                            onClick={() => void handlePick(opt.value)}
                            aria-pressed={active}
                            className={`flex flex-col gap-1.5 rounded-sm border p-3 text-left transition-colors disabled:opacity-50 ${
                                active
                                    ? 'border-azure bg-surface-1 ring-1 ring-azure/40'
                                    : 'border-border bg-surface-1 hover:border-muted'
                            }`}
                        >
                            <div className="flex items-center justify-between">
                                <span className={`text-sm font-medium ${active ? 'text-azure' : 'text-text-primary'}`}>
                                    {opt.label}
                                </span>
                                <div className="flex items-center gap-1">
                                    {busy && <Loader2 className="h-3 w-3 animate-spin text-text-muted" />}
                                    <span className="text-[10px] font-mono text-text-muted">{opt.steps} steps</span>
                                </div>
                            </div>
                            <p className="text-[11px] text-text-muted leading-snug">{opt.summary}</p>
                        </button>
                    )
                })}
            </div>
        </div>
    )
}
