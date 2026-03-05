'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Check, ChevronRight, ChevronDown, Loader2, ExternalLink, AlertCircle, ShieldCheck, X } from 'lucide-react'

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'

type Step = 'welcome' | 'workspace' | 'anthropic' | 'test' | 'telemetry' | 'done'

const STEPS: Step[] = ['welcome', 'workspace', 'anthropic', 'test', 'telemetry', 'done']
const STEP_LABELS = ['Welcome', 'Workspace', 'Anthropic', 'Test', 'Privacy', 'Done']

function StepIndicator({ current }: { current: Step }) {
    const idx = STEPS.indexOf(current)
    return (
        <div className="flex items-center gap-2 mb-8 flex-wrap">
            {STEPS.slice(0, -1).map((s, i) => (
                <div key={s} className="flex items-center gap-2">
                    <div className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold transition-all ${i < idx ? 'bg-indigo-600 text-white' :
                        i === idx ? 'border-2 border-indigo-500 text-indigo-400' :
                            'border border-zinc-700 text-zinc-600'
                        }`}>
                        {i < idx ? <Check className="h-3.5 w-3.5" /> : i + 1}
                    </div>
                    <span className={`text-xs ${i === idx ? 'text-zinc-200 font-medium' : 'text-zinc-600'}`}>
                        {STEP_LABELS[i]}
                    </span>
                    {i < STEPS.length - 2 && <ChevronRight className="h-3 w-3 text-zinc-700" />}
                </div>
            ))}
        </div>
    )
}

const COLLECT_ROWS = [
    ['Error type and stack trace', 'Task content or goals'],
    ['Which step failed (PLAN / CONFIRM / EXECUTE / VERIFY)', 'Workspace or user names'],
    ['Task category (coding, research, ops — not the task itself)', 'Channel handles or credentials'],
    ['Plugin name if a plugin crashed', 'File paths containing your data'],
    ['Plexo version + Node version', 'Tool call arguments'],
    ['Anonymous instance ID (random UUID, generated at install)', 'Memory entries or outputs'],
]

function TelemetryStep({ workspaceId, onComplete }: { workspaceId: string | null; onComplete: () => void }) {
    const [enabled, setEnabled] = useState(false)
    const [expanded, setExpanded] = useState(false)
    const [saving, setSaving] = useState(false)

    async function save() {
        setSaving(true)
        try {
            await fetch(`${API_BASE}/api/v1/telemetry`, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    ...(workspaceId ? { 'x-workspace-id': workspaceId } : {}),
                },
                body: JSON.stringify({ enabled }),
            })
        } catch {
            // Non-fatal — user preference is stored optimistically
        } finally {
            setSaving(false)
            onComplete()
        }
    }

    return (
        <div className="flex flex-col gap-6">
            <div>
                <div className="flex items-center gap-2 mb-1">
                    <ShieldCheck className="h-5 w-5 text-indigo-400" />
                    <h2 className="text-lg font-bold text-zinc-50">Help us fix bugs faster</h2>
                </div>
                <p className="text-sm text-zinc-400 leading-relaxed">
                    Plexo is self-hosted — your data stays on your machine. This is optional, anonymous crash
                    reporting that helps us identify where things break.
                </p>
                <p className="mt-3 text-sm text-zinc-400 leading-relaxed">
                    If you enable this, when Plexo encounters an error, a sanitized report is sent to our
                    servers. No task content, no credentials, no file paths, no workspace names — ever. The
                    stripping happens on your machine before anything leaves.
                </p>
                <p className="mt-3 text-sm text-zinc-400 leading-relaxed">
                    You can change this at any time in{' '}
                    <span className="text-zinc-300 font-medium">Settings → Privacy</span>.
                </p>
            </div>

            {/* Toggle */}
            <div className="flex items-center justify-between rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-3.5">
                <span className="text-sm font-medium text-zinc-200">
                    {enabled ? 'Sending anonymous crash reports' : 'Crash reporting disabled'}
                </span>
                <button
                    id="setup-telemetry-toggle"
                    role="switch"
                    aria-checked={enabled}
                    onClick={() => setEnabled(v => !v)}
                    className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-colors duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 ${enabled ? 'bg-indigo-600' : 'bg-zinc-700'
                        }`}
                >
                    <span className={`inline-block h-4.5 w-4.5 transform rounded-full bg-white shadow transition-transform duration-200 ${enabled ? 'translate-x-5' : 'translate-x-1'
                        }`} />
                </button>
            </div>

            {/* What we collect — expandable */}
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 overflow-hidden">
                <button
                    id="setup-telemetry-details-toggle"
                    onClick={() => setExpanded(v => !v)}
                    className="flex w-full items-center justify-between px-4 py-3 text-sm font-medium text-zinc-300 hover:text-zinc-100 transition-colors"
                >
                    <span>What we collect</span>
                    <ChevronDown className={`h-4 w-4 text-zinc-500 transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`} />
                </button>

                <div className={`grid transition-all duration-300 ${expanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
                    <div className="overflow-hidden">
                        <div className="px-4 pb-4">
                            <div className="grid grid-cols-2 gap-x-4 text-xs">
                                <div className="mb-2 border-b border-zinc-800 pb-2">
                                    <span className="font-semibold text-zinc-300">We collect</span>
                                </div>
                                <div className="mb-2 border-b border-zinc-800 pb-2">
                                    <span className="font-semibold text-zinc-300">We never collect</span>
                                </div>
                                {COLLECT_ROWS.map(([yes, no]) => (
                                    <>
                                        <div key={`yes-${yes}`} className="flex items-start gap-2 py-1.5 border-b border-zinc-800/50">
                                            <Check className="h-3.5 w-3.5 shrink-0 mt-0.5 text-emerald-400" />
                                            <span className="text-zinc-400">{yes}</span>
                                        </div>
                                        <div key={`no-${no}`} className="flex items-start gap-2 py-1.5 border-b border-zinc-800/50">
                                            <X className="h-3.5 w-3.5 shrink-0 mt-0.5 text-red-400" />
                                            <span className="text-zinc-400">{no}</span>
                                        </div>
                                    </>
                                ))}
                            </div>
                            <p className="mt-3 text-[11px] text-zinc-600 leading-relaxed">
                                All sanitization runs locally. You can inspect the{' '}
                                <code className="font-mono text-zinc-500">sanitize()</code> function in{' '}
                                <code className="font-mono text-zinc-500">packages/api/src/telemetry/sanitize.ts</code>.
                            </p>
                        </div>
                    </div>
                </div>
            </div>

            {/* Buttons */}
            <div className="flex gap-3">
                <button
                    id="setup-telemetry-skip"
                    onClick={onComplete}
                    className="flex-1 rounded-xl border border-zinc-700 py-2.5 text-sm text-zinc-400 hover:border-zinc-600 hover:text-zinc-200 transition-colors"
                >
                    Skip for now
                </button>
                <button
                    id="setup-telemetry-save"
                    onClick={() => void save()}
                    disabled={saving}
                    className="flex-1 rounded-xl bg-indigo-600 py-2.5 text-sm font-semibold text-white hover:bg-indigo-500 transition-colors disabled:opacity-40 flex items-center justify-center gap-2"
                >
                    {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                    {saving ? 'Saving…' : 'Save and continue'}
                </button>
            </div>
        </div>
    )
}

export default function SetupPage() {
    const [step, setStep] = useState<Step>('welcome')
    const [workspaceName, setWorkspaceName] = useState('')
    const [anthropicKey, setAnthropicKey] = useState('')
    const [workspaceId, setWorkspaceId] = useState<string | null>(null)
    const [testing, setTesting] = useState(false)
    const [testResult, setTestResult] = useState<'ok' | 'fail' | null>(null)
    const [saving, setSaving] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const apiBase = '/api'

    async function createWorkspace() {
        setSaving(true)
        setError(null)
        try {
            const res = await fetch(`${apiBase}/auth/workspace`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: workspaceName.trim() }),
            })
            if (!res.ok) {
                const err = await res.json() as { error?: { message?: string } }
                throw new Error(err.error?.message ?? 'Failed to create workspace')
            }
            const data = await res.json() as { workspaceId: string }
            setWorkspaceId(data.workspaceId)
            setStep('anthropic')
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Unknown error')
        } finally {
            setSaving(false)
        }
    }

    async function saveAnthropicKey() {
        if (!workspaceId) return
        setSaving(true)
        setError(null)
        try {
            await fetch(`${apiBase}/connections/install`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    workspaceId,
                    registryId: 'anthropic',
                    credentials: { api_key: anthropicKey.trim() },
                }),
            })
            setStep('test')
        } catch {
            setStep('test')
        } finally {
            setSaving(false)
        }
    }

    async function runTest() {
        if (!workspaceId) return
        setTesting(true)
        setTestResult(null)
        try {
            const res = await fetch(`${apiBase}/tasks`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    workspaceId,
                    type: 'automation',
                    source: 'setup-wizard',
                    context: { description: 'Say "Plexo is ready!" and nothing else.' },
                    priority: 10,
                }),
            })
            setTestResult(res.ok ? 'ok' : 'fail')
        } catch {
            setTestResult('fail')
        } finally {
            setTesting(false)
        }
    }

    return (
        <div className="min-h-screen bg-zinc-950 flex items-center justify-center p-6">
            <div className="w-full max-w-lg">
                <div className="mb-8 flex items-center gap-3">
                    <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 text-sm font-bold text-white shadow-lg shadow-indigo-500/20">
                        P
                    </div>
                    <span className="text-lg font-bold text-zinc-100">Plexo Setup</span>
                </div>

                <StepIndicator current={step} />

                <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-7 backdrop-blur-sm">
                    {/* ── Welcome ── */}
                    {step === 'welcome' && (
                        <div className="flex flex-col gap-5">
                            <div>
                                <h1 className="text-xl font-bold text-zinc-50">Welcome to Plexo</h1>
                                <p className="mt-1.5 text-sm text-zinc-500 leading-relaxed">
                                    This wizard will get your AI agent workspace running in under 2 minutes.
                                    No terminal required after this point.
                                </p>
                            </div>
                            <ul className="flex flex-col gap-2">
                                {['Create your workspace', 'Connect Anthropic API key', 'Run a test task'].map((item, i) => (
                                    <li key={item} className="flex items-center gap-3 text-sm text-zinc-400">
                                        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-zinc-800 text-[10px] font-bold text-zinc-500">{i + 1}</span>
                                        {item}
                                    </li>
                                ))}
                            </ul>
                            <button
                                id="setup-get-started"
                                onClick={() => setStep('workspace')}
                                className="mt-2 w-full rounded-xl bg-indigo-600 py-3 text-sm font-semibold text-white hover:bg-indigo-500 transition-colors"
                            >
                                Get started
                            </button>
                        </div>
                    )}

                    {/* ── Workspace ── */}
                    {step === 'workspace' && (
                        <div className="flex flex-col gap-5">
                            <div>
                                <h2 className="text-lg font-bold text-zinc-50">Name your workspace</h2>
                                <p className="mt-1 text-sm text-zinc-500">This is typically your team or project name.</p>
                            </div>
                            <div className="flex flex-col gap-1.5">
                                <label htmlFor="workspace-name" className="text-sm font-medium text-zinc-300">Workspace name</label>
                                <input
                                    id="workspace-name"
                                    type="text"
                                    value={workspaceName}
                                    onChange={(e) => setWorkspaceName(e.target.value)}
                                    placeholder="My Team"
                                    className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-indigo-500 focus:outline-none"
                                    autoFocus
                                    onKeyDown={(e) => e.key === 'Enter' && workspaceName.trim() && void createWorkspace()}
                                />
                            </div>
                            {error && (
                                <div className="flex items-center gap-2 text-xs text-red-400">
                                    <AlertCircle className="h-3.5 w-3.5" /> {error}
                                </div>
                            )}
                            <button
                                id="setup-create-workspace"
                                onClick={() => void createWorkspace()}
                                disabled={!workspaceName.trim() || saving}
                                className="w-full rounded-xl bg-indigo-600 py-3 text-sm font-semibold text-white hover:bg-indigo-500 transition-colors disabled:opacity-40 flex items-center justify-center gap-2"
                            >
                                {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                                {saving ? 'Creating…' : 'Continue'}
                            </button>
                        </div>
                    )}

                    {/* ── Anthropic ── */}
                    {step === 'anthropic' && (
                        <div className="flex flex-col gap-5">
                            <div>
                                <h2 className="text-lg font-bold text-zinc-50">Connect Anthropic</h2>
                                <p className="mt-1 text-sm text-zinc-500">
                                    Plexo uses Claude for task execution. You need an API key or can use OAuth.
                                </p>
                            </div>
                            <div className="flex flex-col gap-1.5">
                                <label htmlFor="anthropic-key" className="text-sm font-medium text-zinc-300">API Key</label>
                                <input
                                    id="anthropic-key"
                                    type="password"
                                    value={anthropicKey}
                                    onChange={(e) => setAnthropicKey(e.target.value)}
                                    placeholder="sk-ant-api03-…"
                                    className="rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-indigo-500 focus:outline-none font-mono"
                                    autoComplete="new-password"
                                    autoFocus
                                />
                                <a
                                    href="https://console.anthropic.com/keys"
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="flex items-center gap-1 text-[11px] text-indigo-400 hover:text-indigo-300"
                                >
                                    Get a key from console.anthropic.com <ExternalLink className="h-3 w-3" />
                                </a>
                            </div>
                            <div className="flex gap-3">
                                <button
                                    id="setup-anthropic-skip"
                                    onClick={() => setStep('test')}
                                    className="flex-1 rounded-xl border border-zinc-700 py-2.5 text-sm text-zinc-400 hover:border-zinc-600 hover:text-zinc-200 transition-colors"
                                >
                                    Skip for now
                                </button>
                                <button
                                    id="setup-anthropic-save"
                                    onClick={() => void saveAnthropicKey()}
                                    disabled={!anthropicKey.trim() || saving}
                                    className="flex-1 rounded-xl bg-indigo-600 py-2.5 text-sm font-semibold text-white hover:bg-indigo-500 transition-colors disabled:opacity-40 flex items-center justify-center gap-2"
                                >
                                    {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                                    {saving ? 'Saving…' : 'Save & continue'}
                                </button>
                            </div>
                        </div>
                    )}

                    {/* ── Test ── */}
                    {step === 'test' && (
                        <div className="flex flex-col gap-5">
                            <div>
                                <h2 className="text-lg font-bold text-zinc-50">Test your agent</h2>
                                <p className="mt-1 text-sm text-zinc-500">Submit a simple task to verify everything is connected.</p>
                            </div>
                            <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-4 text-xs font-mono text-zinc-500">
                                Say &quot;Plexo is ready!&quot; and nothing else.
                            </div>
                            {testResult === 'ok' && (
                                <div className="flex items-center gap-2 rounded-lg bg-emerald-950/40 border border-emerald-900/50 px-4 py-3 text-sm text-emerald-400">
                                    <Check className="h-4 w-4 shrink-0" />
                                    Task queued successfully — your agent will pick it up shortly.
                                </div>
                            )}
                            {testResult === 'fail' && (
                                <div className="flex items-center gap-2 rounded-lg bg-red-950/40 border border-red-900/50 px-4 py-3 text-sm text-red-400">
                                    <AlertCircle className="h-4 w-4 shrink-0" />
                                    Task failed to queue. Make sure the API server is running.
                                </div>
                            )}
                            <div className="flex gap-3">
                                <button
                                    id="setup-run-test"
                                    onClick={() => void runTest()}
                                    disabled={testing}
                                    className="flex-1 rounded-xl border border-zinc-700 py-2.5 text-sm text-zinc-400 hover:border-zinc-600 hover:text-zinc-200 transition-colors flex items-center justify-center gap-2"
                                >
                                    {testing && <Loader2 className="h-4 w-4 animate-spin" />}
                                    {testing ? 'Sending…' : 'Run test task'}
                                </button>
                                <button
                                    id="setup-test-continue"
                                    onClick={() => setStep('telemetry')}
                                    className="flex-1 rounded-xl bg-indigo-600 py-2.5 text-sm font-semibold text-white hover:bg-indigo-500 transition-colors"
                                >
                                    {testResult === 'ok' ? 'Continue →' : 'Skip'}
                                </button>
                            </div>
                        </div>
                    )}

                    {/* ── Telemetry ── */}
                    {step === 'telemetry' && (
                        <TelemetryStep workspaceId={workspaceId} onComplete={() => setStep('done')} />
                    )}

                    {/* ── Done ── */}
                    {step === 'done' && (
                        <div className="flex flex-col items-center gap-5 py-4 text-center">
                            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-emerald-500/15 border border-emerald-500/30">
                                <Check className="h-7 w-7 text-emerald-400" />
                            </div>
                            <div>
                                <h2 className="text-lg font-bold text-zinc-50">You&apos;re all set!</h2>
                                <p className="mt-1 text-sm text-zinc-500">Your workspace is ready. Head to the dashboard to submit tasks.</p>
                            </div>
                            <Link
                                id="setup-open-dashboard"
                                href="/"
                                className="w-full rounded-xl bg-indigo-600 py-3 text-sm font-semibold text-white hover:bg-indigo-500 transition-colors block"
                            >
                                Open dashboard →
                            </Link>
                        </div>
                    )}
                </div>

                <p className="mt-4 text-center text-[11px] text-zinc-700">
                    Plexo · BSL 1.1 · <a href="https://getplexo.com" className="hover:text-zinc-500">getplexo.com</a>
                </p>
            </div>
        </div>
    )
}
