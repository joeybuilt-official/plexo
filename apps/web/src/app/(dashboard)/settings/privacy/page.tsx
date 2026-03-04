'use client'

import { useState, useEffect, useCallback } from 'react'
import { ShieldCheck, Copy, Check, RefreshCcw, X, AlertCircle, Loader2 } from 'lucide-react'
import { useWorkspace } from '@web/context/workspace'

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'

// ── Types ─────────────────────────────────────────────────────────────────────

interface TelemetryConfig {
    enabled: boolean
    instanceId: string
}

interface LastPayload {
    errorType: string
    stackFrames: string[]
    pipelineStep: string | null
    taskCategory: string
    pluginName: string | null
    plexoVersion: string
    nodeVersion: string
    instanceId: string
}

// ── Section wrapper ───────────────────────────────────────────────────────────

function Section({ title, description, children }: {
    title: string
    description?: string
    children: React.ReactNode
}) {
    return (
        <div className="border-b border-zinc-800 pb-8 last:border-0 last:pb-0">
            <div className="mb-5">
                <h2 className="text-base font-semibold text-zinc-100">{title}</h2>
                {description && <p className="mt-1 text-sm text-zinc-500">{description}</p>}
            </div>
            {children}
        </div>
    )
}

// ── Toggle ────────────────────────────────────────────────────────────────────

function Toggle({ id, checked, onChange }: { id: string; checked: boolean; onChange: (v: boolean) => void }) {
    return (
        <button
            id={id}
            role="switch"
            aria-checked={checked}
            onClick={() => onChange(!checked)}
            className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-colors duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 ${checked ? 'bg-indigo-600' : 'bg-zinc-700'
                }`}
        >
            <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform duration-200 ml-0.5 ${checked ? 'translate-x-5' : 'translate-x-0'
                }`} />
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
    useEffect(() => {
        const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
        if (open) document.addEventListener('keydown', handler)
        return () => document.removeEventListener('keydown', handler)
    }, [open, onClose])

    if (!open) return null

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
            <div className="relative z-10 w-full max-w-2xl rounded-2xl border border-zinc-800 bg-zinc-900 shadow-2xl">
                <div className="flex items-center justify-between border-b border-zinc-800 px-6 py-4">
                    <h3 className="text-sm font-semibold text-zinc-100">{title}</h3>
                    <button onClick={onClose} className="rounded-lg p-1 text-zinc-500 hover:text-zinc-200 transition-colors">
                        <X className="h-4 w-4" />
                    </button>
                </div>
                <div className="p-6">{children}</div>
            </div>
        </div>
    )
}

// ── Payload viewer ────────────────────────────────────────────────────────────

function PayloadModal({ open, onClose, enabled }: { open: boolean; onClose: () => void; enabled: boolean }) {
    const [payload, setPayload] = useState<LastPayload | null>(null)
    const [loading, setLoading] = useState(false)

    useEffect(() => {
        if (!open) return
        setLoading(true)
        fetch(`${API_BASE}/api/telemetry/payload`)
            .then(r => r.json() as Promise<{ payload: LastPayload | null }>)
            .then(d => setPayload(d.payload))
            .catch(() => setPayload(null))
            .finally(() => setLoading(false))
    }, [open])

    return (
        <Modal open={open} onClose={onClose} title="Last crash report payload">
            {!enabled && (
                <div className="mb-4 flex items-start gap-2 rounded-lg border border-amber-900/50 bg-amber-950/30 px-4 py-3 text-xs text-amber-400">
                    <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                    This is what would be sent if crash reporting were enabled.
                </div>
            )}
            {loading && (
                <div className="flex justify-center py-8">
                    <Loader2 className="h-5 w-5 animate-spin text-zinc-600" />
                </div>
            )}
            {!loading && !payload && (
                <p className="py-6 text-center text-sm text-zinc-500">No reports recorded yet.</p>
            )}
            {!loading && payload && (
                <pre className="overflow-auto rounded-xl bg-zinc-950 border border-zinc-800 p-4 text-xs font-mono text-emerald-400 leading-relaxed max-h-96">
                    {JSON.stringify(payload, null, 2)}
                </pre>
            )}
        </Modal>
    )
}

// ── Regenerate ID confirm modal ───────────────────────────────────────────────

function RegenerateModal({ open, onClose, onConfirm, loading }: {
    open: boolean
    onClose: () => void
    onConfirm: () => void
    loading: boolean
}) {
    return (
        <Modal open={open} onClose={onClose} title="Regenerate anonymous instance ID">
            <p className="text-sm text-zinc-400 leading-relaxed">
                Regenerating creates a new anonymous ID. This doesn&apos;t affect your data, but previous
                bug reports will no longer be associated with this instance.
            </p>
            <div className="mt-6 flex gap-3">
                <button onClick={onClose} className="flex-1 rounded-xl border border-zinc-700 py-2.5 text-sm text-zinc-400 hover:border-zinc-600 transition-colors">
                    Cancel
                </button>
                <button
                    id="privacy-confirm-regenerate"
                    onClick={onConfirm}
                    disabled={loading}
                    className="flex-1 rounded-xl bg-indigo-600 py-2.5 text-sm font-semibold text-white hover:bg-indigo-500 transition-colors disabled:opacity-40 flex items-center justify-center gap-2"
                >
                    {loading && <Loader2 className="h-4 w-4 animate-spin" />}
                    {loading ? 'Regenerating…' : 'Regenerate ID'}
                </button>
            </div>
        </Modal>
    )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function PrivacyPage() {
    const { workspaceId } = useWorkspace()

    const [config, setConfig] = useState<TelemetryConfig>({ enabled: false, instanceId: '' })
    const [loading, setLoading] = useState(true)
    const [saving, setSaving] = useState(false)
    const [lastSentAt, setLastSentAt] = useState<string | null>(null)
    const [copied, setCopied] = useState(false)
    const [showPayload, setShowPayload] = useState(false)
    const [showRegenerate, setShowRegenerate] = useState(false)
    const [regenerating, setRegenerating] = useState(false)

    const headers = {
        'content-type': 'application/json',
        ...(workspaceId ? { 'x-workspace-id': workspaceId } : {}),
    }

    const load = useCallback(async () => {
        if (!workspaceId) return          // wait until context resolves
        setLoading(true)
        try {
            const r = await fetch(`${API_BASE}/api/telemetry`, {
                headers: { 'x-workspace-id': workspaceId },
            })
            if (r.ok) setConfig(await r.json() as TelemetryConfig)
        } finally {
            setLoading(false)
        }
        // Try to get last report timestamp from last payload
        try {
            const r2 = await fetch(`${API_BASE}/api/telemetry/payload`)
            const d = await r2.json() as { payload: (LastPayload & { timestamp?: string }) | null }
            setLastSentAt(d.payload?.timestamp ?? null)
        } catch { /* optional */ }
    }, [workspaceId])    // re-run when workspaceId becomes available

    useEffect(() => { void load() }, [load])

    async function toggleEnabled() {
        const next = !config.enabled
        setConfig(c => ({ ...c, enabled: next }))
        setSaving(true)
        try {
            await fetch(`${API_BASE}/api/telemetry`, {
                method: 'POST',
                headers,
                body: JSON.stringify({ enabled: next }),
            })
        } finally {
            setSaving(false)
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
            const r = await fetch(`${API_BASE}/api/telemetry/regenerate-id`, { method: 'POST', headers })
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
                <Loader2 className="h-5 w-5 animate-spin text-zinc-600" />
            </div>
        )
    }

    return (
        <>
            <PayloadModal open={showPayload} onClose={() => setShowPayload(false)} enabled={config.enabled} />
            <RegenerateModal
                open={showRegenerate}
                onClose={() => setShowRegenerate(false)}
                onConfirm={() => void regenerateId()}
                loading={regenerating}
            />

            <div className="mx-auto max-w-2xl">
                {/* Page header */}
                <div className="mb-8 flex items-center gap-3">
                    <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-zinc-800 border border-zinc-700">
                        <ShieldCheck className="h-5 w-5 text-indigo-400" />
                    </div>
                    <div>
                        <h1 className="text-xl font-bold text-zinc-50">Privacy</h1>
                        <p className="text-sm text-zinc-500">Control what Plexo reports and how it identifies your instance.</p>
                    </div>
                </div>

                <div className="flex flex-col gap-8 rounded-2xl border border-zinc-800 bg-zinc-900/60 p-7">

                    {/* ── Crash Reporting ── */}
                    <Section title="Crash Reporting">
                        <div className="flex items-center justify-between rounded-xl border border-zinc-800 bg-zinc-950 px-4 py-3.5">
                            <div>
                                <p className="text-sm font-medium text-zinc-200">
                                    {config.enabled
                                        ? 'Sending anonymous crash reports'
                                        : 'Crash reporting disabled'}
                                </p>
                                <p className="mt-0.5 text-xs text-zinc-600">
                                    {lastSentAt
                                        ? `Last report: ${new Date(lastSentAt).toLocaleString()}`
                                        : 'No reports sent yet'}
                                </p>
                            </div>
                            <div className="flex items-center gap-3">
                                {saving && <Loader2 className="h-3.5 w-3.5 animate-spin text-zinc-600" />}
                                <Toggle id="privacy-telemetry-toggle" checked={config.enabled} onChange={() => void toggleEnabled()} />
                            </div>
                        </div>

                        <button
                            id="privacy-view-last-report"
                            onClick={() => setShowPayload(true)}
                            className="mt-3 text-xs text-indigo-400 hover:text-indigo-300 transition-colors"
                        >
                            View last report →
                        </button>
                    </Section>

                    {/* ── Instance ID ── */}
                    <Section
                        title="Anonymous Instance ID"
                        description="This ID is randomly generated at install. It is not linked to your identity, IP address, or any account."
                    >
                        <div className="flex items-center gap-2">
                            <input
                                id="privacy-instance-id"
                                readOnly
                                value={config.instanceId || '—'}
                                className="flex-1 rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-xs font-mono text-zinc-400 focus:outline-none"
                            />
                            <button
                                id="privacy-copy-id"
                                onClick={() => void copyId()}
                                title="Copy to clipboard"
                                className="rounded-lg border border-zinc-800 bg-zinc-950 p-2 text-zinc-500 hover:text-zinc-200 transition-colors"
                            >
                                {copied ? <Check className="h-4 w-4 text-emerald-400" /> : <Copy className="h-4 w-4" />}
                            </button>
                        </div>

                        <button
                            id="privacy-regenerate-id"
                            onClick={() => setShowRegenerate(true)}
                            className="mt-3 flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
                        >
                            <RefreshCcw className="h-3 w-3" />
                            Regenerate ID
                        </button>
                    </Section>

                    {/* ── Data We Don't Have ── */}
                    <Section title="Data We Don't Have">
                        <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-5">
                            <p className="text-sm text-zinc-400 leading-relaxed">
                                Because Plexo is self-hosted, we have no record of your tasks, workspace
                                configuration, or agent outputs. We have no access to your database, your
                                files, or your connected services.
                            </p>
                            <p className="mt-3 text-sm text-zinc-400 leading-relaxed">
                                The only information we can receive is what you explicitly send via crash
                                reporting above.
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
                                    <div key={item} className="flex items-center gap-2 text-xs text-zinc-500">
                                        <div className="h-1.5 w-1.5 rounded-full bg-emerald-500/60" />
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
