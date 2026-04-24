// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { Users, Zap } from 'lucide-react'
import { Section, Field, FieldSelect } from './ui-primitives'
import type { WorkspaceSettings } from './types'

interface Props {
    settings: WorkspaceSettings
    updateSetting: <K extends keyof WorkspaceSettings>(key: K, value: WorkspaceSettings[K]) => void
}

export default function QualityTab({ settings, updateSetting }: Props) {
    return (
        <div className="flex flex-col gap-4">
            <Section title="Ensemble configuration" icon={Users}>
                <p className="text-sm text-text-secondary leading-relaxed">
                    When Ollama is configured, Plexo recruits multiple local models to independently
                    score each task&apos;s work. Their weighted votes form a consensus quality score,
                    decoupled from the executing agent&apos;s self-assessment.
                </p>

                <div className="grid grid-cols-2 gap-4">
                    <Field label="Ensemble size" description="Max judges recruited from your Ollama instance per task.">
                        <FieldSelect
                            value={settings.ensembleSize ?? 3}
                            onChange={e => updateSetting('ensembleSize', parseInt(e.target.value))}
                            className="rounded-lg border border-border bg-surface-1 px-3 py-2 text-sm text-text-primary focus:border-azure focus-ring w-fit"
                        >
                            {[1, 2, 3, 4, 5].map(n => (
                                <option key={n} value={n}>{n} judge{n !== 1 ? 's' : ''}</option>
                            ))}
                        </FieldSelect>
                    </Field>

                    <Field label="Dissent threshold" description="Score deviation that triggers cloud arbitration.">
                        <FieldSelect
                            value={settings.dissentThreshold ?? 0.25}
                            onChange={e => updateSetting('dissentThreshold', parseFloat(e.target.value))}
                            className="rounded-lg border border-border bg-surface-1 px-3 py-2 text-sm text-text-primary focus:border-azure focus-ring w-fit"
                        >
                            {[0.10, 0.15, 0.20, 0.25, 0.30, 0.40, 0.50].map(v => (
                                <option key={v} value={v}>{Math.round(v * 100)}pp</option>
                            ))}
                        </FieldSelect>
                    </Field>
                </div>

                <div className="rounded-lg border border-border bg-surface-1/40 p-4 flex flex-col gap-3">
                    <p className="text-xs font-semibold text-text-secondary uppercase tracking-wider">How it works</p>
                    <ol className="flex flex-col gap-2 text-xs text-text-muted list-none">
                        <li className="flex items-start gap-2">
                            <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-azure-900/50 text-[10px] font-bold text-azure">1</span>
                            Task completes → executor calls <code className="text-text-secondary">judgeQuality()</code>
                        </li>
                        <li className="flex items-start gap-2">
                            <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-azure-900/50 text-[10px] font-bold text-azure">2</span>
                            Ollama <code className="text-text-secondary">/api/tags</code> queried → up to <strong className="text-text-secondary">{settings.ensembleSize ?? 3}</strong> small models recruited
                        </li>
                        <li className="flex items-start gap-2">
                            <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-azure-900/50 text-[10px] font-bold text-azure">3</span>
                            All judges score the work in parallel — weighted by their <code className="text-text-secondary">reliabilityScore</code>
                        </li>
                        <li className="flex items-start gap-2">
                            <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-amber-900/50 text-[10px] font-bold text-amber">4</span>
                            If any judge diverges &gt; <strong className="text-amber">{Math.round((settings.dissentThreshold ?? 0.25) * 100)}pp</strong> from consensus → cloud arbitrator resolves
                        </li>
                        <li className="flex items-start gap-2">
                            <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-azure-900/50 text-[10px] font-bold text-azure">5</span>
                            Result stored in task context &middot; each judge&apos;s <code className="text-text-secondary">reliabilityScore</code> nudged &plusmn;0.5&ndash;1% based on agreement
                        </li>
                    </ol>
                </div>

                <div className="rounded-lg border border-border bg-surface-1/30 p-4 flex flex-col gap-2">
                    <p className="text-xs font-semibold text-text-secondary uppercase tracking-wider">Model preference order</p>
                    <div className="flex flex-wrap gap-1.5">
                        {['llama3.2', 'llama3.1', 'phi3', 'phi3.5', 'gemma2', 'gemma3', 'mistral', 'qwen2.5', 'deepseek-r1'].map((m) => (
                            <span key={m} className="rounded bg-surface-2 px-2 py-0.5 text-[11px] font-mono text-text-muted">{m}</span>
                        ))}
                    </div>
                    <p className="text-[11px] text-text-muted">Tried in priority order. First {settings.ensembleSize ?? 3} available win.</p>
                </div>

                <div className="rounded-lg border border-border bg-surface-1/40 p-4 flex flex-col gap-2">
                    <p className="text-xs font-semibold text-text-secondary uppercase tracking-wider">Fallback modes</p>
                    <div className="flex flex-col gap-1.5 text-xs text-text-muted">
                        {[
                            { mode: 'ensemble', color: 'bg-azure-900/30 text-azure', label: 'Ollama configured + models available + consensus reached' },
                            { mode: 'ensemble+arbitration', color: 'bg-amber-900/30 text-amber', label: 'Ensemble ran but judges disagreed — cloud resolved' },
                            { mode: 'single', color: 'bg-surface-2 text-text-secondary', label: 'Ollama not configured — single cheap cloud model judges' },
                            { mode: 'fallback', color: 'bg-surface-2 text-text-muted', label: 'All judges failed — self-reported score passed through' },
                        ].map(({ mode, color, label }) => (
                            <div key={mode} className="flex items-center gap-2">
                                <span className={`rounded px-1.5 py-0.5 ${color} font-mono text-[11px]`}>{mode}</span>
                                <span>{label}</span>
                            </div>
                        ))}
                    </div>
                </div>

                <a
                    href="/app/settings/intelligence/providers"
                    className="inline-flex items-center gap-1.5 text-xs text-azure hover:text-azure transition-colors"
                >
                    <Zap className="h-3.5 w-3.5" />
                    Configure Ollama in AI Providers →
                </a>
            </Section>
        </div>
    )
}
