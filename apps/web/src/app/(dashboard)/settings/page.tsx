'use client'

import { useState, useEffect, useCallback } from 'react'
import { Settings as SettingsIcon, Key, Zap, Globe, Save, Check, AlertCircle } from 'lucide-react'

interface Section {
    id: string
    label: string
    icon: React.ElementType
}

const SECTIONS: Section[] = [
    { id: 'workspace', label: 'Workspace', icon: Globe },
    { id: 'agent', label: 'Agent', icon: Zap },
    { id: 'api-keys', label: 'API Keys', icon: Key },
]

function Field({ label, id, description, children }: { label: string; id: string; description?: string; children: React.ReactNode }) {
    return (
        <div className="flex flex-col gap-1.5">
            <label htmlFor={id} className="text-sm font-medium text-zinc-200">{label}</label>
            {children}
            {description && <p className="text-xs text-zinc-600">{description}</p>}
        </div>
    )
}

function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
    return (
        <input
            {...props}
            className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500/30 disabled:opacity-50"
        />
    )
}

function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
    return (
        <select
            {...props}
            className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500/30"
        />
    )
}

function SaveButton({ saved, saving }: { saved: boolean; saving: boolean }) {
    return (
        <button
            type="submit"
            disabled={saving}
            className="flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 transition-colors disabled:opacity-50"
        >
            {saved ? <Check className="h-4 w-4" /> : <Save className="h-4 w-4" />}
            {saving ? 'Saving…' : saved ? 'Saved' : 'Save changes'}
        </button>
    )
}

export default function SettingsPage() {
    const [active, setActive] = useState('workspace')
    const [saving, setSaving] = useState(false)
    const [saved, setSaved] = useState(false)
    const [saveError, setSaveError] = useState<string | null>(null)

    const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'
    const WS_ID = process.env.NEXT_PUBLIC_DEFAULT_WORKSPACE ?? ''

    // Workspace settings state
    const [workspaceName, setWorkspaceName] = useState('My Workspace')
    const [costCeiling, setCostCeiling] = useState('10')

    // Agent settings state
    const [tokenBudget, setTokenBudget] = useState('50000')
    const [defaultModel, setDefaultModel] = useState('claude-opus-4-5')
    const [maxRetries, setMaxRetries] = useState('3')

    // Load workspace data on mount
    const loadWorkspace = useCallback(async () => {
        if (!WS_ID) return
        try {
            const res = await fetch(`${API_BASE}/api/workspaces/${WS_ID}`)
            if (!res.ok) return
            const data = await res.json() as { name: string; settings?: Record<string, unknown> }
            if (data.name) setWorkspaceName(data.name)
            const s = data.settings ?? {}
            if (typeof s.costCeilingUsdWeekly === 'number') setCostCeiling(String(s.costCeilingUsdWeekly))
            if (typeof s.defaultModel === 'string') setDefaultModel(s.defaultModel)
            if (typeof s.tokenBudgetPerTask === 'number') setTokenBudget(String(s.tokenBudgetPerTask))
            if (typeof s.maxRetries === 'number') setMaxRetries(String(s.maxRetries))
        } catch { /* non-fatal */ }
    }, [API_BASE, WS_ID])

    useEffect(() => { void loadWorkspace() }, [loadWorkspace])

    // API key state (write-only — never read back)
    const [anthropicKey, setAnthropicKey] = useState('')
    const [openaiKey, setOpenaiKey] = useState('')

    async function handleSave(e: React.FormEvent) {
        e.preventDefault()
        setSaving(true)
        setSaveError(null)
        try {
            if (active === 'workspace' || active === 'agent') {
                // Merge changes into workspace settings
                const payload = active === 'workspace'
                    ? { name: workspaceName, settings: { costCeilingUsdWeekly: parseFloat(costCeiling) || 10 } }
                    : { settings: { defaultModel, tokenBudgetPerTask: parseInt(tokenBudget) || 50000, maxRetries: parseInt(maxRetries) || 3 } }
                const res = await fetch(`${API_BASE}/api/workspaces/${WS_ID}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                })
                if (!res.ok) {
                    const err = await res.json() as { error?: { message?: string } }
                    throw new Error(err.error?.message ?? 'Save failed')
                }
            } else if (active === 'api-keys') {
                // Store non-empty keys into workspace settings (API encrypts at rest)
                const apiKeys: Record<string, string> = {}
                if (anthropicKey.trim()) apiKeys.anthropic = anthropicKey.trim()
                if (openaiKey.trim()) apiKeys.openai = openaiKey.trim()
                if (Object.keys(apiKeys).length > 0) {
                    const res = await fetch(`${API_BASE}/api/workspaces/${WS_ID}`, {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ settings: { apiKeys } }),
                    })
                    if (!res.ok) throw new Error('Failed to save keys')
                }
                setAnthropicKey('')
                setOpenaiKey('')
            }
            setSaved(true)
            setTimeout(() => setSaved(false), 3000)
        } catch (err: unknown) {
            setSaveError(err instanceof Error ? err.message : 'Save failed')
        } finally {
            setSaving(false)
        }
    }

    return (
        <div className="flex gap-8 max-w-4xl">
            {/* Sidebar nav */}
            <nav className="shrink-0 w-44">
                <p className="mb-2 text-[10px] uppercase tracking-widest text-zinc-600">Settings</p>
                <div className="flex flex-col gap-0.5">
                    {SECTIONS.map(({ id, label, icon: Icon }) => (
                        <button
                            key={id}
                            onClick={() => setActive(id)}
                            className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-left transition-colors ${active === id ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300'}`}
                        >
                            <Icon className={`h-4 w-4 ${active === id ? 'text-indigo-400' : 'text-zinc-600'}`} />
                            {label}
                        </button>
                    ))}
                </div>
            </nav>

            {/* Content */}
            <form onSubmit={handleSave} className="flex-1 flex flex-col gap-4">
                {saveError && (
                    <div className="flex items-start gap-2 rounded-lg border border-red-800/50 bg-red-950/20 px-3 py-2.5 text-sm text-red-400">
                        <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                        {saveError}
                    </div>
                )}
                {active === 'workspace' && (
                    <div className="flex flex-col gap-6">
                        <div>
                            <h2 className="text-lg font-bold text-zinc-50">Workspace</h2>
                            <p className="mt-0.5 text-sm text-zinc-500">General workspace configuration</p>
                        </div>
                        <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5 flex flex-col gap-5">
                            <Field id="workspace-name" label="Workspace name" description="Displayed in the sidebar and agent context.">
                                <Input id="workspace-name" value={workspaceName} onChange={(e) => setWorkspaceName(e.target.value)} placeholder="My Workspace" />
                            </Field>
                            <Field id="workspace-id" label="Workspace ID" description="Read-only — used in API calls and env vars.">
                                <Input id="workspace-id" value={WS_ID} readOnly className="font-mono text-xs opacity-50 cursor-default" />
                            </Field>
                            <Field id="cost-ceiling" label="Weekly cost ceiling (USD)" description="Agent stops queueing new tasks when the weekly API cost exceeds this amount. Alert fires at 80%.">
                                <Input id="cost-ceiling" type="number" min="1" step="1" value={costCeiling} onChange={(e) => setCostCeiling(e.target.value)} />
                            </Field>
                        </div>
                        <div className="flex justify-end">
                            <SaveButton saved={saved} saving={saving} />
                        </div>
                    </div>
                )}

                {active === 'agent' && (
                    <div className="flex flex-col gap-6">
                        <div>
                            <h2 className="text-lg font-bold text-zinc-50">Agent</h2>
                            <p className="mt-0.5 text-sm text-zinc-500">Execution behaviour and model settings</p>
                        </div>
                        <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5 flex flex-col gap-5">
                            <Field id="model" label="Default model" description="Model used for task execution. Higher tier = better quality, higher cost.">
                                <Select id="model" value={defaultModel} onChange={(e) => setDefaultModel(e.target.value)}>
                                    <option value="claude-haiku-4-5">Claude Haiku 4.5 (fast, cheap)</option>
                                    <option value="claude-sonnet-4-5">Claude Sonnet 4.5 (balanced)</option>
                                    <option value="claude-opus-4-5">Claude Opus 4.5 (best quality)</option>
                                </Select>
                            </Field>
                            <Field id="token-budget" label="Token budget per task" description="Maximum tokens the agent may use in a single task execution.">
                                <Input id="token-budget" type="number" min="1000" step="1000" value={tokenBudget} onChange={(e) => setTokenBudget(e.target.value)} />
                            </Field>
                            <Field id="max-retries" label="Max retries on failure" description="Number of times the agent retries a failed step before marking the task as failed.">
                                <Select id="max-retries" value={maxRetries} onChange={(e) => setMaxRetries(e.target.value)}>
                                    {['0', '1', '2', '3', '5'].map((v) => (
                                        <option key={v} value={v}>{v}</option>
                                    ))}
                                </Select>
                            </Field>
                        </div>
                        <div className="flex justify-end">
                            <SaveButton saved={saved} saving={saving} />
                        </div>
                    </div>
                )}

                {active === 'api-keys' && (
                    <div className="flex flex-col gap-6">
                        <div>
                            <h2 className="text-lg font-bold text-zinc-50">API Keys</h2>
                            <p className="mt-0.5 text-sm text-zinc-500">Configure credentials for AI providers.</p>
                        </div>
                        <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-6 flex flex-col gap-4">
                            <div className="flex items-start gap-3 rounded-lg border border-indigo-800/40 bg-indigo-950/20 px-4 py-3">
                                <AlertCircle className="h-4 w-4 shrink-0 text-indigo-400 mt-0.5" />
                                <div>
                                    <p className="text-sm text-indigo-300 font-medium">Manage keys in AI Providers</p>
                                    <p className="mt-1 text-xs text-indigo-400/70">
                                        API keys, model selection, provider testing, and the fallback chain are all managed in the dedicated AI Providers page.
                                    </p>
                                    <a
                                        href="/settings/ai-providers"
                                        className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-indigo-400 hover:text-indigo-300 transition-colors"
                                    >
                                        Go to AI Providers →
                                    </a>
                                </div>
                            </div>

                            <div className="pt-2 border-t border-zinc-800">
                                <p className="text-xs font-medium text-zinc-400 mb-2">Self-hosted environment variables</p>
                                <code className="block rounded-lg bg-zinc-950 border border-zinc-800 p-3 text-[11px] font-mono text-zinc-400 whitespace-pre leading-relaxed">
                                    {`ANTHROPIC_API_KEY=sk-ant-api03-…
OPENAI_API_KEY=sk-…
OPENROUTER_API_KEY=sk-or-v1-…
GROQ_API_KEY=gsk_…`}
                                </code>
                                <p className="mt-2 text-[10px] text-zinc-700">Set these in <code className="text-zinc-600">.env.local</code> or your deployment environment.</p>
                            </div>
                        </div>
                    </div>
                )}
            </form>
        </div>
    )
}
