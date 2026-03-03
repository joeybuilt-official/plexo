'use client'

import { useState } from 'react'
import {
    CheckCircle2,
    AlertCircle,
    Circle,
    ChevronDown,
    ChevronRight,
    Cpu,
    TestTube,
    Save,
    Star,
    GripVertical,
    RefreshCw,
} from 'lucide-react'

// ── Types ────────────────────────────────────────────────────────────────────

type ProviderKey =
    | 'openrouter'
    | 'anthropic'
    | 'openai'
    | 'google'
    | 'mistral'
    | 'groq'
    | 'xai'
    | 'deepseek'
    | 'ollama'

type ProviderStatus = 'configured' | 'untested' | 'unconfigured'

type TaskType =
    | 'planning'
    | 'codeGeneration'
    | 'verification'
    | 'summarization'
    | 'classification'
    | 'logAnalysis'

interface ProviderConfig {
    key: ProviderKey
    name: string
    description: string
    badge?: string
    badgeColor?: string
    requiresKey: boolean
    staticModels?: string[]
}

interface ProviderState {
    apiKey: string
    baseUrl: string
    selectedModel: string
    status: ProviderStatus
    testResult: string | null
}

// ── Provider definitions ─────────────────────────────────────────────────────

const PROVIDERS: ProviderConfig[] = [
    {
        key: 'openrouter',
        name: 'OpenRouter',
        description: '200+ models via single API key',
        badge: 'RECOMMENDED',
        badgeColor: 'bg-amber-500/15 text-amber-400 border border-amber-500/30',
        requiresKey: true,
    },
    {
        key: 'anthropic',
        name: 'Anthropic',
        description: 'Claude Sonnet, Haiku, Opus models',
        requiresKey: true,
        staticModels: ['claude-opus-4-5', 'claude-sonnet-4-5', 'claude-haiku-4-5', 'claude-opus-4-6', 'claude-sonnet-4-6'],
    },
    {
        key: 'openai',
        name: 'OpenAI',
        description: 'GPT-4o, o1, o3 models',
        requiresKey: true,
        staticModels: ['gpt-4o', 'gpt-4o-mini', 'o1', 'o1-mini', 'o3', 'o3-mini'],
    },
    {
        key: 'google',
        name: 'Google Gemini',
        description: 'Gemini 2.0, Flash, Pro models',
        requiresKey: true,
        staticModels: ['gemini-2.0-flash', 'gemini-2.0-pro', 'gemini-1.5-flash', 'gemini-1.5-pro'],
    },
    {
        key: 'groq',
        name: 'Groq',
        description: 'Ultra-fast inference, open models',
        requiresKey: true,
        staticModels: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768'],
    },
    {
        key: 'mistral',
        name: 'Mistral',
        description: 'Mistral Large, Small, Nemo models',
        requiresKey: true,
        staticModels: ['mistral-large-latest', 'mistral-small-latest', 'open-mistral-nemo'],
    },
    {
        key: 'deepseek',
        name: 'DeepSeek',
        description: 'DeepSeek-V3, R1 reasoning models',
        requiresKey: true,
        staticModels: ['deepseek-chat', 'deepseek-reasoner'],
    },
    {
        key: 'xai',
        name: 'xAI (Grok)',
        description: 'Grok-3, Grok-3 mini models',
        requiresKey: true,
        staticModels: ['grok-3', 'grok-3-mini', 'grok-2'],
    },
    {
        key: 'ollama',
        name: 'Ollama',
        description: 'Run models locally — no API key required',
        badge: 'Local',
        badgeColor: 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30',
        requiresKey: false,
    },
]

const TASK_LABELS: Record<TaskType, string> = {
    planning: 'Planning',
    codeGeneration: 'Code generation',
    verification: 'Verification',
    summarization: 'Summarization',
    classification: 'Classification',
    logAnalysis: 'Log analysis',
}

const DEFAULT_MODELS: Record<TaskType, string> = {
    planning: 'claude-sonnet-4-5',
    codeGeneration: 'claude-sonnet-4-5',
    verification: 'claude-sonnet-4-5',
    summarization: 'claude-haiku-4-5',
    classification: 'claude-haiku-4-5',
    logAnalysis: 'claude-haiku-4-5',
}

// ── Status indicator ──────────────────────────────────────────────────────────

function StatusDot({ status }: { status: ProviderStatus }) {
    if (status === 'configured') return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
    if (status === 'untested') return <AlertCircle className="h-3.5 w-3.5 text-amber-400" />
    return <Circle className="h-3.5 w-3.5 text-zinc-600" />
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function AIProvidersPage() {
    const [selectedProvider, setSelectedProvider] = useState<ProviderKey>('anthropic')
    const [primaryProvider, setPrimaryProvider] = useState<ProviderKey>('anthropic')
    const [providerStates, setProviderStates] = useState<Record<ProviderKey, ProviderState>>(
        () => Object.fromEntries(
            PROVIDERS.map((p) => [p.key, {
                apiKey: '',
                baseUrl: p.key === 'ollama' ? 'http://localhost:11434' : '',
                selectedModel: '',
                status: 'unconfigured' as ProviderStatus,
                testResult: null,
            }])
        ) as Record<ProviderKey, ProviderState>
    )
    const [testing, setTesting] = useState(false)
    const [saving, setSaving] = useState(false)
    const [saved, setSaved] = useState(false)
    const [showRouting, setShowRouting] = useState(false)
    const [modelRouting, setModelRouting] = useState<Record<TaskType, string>>(
        { ...DEFAULT_MODELS }
    )

    const selected = PROVIDERS.find((p) => p.key === selectedProvider)!
    const state = providerStates[selectedProvider]

    function updateState(key: ProviderKey, patch: Partial<ProviderState>) {
        setProviderStates((prev) => ({
            ...prev,
            [key]: { ...prev[key], ...patch },
        }))
    }

    async function handleTest() {
        setTesting(true)
        updateState(selectedProvider, { testResult: null })
        try {
            const res = await fetch('/api/settings/ai-providers/test', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    provider: selectedProvider,
                    apiKey: state.apiKey,
                    baseUrl: state.baseUrl,
                    model: state.selectedModel || selected.staticModels?.[0] || 'default',
                }),
            })
            const data = await res.json() as { ok: boolean; message: string; latencyMs?: number }
            if (data.ok) {
                updateState(selectedProvider, {
                    status: 'configured',
                    testResult: `✓ ${data.message}${data.latencyMs ? ` in ${data.latencyMs}ms` : ''}`,
                })
            } else {
                updateState(selectedProvider, {
                    status: 'untested',
                    testResult: `✗ ${data.message}`,
                })
            }
        } catch {
            updateState(selectedProvider, {
                status: 'untested',
                testResult: '✗ Network error — check console',
            })
        } finally {
            setTesting(false)
        }
    }

    async function handleSave() {
        setSaving(true)
        await new Promise((r) => setTimeout(r, 500))
        // Mark as untested if key changed
        if (state.status === 'unconfigured' && state.apiKey) {
            updateState(selectedProvider, { status: 'untested' })
        }
        setSaving(false)
        setSaved(true)
        setTimeout(() => setSaved(false), 2500)
    }

    const configuredProviders = PROVIDERS.filter((p) => providerStates[p.key].status !== 'unconfigured')

    return (
        <div className="flex flex-col gap-6 h-full">
            {/* Header */}
            <div>
                <h1 className="text-xl font-bold text-zinc-50">AI Providers</h1>
                <p className="mt-0.5 text-sm text-zinc-500">
                    Configure which AI providers Plexo uses for task execution and routing.
                </p>
            </div>

            {/* Two-panel layout */}
            <div className="flex gap-4 flex-1 min-h-0">
                {/* Left panel — provider grid */}
                <div className="w-[280px] shrink-0 flex flex-col gap-2 overflow-y-auto">
                    {PROVIDERS.map((p) => {
                        const pState = providerStates[p.key]
                        const active = p.key === selectedProvider
                        return (
                            <button
                                key={p.key}
                                onClick={() => setSelectedProvider(p.key)}
                                className={`text-left rounded-xl border p-3 transition-all ${active
                                        ? 'border-indigo-500/50 bg-zinc-900 shadow-sm shadow-indigo-500/10'
                                        : 'border-zinc-800 bg-zinc-900/40 hover:border-zinc-700 hover:bg-zinc-900/70'
                                    }`}
                            >
                                <div className="flex items-start justify-between gap-2">
                                    <div className="flex items-center gap-2.5">
                                        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-zinc-800 text-xs font-bold text-zinc-300">
                                            {p.name.slice(0, 2).toUpperCase()}
                                        </div>
                                        <div>
                                            <div className="flex items-center gap-1.5">
                                                <p className="text-sm font-medium text-zinc-200">{p.name}</p>
                                                {primaryProvider === p.key && (
                                                    <Star className="h-3 w-3 text-indigo-400 fill-indigo-400" />
                                                )}
                                            </div>
                                            {p.badge && (
                                                <span className={`text-[10px] font-semibold tracking-wide rounded px-1.5 py-0.5 ${p.badgeColor}`}>
                                                    {p.badge}
                                                </span>
                                            )}
                                        </div>
                                    </div>
                                    <StatusDot status={pState.status} />
                                </div>
                                <p className="mt-1.5 text-xs text-zinc-500 pl-10">{p.description}</p>
                            </button>
                        )
                    })}
                </div>

                {/* Right panel — provider config */}
                <div className="flex-1 rounded-xl border border-zinc-800 bg-zinc-900/40 p-5 overflow-y-auto">
                    {/* Header */}
                    <div className="flex items-center justify-between mb-5">
                        <div className="flex items-center gap-3">
                            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-zinc-800 text-sm font-bold text-zinc-300">
                                {selected.name.slice(0, 2).toUpperCase()}
                            </div>
                            <div>
                                <h2 className="text-base font-semibold text-zinc-100">{selected.name}</h2>
                                <div className="flex items-center gap-1.5">
                                    <StatusDot status={state.status} />
                                    <span className="text-xs text-zinc-500 capitalize">{state.status}</span>
                                </div>
                            </div>
                        </div>
                        <button
                            onClick={() => setPrimaryProvider(selectedProvider)}
                            className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${primaryProvider === selectedProvider
                                    ? 'border-indigo-500/50 bg-indigo-500/10 text-indigo-400'
                                    : 'border-zinc-700 bg-zinc-800 text-zinc-400 hover:border-zinc-600 hover:text-zinc-200'
                                }`}
                        >
                            <Star className={`h-3.5 w-3.5 ${primaryProvider === selectedProvider ? 'fill-indigo-400' : ''}`} />
                            {primaryProvider === selectedProvider ? 'Primary provider' : 'Set as primary'}
                        </button>
                    </div>

                    {/* Credential fields */}
                    <div className="flex flex-col gap-4">
                        {selected.requiresKey ? (
                            <div className="flex flex-col gap-1.5">
                                <label className="text-sm font-medium text-zinc-300">API Key</label>
                                <input
                                    type="password"
                                    value={state.apiKey}
                                    onChange={(e) => updateState(selectedProvider, { apiKey: e.target.value })}
                                    placeholder="sk-••••••••"
                                    autoComplete="new-password"
                                    className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500/30"
                                />
                                <p className="text-xs text-zinc-600">Write-only — existing value not shown. Leave blank to keep current.</p>
                            </div>
                        ) : (
                            <div className="flex flex-col gap-1.5">
                                <label className="text-sm font-medium text-zinc-300">Base URL</label>
                                <input
                                    type="text"
                                    value={state.baseUrl}
                                    onChange={(e) => updateState(selectedProvider, { baseUrl: e.target.value })}
                                    placeholder="http://localhost:11434"
                                    className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500/30"
                                />
                            </div>
                        )}

                        {/* Model selector (static list) */}
                        {selected.staticModels && (
                            <div className="flex flex-col gap-1.5">
                                <label className="text-sm font-medium text-zinc-300">Default model</label>
                                <select
                                    value={state.selectedModel}
                                    onChange={(e) => updateState(selectedProvider, { selectedModel: e.target.value })}
                                    className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500/30"
                                >
                                    <option value="">Use task routing defaults</option>
                                    {selected.staticModels.map((m) => (
                                        <option key={m} value={m}>{m}</option>
                                    ))}
                                </select>
                            </div>
                        )}

                        {/* Test button + result */}
                        <div className="flex items-center gap-3">
                            <button
                                onClick={handleTest}
                                disabled={testing}
                                className="flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm font-medium text-zinc-300 hover:border-zinc-600 hover:text-zinc-100 transition-colors disabled:opacity-50"
                            >
                                {testing
                                    ? <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                                    : <TestTube className="h-3.5 w-3.5" />
                                }
                                {testing ? 'Testing…' : 'Test connection'}
                            </button>
                            <button
                                onClick={handleSave}
                                disabled={saving}
                                className="flex items-center gap-2 rounded-lg bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-500 transition-colors disabled:opacity-50"
                            >
                                <Save className="h-3.5 w-3.5" />
                                {saving ? 'Saving…' : saved ? 'Saved' : 'Save'}
                            </button>
                        </div>

                        {state.testResult && (
                            <div className={`rounded-lg border px-3 py-2 text-sm font-mono ${state.testResult.startsWith('✓')
                                    ? 'border-emerald-800/50 bg-emerald-950/30 text-emerald-400'
                                    : 'border-red-800/50 bg-red-950/30 text-red-400'
                                }`}>
                                {state.testResult}
                            </div>
                        )}
                    </div>

                    {/* Fallback chain */}
                    {configuredProviders.length > 0 && (
                        <div className="mt-6">
                            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">
                                Fallback chain
                            </h3>
                            <p className="mb-3 text-xs text-zinc-600">
                                If the primary provider fails, Plexo tries these in order.
                            </p>
                            <div className="flex flex-col gap-1.5">
                                {configuredProviders.map((p) => (
                                    <div key={p.key} className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2">
                                        <GripVertical className="h-4 w-4 text-zinc-700" />
                                        <StatusDot status={providerStates[p.key].status} />
                                        <span className="text-sm text-zinc-300">{p.name}</span>
                                        {primaryProvider === p.key && (
                                            <span className="ml-auto text-xs text-indigo-400">primary</span>
                                        )}
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Model routing — collapsible advanced section */}
                    <div className="mt-6">
                        <button
                            onClick={() => setShowRouting((v) => !v)}
                            className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-zinc-500 hover:text-zinc-400 transition-colors"
                        >
                            {showRouting ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                            Model Routing (Advanced)
                        </button>
                        {showRouting && (
                            <div className="mt-3 rounded-xl border border-zinc-800 bg-zinc-900/40 overflow-hidden">
                                <table className="w-full text-sm">
                                    <thead>
                                        <tr className="border-b border-zinc-800">
                                            <th className="px-4 py-2.5 text-left text-xs font-medium text-zinc-500">Task type</th>
                                            <th className="px-4 py-2.5 text-left text-xs font-medium text-zinc-500">Model</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {(Object.entries(TASK_LABELS) as [TaskType, string][]).map(([taskType, label]) => (
                                            <tr key={taskType} className="border-b border-zinc-800/50 last:border-0">
                                                <td className="px-4 py-2.5 text-zinc-400">{label}</td>
                                                <td className="px-4 py-2.5">
                                                    <input
                                                        type="text"
                                                        value={modelRouting[taskType]}
                                                        onChange={(e) => setModelRouting((prev) => ({ ...prev, [taskType]: e.target.value }))}
                                                        className="w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-100 placeholder:text-zinc-600 focus:border-indigo-500 focus:outline-none"
                                                        placeholder={DEFAULT_MODELS[taskType]}
                                                    />
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    )
}
