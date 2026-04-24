// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { useState, useEffect, useCallback } from 'react'
import { ShieldCheck, Copy, Check, RefreshCcw, X, AlertCircle, Loader2, Globe, AlertTriangle, ExternalLink } from 'lucide-react'
import { useWorkspace } from '@web/context/workspace'
import { useFocusTrap } from '@web/hooks/use-focus-trap'

const API_BASE = (typeof window !== 'undefined' ? '' : (process.env.INTERNAL_API_URL || 'http://localhost:3001'))

const ANALYTICS_MD_URL = 'https://github.com/joeybuilt-official/plexo/blob/main/docs/ANALYTICS.md'

// ── Types ─────────────────────────────────────────────────────────────────────

interface AnalyticsConfig {
    errorsEnabled: boolean
    usageEnabled: boolean
    instanceId: string
}

interface DataResidencyExtension {
    name: string
    type: string
    dataResidency?: {
        sendsDataExternally: boolean
        externalDestinations?: Array<{ host: string; purpose: string; dataTypes?: string[] }>
    }
}

interface LastPayload {
    errorType: string
    stackFrames: string[]
    pipelineStep: string | null
    taskCategory: string
    extensionName: string | null
    plexoVersion: string
    nodeVersion: string
    instanceId: string
}

// Example usage payload — generated from the allowlist, not hand-written
const EXAMPLE_USAGE_PAYLOAD = {
    event: 'agent_run_completed',
    distinct_id: '<anonymous-instance-uuid>',
    properties: {
        plexo_version: '<semver>',
        task_type: 'coding',
        model_family: 'anthropic',
        success: true,
        duration_bucket: '30s-2m',
        cost_bucket: '$0.01-$0.10',
        step_count_bucket: '1-9',
    },
    timestamp: new Date().toISOString(),
    '$lib': 'plexo-api',
}

// ── Section wrapper ───────────────────────────────────────────────────────────

function Section({ title, description, children }: {
    title: string
    description?: string
    children: React.ReactNode
}) {
    return (
        <div className="border-b border-border pb-8 last:border-0 last:pb-0">
            <div className="mb-5">
                <h2 className="text-base font-semibold text-text-primary">{title}</h2>
                {description && <p className="mt-1 text-sm text-text-muted">{description}</p>}
            </div>
            {children}
        </div>
    )
}

// ── Toggle ────────────────────────────────────────────────────────────────────

function Toggle({ id, checked, onChange, disabled }: {
    id: string
    checked: boolean
    onChange: (v: boolean) => void
    disabled?: boolean
}) {
    return (
        <button
            id={id}
            role="switch"
            aria-checked={checked}
            disabled={disabled}
            onClick={() => onChange(!checked)}
            className={`relative inline-flex h-8 w-14 shrink-0 cursor-pointer items-center rounded-full transition-colors duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-azure min-h-[44px] disabled:opacity-40 disabled:cursor-not-allowed ${checked ? 'bg-azure' : 'bg-surface-2'}`}
        >
            <span className={`inline-block h-6 w-6 transform rounded-full bg-white shadow transition-transform duration-200 ml-1 ${checked ? 'translate-x-[24px]' : 'translate-x-0'}`} />
        </button>
    )
}

// ── Modal ─────────────────────────────────────────────────────────────────────

function Modal({ open, onClose, title, children }: {
    open: boolean
    onClose: () => void
    title: string
    children: React.ReactNode
}) {
    const trapRef = useFocusTrap<HTMLDivElement>(open)

    useEffect(() => {
        const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
        if (open) document.addEventListener('keydown', handler)
        return () => document.removeEventListener('keydown', handler)
    }, [open, onClose])

    if (!open) return null

    return (
        <div
            ref={trapRef}
            className="fixed inset-0 z-50 flex items-center justify-center p-4"
            role="dialog"
            aria-modal="true"
            aria-labelledby="privacy-modal-title"
        >
            <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
            <div className="relative z-10 w-full max-w-2xl rounded-2xl border border-border bg-surface-1 shadow-2xl">
                <div className="flex items-center justify-between border-b border-border px-6 py-4">
                    <h3 id="privacy-modal-title" className="text-sm font-semibold text-text-primary">{title}</h3>
                    <button onClick={onClose} aria-label="Close dialog" className="rounded-lg p-1 text-text-muted hover:text-text-primary transition-colors min-h-[44px] min-w-[44px] flex items-center justify-center -mr-3">
                        <X className="h-5 w-5 sm:h-4 sm:w-4" />
                    </button>
                </div>
                <div className="p-6">{children}</div>
            </div>
        </div>
    )
}

// ── Error payload modal ───────────────────────────────────────────────────────

function ErrorPayloadModal({ open, onClose, enabled }: { open: boolean; onClose: () => void; enabled: boolean }) {
    const [payload, setPayload] = useState<LastPayload | null>(null)
    const [loading, setLoading] = useState(false)

    useEffect(() => {
        if (!open) return
        setLoading(true)
        fetch(`${API_BASE}/api/v1/analytics/payload`)
            .then(r => r.json() as Promise<{ payload: LastPayload | null }>)
            .then(d => setPayload(d.payload))
            .catch(() => setPayload(null))
            .finally(() => setLoading(false))
    }, [open])

    return (
        <Modal open={open} onClose={onClose} title="What gets sent — crash reports">
            {!enabled && (
                <div className="mb-4 flex items-start gap-2 rounded-lg border border-amber-900/50 bg-amber-dim/30 px-4 py-3 text-xs text-amber">
                    <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                    This is what would be sent if crash reporting were enabled. Nothing is being transmitted now.
                </div>
            )}
            {loading && (
                <div className="flex justify-center py-8">
                    <Loader2 className="h-5 w-5 animate-spin text-text-muted" />
                </div>
            )}
            {!loading && !payload && (
                <p className="py-6 text-center text-sm text-text-muted">No reports recorded yet.</p>
            )}
            {!loading && payload && (
                <pre className="overflow-auto rounded-xl bg-canvas border border-border p-4 text-xs font-mono text-azure leading-relaxed max-h-96">
                    {JSON.stringify(payload, null, 2)}
                </pre>
            )}
        </Modal>
    )
}

// ── Usage payload modal ───────────────────────────────────────────────────────

function UsagePayloadModal({ open, onClose, enabled }: { open: boolean; onClose: () => void; enabled: boolean }) {
    return (
        <Modal open={open} onClose={onClose} title="What gets sent — usage events">
            {!enabled && (
                <div className="mb-4 flex items-start gap-2 rounded-lg border border-amber-900/50 bg-amber-dim/30 px-4 py-3 text-xs text-amber">
                    <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                    This is what would be sent if usage sharing were enabled. Nothing is being transmitted now.
                </div>
            )}
            <p className="mb-3 text-xs text-text-muted">
                Example event. All events follow this structure — only properties from the allowlist are ever included.
            </p>
            <pre className="overflow-auto rounded-xl bg-canvas border border-border p-4 text-xs font-mono text-azure leading-relaxed max-h-96">
                {JSON.stringify(EXAMPLE_USAGE_PAYLOAD, null, 2)}
            </pre>
            <p className="mt-3 text-xs text-text-muted">
                10 event types total. See{' '}
                <a href={ANALYTICS_MD_URL} target="_blank" rel="noopener noreferrer" className="text-azure hover:underline">
                    ANALYTICS.md
                </a>
                {' '}for the full taxonomy and property allowlist.
            </p>
        </Modal>
    )
}

// ── Regenerate ID modal ───────────────────────────────────────────────────────

function RegenerateModal({ open, onClose, onConfirm, loading }: {
    open: boolean
    onClose: () => void
    onConfirm: () => void
    loading: boolean
}) {
    return (
        <Modal open={open} onClose={onClose} title="Regenerate anonymous instance ID">
            <p className="text-sm text-text-secondary leading-relaxed">
                Regenerating creates a new anonymous ID. This doesn&apos;t affect your data, but previous
                reports will no longer be associated with this instance.
            </p>
            <div className="mt-6 flex flex-col sm:flex-row gap-3">
                <button onClick={onClose} className="flex-1 rounded-xl border border-border py-2.5 text-sm text-text-secondary hover:border-border transition-colors min-h-[44px]">
                    Cancel
                </button>
                <button
                    id="privacy-confirm-regenerate"
                    onClick={onConfirm}
                    disabled={loading}
                    className="flex-1 rounded-xl bg-azure py-2.5 text-sm font-semibold text-text-primary hover:bg-azure/90 transition-colors disabled:opacity-40 flex items-center justify-center gap-2 min-h-[44px]"
                >
                    {loading && <Loader2 className="h-4 w-4 animate-spin" />}
                    {loading ? 'Regenerating…' : 'Regenerate ID'}
                </button>
            </div>
        </Modal>
    )
}

// ── Payload links ─────────────────────────────────────────────────────────────

function PayloadLinks({
    onViewError,
    onViewUsage,
}: {
    onViewError: () => void
    onViewUsage: () => void
}) {
    return (
        <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2">
            <button
                onClick={onViewError}
                className="text-xs text-azure hover:underline flex items-center gap-1"
            >
                See exactly what gets sent →
            </button>
            <a
                href={ANALYTICS_MD_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-text-muted hover:text-text-secondary flex items-center gap-1"
            >
                How this data is used <ExternalLink className="h-3 w-3" />
            </a>
        </div>
    )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function PrivacyPage() {
    const { workspaceId } = useWorkspace()

    const [config, setConfig] = useState<AnalyticsConfig>({ errorsEnabled: false, usageEnabled: false, instanceId: '' })
    const [loading, setLoading] = useState(true)
    const [savingErrors, setSavingErrors] = useState(false)
    const [savingUsage, setSavingUsage] = useState(false)
    const [lastSentAt, setLastSentAt] = useState<string | null>(null)
    const [copied, setCopied] = useState(false)
    const [showErrorPayload, setShowErrorPayload] = useState(false)
    const [showUsagePayload, setShowUsagePayload] = useState(false)
    const [showRegenerate, setShowRegenerate] = useState(false)
    const [regenerating, setRegenerating] = useState(false)
    const [drExtensions, setDrExtensions] = useState<DataResidencyExtension[]>([])

    const headers = {
        'content-type': 'application/json',
        ...(workspaceId ? { 'x-workspace-id': workspaceId } : {}),
    }

    const load = useCallback(async () => {
        if (!workspaceId) return
        setLoading(true)
        try {
            const r = await fetch(`${API_BASE}/api/v1/analytics`, {
                headers: { 'x-workspace-id': workspaceId },
            })
            if (r.ok) {
                const d = await r.json() as AnalyticsConfig
                setConfig(d)
            }
        } finally {
            setLoading(false)
        }
        try {
            const r2 = await fetch(`${API_BASE}/api/v1/analytics/payload`)
            const d = await r2.json() as { payload: (LastPayload & { timestamp?: string }) | null }
            setLastSentAt(d.payload?.timestamp ?? null)
        } catch { /* optional */ }
    }, [workspaceId])

    useEffect(() => { void load() }, [load])

    useEffect(() => {
        if (!workspaceId) return
        fetch(`${API_BASE}/api/v1/extensions?workspaceId=${workspaceId}`)
            .then(r => r.ok ? r.json() as Promise<{ items?: DataResidencyExtension[] } | DataResidencyExtension[]> : null)
            .then(d => {
                if (!d) return
                const items = Array.isArray(d) ? d : (d.items ?? [])
                setDrExtensions(items.filter(p => p.dataResidency))
            })
            .catch((err) => console.error('[settings/privacy] extensions fetch failed', err))
    }, [workspaceId])

    async function toggleErrors() {
        const next = !config.errorsEnabled
        setConfig(c => ({ ...c, errorsEnabled: next }))
        setSavingErrors(true)
        try {
            await fetch(`${API_BASE}/api/v1/analytics`, {
                method: 'POST',
                headers,
                body: JSON.stringify({ errorsEnabled: next }),
            })
        } finally {
            setSavingErrors(false)
        }
    }

    async function toggleUsage() {
        const next = !config.usageEnabled
        setConfig(c => ({ ...c, usageEnabled: next }))
        setSavingUsage(true)
        try {
            await fetch(`${API_BASE}/api/v1/analytics`, {
                method: 'POST',
                headers,
                body: JSON.stringify({ usageEnabled: next }),
            })
        } finally {
            setSavingUsage(false)
        }
    }

    async function copyId() {
        await navigator.clipboard.writeText(config.instanceId)
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
    }

    async function regenerateId() {
        setRegenerating(true)
        try {
            const r = await fetch(`${API_BASE}/api/v1/analytics/regenerate-id`, { method: 'POST', headers })
            if (r.ok) {
                const d = await r.json() as { instanceId: string }
                setConfig(c => ({ ...c, instanceId: d.instanceId }))
            }
        } finally {
            setRegenerating(false)
            setShowRegenerate(false)
        }
    }

    if (loading) {
        return (
            <div className="flex h-48 items-center justify-center">
                <Loader2 className="h-5 w-5 animate-spin text-text-muted" />
            </div>
        )
    }

    return (
        <>
            <ErrorPayloadModal open={showErrorPayload} onClose={() => setShowErrorPayload(false)} enabled={config.errorsEnabled} />
            <UsagePayloadModal open={showUsagePayload} onClose={() => setShowUsagePayload(false)} enabled={config.usageEnabled} />
            <RegenerateModal
                open={showRegenerate}
                onClose={() => setShowRegenerate(false)}
                onConfirm={() => void regenerateId()}
                loading={regenerating}
            />

            <div className="mx-auto max-w-2xl">
                <div className="mb-8 flex flex-col sm:flex-row sm:items-center gap-3">
                    <div className="flex h-12 w-12 sm:h-9 sm:w-9 shrink-0 items-center justify-center rounded-xl bg-surface-2 border border-border">
                        <ShieldCheck className="h-6 w-6 sm:h-5 sm:w-5 text-azure" />
                    </div>
                    <div>
                        <h1 className="text-2xl font-bold text-text-primary">Privacy</h1>
                        <p className="text-sm text-text-muted">You can change these at any time. Changes take effect immediately.</p>
                    </div>
                </div>

                <div className="flex flex-col gap-8 rounded-2xl border border-border bg-surface-1/60 p-7">

                    {/* ── Share crash reports ── */}
                    <Section title="Share crash reports">
                        <p className="text-sm text-text-secondary leading-relaxed mb-4">
                            If Plexo crashes or hits an unhandled error, a diagnostic report is sent to the Joeybuilt team.
                            The report contains technical details only — Plexo version, the error, and a stack trace.
                            No content, credentials, or personal data is ever included.
                        </p>
                        <p className="text-sm text-text-secondary leading-relaxed mb-5">
                            This is the fastest way for a bug on your instance to become a fix in the next release.
                            Without it, we only hear about problems when someone files a report manually.
                        </p>

                        <div className="flex flex-col sm:flex-row sm:items-center justify-between rounded-xl border border-border bg-canvas px-4 py-3.5 gap-4 sm:gap-0">
                            <div>
                                <p className="text-sm font-medium text-text-primary">
                                    {config.errorsEnabled ? 'Sending anonymous crash reports' : 'Crash reporting disabled'}
                                </p>
                                <p className="mt-0.5 text-xs text-text-muted">
                                    {lastSentAt
                                        ? `Last report: ${new Date(lastSentAt).toLocaleString()}`
                                        : 'No reports sent yet'}
                                </p>
                            </div>
                            <div className="flex items-center gap-3">
                                {savingErrors && <Loader2 className="h-4 w-4 sm:h-3.5 sm:w-3.5 animate-spin text-text-muted" />}
                                <Toggle id="privacy-errors-toggle" checked={config.errorsEnabled} onChange={() => void toggleErrors()} disabled={savingErrors} />
                            </div>
                        </div>

                        <p className="mt-3 text-xs text-text-muted leading-relaxed">
                            Reports are processed by Joeybuilt-managed infrastructure. Turning this off stops future reports immediately.
                            Data already received is retained for up to 90 days.
                        </p>

                        <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2">
                            <button
                                id="privacy-view-error-payload"
                                onClick={() => setShowErrorPayload(true)}
                                className="text-xs text-azure hover:underline"
                            >
                                See exactly what gets sent →
                            </button>
                            <a
                                href={ANALYTICS_MD_URL}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-xs text-text-muted hover:text-text-secondary flex items-center gap-1"
                            >
                                How this data is used <ExternalLink className="h-3 w-3" />
                            </a>
                        </div>
                    </Section>

                    {/* ── Share usage patterns ── */}
                    <Section title="Share usage patterns">
                        <p className="text-sm text-text-secondary leading-relaxed mb-4">
                            A small set of anonymous events — things like whether an agent run succeeded, or whether
                            onboarding completed — is sent to the Joeybuilt team. No content, credentials, IP addresses,
                            or identifying information is ever shared. Events are tied to a random ID generated on your
                            instance, not to you.
                        </p>
                        <p className="text-sm text-text-secondary leading-relaxed mb-5">
                            This tells us which parts of Plexo people actually use, where things break down, and what to
                            focus on. It&apos;s the difference between building what we assume people need and building
                            what the data shows they need.
                        </p>

                        <div className="flex flex-col sm:flex-row sm:items-center justify-between rounded-xl border border-border bg-canvas px-4 py-3.5 gap-4 sm:gap-0">
                            <div>
                                <p className="text-sm font-medium text-text-primary">
                                    {config.usageEnabled ? 'Sending anonymous usage events' : 'Usage sharing disabled'}
                                </p>
                                <p className="mt-0.5 text-xs text-text-muted">
                                    10 event types. No content, no identifiers.
                                </p>
                            </div>
                            <div className="flex items-center gap-3">
                                {savingUsage && <Loader2 className="h-4 w-4 sm:h-3.5 sm:w-3.5 animate-spin text-text-muted" />}
                                <Toggle id="privacy-usage-toggle" checked={config.usageEnabled} onChange={() => void toggleUsage()} disabled={savingUsage} />
                            </div>
                        </div>

                        <p className="mt-3 text-xs text-text-muted leading-relaxed">
                            Data is sent to Joeybuilt-managed infrastructure. Turning this off stops future events immediately.
                            Data already received is retained for up to 90 days.
                        </p>

                        <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2">
                            <button
                                id="privacy-view-usage-payload"
                                onClick={() => setShowUsagePayload(true)}
                                className="text-xs text-azure hover:underline"
                            >
                                See exactly what gets sent →
                            </button>
                            <a
                                href={ANALYTICS_MD_URL}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-xs text-text-muted hover:text-text-secondary flex items-center gap-1"
                            >
                                How this data is used <ExternalLink className="h-3 w-3" />
                            </a>
                        </div>
                    </Section>

                    {/* ── Instance ID ── */}
                    <Section
                        title="Anonymous Instance ID"
                        description="This ID is randomly generated at install. It is not linked to your identity, IP address, or any account."
                    >
                        <div className="flex flex-col sm:flex-row sm:items-center gap-2">
                            <input
                                id="privacy-instance-id"
                                readOnly
                                value={config.instanceId || '—'}
                                className="flex-1 rounded-lg border border-border bg-canvas px-3 py-2 text-[16px] sm:text-xs font-mono text-text-secondary focus-ring min-h-[44px]"
                            />
                            <button
                                id="privacy-copy-id"
                                onClick={() => void copyId()}
                                title="Copy to clipboard"
                                className="flex items-center justify-center rounded-lg border border-border bg-canvas p-2 text-text-muted hover:text-text-primary transition-colors min-h-[44px] sm:min-w-[44px] w-full sm:w-auto"
                            >
                                {copied ? <Check className="h-4 w-4 text-azure mr-2 sm:mr-0" /> : <Copy className="h-4 w-4 mr-2 sm:mr-0" />}
                                <span className="sm:hidden text-sm font-medium">{copied ? 'Copied' : 'Copy'}</span>
                            </button>
                        </div>

                        <button
                            id="privacy-regenerate-id"
                            onClick={() => setShowRegenerate(true)}
                            className="mt-3 flex items-center gap-1.5 text-sm sm:text-xs text-text-muted hover:text-text-secondary transition-colors min-h-[44px] px-2 -mx-2 w-fit"
                        >
                            <RefreshCcw className="h-3.5 w-3.5 sm:h-3 sm:w-3" />
                            Regenerate ID
                        </button>
                    </Section>

                    {/* ── Tool Data Residency ── */}
                    <Section
                        title="Extension Data Residency"
                        description="Which installed extensions (tools, connectors, skills) send data to external services, and where."
                    >
                        {drExtensions.length === 0 ? (
                            <p className="text-sm text-text-muted">No extensions have declared data residency information.</p>
                        ) : (
                            <div className="flex flex-col gap-3">
                                {drExtensions.map(p => {
                                    const dr = p.dataResidency!
                                    const hasUnknownDests = dr.sendsDataExternally && (!dr.externalDestinations || dr.externalDestinations.length === 0)
                                    return (
                                        <div key={p.name} className="rounded-xl border border-border bg-canvas p-4">
                                            <div className="flex items-center gap-2 mb-2">
                                                <span className="text-sm font-medium text-text-primary">{p.name}</span>
                                                <span className="text-[11px] rounded border border-border px-1.5 py-0.5 text-text-muted">{p.type}</span>
                                                {dr.sendsDataExternally ? (
                                                    <span className="flex items-center gap-1 text-[11px] text-amber">
                                                        <Globe className="h-3 w-3" /> Sends externally
                                                    </span>
                                                ) : (
                                                    <span className="text-[11px] text-azure">Local only</span>
                                                )}
                                                {hasUnknownDests && (
                                                    <span className="flex items-center gap-1 text-[11px] text-red">
                                                        <AlertTriangle className="h-3 w-3" /> Unknown destinations
                                                    </span>
                                                )}
                                            </div>
                                            {dr.externalDestinations && dr.externalDestinations.length > 0 && (
                                                <div className="flex flex-col gap-1">
                                                    {dr.externalDestinations.map((dest, i) => (
                                                        <div key={i} className="flex items-center gap-2 text-xs text-text-muted">
                                                            <span className="font-mono text-text-secondary">{dest.host}</span>
                                                            <span>— {dest.purpose}</span>
                                                        </div>
                                                    ))}
                                                </div>
                                            )}
                                        </div>
                                    )
                                })}
                            </div>
                        )}
                    </Section>

                    {/* ── Data We Don't Have ── */}
                    <Section title="Data We Don't Have">
                        <div className="rounded-xl border border-border bg-canvas p-5">
                            <p className="text-sm text-text-secondary leading-relaxed">
                                Because Plexo is self-hosted, we have no record of your tasks, workspace
                                configuration, or agent outputs. We have no access to your database, your
                                files, or your connected services.
                            </p>
                            <p className="mt-3 text-sm text-text-secondary leading-relaxed">
                                The only information we can receive is what you explicitly opt into above —
                                processed by Joeybuilt-managed infrastructure.
                            </p>
                            <div className="mt-5 grid grid-cols-1 sm:grid-cols-2 gap-3">
                                {[
                                    'Zero task content',
                                    'Zero workspace config',
                                    'Zero agent outputs',
                                    'Zero file access',
                                    'Zero database access',
                                    'Zero connected services',
                                ].map(item => (
                                    <div key={item} className="flex items-center gap-2 text-xs text-text-muted">
                                        <div className="h-1.5 w-1.5 rounded-full bg-azure/60" />
                                        {item}
                                    </div>
                                ))}
                            </div>
                        </div>
                    </Section>
                </div>
            </div>
        </>
    )
}
