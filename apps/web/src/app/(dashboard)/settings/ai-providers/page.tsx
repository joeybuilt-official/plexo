'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useWorkspace } from '@web/context/workspace'
import {
    CheckCircle2,
    AlertCircle,
    Circle,
    ChevronDown,
    ChevronRight,
    ExternalLink,
    TestTube,
    Save,
    Star,
    RefreshCw,
    Zap,
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
    supportsOAuth?: boolean   // providers that accept Claude.ai subscription tokens
    staticModels?: string[]
}

interface ProviderState {
    apiKey: string
    oauthToken: string        // Claude.ai subscription token (sk-ant-oat01-*)
    baseUrl: string
    selectedModel: string
    status: ProviderStatus
    testResult: string | null
}

// ── Provider API key links ───────────────────────────────────────────────────

const PROVIDER_LINKS: Partial<Record<ProviderKey, { label: string; url: string }>> = {
    openrouter: { label: 'Get API key', url: 'https://openrouter.ai/keys' },
    anthropic: { label: 'Get API key', url: 'https://console.anthropic.com/account/keys' },
    openai: { label: 'Get API key', url: 'https://platform.openai.com/api-keys' },
    google: { label: 'Get API key', url: 'https://aistudio.google.com/app/apikey' },
    groq: { label: 'Get API key', url: 'https://console.groq.com/keys' },
    mistral: { label: 'Get API key', url: 'https://console.mistral.ai/api-keys/' },
    deepseek: { label: 'Get API key', url: 'https://platform.deepseek.com/api_keys' },
    xai: { label: 'Get API key', url: 'https://console.x.ai/' },
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
        supportsOAuth: true,
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
        description: 'Gemini 2.5, 2.0, 1.5 models',
        requiresKey: true,
        staticModels: ['gemini-2.5-pro-exp-03-25', 'gemini-2.0-flash-lite', 'gemini-1.5-flash', 'gemini-1.5-pro'],
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
                oauthToken: '',
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
    const [loadError, setLoadError] = useState<string | null>(null)
    const [modelRouting, setModelRouting] = useState<Record<TaskType, string>>(
        { ...DEFAULT_MODELS }
    )
    const [fallbackOrder, setFallbackOrder] = useState<ProviderKey[]>(PROVIDERS.map((p) => p.key))

    const API_BASE = typeof window !== 'undefined'
        ? (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001')
        : 'http://localhost:3001'
    const { workspaceId: ctxWorkspaceId } = useWorkspace()
    const WS_ID = ctxWorkspaceId || (process.env.NEXT_PUBLIC_DEFAULT_WORKSPACE ?? '')

    // Load persisted config on mount
    useEffect(() => {
        if (!WS_ID) return
        void (async () => {
            try {
                const res = await fetch(`${API_BASE}/api/workspaces/${WS_ID}`)
                if (!res.ok) return
                const ws = await res.json() as {
                    settings?: {
                        aiProviders?: {
                            primary?: ProviderKey
                            modelRouting?: Record<TaskType, string>
                            fallbackOrder?: ProviderKey[]
                            providers?: Record<ProviderKey, { status: ProviderStatus; selectedModel: string; baseUrl: string }>
                        }
                    }
                }
                const aiCfg = ws.settings?.aiProviders
                if (!aiCfg) return
                if (aiCfg.primary) setPrimaryProvider(aiCfg.primary)
                if (aiCfg.modelRouting) setModelRouting((prev) => ({ ...prev, ...aiCfg.modelRouting }))
                if (aiCfg.fallbackOrder?.length) setFallbackOrder(aiCfg.fallbackOrder)
                if (aiCfg.providers) {
                    setProviderStates((prev) => {
                        const next = { ...prev }
                        for (const [k, v] of Object.entries(aiCfg.providers!)) {
                            const pk = k as ProviderKey
                            if (next[pk]) {
                                next[pk] = { ...next[pk], status: v.status, selectedModel: v.selectedModel ?? '', baseUrl: v.baseUrl ?? next[pk].baseUrl }
                            }
                        }
                        return next
                    })
                }
            } catch {
                setLoadError('Could not load saved provider config')
            }
        })()
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    const selected = PROVIDERS.find((p) => p.key === selectedProvider)!
    const state = providerStates[selectedProvider]

    function updateState(key: ProviderKey, patch: Partial<ProviderState>) {
        setProviderStates((prev) => ({
            ...prev,
            [key]: { ...prev[key], ...patch },
        }))
    }

    const oauthPopupRef = useRef<Window | null>(null)

    const handleClaudeOAuth = useCallback(() => {
        if (!WS_ID) return
        const url = `${API_BASE}/api/oauth/anthropic/start?workspaceId=${WS_ID}`
        const popup = window.open(url, 'claude-oauth', 'width=600,height=700,left=200,top=100')
        oauthPopupRef.current = popup

        function onMessage(e: MessageEvent) {
            if (e.data?.type !== 'oauth_callback' || e.data?.provider !== 'anthropic') return
            window.removeEventListener('message', onMessage)
            if (e.data.ok) {
                updateState('anthropic', {
                    status: 'configured',
                    testResult: '✓ Connected via Claude.ai subscription — tokens stored securely.',
                })
            } else {
                updateState('anthropic', {
                    status: 'untested',
                    testResult: `✗ Claude.ai OAuth failed: ${e.data.error ?? 'unknown error'}`,
                })
            }
        }
        window.addEventListener('message', onMessage)

        // Cleanup if popup is closed without completing
        const poll = setInterval(() => {
            if (popup?.closed) {
                clearInterval(poll)
                window.removeEventListener('message', onMessage)
            }
        }, 500)
    }, [WS_ID, API_BASE])

    async function handleTest() {
        setTesting(true)
        updateState(selectedProvider, { testResult: null })
        try {
            // For Anthropic: prefer the OAuth token if set, otherwise use the API key
            const effectiveKey = selected.supportsOAuth && state.oauthToken
                ? state.oauthToken
                : state.apiKey
            const res = await fetch(`${API_BASE}/api/settings/ai-providers/test`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    provider: selectedProvider,
                    apiKey: effectiveKey,
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
        if (!WS_ID) return
        setSaving(true)
        try {
            // Persist provider config to workspace settings, including API keys.
            // Keys are stored in workspace JSONB settings (local dev only).
            // In production, prefer ANTHROPIC_API_KEY env var.
            const providersConfig: Record<string, { status: ProviderStatus; selectedModel: string; baseUrl: string; apiKey?: string; oauthToken?: string }> = {}
            for (const p of PROVIDERS) {
                const s = providerStates[p.key]
                // Include any provider that has a credential (regardless of test status)
                // OR that was already confirmed as configured/untested.
                const hasCredential = !!(s.apiKey || s.oauthToken)
                const hasStatus = s.status !== 'unconfigured'
                if (hasCredential || hasStatus) {
                    // Promote unconfigured-but-keyed providers to 'untested' before writing
                    const effectiveStatus = s.status === 'unconfigured' && hasCredential ? 'untested' : s.status
                    providersConfig[p.key] = {
                        status: effectiveStatus,
                        selectedModel: s.selectedModel,
                        baseUrl: s.baseUrl,
                        ...(s.apiKey ? { apiKey: s.apiKey } : {}),
                        ...(s.oauthToken ? { oauthToken: s.oauthToken } : {}),
                    }
                }
            }
            const res = await fetch(`${API_BASE}/api/workspaces/${WS_ID}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    settings: {
                        aiProviders: {
                            primary: primaryProvider,
                            primaryProvider: primaryProvider,  // canonical name read by agent-loop
                            modelRouting,
                            providers: providersConfig,
                            fallbackOrder,
                            fallbackChain: fallbackOrder,      // canonical name read by agent-loop
                        },
                    },
                }),
            })
            if (res.ok) {
                // Update UI state to reflect promoted statuses
                for (const p of PROVIDERS) {
                    const s = providerStates[p.key]
                    if (s.status === 'unconfigured' && (s.apiKey || s.oauthToken)) {
                        updateState(p.key, { status: 'untested' })
                    }
                }
                setSaved(true)
                setTimeout(() => setSaved(false), 2500)
            }
        } finally {
            setSaving(false)
        }
    }

    // All providers with any meaningful status (not completely unconfigured)
    const chainProviders = fallbackOrder
        .map((k) => PROVIDERS.find((p) => p.key === k)!)
        .filter((p): p is typeof PROVIDERS[number] => p != null && providerStates[p.key].status !== 'unconfigured')

    // Active = tested and working; warn = present but untested (greyed out, click to configure)
    const activeChainProviders = chainProviders.filter((p) => providerStates[p.key].status === 'configured')
    const warnChainProviders = chainProviders.filter((p) => providerStates[p.key].status !== 'configured')

    // Alias so section-visibility guard (configuredProviders.length > 0) still works
    const configuredProviders = chainProviders

    function moveFallback(key: ProviderKey, dir: -1 | 1) {
        setFallbackOrder((prev) => {
            const visible = prev.filter((k) => providerStates[k].status !== 'unconfigured')
            const hidden = prev.filter((k) => providerStates[k].status === 'unconfigured')
            const idx = visible.indexOf(key)
            if (idx === -1) return prev
            const swap = idx + dir
            if (swap < 0 || swap >= visible.length) return prev
            const next = [...visible]
                ;[next[idx], next[swap]] = [next[swap]!, next[idx]!]
            return [...next, ...hidden]
        })
    }

    function removeFromFallback(key: ProviderKey) {
        setFallbackOrder((prev) => prev.filter((k) => k !== key))
        setProviderStates((prev) => ({
            ...prev,
            [key]: { ...prev[key], status: 'unconfigured' as const },
        }))
    }

    return (
        <div className="flex flex-col gap-6 h-full">
            {/* Header */}
            <div>
                <h1 className="text-xl font-bold text-zinc-50">AI Providers</h1>
                <p className="mt-0.5 text-sm text-zinc-500">
                    Configure which AI providers Plexo uses for task execution and routing.
                </p>
            </div>

            {loadError && (
                <div className="rounded-lg border border-amber-800/50 bg-amber-950/20 px-3 py-2 text-xs text-amber-400">{loadError}</div>
            )}
            {!WS_ID && (
                <div className="rounded-lg border border-red-800/50 bg-red-950/20 px-3 py-2 text-xs text-red-400">NEXT_PUBLIC_DEFAULT_WORKSPACE not set — changes will not be persisted.</div>
            )}

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
                            <div className="flex flex-col gap-4">

                                {/* Claude OAuth — prominent inline connect button */}
                                {selected.supportsOAuth && (
                                    <div className="flex flex-col gap-3 rounded-xl border border-violet-500/20 bg-violet-500/5 p-4">
                                        <div className="flex items-start gap-3">
                                            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-violet-500/15">
                                                <Zap className="h-4 w-4 text-violet-400" />
                                            </div>
                                            <div>
                                                <p className="text-sm font-medium text-zinc-200">Connect with Claude.ai</p>
                                                <p className="mt-0.5 text-xs text-zinc-500">
                                                    Use your Claude Pro or Max subscription instead of a paid API key.
                                                    Tokens are stored securely and refreshed automatically.
                                                </p>
                                            </div>
                                        </div>
                                        <button
                                            onClick={handleClaudeOAuth}
                                            disabled={!WS_ID}
                                            className="flex w-full items-center justify-center gap-2 rounded-lg bg-violet-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-violet-500 transition-colors disabled:opacity-40"
                                        >
                                            <Zap className="h-3.5 w-3.5" />
                                            Connect with Claude.ai
                                        </button>
                                    </div>
                                )}

                                {/* API key field */}
                                <div className="flex flex-col gap-1.5">
                                    <div className="flex items-center justify-between">
                                        <label className="text-sm font-medium text-zinc-300">
                                            {selected.supportsOAuth ? 'API Key' : 'API Key'}
                                        </label>
                                        {PROVIDER_LINKS[selectedProvider] && (
                                            <a
                                                href={PROVIDER_LINKS[selectedProvider]!.url}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                className="flex items-center gap-1 text-xs text-indigo-400 hover:text-indigo-300 transition-colors"
                                            >
                                                {PROVIDER_LINKS[selectedProvider]!.label}
                                                <ExternalLink className="h-3 w-3" />
                                            </a>
                                        )}
                                    </div>
                                    <input
                                        type="password"
                                        value={state.apiKey}
                                        onChange={(e) => updateState(selectedProvider, { apiKey: e.target.value })}
                                        placeholder={selected.supportsOAuth ? 'sk-ant-api03-•••••••• (permanent API key)' : 'sk-••••••••'}
                                        autoComplete="new-password"
                                        className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500/30"
                                    />
                                    <p className="text-xs text-zinc-600">
                                        {selected.supportsOAuth
                                            ? 'Permanent API key from console.anthropic.com. Write-only — leave blank to keep current.'
                                            : 'Write-only — existing value not shown. Leave blank to keep current.'}
                                    </p>
                                </div>

                                {/* OAuth token manual paste (Anthropic only) */}
                                {selected.supportsOAuth && (
                                    <div className="flex flex-col gap-1.5">
                                        <div className="flex items-center gap-2">
                                            <label className="text-sm font-medium text-zinc-300">Claude.ai OAuth Token</label>
                                            <span className="text-[10px] font-semibold rounded px-1.5 py-0.5 bg-violet-500/15 text-violet-400 border border-violet-500/30">manual paste</span>
                                        </div>
                                        <input
                                            type="password"
                                            value={state.oauthToken}
                                            onChange={(e) => updateState(selectedProvider, { oauthToken: e.target.value })}
                                            placeholder="sk-ant-oat01-•••••••• (if not using the button above)"
                                            autoComplete="new-password"
                                            className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500/30"
                                        />
                                        <p className="text-xs text-zinc-600">
                                            Use the button above if possible — tokens expire after 1hr and need manual re-entry.
                                            Uses <code className="text-zinc-500">Authorization: Bearer</code>. Takes priority over API key if set.
                                        </p>
                                    </div>
                                )}
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
                </div>
            </div>

            {/* ── Global Routing ─────────────────────────────────── */}
            {configuredProviders.length > 0 && (
                <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
                    <div className="flex items-start justify-between gap-4">
                        <div>
                            <h2 className="text-sm font-semibold text-zinc-200">Fallback Chain</h2>
                            <p className="mt-0.5 text-xs text-zinc-500">
                                If the primary provider fails, Plexo tries these in order — across all task types.
                            </p>
                        </div>
                        <button
                            onClick={() => setShowRouting((v) => !v)}
                            className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-400 transition-colors shrink-0"
                        >
                            {showRouting ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                            Model routing
                        </button>
                    </div>

                    {/* Provider priority row */}
                    <div className="mt-4 flex items-center gap-2 flex-wrap">
                        {/* Active (configured) providers — full controls */}
                        {activeChainProviders.map((p, idx) => (
                            <div
                                key={p.key}
                                className={`flex items-center gap-2 rounded-lg border px-3 py-2 ${primaryProvider === p.key
                                    ? 'border-indigo-500/40 bg-indigo-500/8'
                                    : 'border-zinc-700 bg-zinc-900/60'
                                    }`}
                            >
                                <span className="text-xs text-zinc-600 font-mono w-4 text-center">{idx + 1}</span>
                                <StatusDot status={providerStates[p.key].status} />
                                <span className="text-sm text-zinc-300">{p.name}</span>
                                {primaryProvider === p.key && (
                                    <span className="text-[10px] text-indigo-400 font-medium">primary</span>
                                )}
                                <div className="flex gap-0.5 ml-1">
                                    <button
                                        onClick={() => moveFallback(p.key, -1)}
                                        disabled={idx === 0}
                                        className="text-zinc-600 hover:text-zinc-400 disabled:opacity-20 leading-none px-0.5"
                                        aria-label="Move earlier"
                                    >◀</button>
                                    <button
                                        onClick={() => moveFallback(p.key, 1)}
                                        disabled={idx === activeChainProviders.length - 1}
                                        className="text-zinc-600 hover:text-zinc-400 disabled:opacity-20 leading-none px-0.5"
                                        aria-label="Move later"
                                    >▶</button>
                                    <button
                                        onClick={() => removeFromFallback(p.key)}
                                        className="ml-1 text-zinc-600 hover:text-red-400 leading-none px-0.5 transition-colors"
                                        aria-label="Remove from chain"
                                        title="Remove from chain"
                                    >×</button>
                                </div>
                            </div>
                        ))}

                        {/* Degraded (untested/unconfigured) providers — greyed, clickable, removable */}
                        {warnChainProviders.map((p) => (
                            <div
                                key={p.key}
                                className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/30 px-3 py-2 opacity-50"
                                title={`${p.name} — not tested. Click to configure.`}
                            >
                                <StatusDot status={providerStates[p.key].status} />
                                <button
                                    onClick={() => setSelectedProvider(p.key)}
                                    className="text-sm text-zinc-500 hover:text-zinc-300 transition-colors"
                                >
                                    {p.name}
                                </button>
                                <button
                                    onClick={() => removeFromFallback(p.key)}
                                    className="ml-1 text-zinc-600 hover:text-red-400 leading-none px-0.5 transition-colors"
                                    aria-label="Remove from chain"
                                    title="Remove from chain"
                                >×</button>
                            </div>
                        ))}
                    </div>

                    {/* Model routing — collapsible */}
                    {showRouting && (
                        <div className="mt-4 rounded-xl border border-zinc-800 bg-zinc-900/40 overflow-hidden">
                            <div className="px-4 py-2.5 border-b border-zinc-800">
                                <p className="text-xs text-zinc-500">Map each task type to a specific model. Leave blank to use the primary provider's default.</p>
                            </div>
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
            )}
        </div>
    )
}
