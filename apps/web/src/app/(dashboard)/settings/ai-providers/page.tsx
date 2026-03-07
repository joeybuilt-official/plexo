'use client'

export const dynamic = 'force-dynamic'

import { useState, useEffect, useRef, useMemo } from 'react'
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
    Users,
    X,
    Link2,
    Share2,
} from 'lucide-react'
import { getModelCapabilities } from '@web/lib/models'
import { CapabilityList } from '@web/components/capabilities'
import { useListFilter, ListToolbar } from '@web/components/list-toolbar'
import type { FilterDimension } from '@web/components/list-toolbar'

const FILTER_KEYS = ['status', 'type'] as const

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
    dynamicModels: string[]   // fetched from local provider (e.g. Ollama /api/tags)
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
        description: '200+ models via single API key — free tier available, no credits required',
        badge: 'RECOMMENDED',
        badgeColor: 'bg-amber-500/15 text-amber-400 border border-amber-500/30',
        requiresKey: true,
        staticModels: [
            // Free tier (no credits needed — ~50 req/day; some require Model Training enabled in OR privacy settings)
            'deepseek/deepseek-chat-v3-0324:free',
            'meta-llama/llama-3.3-70b-instruct:free',
            'deepseek/deepseek-r1:free',
            'mistralai/mistral-small-3.1-24b-instruct:free',
            'meta-llama/llama-3.2-3b-instruct:free',
            // Paid models (requires credits)
            'openai/gpt-4o',
            'openai/gpt-4o-mini',
            'anthropic/claude-sonnet-4-5',
            'anthropic/claude-haiku-4-5',
            'google/gemini-2.5-flash',
            'meta-llama/llama-3.3-70b-instruct',
        ],
    },
    {
        key: 'anthropic',
        name: 'Anthropic',
        description: 'Claude Sonnet, Haiku, Opus — API key required (sk-ant-api03-*)',
        requiresKey: true,
        staticModels: ['claude-opus-4-5', 'claude-sonnet-4-5', 'claude-haiku-4-5', 'claude-opus-4-6', 'claude-sonnet-4-6'],
    },
    {
        key: 'openai',
        name: 'OpenAI',
        description: 'GPT-4o, o1, o3 models',
        requiresKey: true,
        staticModels: ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4o', 'gpt-4o-mini', 'o4-mini', 'o3', 'o3-mini', 'o1', 'o1-mini'],
    },
    {
        key: 'google',
        name: 'Google Gemini',
        description: 'Gemini 2.5, 2.0 models',
        requiresKey: true,
        staticModels: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.5-flash-8b', 'gemini-2.0-flash'],
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

// Per-provider smart defaults for each task type.
// These are used as placeholder / initial values — never hard-wired Claude IDs on non-Anthropic providers.
const PROVIDER_DEFAULT_ROUTING: Partial<Record<ProviderKey, Record<TaskType, string>>> = {
    anthropic: {
        planning: 'claude-sonnet-4-5',
        codeGeneration: 'claude-sonnet-4-5',
        verification: 'claude-sonnet-4-5',
        summarization: 'claude-haiku-4-5',
        classification: 'claude-haiku-4-5',
        logAnalysis: 'claude-haiku-4-5',
    },
    openai: {
        planning: 'gpt-4.1',
        codeGeneration: 'gpt-4.1',
        verification: 'gpt-4.1',
        summarization: 'gpt-4.1-mini',
        classification: 'gpt-4o-mini',
        logAnalysis: 'gpt-4.1-mini',
    },
    google: {
        planning: 'gemini-2.5-pro',
        codeGeneration: 'gemini-2.5-pro',
        verification: 'gemini-2.5-pro',
        summarization: 'gemini-2.5-flash',
        classification: 'gemini-2.5-flash',
        logAnalysis: 'gemini-2.5-flash',
    },
    groq: {
        planning: 'llama-3.3-70b-versatile',
        codeGeneration: 'llama-3.3-70b-versatile',
        verification: 'llama-3.3-70b-versatile',
        summarization: 'llama-3.1-8b-instant',
        classification: 'llama-3.1-8b-instant',
        logAnalysis: 'llama-3.1-8b-instant',
    },
    mistral: {
        planning: 'mistral-large-latest',
        codeGeneration: 'mistral-large-latest',
        verification: 'mistral-large-latest',
        summarization: 'mistral-small-latest',
        classification: 'mistral-small-latest',
        logAnalysis: 'mistral-small-latest',
    },
    deepseek: {
        planning: 'deepseek-reasoner',
        codeGeneration: 'deepseek-chat',
        verification: 'deepseek-chat',
        summarization: 'deepseek-chat',
        classification: 'deepseek-chat',
        logAnalysis: 'deepseek-chat',
    },
    xai: {
        planning: 'grok-3',
        codeGeneration: 'grok-3',
        verification: 'grok-3',
        summarization: 'grok-3-mini',
        classification: 'grok-3-mini',
        logAnalysis: 'grok-3-mini',
    },
    openrouter: {
        planning: 'openai/gpt-4o',
        codeGeneration: 'openai/gpt-4o',
        verification: 'openai/gpt-4o',
        summarization: 'openai/gpt-4o-mini',
        classification: 'openai/gpt-4o-mini',
        logAnalysis: 'openai/gpt-4o-mini',
    },
}

function getDefaultModelsForProvider(providerKey: ProviderKey): Record<TaskType, string> {
    return PROVIDER_DEFAULT_ROUTING[providerKey] ?? PROVIDER_DEFAULT_ROUTING.anthropic!
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
                dynamicModels: [] as string[],
                status: 'unconfigured' as ProviderStatus,
                testResult: null,
            }])
        ) as unknown as Record<ProviderKey, ProviderState>
    )
    const [testing, setTesting] = useState(false)
    const [connecting, setConnecting] = useState(false)
    const [saving, setSaving] = useState(false)
    const [saved, setSaved] = useState(false)
    const [showRouting, setShowRouting] = useState(false)
    const [showFallback, setShowFallback] = useState(false)
    const [showCostDefaults, setShowCostDefaults] = useState(false)
    const [editingKey, setEditingKey] = useState<Record<ProviderKey, boolean>>(
        () => Object.fromEntries(PROVIDERS.map((p) => [p.key, false])) as Record<ProviderKey, boolean>
    )
    const [clearConfirm, setClearConfirm] = useState<ProviderKey | null>(null)
    const [loadError, setLoadError] = useState<string | null>(null)
    const [modelRouting, setModelRouting] = useState<Record<TaskType, string>>(
        () => ({ ...getDefaultModelsForProvider('anthropic') })
    )
    const [fallbackOrder, setFallbackOrder] = useState<ProviderKey[]>(PROVIDERS.map((p) => p.key))
    const [wsDefaultCostCeiling, setWsDefaultCostCeiling] = useState('')
    const [wsDefaultTokenBudget, setWsDefaultTokenBudget] = useState('')

    // Key sharing state
    type KeyShare = { id: string; providerKey: string; grantedAt: string; targetWorkspace?: { id: string; name: string }; sourceWorkspace?: { id: string; name: string } }
    type OwnWorkspace = { id: string; name: string }
    const [lending, setLending] = useState<KeyShare[]>([])
    const [borrowing, setBorrowing] = useState<KeyShare[]>([])
    const [ownWorkspaces, setOwnWorkspaces] = useState<OwnWorkspace[]>([])
    const [shareModal, setShareModal] = useState<{ providerKey: ProviderKey } | null>(null)
    const [shareTargets, setShareTargets] = useState<Set<string>>(new Set())
    const [sharingBusy, setSharingBusy] = useState(false)

    const API_BASE = typeof window !== 'undefined'
        ? ((typeof window !== 'undefined' ? '' : (process.env.INTERNAL_API_URL || 'http://localhost:3001')))
        : 'http://localhost:3001'
    const { workspaceId: ctxWorkspaceId } = useWorkspace()
    const WS_ID = ctxWorkspaceId || (process.env.NEXT_PUBLIC_DEFAULT_WORKSPACE ?? '')
    // Track which workspace we've already loaded — prevents double-fetch
    const loadedForRef = useRef<string | null>(null)

    const lf = useListFilter(FILTER_KEYS, 'default')
    const { search, filterValues, clearAll } = lf

    // WS_ID is async from useWorkspace() context — deps [WS_ID] ensures we reload
    // when it resolves. loadedForRef prevents redundant re-fetches for same workspace.
    useEffect(() => {
        if (!WS_ID || loadedForRef.current === WS_ID) return
        loadedForRef.current = WS_ID
        void (async () => {
            try {
                const res = await fetch(`${API_BASE}/api/v1/workspaces/${WS_ID}/ai-providers`)
                if (!res.ok) return
                const data = await res.json() as {
                    aiProviders?: {
                        primary?: ProviderKey
                        primaryProvider?: ProviderKey
                        modelRouting?: Record<TaskType, string>
                        fallbackOrder?: ProviderKey[]
                        fallbackChain?: ProviderKey[]
                        providers?: Record<ProviderKey, {
                            status: ProviderStatus
                            selectedModel: string
                            baseUrl: string
                            // apiKey / oauthToken will be '__configured__' sentinel if set
                            apiKey?: string
                            oauthToken?: string
                        }>
                    }
                }
                const aiCfg = data.aiProviders
                if (!aiCfg) return
                const primary = aiCfg.primary ?? aiCfg.primaryProvider
                if (primary) {
                    setPrimaryProvider(primary)
                    if (!aiCfg.modelRouting) {
                        setModelRouting({ ...getDefaultModelsForProvider(primary as ProviderKey) })
                    }
                }
                if (aiCfg.modelRouting) {
                    setModelRouting((prev) => ({
                        ...getDefaultModelsForProvider((primary ?? 'anthropic') as ProviderKey),
                        ...prev,
                        ...aiCfg.modelRouting,
                    }))
                }
                const order = aiCfg.fallbackOrder ?? aiCfg.fallbackChain
                if (order?.length) setFallbackOrder(order)
                // Load workspace budget defaults
                const rawData = data as Record<string, unknown>
                const rawAp = rawData.aiProviders as Record<string, unknown> | undefined
                if (rawAp?.defaultTaskCostCeiling) setWsDefaultCostCeiling(String(rawAp.defaultTaskCostCeiling))
                if (rawAp?.defaultTokenBudget) setWsDefaultTokenBudget(String(rawAp.defaultTokenBudget))
                if (aiCfg.providers) {
                    const ollamaEntry = aiCfg.providers['ollama' as ProviderKey]
                    setProviderStates((prev) => {
                        const next = { ...prev }
                        for (const [k, v] of Object.entries(aiCfg.providers!)) {
                            const pk = k as ProviderKey
                            if (next[pk]) {
                                next[pk] = {
                                    ...next[pk],
                                    status: v.status,
                                    selectedModel: v.selectedModel ?? '',
                                    baseUrl: v.baseUrl ?? next[pk].baseUrl,
                                    // Sentinel means configured — keep input empty so placeholder shows
                                    apiKey: '',
                                }
                            }
                        }
                        return next
                    })
                    // Auto-fetch Ollama models if it was previously configured
                    if (ollamaEntry?.status === 'configured') {
                        const ollamaBase = ollamaEntry.baseUrl ?? 'http://localhost:11434'
                        void (async () => {
                            try {
                                const mr = await fetch(`${API_BASE}/api/v1/settings/ai-providers/models?provider=ollama&baseUrl=${encodeURIComponent(ollamaBase)}`)
                                if (mr.ok) {
                                    const md = await mr.json() as { ok: boolean; models?: string[] }
                                    if (md.ok && md.models?.length) {
                                        setProviderStates((prev) => ({
                                            ...prev,
                                            ollama: { ...prev.ollama, dynamicModels: md.models! },
                                        }))
                                    }
                                }
                            } catch { /* non-fatal */ }
                        })()
                    }
                }
            } catch {
                setLoadError('Could not load saved provider config')
            }
        })()
    // WS_ID is async from useWorkspace() — run again when it resolves
    }, [WS_ID, API_BASE])

    // Load key shares and own workspaces once WS_ID resolves
    useEffect(() => {
        if (!WS_ID) return
        void (async () => {
            try {
                const [sharesRes, wsRes] = await Promise.all([
                    fetch(`${API_BASE}/api/v1/workspaces/${WS_ID}/key-shares`),
                    fetch(`${API_BASE}/api/v1/workspaces`),
                ])
                if (sharesRes.ok) {
                    const sd = await sharesRes.json() as { lending?: KeyShare[]; borrowing?: KeyShare[] }
                    setLending(sd.lending ?? [])
                    setBorrowing(sd.borrowing ?? [])
                }
                if (wsRes.ok) {
                    const wd = await wsRes.json() as OwnWorkspace[]
                    setOwnWorkspaces(wd.filter((w) => w.id !== WS_ID))
                }
            } catch { /* non-fatal */ }
        })()
    }, [WS_ID, API_BASE])

    const selected = PROVIDERS.find((p) => p.key === selectedProvider)!
    const state = providerStates[selectedProvider]

    function updateState(key: ProviderKey, patch: Partial<ProviderState>) {
        setProviderStates((prev) => ({
            ...prev,
            [key]: { ...prev[key], ...patch },
        }))
    }

    async function handleShare() {
        if (!WS_ID || !shareModal || shareTargets.size === 0) return
        setSharingBusy(true)
        try {
            await Promise.all([...shareTargets].map((targetWsId) =>
                fetch(`${API_BASE}/api/v1/workspaces/${WS_ID}/key-shares`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ targetWorkspaceId: targetWsId, providerKey: shareModal.providerKey }),
                })
            ))
            // Refresh shares
            const res = await fetch(`${API_BASE}/api/v1/workspaces/${WS_ID}/key-shares`)
            if (res.ok) {
                const sd = await res.json() as { lending?: KeyShare[]; borrowing?: KeyShare[] }
                setLending(sd.lending ?? [])
                setBorrowing(sd.borrowing ?? [])
            }
            setShareModal(null)
            setShareTargets(new Set())
        } finally {
            setSharingBusy(false)
        }
    }

    async function handleRevokeShare(shareId: string) {
        if (!WS_ID) return
        await fetch(`${API_BASE}/api/v1/workspaces/${WS_ID}/key-shares/${shareId}`, { method: 'DELETE' })
        setLending((prev) => prev.filter((s) => s.id !== shareId))
    }

    async function handleStopBorrowing(providerKey: ProviderKey) {
        if (!WS_ID) return
        const share = borrowing.find((s) => s.providerKey === providerKey)
        if (!share?.sourceWorkspace?.id) return
        // DELETE on the source workspace's share
        await fetch(`${API_BASE}/api/v1/workspaces/${share.sourceWorkspace.id}/key-shares/${share.id}`, { method: 'DELETE' })
        setBorrowing((prev) => prev.filter((s) => s.id !== share.id))
        // Reset the provider to unconfigured in local state
        updateState(providerKey, { status: 'unconfigured', apiKey: '' })
    }

    // Fetch models from a URL-based provider (Ollama, etc.) without running a test.
    // Populates dynamicModels so the dropdown appears before Save & Test.
    async function handleConnect() {
        setConnecting(true)
        try {
            const baseUrl = providerStates[selectedProvider].baseUrl || 'http://localhost:11434'
            const res = await fetch(
                `${API_BASE}/api/v1/settings/ai-providers/models?provider=${selectedProvider}&baseUrl=${encodeURIComponent(baseUrl)}`
            )
            if (res.ok) {
                const data = await res.json() as { ok: boolean; models?: string[]; error?: string }
                if (data.ok && data.models?.length) {
                    updateState(selectedProvider, {
                        dynamicModels: data.models,
                        selectedModel: providerStates[selectedProvider].selectedModel || data.models[0]!,
                        status: 'untested',
                    })
                } else {
                    updateState(selectedProvider, { testResult: `✗ ${data.error ?? 'No models found — is Ollama running?'}` })
                }
            } else {
                updateState(selectedProvider, { testResult: '✗ Could not reach the server — check the URL and try again' })
            }
        } catch {
            updateState(selectedProvider, { testResult: '✗ Network error — check console' })
        } finally {
            setConnecting(false)
        }
    }

    async function handleTest() {
        setTesting(true)
        updateState(selectedProvider, { testResult: null })
        try {
            const res = await fetch(`${API_BASE}/api/v1/settings/ai-providers/test`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    provider: selectedProvider,
                    apiKey: state.apiKey,
                    baseUrl: state.baseUrl,
                    model: state.selectedModel || selected.staticModels?.[0] || undefined,
                    workspaceId: WS_ID,
                }),
            })
            const data = await res.json() as { ok: boolean; message: string; latencyMs?: number; model?: string }
            if (data.ok) {
                const patch: Partial<ProviderState> = {
                    status: 'configured',
                    testResult: `✓ ${data.message}${data.latencyMs ? ` in ${data.latencyMs}ms` : ''}`,
                    ...(data.model ? { selectedModel: data.model } : {}),
                }
                updateState(selectedProvider, patch)
                // Exit key-edit mode on success
                setEditingKey((prev) => ({ ...prev, [selectedProvider]: false }))
                // For Ollama: also fetch the model list so the dropdown is populated
                if (selectedProvider === 'ollama') {
                    try {
                        const modelsRes = await fetch(`${API_BASE}/api/v1/settings/ai-providers/models?provider=ollama&baseUrl=${encodeURIComponent(state.baseUrl || 'http://localhost:11434')}`)
                        if (modelsRes.ok) {
                            const modelsData = await modelsRes.json() as { ok: boolean; models?: string[] }
                            if (modelsData.ok && modelsData.models?.length) {
                                const firstModel = modelsData.models[0]!
                                patch.dynamicModels = modelsData.models
                                if (!patch.selectedModel) patch.selectedModel = firstModel
                                updateState(selectedProvider, { dynamicModels: modelsData.models, selectedModel: patch.selectedModel })
                            }
                        }
                    } catch { /* non-fatal */ }
                }
                // Auto-save with the new state explicitly — avoids React setState timing issue
                await handleSave({ [selectedProvider]: patch } as Partial<Record<ProviderKey, Partial<ProviderState>>>)
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

    async function handleSave(stateOverrides?: Partial<Record<ProviderKey, Partial<ProviderState>>>) {
        if (!WS_ID) return
        setSaving(true)
        try {
            const providersConfig: Record<string, { status: ProviderStatus; selectedModel: string; baseUrl: string; apiKey?: string }> = {}
            for (const p of PROVIDERS) {
                // Merge current state with any overrides (e.g. from successful test result)
                const s = { ...providerStates[p.key], ...(stateOverrides?.[p.key] ?? {}) }
                const hasCredential = !!s.apiKey
                const hasStatus = s.status !== 'unconfigured'
                if (hasCredential || hasStatus) {
                    const effectiveStatus = s.status === 'unconfigured' && hasCredential ? 'untested' : s.status
                    providersConfig[p.key] = {
                        status: effectiveStatus,
                        selectedModel: s.selectedModel.trim(),
                        baseUrl: s.baseUrl.trim(),
                        // Only include credential value when user has entered something new
                        // Empty string means "don't change" — server will keep existing encrypted value
                        ...(s.apiKey?.trim() ? { apiKey: s.apiKey.trim() } : {}),
                    }
                }
            }
            const res = await fetch(`${API_BASE}/api/v1/workspaces/${WS_ID}/ai-providers`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    primary: primaryProvider,
                    primaryProvider: primaryProvider,
                    modelRouting,
                    providers: providersConfig,
                    fallbackOrder,
                    fallbackChain: fallbackOrder,
                    // Workspace-level task budget defaults
                    ...(parseFloat(wsDefaultCostCeiling) > 0 ? { defaultTaskCostCeiling: parseFloat(wsDefaultCostCeiling) } : {}),
                    ...(parseInt(wsDefaultTokenBudget, 10) > 0 ? { defaultTokenBudget: parseInt(wsDefaultTokenBudget, 10) } : {}),
                }),
            })
            if (res.ok) {
                for (const p of PROVIDERS) {
                    const s = { ...providerStates[p.key], ...(stateOverrides?.[p.key] ?? {}) }
                    if (s.status === 'unconfigured' && s.apiKey) {
                        updateState(p.key, { status: 'untested' })
                    }
                }
                setSaved(true)
                // Clear key inputs after successful save — server has them encrypted
                setProviderStates((prev) => {
                    const cleared = { ...prev }
                    for (const p of PROVIDERS) {
                        cleared[p.key] = { ...cleared[p.key], apiKey: '' }
                    }
                    return cleared
                })
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

    const displayedProviders = useMemo((): ProviderConfig[] => {
        let res = PROVIDERS
        const q = search.trim().toLowerCase()
        if (filterValues.status) {
            res = res.filter((p) => providerStates[p.key].status === filterValues.status)
        }
        if (filterValues.type) {
            res = res.filter((p) => (filterValues.type === 'local' ? !p.requiresKey : p.requiresKey))
        }
        if (q) {
            res = res.filter((p) =>
                p.name.toLowerCase().includes(q) ||
                p.description.toLowerCase().includes(q)
            )
        }

        res = [...res].sort((a, b) => {
            if (lf.sort === 'name_asc') return a.name.localeCompare(b.name)
            if (lf.sort === 'name_desc') return b.name.localeCompare(a.name)

            // default
            const aStatus = providerStates[a.key].status
            const bStatus = providerStates[b.key].status

            // primary first
            if (primaryProvider === a.key) return -1
            if (primaryProvider === b.key) return 1

            const statusOrder = { 'configured': 0, 'untested': 1, 'unconfigured': 2 }
            return statusOrder[aStatus] - statusOrder[bStatus]
        })

        return res
    }, [search, filterValues.status, filterValues.type, lf.sort, providerStates, primaryProvider])

    const dimensions = useMemo(
        (): FilterDimension[] => [
            {
                key: 'status',
                label: 'Status',
                options: [
                    { value: 'configured', label: 'Configured', dimmed: !PROVIDERS.some((p) => providerStates[p.key].status === 'configured') },
                    { value: 'untested', label: 'Untested', dimmed: !PROVIDERS.some((p) => providerStates[p.key].status === 'untested') },
                    { value: 'unconfigured', label: 'Unconfigured', dimmed: !PROVIDERS.some((p) => providerStates[p.key].status === 'unconfigured') },
                ],
            },
            {
                key: 'type',
                label: 'Type',
                options: [
                    { value: 'cloud', label: 'Cloud' },
                    { value: 'local', label: 'Local' },
                ],
            },
        ],
        [providerStates]
    )

    return (
        <>
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

            <ListToolbar
                hook={lf}
                placeholder="Search AI providers…"
                dimensions={dimensions}
                sortOptions={[
                    { label: 'Priority (Configured first)', value: 'default' },
                    { label: 'Name (A-Z)', value: 'name_asc' },
                    { label: 'Name (Z-A)', value: 'name_desc' },
                ]}
            />

            {/* Two-panel layout */}
            <div className="flex gap-4 flex-1 min-h-0 pt-2">
                {/* Left panel — provider grid */}
                <div className="w-[280px] shrink-0 flex flex-col gap-2 overflow-y-auto">
                    {displayedProviders.length === 0 ? (
                        <div className="flex flex-col items-center justify-center py-12 gap-2 text-sm text-zinc-600 text-center px-4">
                            {lf.hasFilters ? 'No providers match your filters' : 'No providers found'}
                            {lf.hasFilters && (
                                <button
                                    onClick={clearAll}
                                    className="mt-2 text-xs text-indigo-400 hover:text-indigo-300"
                                >
                                    Clear filters
                                </button>
                            )}
                        </div>
                    ) : displayedProviders.map((p: ProviderConfig) => {
                        const pState = providerStates[p.key]
                        const active = p.key === selectedProvider
                        const modelLabel = pState.selectedModel || null
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
                                {modelLabel ? (
                                    <p className="mt-1.5 text-[10px] font-mono text-zinc-500 pl-10 truncate" title={modelLabel}>{modelLabel}</p>
                                ) : (
                                    <p className="mt-1.5 text-xs text-zinc-600 pl-10 truncate">{p.description}</p>
                                )}
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
                            onClick={() => { setPrimaryProvider(selectedProvider); setModelRouting({ ...getDefaultModelsForProvider(selectedProvider) }) }}
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

                                {/* OpenRouter-specific: free tier notice */}
                                {selectedProvider === 'openrouter' && editingKey[selectedProvider] && (
                                    <div className="flex flex-col gap-2 rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-4">
                                        <div className="flex items-start gap-3">
                                            <CheckCircle2 className="h-4 w-4 shrink-0 mt-0.5 text-emerald-400" />
                                            <div>
                                                <p className="text-sm font-medium text-emerald-300">Free tier available — no credits required</p>
                                                <p className="mt-1 text-xs text-zinc-500 leading-relaxed">
                                                    OpenRouter blocks accounts with no purchase history from paid models (402 error).
                                                    Free models with the <code className="text-zinc-400">:free</code> suffix work with any key — no credit card needed.
                                                    Plexo tries multiple free models in order until one works.
                                                </p>
                                                <p className="mt-1.5 text-xs text-zinc-500 leading-relaxed">
                                                    <strong className="text-zinc-400">Privacy note:</strong> Some free models require{' '}
                                                    <a href="https://openrouter.ai/settings/privacy" target="_blank" rel="noopener noreferrer" className="text-indigo-400 hover:text-indigo-300 underline underline-offset-2">Model Training</a>
                                                    {' '}enabled in your OR settings. If all free models fail, enable it or add credits.
                                                    Free limit: ~50 req/day ($10+ in credits raises it to 1,000/day).
                                                </p>
                                            </div>
                                        </div>
                                    </div>
                                )}

                                {/* Anthropic-specific: subscription token policy notice */}
                                {selectedProvider === 'anthropic' && editingKey[selectedProvider] && (
                                    <div className="flex flex-col gap-2 rounded-xl border border-amber-500/25 bg-amber-500/5 p-4">
                                        <div className="flex items-start gap-3">
                                            <AlertCircle className="h-4 w-4 shrink-0 mt-0.5 text-amber-400" />
                                            <div>
                                                <p className="text-sm font-medium text-amber-300">API key required — subscription tokens are blocked</p>
                                                <p className="mt-1 text-xs text-zinc-500 leading-relaxed">
                                                    As of January 2026, Anthropic blocks OAuth tokens (<code className="text-zinc-400">sk-ant-oat01-*</code>) obtained
                                                    from Claude Free, Pro, or Max subscriptions from being used in third-party tools.
                                                    This is enforced server-side and violates their ToS. Attempting to use one will result in a 405 error.
                                                </p>
                                                <p className="mt-1.5 text-xs text-zinc-500 leading-relaxed">
                                                    Use a paid API key (<code className="text-zinc-400">sk-ant-api03-*</code>) from{' '}
                                                    <a href="https://console.anthropic.com/account/keys" target="_blank" rel="noopener noreferrer" className="text-indigo-400 hover:text-indigo-300 underline underline-offset-2">console.anthropic.com</a>.
                                                    These bill per token.
                                                </p>
                                            </div>
                                        </div>
                                    </div>
                                )}

                                {/* API key / subscription token field */}
                                <div className="flex flex-col gap-1.5">
                                    <div className="flex items-center justify-between">
                                        <label className="text-sm font-medium text-zinc-300">API Key</label>
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

                                    {/* Configured pill — shown when a key is stored and not editing */}
                                    {state.status !== 'unconfigured' && !editingKey[selectedProvider] ? (
                                        <div className="flex items-center gap-2">
                                            <div className="flex-1 flex items-center gap-3 rounded-lg border border-zinc-700/50 bg-zinc-800/40 px-3 py-2">
                                                <span className="text-zinc-600 tracking-[0.3em] text-sm select-none">••••••••••••••••••••</span>
                                                <span className={`ml-auto text-[10px] font-medium px-1.5 py-0.5 rounded ${
                                                    state.status === 'configured'
                                                        ? 'bg-emerald-900/40 text-emerald-400'
                                                        : 'bg-amber-900/40 text-amber-400'
                                                }`}>
                                                    {state.status === 'configured' ? 'Verified' : 'Saved'}
                                                </span>
                                            </div>
                                            {clearConfirm === selectedProvider ? (
                                                <div className="flex items-center gap-1.5 shrink-0">
                                                    <span className="text-[11px] text-zinc-500">Remove key?</span>
                                                    <button
                                                        onClick={async () => {
                                                            setClearConfirm(null)
                                                            updateState(selectedProvider, { apiKey: '__CLEAR__', status: 'unconfigured', testResult: null })
                                                            await handleSave({ [selectedProvider]: { apiKey: '__CLEAR__', status: 'unconfigured' } } as Partial<Record<ProviderKey, Partial<ProviderState>>>)
                                                            updateState(selectedProvider, { apiKey: '' })
                                                        }}
                                                        className="text-[11px] font-medium text-red-400 hover:text-red-300 transition-colors"
                                                    >
                                                        Remove
                                                    </button>
                                                    <button
                                                        onClick={() => setClearConfirm(null)}
                                                        className="text-[11px] text-zinc-600 hover:text-zinc-400 transition-colors"
                                                    >
                                                        Cancel
                                                    </button>
                                                </div>
                                            ) : (
                                                <div className="flex items-center gap-2 shrink-0">
                                                    <button
                                                        onClick={() => setEditingKey((prev) => ({ ...prev, [selectedProvider]: true }))}
                                                        className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors"
                                                    >
                                                        Change
                                                    </button>
                                                    <button
                                                        onClick={() => setClearConfirm(selectedProvider)}
                                                        className="text-zinc-700 hover:text-red-400 transition-colors"
                                                        title="Remove stored key"
                                                    >
                                                        <X className="h-3.5 w-3.5" />
                                                    </button>
                                                </div>
                                            )}
                                        </div>
                                    ) : (
                                        /* Edit mode — show real input */
                                        <div className="flex flex-col gap-1.5">
                                            <div className="flex items-center gap-2">
                                                <input
                                                    type="password"
                                                    value={state.apiKey}
                                                    onChange={(e) => updateState(selectedProvider, { apiKey: e.target.value })}
                                                    onKeyDown={(e) => e.key === 'Enter' && void handleTest()}
                                                    placeholder="sk-ant-api03-••••••••"
                                                    autoFocus
                                                    autoComplete="new-password"
                                                    className="flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500/30"
                                                />
                                                {editingKey[selectedProvider] && (
                                                    <button
                                                        onClick={() => {
                                                            setEditingKey((prev) => ({ ...prev, [selectedProvider]: false }))
                                                            updateState(selectedProvider, { apiKey: '' })
                                                        }}
                                                        className="text-zinc-600 hover:text-zinc-400 transition-colors"
                                                        title="Cancel"
                                                    >
                                                        <X className="h-4 w-4" />
                                                    </button>
                                                )}
                                            </div>
                                        </div>
                                    )}

                                    <p className="text-xs text-zinc-600">
                                        Encrypted at rest (AES-256-GCM). Leave blank to keep the existing key.
                                    </p>
                                </div>
                            </div>
                        ) : (
                            <div className="flex flex-col gap-3">
                                <div className="flex flex-col gap-1.5">
                                    <div className="flex items-center justify-between">
                                        <label className="text-sm font-medium text-zinc-300">Base URL</label>
                                        <span className="text-[10px] text-zinc-600">Local or remote — any reachable Ollama instance</span>
                                    </div>
                                    <div className="flex gap-2">
                                        <input
                                            type="text"
                                            value={state.baseUrl}
                                            onChange={(e) => updateState(selectedProvider, { baseUrl: e.target.value, dynamicModels: [], status: 'unconfigured' })}
                                            onKeyDown={(e) => e.key === 'Enter' && void handleConnect()}
                                            placeholder="http://localhost:11434"
                                            className="flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500/30"
                                        />
                                        {state.dynamicModels.length === 0 && (
                                            <button
                                                onClick={() => void handleConnect()}
                                                disabled={connecting || !state.baseUrl}
                                                className="flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-2 text-sm font-medium text-zinc-200 hover:bg-zinc-700 transition-colors disabled:opacity-50 shrink-0"
                                            >
                                                {connecting
                                                    ? <><RefreshCw className="h-3.5 w-3.5 animate-spin" />Connecting…</>
                                                    : 'Connect'
                                                }
                                            </button>
                                        )}
                                    </div>
                                    <p className="text-xs text-zinc-600">
                                        Plexo will call <code className="text-zinc-500">/api/tags</code> to discover models and <code className="text-zinc-500">/v1</code> for inference.
                                        No API key required — network connectivity is sufficient.
                                    </p>
                                </div>
                            </div>
                        )}

                        {(selected.staticModels || state.dynamicModels.length > 0) && (
                            <div className="flex flex-col gap-2">
                                <label className="text-sm font-medium text-zinc-300">Default model</label>
                                <select
                                    value={state.selectedModel}
                                    onChange={(e) => updateState(selectedProvider, { selectedModel: e.target.value })}
                                    className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500/30"
                                >
                                    <option value="">Use task routing defaults</option>
                                    {(selected.staticModels ?? state.dynamicModels).map((m) => (
                                        <option key={m} value={m}>{m}</option>
                                    ))}
                                </select>
                                {state.selectedModel && (
                                    <div className="mt-1">
                                        <CapabilityList caps={getModelCapabilities(state.selectedModel)} />
                                    </div>
                                )}
                                {state.dynamicModels.length > 0 && !selected.staticModels && (
                                    <p className="text-xs text-zinc-600">{state.dynamicModels.length} models available from your Ollama instance.</p>
                                )}
                            </div>
                        )}

                        {/* Ensemble quality judge badge — Ollama only */}
                        {selectedProvider === 'ollama' && state.status === 'configured' && state.dynamicModels.length > 0 && (
                            <div className="rounded-lg border border-indigo-800/30 bg-indigo-950/20 px-3 py-3 flex flex-col gap-1.5">
                                <div className="flex items-center gap-2">
                                    <Users className="h-3.5 w-3.5 text-indigo-400" />
                                    <p className="text-xs font-semibold text-indigo-400">Used for quality ensemble</p>
                                    <span className="ml-auto text-[10px] rounded px-1.5 py-0.5 bg-indigo-900/40 text-indigo-400">
                                        up to {Math.min(3, state.dynamicModels.length)} judges
                                    </span>
                                </div>
                                <p className="text-[11px] text-zinc-600 leading-relaxed">
                                    After each task, Plexo runs the deliverable through {Math.min(3, state.dynamicModels.length)} local model
                                    {Math.min(3, state.dynamicModels.length) !== 1 ? 's' : ''} in
                                    parallel and aggregates a consensus quality score. If judges disagree, a cloud model arbitrates.
                                </p>
                                {state.dynamicModels.slice(0, 5).length > 0 && (
                                    <div className="flex flex-wrap gap-1 mt-0.5">
                                        {state.dynamicModels.slice(0, 5).map((m) => (
                                            <span key={m} className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] font-mono text-zinc-400">{m}</span>
                                        ))}
                                        {state.dynamicModels.length > 5 && (
                                            <span className="text-[10px] text-zinc-600">+{state.dynamicModels.length - 5} more</span>
                                        )}
                                    </div>
                                )}
                            </div>
                        )}

                        {/* Primary action — only show Save & Test when ready */}
                        {(!selected.requiresKey ? state.dynamicModels.length > 0 : true) && (
                            <div className="flex items-center">
                                <button
                                    onClick={() => void handleTest()}
                                    disabled={testing || saving}
                                    className="flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 transition-colors disabled:opacity-50"
                                >
                                    {testing
                                        ? <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                                        : <TestTube className="h-3.5 w-3.5" />
                                    }
                                    {testing ? 'Testing…' : saving ? 'Saving…' : saved ? 'Saved ✓' : 'Save & Test'}
                                </button>
                            </div>
                        )}

                        {state.testResult && (
                            <div className={`rounded-lg border px-3 py-2 text-sm font-mono ${state.testResult.startsWith('✓')
                                ? 'border-emerald-800/50 bg-emerald-950/30 text-emerald-400'
                                : 'border-red-800/50 bg-red-950/30 text-red-400'
                                }`}>
                                {state.testResult}
                            </div>
                        )}

                        {/* ── Borrowed badge (target workspace UI) ── */}
                        {(() => {
                            const borrow = borrowing.find((s) => s.providerKey === selectedProvider)
                            if (!borrow) return null
                            return (
                                <div className="flex items-center gap-3 rounded-xl border border-indigo-800/30 bg-indigo-950/10 px-4 py-3">
                                    <Link2 className="h-4 w-4 text-indigo-400 shrink-0" />
                                    <div className="flex-1 min-w-0">
                                        <p className="text-xs font-medium text-indigo-300">Borrowed from <span className="font-semibold">{borrow.sourceWorkspace?.name ?? 'another workspace'}</span></p>
                                        <p className="text-[10px] text-zinc-600 mt-0.5">Key stays encrypted in the source workspace — not copied here.</p>
                                    </div>
                                    <button
                                        onClick={() => void handleStopBorrowing(selectedProvider)}
                                        className="text-[11px] text-red-500 hover:text-red-400 transition-colors shrink-0"
                                    >
                                        Stop borrowing
                                    </button>
                                </div>
                            )
                        })()}

                        {/* ── Key sharing (source workspace UI) ── */}
                        {state.status !== 'unconfigured' && !borrowing.find((s) => s.providerKey === selectedProvider) && (
                            <div className="flex flex-col gap-2">
                                <div className="flex items-center justify-between">
                                    <p className="text-xs font-medium text-zinc-500">Shared with</p>
                                    {ownWorkspaces.length > 0 && (
                                        <button
                                            onClick={() => { setShareModal({ providerKey: selectedProvider }); setShareTargets(new Set()) }}
                                            className="flex items-center gap-1 text-[11px] text-indigo-400 hover:text-indigo-300 transition-colors"
                                        >
                                            <Share2 className="h-3 w-3" />
                                            Share with a workspace
                                        </button>
                                    )}
                                </div>
                                {lending.filter((s) => s.providerKey === selectedProvider).length === 0 ? (
                                    <p className="text-[11px] text-zinc-700">Not shared with any workspaces.</p>
                                ) : (
                                    <div className="flex flex-col gap-1">
                                        {lending.filter((s) => s.providerKey === selectedProvider).map((share) => (
                                            <div key={share.id} className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2">
                                                <span className="text-xs text-zinc-300">{share.targetWorkspace?.name ?? share.id}</span>
                                                <button
                                                    onClick={() => void handleRevokeShare(share.id)}
                                                    className="text-[11px] text-zinc-600 hover:text-red-400 transition-colors"
                                                    title="Revoke share"
                                                >
                                                    <X className="h-3.5 w-3.5" />
                                                </button>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                </div>
            </div>

            {/* ── Global Routing ─────────────────────────────────── */}
            {configuredProviders.length > 0 && (
                <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 overflow-hidden">
                    <button
                        onClick={() => setShowFallback((v) => !v)}
                        className="w-full flex items-center justify-between px-5 py-3.5 hover:bg-zinc-800/30 transition-colors"
                    >
                        <div className="flex items-center gap-3 min-w-0 flex-1">
                            <h2 className="text-sm font-semibold text-zinc-200 shrink-0">Fallback Chain</h2>
                            {/* Inline chain pill strip — always visible */}
                            <div className="flex items-center gap-1 flex-wrap min-w-0">
                                {activeChainProviders.map((p, idx) => (
                                    <div key={p.key} className="flex items-center gap-1">
                                        {idx > 0 && <span className="text-zinc-700 text-[10px] select-none">›</span>}
                                        <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium border ${
                                            primaryProvider === p.key
                                                ? 'border-indigo-500/40 bg-indigo-500/10 text-indigo-300'
                                                : 'border-zinc-700/80 bg-zinc-800/80 text-zinc-400'
                                        }`}>
                                            {borrowing.find((s) => s.providerKey === p.key)
                                                ? <Link2 className="h-2.5 w-2.5 text-indigo-400 shrink-0" />
                                                : <span className="h-1.5 w-1.5 rounded-full bg-emerald-400/80 shrink-0" />}
                                            {p.name}
                                        </span>
                                    </div>
                                ))}
                                {warnChainProviders.map((p) => (
                                    <div key={p.key} className="flex items-center gap-1">
                                        <span className="text-zinc-700 text-[10px] select-none">›</span>
                                        <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium border border-zinc-800 text-zinc-600 opacity-50">
                                            <span className="h-1.5 w-1.5 rounded-full bg-amber-500/50 shrink-0" />
                                            {p.name}
                                        </span>
                                    </div>
                                ))}
                            </div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0 ml-2">
                            <button
                                onClick={(e) => { e.stopPropagation(); setShowFallback(true); setShowRouting((v) => !v) }}
                                className="flex items-center gap-1 text-[10px] text-zinc-600 hover:text-zinc-400 transition-colors px-2 py-1 rounded hover:bg-zinc-800"
                            >
                                Model routing
                                {showRouting ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                            </button>
                            {showFallback ? <ChevronDown className="h-3.5 w-3.5 text-zinc-500" /> : <ChevronRight className="h-3.5 w-3.5 text-zinc-500" />}
                        </div>
                    </button>
                    {showFallback && <div className="px-5 pb-5">
                    {/* Provider priority row — edit controls */}
                    <div className="mt-2 flex items-center gap-2 flex-wrap">
                        {activeChainProviders.map((p, idx) => (
                            <div
                                key={p.key}
                                className={`flex items-center gap-2 rounded-lg border px-3 py-2 ${
                                    primaryProvider === p.key
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
                                    <button onClick={() => moveFallback(p.key, -1)} disabled={idx === 0} className="text-zinc-600 hover:text-zinc-400 disabled:opacity-20 leading-none px-0.5" aria-label="Move earlier">◀</button>
                                    <button onClick={() => moveFallback(p.key, 1)} disabled={idx === activeChainProviders.length - 1} className="text-zinc-600 hover:text-zinc-400 disabled:opacity-20 leading-none px-0.5" aria-label="Move later">▶</button>
                                    <button onClick={() => removeFromFallback(p.key)} className="ml-1 text-zinc-600 hover:text-red-400 leading-none px-0.5 transition-colors" aria-label="Remove from chain" title="Remove from chain">×</button>
                                </div>
                            </div>
                        ))}
                        {warnChainProviders.map((p) => (
                            <div key={p.key} className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/30 px-3 py-2 opacity-50" title={`${p.name} — not tested. Click to configure.`}>
                                <StatusDot status={providerStates[p.key].status} />
                                <button onClick={() => setSelectedProvider(p.key)} className="text-sm text-zinc-500 hover:text-zinc-300 transition-colors">{p.name}</button>
                                <button onClick={() => removeFromFallback(p.key)} className="ml-1 text-zinc-600 hover:text-red-400 leading-none px-0.5 transition-colors" aria-label="Remove from chain" title="Remove from chain">×</button>
                            </div>
                        ))}
                    </div>
                    {/* Model routing — collapsible */}
                    {showRouting && (() => {
                        // Models to populate the routing dropdowns — primary provider's list.
                        const primaryConfig = PROVIDERS.find((p) => p.key === primaryProvider)
                        const primaryState = providerStates[primaryProvider]
                        const routingModels: string[] = [
                            ...(primaryConfig?.staticModels ?? []),
                            ...(primaryState?.dynamicModels ?? []),
                        ]
                        const defaults = getDefaultModelsForProvider(primaryProvider)
                        return (
                            <div className="mt-4 rounded-xl border border-zinc-800 bg-zinc-900/40 overflow-hidden">
                                <div className="px-4 py-2.5 border-b border-zinc-800 flex items-center justify-between">
                                    <p className="text-xs text-zinc-500">Per-task model override. Defaults are chosen for your active provider.</p>
                                    <button
                                        onClick={() => setModelRouting({ ...getDefaultModelsForProvider(primaryProvider) })}
                                        className="text-[10px] text-zinc-600 hover:text-zinc-400 transition-colors"
                                    >Reset to defaults</button>
                                </div>
                                <table className="w-full text-sm">
                                    <thead><tr className="border-b border-zinc-800"><th className="px-4 py-2.5 text-left text-xs font-medium text-zinc-500">Task type</th><th className="px-4 py-2.5 text-left text-xs font-medium text-zinc-500">Model</th></tr></thead>
                                    <tbody>
                                        {(Object.entries(TASK_LABELS) as [TaskType, string][]).map(([taskType, label]) => (
                                            <tr key={taskType} className="border-b border-zinc-800/50 last:border-0">
                                                <td className="px-4 py-2.5 text-zinc-400">{label}</td>
                                                <td className="px-4 py-2.5">
                                                    <select
                                                        value={modelRouting[taskType]}
                                                        onChange={(e) => setModelRouting((prev) => ({ ...prev, [taskType]: e.target.value }))}
                                                        className="w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-100 focus:border-indigo-500 focus:outline-none"
                                                    >
                                                        <option value="">Provider default ({defaults[taskType]})</option>
                                                        {routingModels.map((m) => (
                                                            <option key={m} value={m}>{m}</option>
                                                        ))}
                                                    </select>
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )
                    })()}
                    </div>}
                </div>
            )}

            {/* ── Cost Defaults ──────────────────────────────────────────── */}
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 overflow-hidden">
                <button
                    onClick={() => setShowCostDefaults((v) => !v)}
                    className="w-full flex items-center justify-between px-5 py-3.5 hover:bg-zinc-800/30 transition-colors"
                >
                    <div className="flex items-center gap-4 min-w-0 flex-1">
                        <h2 className="text-sm font-semibold text-zinc-200 shrink-0">Cost Defaults</h2>
                        {/* Inline stat summary — always visible */}
                        <div className="flex items-center gap-3">
                            <div className="flex items-center gap-1.5">
                                <span className="text-[10px] text-zinc-600 uppercase tracking-wide font-medium">ceiling</span>
                                <span className={`text-xs font-mono font-medium ${
                                    wsDefaultCostCeiling && parseFloat(wsDefaultCostCeiling) > 0
                                        ? 'text-zinc-300'
                                        : 'text-zinc-600'
                                }`}>
                                    {wsDefaultCostCeiling && parseFloat(wsDefaultCostCeiling) > 0
                                        ? `$${parseFloat(wsDefaultCostCeiling).toFixed(2)}`
                                        : '—'}
                                </span>
                            </div>
                            <span className="text-zinc-800 text-[10px]">·</span>
                            <div className="flex items-center gap-1.5">
                                <span className="text-[10px] text-zinc-600 uppercase tracking-wide font-medium">tokens</span>
                                <span className={`text-xs font-mono font-medium ${
                                    wsDefaultTokenBudget && parseInt(wsDefaultTokenBudget, 10) > 0
                                        ? 'text-zinc-300'
                                        : 'text-zinc-600'
                                }`}>
                                    {wsDefaultTokenBudget && parseInt(wsDefaultTokenBudget, 10) > 0
                                        ? parseInt(wsDefaultTokenBudget, 10).toLocaleString()
                                        : '—'}
                                </span>
                            </div>
                        </div>
                    </div>
                    {showCostDefaults ? <ChevronDown className="h-3.5 w-3.5 text-zinc-500 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 text-zinc-500 shrink-0" />}
                </button>
                {showCostDefaults && <div className="px-5 pb-5">
                <div className="grid grid-cols-2 gap-4 mt-1">
                    <div className="flex flex-col gap-1.5">
                        <label htmlFor="ws-cost-ceiling" className="text-xs font-medium text-zinc-400">Cost ceiling per task (USD)</label>
                        <div className="relative">
                            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-600 text-sm">$</span>
                            <input
                                id="ws-cost-ceiling"
                                type="number"
                                min="0.01"
                                step="0.10"
                                placeholder="0.50"
                                value={wsDefaultCostCeiling}
                                onChange={(e) => setWsDefaultCostCeiling(e.target.value)}
                                className="w-full rounded-lg border border-zinc-700 bg-zinc-900 pl-7 pr-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500/30"
                            />
                        </div>
                        <p className="text-[11px] text-zinc-600">Chat &amp; channel tasks with no explicit ceiling. Hierarchy: task › project › workspace.</p>
                    </div>
                    <div className="flex flex-col gap-1.5">
                        <label htmlFor="ws-token-budget" className="text-xs font-medium text-zinc-400">Token budget per call (output)</label>
                        <input
                            id="ws-token-budget"
                            type="number"
                            min="256"
                            step="512"
                            placeholder="8192"
                            value={wsDefaultTokenBudget}
                            onChange={(e) => setWsDefaultTokenBudget(e.target.value)}
                            className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500/30"
                        />
                        <p className="text-[11px] text-zinc-600">Max output tokens per LLM call. 0 = no cap (model default).</p>
                    </div>
                </div>
                <div className="mt-4 flex items-center justify-between">
                    <p className="text-[11px] text-zinc-600">
                        Ceiling hierarchy: task explicit › project › workspace › weekly cap.
                    </p>
                    <button
                        onClick={() => void handleSave()}
                        disabled={saving}
                        className="flex items-center gap-2 rounded-lg bg-indigo-600 px-3.5 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 transition-colors disabled:opacity-50 shrink-0"
                    >
                        <Save className="h-3 w-3" />
                        {saving ? 'Saving…' : saved ? 'Saved ✓' : 'Save'}
                    </button>
                </div>
                </div>}
            </div>
        </div>

        {/* ── Share Modal ────────────────────────────────────────────── */}
        {shareModal && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
                <div className="w-full max-w-sm rounded-2xl border border-zinc-700 bg-zinc-900 p-6 shadow-2xl">
                    <div className="flex items-center justify-between mb-4">
                        <h3 className="text-sm font-semibold text-zinc-100">
                            Share <span className="text-indigo-300">{PROVIDERS.find((p) => p.key === shareModal?.providerKey)?.name}</span> key
                        </h3>
                        <button onClick={() => setShareModal(null)} className="text-zinc-600 hover:text-zinc-400 transition-colors">
                            <X className="h-4 w-4" />
                        </button>
                    </div>
                    <p className="text-xs text-zinc-500 mb-4 leading-relaxed">
                        Select workspaces to share this key with. The key stays encrypted here — target workspaces get a verified reference only.
                    </p>
                    <div className="flex flex-col gap-2 mb-5">
                        {ownWorkspaces.length === 0 ? (
                            <p className="text-xs text-zinc-600">No other workspaces found.</p>
                        ) : ownWorkspaces.map((ws) => {
                            const alreadyShared = lending.some((s) => s.providerKey === shareModal?.providerKey && s.targetWorkspace?.id === ws.id)
                            const checked = shareTargets.has(ws.id)
                            return (
                                <label key={ws.id} className={`flex items-center gap-3 rounded-lg border px-3 py-2.5 cursor-pointer transition-colors ${checked
                                    ? 'border-indigo-500/50 bg-indigo-500/5'
                                    : 'border-zinc-700/60 bg-zinc-800/40 hover:border-zinc-600'
                                }`}>
                                    <input
                                        type="checkbox"
                                        checked={checked || alreadyShared}
                                        disabled={alreadyShared}
                                        onChange={(e) => {
                                            setShareTargets((prev) => {
                                                const next = new Set(prev)
                                                if (e.target.checked) next.add(ws.id); else next.delete(ws.id)
                                                return next
                                            })
                                        }}
                                        className="accent-indigo-500"
                                    />
                                    <span className="text-sm text-zinc-200">{ws.name}</span>
                                    {alreadyShared && <span className="ml-auto text-[10px] text-indigo-400 font-medium">Already shared</span>}
                                </label>
                            )
                        })}
                    </div>
                    <div className="flex gap-2 justify-end">
                        <button
                            onClick={() => setShareModal(null)}
                            className="px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 transition-colors"
                        >Cancel</button>
                        <button
                            onClick={() => void handleShare()}
                            disabled={sharingBusy || shareTargets.size === 0}
                            className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 transition-colors disabled:opacity-50"
                        >
                            {sharingBusy ? <RefreshCw className="h-3 w-3 animate-spin" /> : <Share2 className="h-3 w-3" />}
                            {sharingBusy ? 'Sharing…' : `Share with ${shareTargets.size || ''} workspace${shareTargets.size !== 1 ? 's' : ''}`}
                        </button>
                    </div>
                </div>
            </div>
        )}
        </>
    )
}
