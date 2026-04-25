// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

export const dynamic = 'force-dynamic'

/**
 * Phase 6 — first-run wizard (redesigned).
 *
 * Two-column layout:
 *   Left rail (320px): brand + numbered step checklist with status
 *                      icons (done/active/upcoming) + skip link
 *   Right column (1fr): single focused step body, vertically centered
 *                       so it sits at eye level on tall viewports
 *   Sticky footer: Back · counter · Continue (full width)
 *
 * Replaces the original single-column pill-rail layout that left
 * ~600px of empty vertical space and pushed content into the
 * right half of wide viewports via mx-auto + max-w-3xl. The new
 * layout uses the full content area and gives every step a strong
 * visual focus.
 */

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import {
    Loader2, CheckCircle2, XCircle, HelpCircle, Wand2, Database,
    BrainCircuit, Network, DollarSign, Sparkles, ArrowRight, ArrowLeft,
    Search, Check, Circle,
} from 'lucide-react'
import { useWorkspace } from '@web/context/workspace'
import {
    useDetect, completeWizard,
    type DetectResponse, type DetectServiceProbe,
} from '@web/lib/intelligence-dashboard-client'
import {
    patchInferenceMode, patchCostCeiling,
    type InferenceMode,
} from '@web/lib/intelligence-client'
import { patchSclSettings } from '@web/lib/scl-client'

type StepKey = 'detect' | 'embeddings' | 'routing' | 'scl' | 'budget' | 'done'

interface StepDef {
    key: StepKey
    title: string
    blurb: string
    icon: typeof Network
}

const STEPS: StepDef[] = [
    { key: 'detect',     title: 'Detect',     blurb: 'See what\'s available',    icon: Search },
    { key: 'embeddings', title: 'Embeddings', blurb: 'Power memory & SCL',       icon: Database },
    { key: 'routing',    title: 'Routing',    blurb: 'Pick how Plexo picks',     icon: Network },
    { key: 'scl',        title: 'Memory',     blurb: 'Concept clustering',       icon: BrainCircuit },
    { key: 'budget',     title: 'Budget',     blurb: 'Set your monthly ceiling', icon: DollarSign },
    { key: 'done',       title: 'Finish',     blurb: 'Land on the dashboard',    icon: Sparkles },
]

const STEP_ORDER: StepKey[] = STEPS.map(s => s.key)

export default function FirstRunWizardPage() {
    const router = useRouter()
    const { workspaceId } = useWorkspace()
    const wsId = workspaceId || null
    const [step, setStep] = useState<StepKey>('detect')
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const [embeddingsChoice, setEmbeddingsChoice] = useState<string | null>(null)
    const [inferenceMode, setInferenceMode] = useState<InferenceMode>('auto')
    const [sclEnabled] = useState(true)
    const [budgetUsd, setBudgetUsd] = useState<number>(20)

    const { data: detect, isLoading: detectLoading, mutate: refetchDetect } = useDetect(wsId)

    if (!wsId) {
        return (
            <div className="flex h-full items-center justify-center p-8">
                <div className="rounded-sm border border-border bg-surface-1 p-6 text-sm text-text-muted">
                    Pick a workspace from the sidebar to start the wizard.
                </div>
            </div>
        )
    }

    const stepIndex = STEP_ORDER.indexOf(step)
    const isLast = step === 'done'

    function goNext() {
        const i = STEP_ORDER.indexOf(step)
        if (i < STEP_ORDER.length - 1) setStep(STEP_ORDER[i + 1]!)
    }
    function goBack() {
        const i = STEP_ORDER.indexOf(step)
        if (i > 0) setStep(STEP_ORDER[i - 1]!)
    }

    async function persistAndAdvance() {
        if (!wsId) return
        setBusy(true); setError(null)
        try {
            if (step === 'embeddings') {
                goNext()
            } else if (step === 'routing') {
                await patchInferenceMode(wsId, inferenceMode); goNext()
            } else if (step === 'scl') {
                await patchSclSettings(wsId, { enabled: sclEnabled }); goNext()
            } else if (step === 'budget') {
                await patchCostCeiling(wsId, { ceilingUsd: budgetUsd, mode: 'soft_warn' }); goNext()
            } else {
                goNext()
            }
        } catch (err: unknown) {
            setError(String((err as Error)?.message ?? 'Failed to save step'))
        } finally {
            setBusy(false)
        }
    }

    async function finish() {
        if (!wsId) return
        setBusy(true); setError(null)
        try {
            await completeWizard(wsId)
            router.push('/app/intelligence')
        } catch (err: unknown) {
            setError(String((err as Error)?.message ?? 'Failed to complete wizard'))
        } finally {
            setBusy(false)
        }
    }

    return (
        <div className="flex h-full flex-col bg-canvas">
            {/* Ambient gradient backdrop — subtle, pinned to the top, fades out fast. */}
            <div
                aria-hidden
                className="pointer-events-none absolute inset-x-0 top-0 h-64 bg-azure/5"
            />

            <div className="relative flex flex-1 overflow-hidden">
                {/* ── Left rail ─────────────────────────────────────────── */}
                <aside className="relative hidden w-[320px] shrink-0 flex-col border-r border-border/80 bg-surface-1/60 lg:flex">
                    {/* Brand row */}
                    <div className="relative border-b border-border/80 px-6 py-6">
                        <div className="flex items-center gap-3">
                            <div className="relative flex h-10 w-10 items-center justify-center rounded-sm border border-azure/40 bg-azure/10 text-azure">
                                <Wand2 className="h-5 w-5" />
                                <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-azure" />
                            </div>
                            <div className="min-w-0">
                                <div className="text-[13px] font-medium tracking-tight text-text-primary">First-run setup</div>
                                <div className="text-[11px] text-text-muted">Under 60 seconds</div>
                            </div>
                        </div>
                    </div>

                    {/* Step rail with connecting line */}
                    <nav className="relative flex-1 overflow-y-auto px-4 py-5">
                        <ol className="relative space-y-0.5">
                            {/* Vertical connector line behind the badges */}
                            <div
                                aria-hidden
                                className="absolute left-[30px] top-4 bottom-4 w-px bg-border"
                            />
                            {STEPS.map((s, i) => {
                                const status: 'done' | 'active' | 'upcoming' =
                                    i < stepIndex ? 'done' : i === stepIndex ? 'active' : 'upcoming'
                                const StepIcon = s.icon
                                return (
                                    <li key={s.key} className="relative">
                                        <button
                                            type="button"
                                            onClick={() => setStep(s.key)}
                                            className={`group relative flex w-full items-start gap-3 rounded-sm px-3 py-3 text-left transition-all ${
                                                status === 'active'
                                                    ? 'bg-azure/5'
                                                    : 'hover:bg-canvas/60'
                                            }`}
                                        >
                                            <StepBadge index={i + 1} status={status} icon={StepIcon} />
                                            <div className="min-w-0 flex-1 pt-0.5">
                                                <div className={`text-[13px] font-medium tracking-tight transition-colors ${
                                                    status === 'active'
                                                        ? 'text-text-primary'
                                                        : status === 'done'
                                                            ? 'text-text-primary/70'
                                                            : 'text-text-muted group-hover:text-text-primary/80'
                                                }`}>
                                                    {s.title}
                                                </div>
                                                <div className="truncate text-[11px] text-text-muted">{s.blurb}</div>
                                            </div>
                                            {status === 'active' && (
                                                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-azure">
                                                    <ArrowRight className="h-3 w-3" />
                                                </span>
                                            )}
                                        </button>
                                    </li>
                                )
                            })}
                        </ol>
                    </nav>

                    <div className="border-t border-border/80 px-6 py-4">
                        <Link
                            href="/app/intelligence"
                            className="block text-center text-[11px] text-text-muted transition-colors hover:text-text-primary"
                        >
                            Skip and go to dashboard
                        </Link>
                    </div>
                </aside>

                {/* ── Right column ──────────────────────────────────────── */}
                <main className="flex flex-1 flex-col overflow-hidden">
                    {/* Mobile-only header — desktop hides this; rail covers it */}
                    <div className="flex items-center justify-between border-b border-border bg-surface-1 p-4 lg:hidden">
                        <div className="flex items-center gap-2">
                            <Wand2 className="h-4 w-4 text-azure" />
                            <span className="text-sm font-medium text-text-primary">First-run setup</span>
                        </div>
                        <Link href="/app/intelligence" className="text-[11px] text-text-muted hover:text-text-primary">Skip</Link>
                    </div>

                    <div className="flex-1 overflow-y-auto">
                        <div className="mx-auto flex min-h-full w-full max-w-[640px] flex-col justify-center px-8 py-12">
                            {step === 'detect' && (
                                <DetectStep
                                    data={detect ?? null}
                                    loading={detectLoading}
                                    onSeedRecommendations={(d) => {
                                        if (d.recommendations.embeddingsProvider) {
                                            setEmbeddingsChoice(d.recommendations.embeddingsProvider)
                                        }
                                        setInferenceMode((d.recommendations.inferenceMode as InferenceMode) ?? 'auto')
                                        // SCL always on — ignore recommendation
                                        setBudgetUsd(d.recommendations.costCeilingUsd ?? 20)
                                    }}
                                    onRefresh={() => refetchDetect()}
                                />
                            )}
                            {step === 'embeddings' && (
                                <EmbeddingsStep
                                    data={detect ?? null}
                                    choice={embeddingsChoice}
                                    onChange={setEmbeddingsChoice}
                                />
                            )}
                            {step === 'routing' && <RoutingStep mode={inferenceMode} onChange={setInferenceMode} />}
                            {step === 'scl' && <SclStep enabled={sclEnabled} onChange={() => {}} />}
                            {step === 'budget' && <BudgetStep value={budgetUsd} onChange={setBudgetUsd} />}
                            {step === 'done' && <DoneStep />}

                            {error && (
                                <div className="mt-6 rounded-sm border border-rose-700/40 bg-surface-1 p-3 text-xs text-rose-300">
                                    {error}
                                </div>
                            )}
                        </div>
                    </div>
                </main>
            </div>

            {/* ── Sticky footer ─────────────────────────────────────────── */}
            <footer className="relative border-t border-border/80 bg-surface-1/60">
                {/* Thin accent line along the top of the footer */}
                <div
                    aria-hidden
                    className="pointer-events-none absolute inset-x-0 top-0 h-px bg-azure/10"
                />
                <div className="flex items-center justify-between px-6 py-4">
                    <button
                        type="button"
                        onClick={goBack}
                        disabled={stepIndex === 0 || busy}
                        className="inline-flex items-center gap-1.5 rounded-sm border border-border bg-canvas px-3.5 py-2 text-xs font-medium text-text-muted transition-all hover:border-border/60 hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-30"
                    >
                        <ArrowLeft className="h-3.5 w-3.5" /> Back
                    </button>
                    <div className="flex items-center gap-2 text-[11px] tabular-nums text-text-muted">
                        <div className="flex items-center gap-1">
                            {STEPS.map((_, i) => (
                                <span
                                    key={i}
                                    className={`h-1 rounded-full transition-all ${
                                        i < stepIndex
                                            ? 'w-6 bg-azure/60'
                                            : i === stepIndex
                                                ? 'w-8 bg-azure'
                                                : 'w-6 bg-border'
                                    }`}
                                />
                            ))}
                        </div>
                        <span className="ml-2">
                            Step <span className="text-text-primary">{stepIndex + 1}</span> of {STEPS.length}
                        </span>
                    </div>
                    {isLast ? (
                        <button
                            type="button"
                            onClick={finish}
                            disabled={busy}
                            className="inline-flex items-center gap-1.5 rounded-sm border border-azure/60 bg-azure/15 px-5 py-2 text-xs font-medium text-azure transition-all disabled:opacity-40"
                        >
                            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                            Finish setup <ArrowRight className="h-3.5 w-3.5" />
                        </button>
                    ) : (
                        <button
                            type="button"
                            onClick={persistAndAdvance}
                            disabled={busy || (step === 'detect' && (!detect || detectLoading))}
                            className="inline-flex items-center gap-1.5 rounded-sm border border-azure/60 bg-azure/15 px-5 py-2 text-xs font-medium text-azure transition-all disabled:opacity-40"
                        >
                            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                            Continue <ArrowRight className="h-3.5 w-3.5" />
                        </button>
                    )}
                </div>
            </footer>
        </div>
    )
}

// ── Step badge ──────────────────────────────────────────────────────────

function StepBadge({
    index, status, icon: Icon,
}: {
    index: number
    status: 'done' | 'active' | 'upcoming'
    icon: typeof Network
}) {
    if (status === 'done') {
        return (
            <span className="relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-azure/50 bg-azure/15 text-azure">
                <Check className="h-3.5 w-3.5" strokeWidth={3} />
            </span>
        )
    }
    if (status === 'active') {
        return (
            <span className="relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-azure bg-azure/10 text-azure">
                <Icon className="h-3.5 w-3.5" />
            </span>
        )
    }
    return (
        <span className="relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border bg-canvas text-[11px] font-medium text-text-muted">
            {index}
        </span>
    )
}

// ── Step header primitive ───────────────────────────────────────────────

function StepHeader({ icon: Icon, title, body }: { icon: typeof Network; title: string; body: string }) {
    return (
        <div className="mb-8">
            <div className="relative mb-4 inline-flex h-12 w-12 items-center justify-center rounded-sm border border-azure/40 bg-azure/10 text-azure">
                <Icon className="h-5 w-5" />
                <span className="absolute inset-0 rounded-sm ring-1 ring-azure/10" />
            </div>
            <h2 className="text-[26px] font-medium leading-tight tracking-tight text-text-primary">{title}</h2>
            <p className="mt-2 max-w-xl text-[13px] leading-relaxed text-text-muted">{body}</p>
        </div>
    )
}

// ── Step 1 — detect ─────────────────────────────────────────────────────

function DetectStep({
    data, loading, onSeedRecommendations, onRefresh,
}: {
    data: DetectResponse | null
    loading: boolean
    onSeedRecommendations: (d: DetectResponse) => void
    onRefresh: () => void
}) {
    const [seeded, setSeeded] = useState(false)
    if (data && !seeded) {
        onSeedRecommendations(data)
        setSeeded(true)
    }

    if (loading || !data) {
        return (
            <div>
                <StepHeader icon={Search} title="Detecting your environment" body="Probing services and provider keys…" />
                <div className="rounded-sm border border-border bg-surface-1 p-6 text-center text-xs text-text-muted">
                    <Loader2 className="mr-2 inline h-3.5 w-3.5 animate-spin" /> Probing services…
                </div>
            </div>
        )
    }

    const services = [data.services.postgres, data.services.pgvector, data.services.embeddings, data.services.ollama]
    return (
        <div>
            <StepHeader
                icon={Search}
                title="Detected environment"
                body="Plexo probed your local services and provider keys. Anything missing here can be added later in Settings."
            />

            <div className="space-y-4">
                <div className="rounded-sm border border-border bg-surface-1">
                    <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
                        <span className="text-xs font-medium text-text-primary">Services</span>
                        <button
                            type="button"
                            onClick={onRefresh}
                            className="text-[11px] text-text-muted hover:text-text-primary"
                        >
                            Re-probe
                        </button>
                    </div>
                    <div className="grid gap-2 p-3 sm:grid-cols-2">
                        {services.map(s => <ServiceRow key={s.name} probe={s} />)}
                    </div>
                </div>

                <div className="rounded-sm border border-border bg-surface-1 p-4">
                    <div className="flex items-center justify-between">
                        <span className="text-xs font-medium text-text-primary">Provider keys</span>
                        <span className="text-[11px] text-text-muted">
                            {data.providers.enabled} enabled · {data.providers.withChat} chat · {data.providers.withEmbedding} embedding
                        </span>
                    </div>
                    {data.providers.items.length === 0 ? (
                        <p className="mt-2 text-[11px] text-text-muted">
                            No provider instances yet. Add one in Settings → AI Providers, then come back here.
                        </p>
                    ) : (
                        <div className="mt-3 flex flex-wrap gap-1.5">
                            {data.providers.items.map(p => (
                                <span
                                    key={p.id}
                                    className={`rounded-md border px-2 py-0.5 text-[11px] ${
                                        p.enabled
                                            ? 'border-emerald-700/40 text-emerald-300'
                                            : 'border-border text-text-muted'
                                    }`}
                                >
                                    {p.providerType}{p.nickname ? ` · ${p.nickname}` : ''}
                                </span>
                            ))}
                        </div>
                    )}
                </div>
            </div>
        </div>
    )
}

function ServiceRow({ probe }: { probe: DetectServiceProbe }) {
    const Icon = probe.status === 'up' ? CheckCircle2 : probe.status === 'down' ? XCircle : HelpCircle
    const tone = probe.status === 'up'
        ? 'border-emerald-700/40 text-emerald-300'
        : probe.status === 'down'
            ? 'border-rose-700/40 text-rose-300'
            : 'border-border text-text-muted'
    return (
        <div className={`flex items-center justify-between rounded-md border bg-canvas px-3 py-2 ${tone}`}>
            <div className="flex items-center gap-2">
                <Icon className="h-3.5 w-3.5" />
                <span className="text-xs text-text-primary">{probe.name}</span>
            </div>
            <div className="text-[11px] text-text-muted">
                {probe.latencyMs != null ? `${probe.latencyMs}ms` : (probe.detail ?? '—')}
            </div>
        </div>
    )
}

// ── Step 2 — embeddings ─────────────────────────────────────────────────

function EmbeddingsStep({
    data, choice, onChange,
}: {
    data: DetectResponse | null
    choice: string | null
    onChange: (s: string) => void
}) {
    const localUp = data?.services.embeddings.status === 'up'
    const byoProviders = data?.providers.items.filter(p => p.enabled && p.hasEmbeddingModel) ?? []

    return (
        <div>
            <StepHeader
                icon={Database}
                title="Pick an embeddings provider"
                body="Embeddings power memory recall and SCL expansion. Local is free and private; BYO keys are hosted but cheap. You can change this later in Settings → Intelligence → Embeddings."
            />
            <div className="grid gap-3 sm:grid-cols-2">
                <ChoiceTile
                    icon={Database}
                    active={choice === 'local'}
                    disabled={!localUp}
                    onClick={() => onChange('local')}
                    title="Local"
                    badge="Recommended"
                    body={localUp
                        ? 'snowflake-arctic-embed via the on-box embeddings server. Free, private, no API key.'
                        : 'EMBEDDINGS_URL not reachable. Enable the local-embeddings compose profile to use this.'
                    }
                />
                <ChoiceTile
                    icon={Sparkles}
                    active={choice !== null && choice !== 'local'}
                    disabled={byoProviders.length === 0}
                    onClick={() => byoProviders[0] && onChange(byoProviders[0].providerType)}
                    title="BYO key"
                    body={byoProviders.length > 0
                        ? `Use ${byoProviders[0]!.providerType} (${byoProviders.length} embedding-capable provider${byoProviders.length === 1 ? '' : 's'} configured).`
                        : 'No embedding-capable provider keys yet. Add one in Settings → AI Providers.'
                    }
                />
            </div>
        </div>
    )
}

// ── Step 3 — routing ────────────────────────────────────────────────────

function RoutingStep({ mode, onChange }: { mode: InferenceMode; onChange: (m: InferenceMode) => void }) {
    const modes: Array<{ key: InferenceMode; title: string; body: string; badge?: string }> = [
        { key: 'auto',     title: 'Auto',     badge: 'Recommended', body: 'Plexo picks the cheapest capable model per task. Smart defaults already seeded.' },
        { key: 'byok',     title: 'BYO keys', body: 'Use only your provider keys. Same chain editor, no managed fallback.' },
        { key: 'proxy',    title: 'Proxy',    body: 'Send everything through the Plexo-managed proxy. No keys needed.' },
        { key: 'override', title: 'Override', body: 'Pin a single model for everything. Advanced — easy to misconfigure.' },
    ]
    return (
        <div>
            <StepHeader
                icon={Network}
                title="Pick an inference mode"
                body="Defaults are sensible — keep auto and the per-task-type chains will handle everything. Customize in Settings → Intelligence → Routing."
            />
            <div className="grid gap-3 sm:grid-cols-2">
                {modes.map(m => (
                    <ChoiceTile
                        key={m.key}
                        icon={Network}
                        active={mode === m.key}
                        onClick={() => onChange(m.key)}
                        title={m.title}
                        badge={m.badge}
                        body={m.body}
                    />
                ))}
            </div>
        </div>
    )
}

// ── Step 4 — SCL ────────────────────────────────────────────────────────

function SclStep({ enabled, onChange }: { enabled: boolean; onChange: (b: boolean) => void }) {
    return (
        <div>
            <StepHeader
                icon={BrainCircuit}
                title="Semantic Concept Lattice (SCL)"
                body="SCL clusters your workspace memory into concept attractors so the agent can recall related ideas, not just exact matches. Off is fine for hobbyists; on is recommended for power users."
            />
            <div className="grid gap-3 sm:grid-cols-2">
                <ChoiceTile
                    icon={Circle}
                    active={!enabled}
                    onClick={() => onChange(false)}
                    title="Off"
                    badge="Default"
                    body="Skip SCL. Memory still works — recall is plain vector similarity."
                />
                <ChoiceTile
                    icon={BrainCircuit}
                    active={enabled}
                    onClick={() => onChange(true)}
                    title="On"
                    body="Enable concept clustering, drift triage, RSI proposals. Adds light background work."
                />
            </div>
        </div>
    )
}

// ── Step 5 — budget ─────────────────────────────────────────────────────

function BudgetStep({ value, onChange }: { value: number; onChange: (n: number) => void }) {
    const presets = [5, 20, 100, 500]
    return (
        <div>
            <StepHeader
                icon={DollarSign}
                title="Monthly budget"
                body="Soft warn at 80% and 100% — Plexo doesn't block requests by default. Switch to hard block in Settings → Intelligence → Routing if you need a strict ceiling."
            />
            <div className="rounded-sm border border-border bg-surface-1 p-6">
                <div className="flex items-baseline justify-between">
                    <span className="text-xs uppercase tracking-wide text-text-muted">Monthly ceiling</span>
                    <span className="text-3xl font-medium tabular-nums text-text-primary">${value.toFixed(0)}</span>
                </div>
                <input
                    type="range"
                    min={1}
                    max={1000}
                    step={1}
                    value={value}
                    onChange={e => onChange(Number(e.target.value))}
                    className="mt-4 w-full accent-azure"
                />
                <div className="mt-4 flex flex-wrap gap-2">
                    {presets.map(p => (
                        <button
                            key={p}
                            type="button"
                            onClick={() => onChange(p)}
                            className={`rounded-md border px-3 py-1 text-xs transition-colors ${
                                value === p
                                    ? 'border-azure bg-azure/10 text-azure ring-1 ring-azure/30'
                                    : 'border-border bg-canvas text-text-muted hover:text-text-primary'
                            }`}
                        >
                            ${p}
                        </button>
                    ))}
                </div>
            </div>
        </div>
    )
}

// ── Step 6 — done ───────────────────────────────────────────────────────

function DoneStep() {
    return (
        <div className="text-center">
            <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-full border border-azure/40 bg-azure/10 text-azure">
                <Sparkles className="h-7 w-7" />
            </div>
            <h2 className="text-2xl font-medium text-text-primary">You&apos;re ready</h2>
            <p className="mx-auto mt-2 max-w-sm text-sm text-text-muted">
                Plexo&apos;s intelligence stack is configured. Click finish to land on the dashboard —
                you&apos;ll see live providers, health, and inference logs from there.
            </p>
        </div>
    )
}

// ── Choice tile primitive ───────────────────────────────────────────────

function ChoiceTile({
    icon: Icon, active, disabled, onClick, title, body, badge,
}: {
    icon: typeof Network
    active: boolean | null
    disabled?: boolean
    onClick: () => void
    title: string
    body: string
    badge?: string
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            className={`group relative flex flex-col gap-4 overflow-hidden rounded-sm border p-5 text-left transition-all duration-200 disabled:cursor-not-allowed disabled:opacity-50 ${
                active
                    ? 'border-azure/70 bg-azure/5'
                    : 'border-border bg-surface-1 hover:border-azure/40 hover:bg-surface-1/80'
            }`}
        >
            {/* Subtle gradient sheen on active */}
            {active && (
                <div
                    aria-hidden
                    className="pointer-events-none absolute inset-0 bg-azure/5"
                />
            )}
            <div className="relative flex items-center justify-between">
                <div className={`flex h-10 w-10 items-center justify-center rounded-sm border transition-all ${
                    active
                        ? 'border-azure/50 bg-azure/15 text-azure'
                        : 'border-border bg-canvas text-text-muted group-hover:border-azure/30 group-hover:text-text-primary'
                }`}>
                    <Icon className="h-4 w-4" />
                </div>
                {badge && (
                    <span className={`rounded-sm border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider transition-colors ${
                        active
                            ? 'border-azure/40 bg-azure/15 text-azure'
                            : 'border-azure/25 bg-azure/5 text-azure/80'
                    }`}>
                        {badge}
                    </span>
                )}
                {active && !badge && (
                    <span className="flex h-6 w-6 items-center justify-center rounded-full bg-azure/20 text-azure">
                        <Check className="h-3.5 w-3.5" strokeWidth={3} />
                    </span>
                )}
            </div>
            <div className="relative">
                <div className={`text-[15px] font-medium tracking-tight transition-colors ${active ? 'text-text-primary' : 'text-text-primary/90'}`}>
                    {title}
                </div>
                <div className="mt-1.5 text-[12px] leading-relaxed text-text-muted">{body}</div>
            </div>
        </button>
    )
}
