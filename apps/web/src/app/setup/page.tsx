// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Check, ChevronRight, ChevronDown, Loader2, ExternalLink, AlertCircle, ShieldCheck, X } from 'lucide-react'
import { createClient as createBrowserClient } from '@web/lib/supabase/client'

const API_BASE = (typeof window !== 'undefined' ? '' : (process.env.INTERNAL_API_URL || 'http://localhost:3001'))

const STEPS = ['welcome', 'workspace', 'model', 'test', 'telemetry', 'done'] as const
type Step = typeof STEPS[number]

const STEP_LABELS = ['Welcome', 'Workspace', 'AI Model', 'Test', 'Privacy', 'Done']

const MODELS = [
    { key: 'anthropic', name: 'Claude 3.5 Sonnet (Anthropic)', link: 'https://console.anthropic.com/keys', placeholder: 'sk-ant-api03-…' },
    { key: 'openai', name: 'GPT-4o (OpenAI)', link: 'https://platform.openai.com/api-keys', placeholder: 'sk-proj-…' },
    { key: 'google', name: 'Gemini 1.5 Pro (Google)', link: 'https://aistudio.google.com/app/apikey', placeholder: 'AIza…' },
    { key: 'groq', name: 'Llama 3 / Mixtral (Groq)', link: 'https://console.groq.com/keys', placeholder: 'gsk_…' },
    { key: 'deepseek', name: 'DeepSeek V3', link: 'https://platform.deepseek.com/api_keys', placeholder: 'sk-…' },
    { key: 'mistral', name: 'Mistral Large', link: 'https://console.mistral.ai/api-keys/', placeholder: '…' },
    { key: 'xai', name: 'Grok 2 (xAI)', link: 'https://console.x.ai/', placeholder: 'xai-…' },
    { key: 'openrouter', name: 'OpenRouter (200+ models)', link: 'https://openrouter.ai/keys', placeholder: 'sk-or-v1-…' },
    { key: 'ollama', name: 'Ollama (Local or Remote)', link: 'https://ollama.com', placeholder: 'http://localhost:11434' },
]

function StepIndicator({ current }: { current: Step }) {
    const idx = STEPS.indexOf(current)
    return (
        <div className="flex items-center gap-2 mb-8 flex-wrap">
            {STEPS.slice(0, -1).map((s, i) => (
                <div key={s} className="flex items-center gap-2">
                    <div className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold transition-all ${i < idx ? 'bg-azure text-white' :
                        i === idx ? 'border-2 border-azure text-azure' :
                            'border border-border text-text-muted'
                        }`}>
                        {i < idx ? <Check className="h-3.5 w-3.5" /> : i + 1}
                    </div>
                    <span className={`text-xs ${i === idx ? 'text-text-primary font-medium' : 'text-text-muted'}`}>
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
    ['Extension name if an extension crashed', 'File paths containing your data'],
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
                    <ShieldCheck className="h-5 w-5 text-azure" />
                    <h2 className="text-lg font-bold text-zinc-50">Help us fix bugs faster</h2>
                </div>
                <p className="text-sm text-text-secondary leading-relaxed">
                    Plexo is self-hosted — your data stays on your machine. This is optional, anonymous crash
                    reporting that helps us identify where things break.
                </p>
                <p className="mt-3 text-sm text-text-secondary leading-relaxed">
                    If you enable this, when Plexo encounters an error, a sanitized report is sent to our
                    servers. No task content, no credentials, no file paths, no workspace names — ever. The
                    stripping happens on your machine before anything leaves.
                </p>
                <p className="mt-3 text-sm text-text-secondary leading-relaxed">
                    You can change this at any time in{' '}
                    <span className="text-text-secondary font-medium">Settings → Privacy</span>.
                </p>
            </div>

            {/* Toggle */}
            <div className="flex items-center justify-between rounded-xl border border-border bg-surface-1 px-4 py-3.5">
                <span className="text-sm font-medium text-text-primary">
                    {enabled ? 'Sending anonymous crash reports' : 'Crash reporting disabled'}
                </span>
                <button
                    id="setup-telemetry-toggle"
                    role="switch"
                    aria-checked={enabled}
                    onClick={() => setEnabled(v => !v)}
                    className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-colors duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-azure ${enabled ? 'bg-azure' : 'bg-zinc-700'
                        }`}
                >
                    <span className={`inline-block h-4.5 w-4.5 transform rounded-full bg-white shadow transition-transform duration-200 ${enabled ? 'translate-x-5' : 'translate-x-1'
                        }`} />
                </button>
            </div>

            {/* What we collect — expandable */}
            <div className="rounded-xl border border-border bg-surface-1/50 overflow-hidden">
                <button
                    id="setup-telemetry-details-toggle"
                    onClick={() => setExpanded(v => !v)}
                    className="flex w-full items-center justify-between px-4 py-3 text-sm font-medium text-text-secondary hover:text-text-primary transition-colors"
                >
                    <span>What we collect</span>
                    <ChevronDown className={`h-4 w-4 text-text-muted transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`} />
                </button>

                <div className={`grid transition-all duration-300 ${expanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
                    <div className="overflow-hidden">
                        <div className="px-4 pb-4">
                            <div className="grid grid-cols-2 gap-x-4 text-xs">
                                <div className="mb-2 border-b border-border pb-2">
                                    <span className="font-semibold text-text-secondary">We collect</span>
                                </div>
                                <div className="mb-2 border-b border-border pb-2">
                                    <span className="font-semibold text-text-secondary">We never collect</span>
                                </div>
                                {COLLECT_ROWS.map(([yes, no]) => (
                                    <>
                                        <div key={`yes-${yes}`} className="flex items-start gap-2 py-1.5 border-b border-border-subtle">
                                            <Check className="h-3.5 w-3.5 shrink-0 mt-0.5 text-azure" />
                                            <span className="text-text-secondary">{yes}</span>
                                        </div>
                                        <div key={`no-${no}`} className="flex items-start gap-2 py-1.5 border-b border-border-subtle">
                                            <X className="h-3.5 w-3.5 shrink-0 mt-0.5 text-red" />
                                            <span className="text-text-secondary">{no}</span>
                                        </div>
                                    </>
                                ))}
                            </div>
                            <p className="mt-3 text-[11px] text-text-muted leading-relaxed">
                                All sanitization runs locally. You can inspect the{' '}
                                <code className="font-mono text-text-muted">sanitize()</code> function in{' '}
                                <code className="font-mono text-text-muted">packages/api/src/telemetry/sanitize.ts</code>.
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
                    className="flex-1 rounded-xl border border-border py-2.5 text-sm text-text-secondary hover:border-zinc-600 hover:text-text-primary transition-colors"
                >
                    Skip for now
                </button>
                <button
                    id="setup-telemetry-save"
                    onClick={() => void save()}
                    disabled={saving}
                    className="flex-1 rounded-xl bg-azure py-2.5 text-sm font-semibold text-text-primary hover:bg-azure/90 transition-colors disabled:opacity-40 flex items-center justify-center gap-2"
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
    const [selectedProvider, setSelectedProvider] = useState('anthropic')
    const [providerCredential, setProviderCredential] = useState('')
    const [workspaceId, setWorkspaceId] = useState<string | null>(null)
    const [testing, setTesting] = useState(false)
    const [testResult, setTestResult] = useState<'ok' | 'fail' | null>(null)
    const [testPrompt, setTestPrompt] = useState('Say "Plexo is ready!" and nothing else.')
    const [saving, setSaving] = useState(false)
    const [error, setError] = useState<string | null>(null)

    async function createWorkspace() {
        setSaving(true)
        setError(null)
        try {
            // Get the Supabase session so we can authenticate the request
            const supabase = createBrowserClient()
            const { data: { session } } = await supabase.auth.getSession()
            if (!session?.user?.id) {
                setError('Not signed in — please log in first.')
                setSaving(false)
                return
            }

            const headers: Record<string, string> = { 'Content-Type': 'application/json' }
            if (session.access_token) {
                headers['Authorization'] = `Bearer ${session.access_token}`
            }

            const res = await fetch(`${API_BASE}/api/v1/auth/workspace`, {
                method: 'POST',
                headers,
                body: JSON.stringify({ name: workspaceName.trim(), ownerId: session.user.id }),
            })
            if (!res.ok) {
                // Handle non-JSON error responses gracefully
                const text = await res.text()
                let message = 'Failed to create workspace'
                try {
                    const parsed = JSON.parse(text) as { error?: { message?: string } }
                    message = parsed.error?.message ?? message
                } catch {
                    message = text || message
                }
                throw new Error(message)
            }
            const data = await res.json() as { workspaceId: string }
            setWorkspaceId(data.workspaceId)
            localStorage.setItem('plexo_workspace_id', data.workspaceId)
            setStep('model')
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Unknown error')
        } finally {
            setSaving(false)
        }
    }

    async function saveProvider() {
        if (!workspaceId) return
        setSaving(true)
        setError(null)
        try {
            const url = `${API_BASE}/api/v1/workspaces/${workspaceId}/ai-providers`

            await fetch(url, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    primary: selectedProvider,
                    primaryProvider: selectedProvider,
                    providers: {
                        [selectedProvider]: {
                            status: 'untested',
                            ...(selectedProvider === 'ollama'
                                ? { baseUrl: providerCredential.trim() || 'http://localhost:11434' }
                                : { apiKey: providerCredential.trim() })
                        }
                    }
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
            const res = await fetch(`${API_BASE}/api/v1/tasks`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    workspaceId,
                    type: 'automation',
                    source: 'dashboard',
                    context: { description: testPrompt.trim() || 'Say "Plexo is ready!" and nothing else.' },
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
        <div className="min-h-screen bg-canvas flex items-center justify-center p-6">
            <div className="w-full max-w-xl">
                <div className="mb-8 flex items-center gap-3">
                    <div className="flex h-9 w-9 items-center justify-center rounded-xl   text-sm font-bold text-text-primary shadow-lg shadow-azure/20">
                        P
                    </div>
                    <span className="text-lg font-bold text-text-primary">Plexo Setup</span>
                </div>

                <StepIndicator current={step} />

                <div className="rounded-2xl border border-border bg-surface-1/60 p-7 backdrop-blur-sm">
                    {/* ── Welcome ── */}
                    {step === 'welcome' && (
                        <div className="flex flex-col gap-5">
                            <div>
                                <h1 className="text-xl font-bold text-zinc-50">Welcome to Plexo</h1>
                                <p className="mt-1.5 text-sm text-text-muted leading-relaxed">
                                    This wizard will get your AI agent workspace running in under 2 minutes.
                                    No terminal required after this point.
                                </p>
                            </div>
                            <ul className="flex flex-col gap-2">
                                {['Create your workspace', 'Connect an AI Model', 'Run a test task'].map((item, i) => (
                                    <li key={item} className="flex items-center gap-3 text-sm text-text-secondary">
                                        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-surface-2 text-[10px] font-bold text-text-muted">{i + 1}</span>
                                        {item}
                                    </li>
                                ))}
                            </ul>
                            <button
                                id="setup-get-started"
                                onClick={() => setStep('workspace')}
                                className="mt-2 w-full rounded-xl bg-azure py-3 text-sm font-semibold text-text-primary hover:bg-azure/90 transition-colors"
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
                                <p className="mt-1 text-sm text-text-muted">This is typically your team or project name.</p>
                            </div>
                            <div className="flex flex-col gap-1.5">
                                <label htmlFor="workspace-name" className="text-sm font-medium text-text-secondary">Workspace name</label>
                                <input
                                    id="workspace-name"
                                    type="text"
                                    value={workspaceName}
                                    onChange={(e) => setWorkspaceName(e.target.value)}
                                    placeholder="My Team"
                                    className="rounded-lg border border-border bg-canvas px-3 py-2.5 text-sm text-text-primary placeholder:text-text-muted focus:border-azure focus:outline-none"
                                    autoFocus
                                    onKeyDown={(e) => e.key === 'Enter' && workspaceName.trim() && void createWorkspace()}
                                />
                            </div>
                            {error && (
                                <div className="flex items-center gap-2 text-xs text-red">
                                    <AlertCircle className="h-3.5 w-3.5" /> {error}
                                </div>
                            )}
                            <button
                                id="setup-create-workspace"
                                onClick={() => void createWorkspace()}
                                disabled={!workspaceName.trim() || saving}
                                className="w-full rounded-xl bg-azure py-3 text-sm font-semibold text-text-primary hover:bg-azure/90 transition-colors disabled:opacity-40 flex items-center justify-center gap-2"
                            >
                                {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                                {saving ? 'Creating…' : 'Continue'}
                            </button>
                        </div>
                    )}

                    {/* ── AI Provider ── */}
                    {step === 'model' && (
                        <div className="flex flex-col gap-5">
                            <div>
                                <h2 className="text-lg font-bold text-zinc-50">Choose an AI Model</h2>
                                <p className="mt-1 text-sm text-text-muted">
                                    Plexo needs an AI model to execute tasks.
                                </p>
                            </div>

                            <div className="flex flex-col gap-1.5">
                                <label className="text-sm font-medium text-text-secondary">Which LLM would you like to use?</label>
                                <select
                                    value={selectedProvider}
                                    onChange={(e) => {
                                        setSelectedProvider(e.target.value)
                                        setProviderCredential('')
                                    }}
                                    className="rounded-lg border border-border bg-canvas px-3 py-2.5 text-sm text-text-primary focus:border-azure focus:outline-none"
                                >
                                    {MODELS.map(p => (
                                        <option key={p.key} value={p.key}>{p.name}</option>
                                    ))}
                                </select>
                            </div>

                            <div className="flex flex-col gap-1.5">
                                <label htmlFor="provider-credential" className="text-sm font-medium text-text-secondary">
                                    {selectedProvider === 'ollama' ? 'Base URL' : 'API Key'}
                                </label>
                                <input
                                    id="provider-credential"
                                    type={selectedProvider === 'ollama' ? 'text' : 'password'}
                                    value={providerCredential}
                                    onChange={(e) => setProviderCredential(e.target.value)}
                                    placeholder={MODELS.find(p => p.key === selectedProvider)?.placeholder}
                                    className="rounded-lg border border-border bg-canvas px-3 py-2.5 text-sm text-text-primary placeholder:text-text-muted focus:border-azure focus:outline-none font-mono"
                                    autoComplete="new-password"
                                    autoFocus
                                />
                                {MODELS.find(p => p.key === selectedProvider)?.link && selectedProvider !== 'ollama' && (
                                    <a
                                        href={MODELS.find(p => p.key === selectedProvider)?.link}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="flex items-center gap-1 text-[11px] text-azure mt-1"
                                    >
                                        Get a key from {new URL(MODELS.find(p => p.key === selectedProvider)?.link || 'https://example.com').hostname.replace('console.', '').replace('platform.', '')} <ExternalLink className="h-3 w-3" />
                                    </a>
                                )}
                            </div>
                            <div className="flex gap-3">
                                <button
                                    id="setup-provider-skip"
                                    onClick={() => setStep('test')}
                                    className="flex-1 rounded-xl border border-border py-2.5 text-sm text-text-secondary hover:border-zinc-600 hover:text-text-primary transition-colors"
                                >
                                    Skip for now
                                </button>
                                <button
                                    id="setup-provider-save"
                                    onClick={() => void saveProvider()}
                                    disabled={saving}
                                    className="flex-1 rounded-xl bg-azure py-2.5 text-sm font-semibold text-text-primary hover:bg-azure/90 transition-colors disabled:opacity-40 flex items-center justify-center gap-2"
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
                                <p className="mt-1 text-sm text-text-muted">Submit a simple task to verify everything is connected.</p>
                            </div>
                            <input
                                type="text"
                                value={testPrompt}
                                onChange={(e) => setTestPrompt(e.target.value)}
                                className="w-full rounded-xl border border-border bg-canvas px-4 py-3 text-sm font-mono text-text-secondary focus:border-azure focus:outline-none focus:text-text-primary transition-colors"
                            />
                            {testResult === 'ok' && (
                                <div className="flex items-center gap-2 rounded-lg bg-azure/5 border border-azure/20 px-4 py-3 text-sm text-azure">
                                    <Check className="h-4 w-4 shrink-0" />
                                    Task queued successfully — your agent will pick it up shortly.
                                </div>
                            )}
                            {testResult === 'fail' && (
                                <div className="flex items-center gap-2 rounded-lg bg-red-950/40 border border-red-900/50 px-4 py-3 text-sm text-red">
                                    <AlertCircle className="h-4 w-4 shrink-0" />
                                    Task failed to queue. Make sure the API server is running.
                                </div>
                            )}
                            <div className="flex gap-3">
                                <button
                                    id="setup-run-test"
                                    onClick={() => void runTest()}
                                    disabled={testing}
                                    className="flex-1 rounded-xl border border-border py-2.5 text-sm text-text-secondary hover:border-zinc-600 hover:text-text-primary transition-colors flex items-center justify-center gap-2"
                                >
                                    {testing && <Loader2 className="h-4 w-4 animate-spin" />}
                                    {testing ? 'Sending…' : 'Run test task'}
                                </button>
                                <button
                                    id="setup-test-continue"
                                    onClick={() => setStep('telemetry')}
                                    className="flex-1 rounded-xl bg-azure py-2.5 text-sm font-semibold text-text-primary hover:bg-azure/90 transition-colors"
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
                            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-azure/10 border border-azure/30">
                                <Check className="h-7 w-7 text-azure" />
                            </div>
                            <div>
                                <h2 className="text-lg font-bold text-zinc-50">You&apos;re all set!</h2>
                                <p className="mt-1 text-sm text-text-muted">Your workspace is ready. Head to the dashboard to submit tasks.</p>
                            </div>
                            <Link
                                id="setup-open-dashboard"
                                href="/"
                                className="w-full rounded-xl bg-azure py-3 text-sm font-semibold text-text-primary hover:bg-azure/90 transition-colors block"
                            >
                                Open dashboard →
                            </Link>
                        </div>
                    )}
                </div>

                <p className="mt-4 text-center text-[11px] text-zinc-700">
                    Plexo · <a href="https://github.com/joeybuilt-official/plexo/blob/main/LICENSE" className="hover:text-text-muted">AGPL-3.0 Open Source</a> · <a href="https://getplexo.com" className="hover:text-text-muted">getplexo.com</a>
                </p>
            </div>
        </div>
    )
}
