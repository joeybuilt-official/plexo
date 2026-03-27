// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

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
    Plus,
    Trash2,
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
    | 'ollama_cloud'
    | `custom_${string}`

type ProviderStatus = 'configured' | 'untested' | 'unconfigured' | 'borrowed'

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
    enabled: boolean          // false = present but excluded from agent dispatch
    testResult: string | null
}

interface CustomProviderConfig {
    key: ProviderKey      // e.g. 'custom_together'
    name: string          // e.g. 'Together AI'
    description: string   // auto-generated or user-entered
    baseUrl: string
    compatMode: 'openai' | 'anthropic' | 'ollama'
    staticModels: string[]
    requiresKey: boolean  // always true
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
    ollama_cloud: { label: 'Get API key', url: 'https://ollama.com/settings/keys' },
}

// ── Provider definitions ─────────────────────────────────────────────────────

const PROVIDERS: ProviderConfig[] = [
    {
        key: 'openrouter',
        name: 'OpenRouter',
        description: '200+ models via single API key — free tier available, no credits required',
        badge: 'RECOMMENDED',
        badgeColor: 'bg-amber/15 text-amber border border-amber-500/30',
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
        badgeColor: 'bg-azure/15 text-azure border border-azure/30',
        requiresKey: false,
    },
    {
        key: 'ollama_cloud',
        name: 'Ollama Cloud',
        description: 'gpt-oss, deepseek, kimi, glm — free tier included',
        badge: 'Free tier',
        badgeColor: 'bg-sky-500/15 text-sky-400 border border-sky-500/30',
        requiresKey: true,
        staticModels: [
            // Well-known cloud models (updated periodically)
            'gpt-oss:20b-cloud',
            'gpt-oss:120b-cloud',
            'deepseek-v3.1:671b-cloud',
            'kimi-k2:1t-cloud',
            'glm-4.6:cloud',
            'qwen3-vl:235b-cloud',
            'devstral-small-2:cloud',
            'minimax-m2:cloud',
        ],
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
    if (status === 'configured') return <CheckCircle2 className="h-3.5 w-3.5 text-azure" />
    if (status === 'untested') return <AlertCircle className="h-3.5 w-3.5 text-amber" />
    if (status === 'borrowed') return <Link2 className="h-3.5 w-3.5 text-azure" />
    return <Circle className="h-3.5 w-3.5 text-text-muted" />
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
                enabled: true,
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

    // Custom provider state
    const [customProviders, setCustomProviders] = useState<CustomProviderConfig[]>([])
    const [showAddCustom, setShowAddCustom] = useState(false)
    const [probeUrl, setProbeUrl] = useState('')
    const [probeKey, setProbeKey] = useState('')
    const [probeName, setProbeName] = useState('')
    const [probing, setProbing] = useState(false)
    const [probeResult, setProbeResult] = useState<{ protocol: string; models: string[] } | null>(null)

    // Key sharing state
    type KeyShare = { id: string; providerKey: string; grantedAt: string; targetWorkspace?: { id: string; name: string }; sourceWorkspace?: { id: string; name: string } }
    type OwnWorkspace = { id: string; name: string }
    const [lending, setLending] = useState<KeyShare[]>([])
    const [borrowing, setBorrowing] = useState<KeyShare[]>([])
    const [ownWorkspaces, setOwnWorkspaces] = useState<OwnWorkspace[]>([])
    const [sharingWs, setSharingWs] = useState<Set<string>>(new Set()) // per-ws loading

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
                                const rawV = v as typeof v & { enabled?: boolean }
                                next[pk] = {
                                    ...next[pk],
                                    status: v.status,
                                    selectedModel: v.selectedModel ?? '',
                                    baseUrl: v.baseUrl ?? next[pk].baseUrl,
                                    // Sentinel means configured — keep input empty so placeholder shows
                                    apiKey: '',
                                    // Default true — absence of the field means enabled
                                    enabled: rawV.enabled !== false,
                                }
                            }
                        }
                        return next
                    })
                    // Auto-fetch Ollama local models if configured or borrowed
                    if (ollamaEntry?.status === 'configured' || ollamaEntry?.status === 'borrowed') {
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
                    // Auto-fetch Ollama Cloud models if previously configured
                    const ollamaCloudEntry = aiCfg.providers['ollama_cloud' as ProviderKey]
                    if (ollamaCloudEntry?.status === 'configured') {
                        void (async () => {
                            try {
                                const mr = await fetch(`${API_BASE}/api/v1/settings/ai-providers/models?provider=ollama_cloud&workspaceId=${encodeURIComponent(WS_ID)}`)
                                if (mr.ok) {
                                    const md = await mr.json() as { ok: boolean; models?: string[] }
                                    if (md.ok && md.models?.length) {
                                        setProviderStates((prev) => ({
                                            ...prev,
                                            ollama_cloud: { ...prev.ollama_cloud, dynamicModels: md.models! },
                                        }))
                                    }
                                }
                            } catch { /* non-fatal */ }
                        })()
                    }

                    // Load custom providers from saved config
                    const customs: CustomProviderConfig[] = []
                    for (const [key, val] of Object.entries(aiCfg.providers)) {
                        if (key.startsWith('custom_') && val) {
                            customs.push({
                                key: key as ProviderKey,
                                name: (val as any).displayName ?? key.replace('custom_', '').replace(/_/g, ' '),
                                description: `Custom ${(val as any).compatMode ?? 'openai'}-compatible provider`,
                                baseUrl: (val as any).baseUrl ?? '',
                                compatMode: (val as any).compatMode ?? 'openai',
                                staticModels: (val as any).discoveredModels ?? [],
                                requiresKey: true,
                            })
                        }
                    }
                    setCustomProviders(customs)
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
                    const data = await wsRes.json() as { items?: OwnWorkspace[] } | OwnWorkspace[]
                    const wd = Array.isArray(data) ? data : (data.items ?? [])
                    setOwnWorkspaces(wd.filter((w) => w.id !== WS_ID))
                }
            } catch { /* non-fatal */ }
        })()
    }, [WS_ID, API_BASE])

    const allProviders: (ProviderConfig | CustomProviderConfig)[] = useMemo(() => [...PROVIDERS, ...customProviders], [customProviders])

    const selected = allProviders.find((p) => p.key === selectedProvider) ?? PROVIDERS[0]!
    const defaultState: ProviderState = { apiKey: '', baseUrl: '', selectedModel: '', dynamicModels: [], status: 'unconfigured', enabled: true, testResult: null }
    const state = providerStates[selectedProvider] ?? defaultState

    function updateState(key: ProviderKey, patch: Partial<ProviderState>) {
        setProviderStates((prev) => ({
            ...prev,
            [key]: { ...prev[key], ...patch },
        }))
    }

    async function handleToggleShare(targetWsId: string, providerKey: ProviderKey) {
        if (!WS_ID) return
        setSharingWs((prev) => new Set(prev).add(targetWsId))
        try {
            const existing = lending.find((s) => s.providerKey === providerKey && s.targetWorkspace?.id === targetWsId)
            if (existing) {
                await fetch(`${API_BASE}/api/v1/workspaces/${WS_ID}/key-shares/${existing.id}`, { method: 'DELETE' })
                setLending((prev) => prev.filter((s) => s.id !== existing.id))
            } else {
                const res = await fetch(`${API_BASE}/api/v1/workspaces/${WS_ID}/key-shares`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ targetWorkspaceId: targetWsId, providerKey }),
                })
                if (res.ok) {
                    const data = await res.json() as { shareId: string; targetWorkspace: { id: string; name: string } }
                    setLending((prev) => [...prev, {
                        id: data.shareId,
                        providerKey,
                        grantedAt: new Date().toISOString(),
                        targetWorkspace: data.targetWorkspace,
                    }])
                }
            }
        } finally {
            setSharingWs((prev) => { const next = new Set(prev); next.delete(targetWsId); return next })
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
        await fetch(`${API_BASE}/api/v1/workspaces/${share.sourceWorkspace.id}/key-shares/${share.id}`, { method: 'DELETE' })
        setBorrowing((prev) => prev.filter((s) => s.id !== share.id))
        updateState(providerKey, { status: 'unconfigured', apiKey: '' })
    }

    // ── Custom provider helpers ────────────────────────────────────────────────

    const handleProbe = async () => {
        setProbing(true)
        setProbeResult(null)
        try {
            const r = await fetch(`${API_BASE}/api/v1/settings/ai-providers/probe`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ baseUrl: probeUrl, apiKey: probeKey }),
            })
            const data = await r.json()
            if (data.ok) setProbeResult(data)
            else setProbeResult({ protocol: 'unknown', models: [] })
        } catch { setProbeResult({ protocol: 'unknown', models: [] }) }
        finally { setProbing(false) }
    }

    const handleAddCustom = () => {
        if (!probeName.trim() || !probeUrl.trim()) return
        const slug = probeName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
        const key = `custom_${slug}` as ProviderKey
        const models = probeResult?.models ?? []
        const newProvider: CustomProviderConfig = {
            key,
            name: probeName.trim(),
            description: `${probeResult?.protocol ?? 'OpenAI'}-compatible provider`,
            baseUrl: probeUrl.trim(),
            compatMode: (probeResult?.protocol as CustomProviderConfig['compatMode']) ?? 'openai',
            staticModels: models,
            requiresKey: true,
        }
        setCustomProviders(prev => [...prev, newProvider])
        setProviderStates(prev => ({
            ...prev,
            [key]: {
                apiKey: probeKey,
                baseUrl: probeUrl.trim(),
                selectedModel: models[0] ?? '',
                dynamicModels: models,
                status: probeKey ? 'untested' as ProviderStatus : 'unconfigured' as ProviderStatus,
                enabled: true,
                testResult: null,
            },
        }))
        // Reset modal state
        setShowAddCustom(false)
        setProbeName('')
        setProbeUrl('')
        setProbeKey('')
        setProbeResult(null)
        // Select the new provider
        setSelectedProvider(key)
    }

    const handleRemoveCustom = (key: string) => {
        setCustomProviders(prev => prev.filter(c => c.key !== key))
        setProviderStates(prev => {
            const next = { ...prev }
            delete next[key as ProviderKey]
            return next
        })
        setSelectedProvider('anthropic')
    }

    const handleRescanCustom = async (key: string) => {
        const cp = customProviders.find(c => c.key === key)
        if (!cp) return
        const st = providerStates[key as ProviderKey]
        setConnecting(true)
        try {
            const r = await fetch(`${API_BASE}/api/v1/settings/ai-providers/probe`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ baseUrl: cp.baseUrl, apiKey: st?.apiKey || '' }),
            })
            const data = await r.json()
            if (data.ok && data.models?.length) {
                setCustomProviders(prev => prev.map(c => c.key === key ? { ...c, staticModels: data.models } : c))
                updateState(key as ProviderKey, { dynamicModels: data.models })
            }
        } catch { /* non-fatal */ }
        finally { setConnecting(false) }
    }

    // Fetch models from a URL-based provider (Ollama local) without running a test.
    // Also handles Ollama Cloud by hitting the /models endpoint with bearer key.
    // Populates dynamicModels so the dropdown appears before Save & Test.
    async function handleConnect() {
        setConnecting(true)
        try {
            let url: string
            if (selectedProvider === 'ollama_cloud') {
                // For cloud, prefer explicitly entered key; fall back to server-decrypted stored key via workspaceId
                const key = providerStates.ollama_cloud.apiKey
                url = `${API_BASE}/api/v1/settings/ai-providers/models?provider=ollama_cloud${
                    key ? `&apiKey=${encodeURIComponent(key)}` : `&workspaceId=${encodeURIComponent(WS_ID)}`
                }`
            } else {
                const baseUrl = providerStates[selectedProvider].baseUrl || 'http://localhost:11434'
                url = `${API_BASE}/api/v1/settings/ai-providers/models?provider=${selectedProvider}&baseUrl=${encodeURIComponent(baseUrl)}`
            }
            const res = await fetch(url)
            if (res.ok) {
                const data = await res.json() as { ok: boolean; models?: string[]; error?: string }
                if (data.ok && data.models?.length) {
                    updateState(selectedProvider, {
                        dynamicModels: data.models,
                        selectedModel: providerStates[selectedProvider].selectedModel || data.models[0]!,
                        status: 'untested',
                    })
                } else {
                    updateState(selectedProvider, { testResult: `✗ ${data.error ?? 'No models found — check your API key'}` })
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
                // For local Ollama or Ollama Cloud: also fetch the model list so the dropdown is populated
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
                if (selectedProvider === 'ollama_cloud') {
                    try {
                        const key = state.apiKey
                        const modelsRes = await fetch(
                            `${API_BASE}/api/v1/settings/ai-providers/models?provider=ollama_cloud${
                                key ? `&apiKey=${encodeURIComponent(key)}` : ''
                            }`
                        )
                        if (modelsRes.ok) {
                            const modelsData = await modelsRes.json() as { ok: boolean; models?: string[] }
                            if (modelsData.ok && modelsData.models?.length) {
                                patch.dynamicModels = modelsData.models
                                if (!patch.selectedModel) patch.selectedModel = modelsData.models[0]!
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
                    testResult: `✗ ${data.message ?? 'Test failed — check console for details'}`,
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
            const providersConfig: Record<string, Record<string, unknown>> = {}
            for (const p of allProviders) {
                const key = p.key as ProviderKey
                // Merge current state with any overrides (e.g. from successful test result)
                const s = { ...(providerStates[key] ?? {}), ...(stateOverrides?.[key] ?? {}) } as ProviderState
                if (!s.status) continue
                const hasCredential = !!s.apiKey
                const hasStatus = s.status !== 'unconfigured'
                if (hasCredential || hasStatus) {
                    const effectiveStatus = s.status === 'unconfigured' && hasCredential ? 'untested' : s.status
                    const providerEntry: Record<string, unknown> = {
                        status: effectiveStatus,
                        selectedModel: (s.selectedModel ?? '').trim(),
                        baseUrl: (s.baseUrl ?? '').trim(),
                        // Only include credential value when user has entered something new
                        // Empty string means "don't change" — server will keep existing encrypted value
                        ...(s.apiKey?.trim() ? { apiKey: s.apiKey.trim() } : {}),
                        // Always persist enabled flag so disabling survives a re-save
                        enabled: s.enabled !== false,
                    }
                    // Include extra metadata for custom providers
                    if (key.startsWith('custom_')) {
                        const cp = customProviders.find(c => c.key === key)
                        if (cp) {
                            providerEntry.displayName = cp.name
                            providerEntry.compatMode = cp.compatMode
                            providerEntry.discoveredModels = cp.staticModels
                        }
                    }
                    providersConfig[key] = providerEntry
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
                for (const p of allProviders) {
                    const key = p.key as ProviderKey
                    const s = { ...(providerStates[key] ?? {}), ...(stateOverrides?.[key] ?? {}) } as ProviderState
                    if (s.status === 'unconfigured' && s.apiKey) {
                        updateState(key, { status: 'untested' })
                    }
                }
                setSaved(true)
                // Clear key inputs after successful save — server has them encrypted
                setProviderStates((prev) => {
                    const cleared = { ...prev }
                    for (const p of allProviders) {
                        const key = p.key as ProviderKey
                        if (cleared[key]) cleared[key] = { ...cleared[key], apiKey: '' }
                    }
                    return cleared
                })
                setTimeout(() => setSaved(false), 2500)
            }
        } finally {
            setSaving(false)
        }
    }

    // All providers that are configured AND enabled (disabled providers excluded from chain display)
    const chainProviders = fallbackOrder
        .map((k) => allProviders.find((p) => p.key === k)!)
        .filter((p) => p != null && providerStates[p.key as ProviderKey]?.status !== 'unconfigured' && providerStates[p.key as ProviderKey]?.enabled !== false)

    // Active = tested, working, and enabled; warn = present but untested
    const activeChainProviders = chainProviders.filter((p) => providerStates[p.key]?.status === 'configured')
    const warnChainProviders = chainProviders.filter((p) => providerStates[p.key]?.status !== 'configured')

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

    const displayedProviders = useMemo((): (ProviderConfig | CustomProviderConfig)[] => {
        let res: (ProviderConfig | CustomProviderConfig)[] = allProviders
        const q = search.trim().toLowerCase()
        if (filterValues.status) {
            res = res.filter((p) => providerStates[p.key as ProviderKey]?.status === filterValues.status)
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
            const aStatus = providerStates[a.key as ProviderKey]?.status ?? 'unconfigured'
            const bStatus = providerStates[b.key as ProviderKey]?.status ?? 'unconfigured'

            // primary first
            if (primaryProvider === a.key) return -1
            if (primaryProvider === b.key) return 1

            const statusOrder: Record<ProviderStatus, number> = { 'configured': 0, 'borrowed': 0, 'untested': 1, 'unconfigured': 2 }
            return statusOrder[aStatus] - statusOrder[bStatus]
        })

        return res
    }, [search, filterValues.status, filterValues.type, lf.sort, providerStates, primaryProvider, allProviders])

    const dimensions = useMemo(
        (): FilterDimension[] => [
            {
                key: 'status',
                label: 'Status',
                options: [
                    { value: 'configured', label: 'Configured', dimmed: !allProviders.some((p) => providerStates[p.key as ProviderKey]?.status === 'configured') },
                    { value: 'untested', label: 'Untested', dimmed: !allProviders.some((p) => providerStates[p.key as ProviderKey]?.status === 'untested') },
                    { value: 'unconfigured', label: 'Unconfigured', dimmed: !allProviders.some((p) => providerStates[p.key as ProviderKey]?.status === 'unconfigured') },
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
                <p className="mt-0.5 text-sm text-text-muted">
                    LLM inference endpoints only. For tool integrations (MCP, APIs, webhooks), use{' '}
                    <a href="/connections" className="text-azure hover:underline">Connections</a>.
                </p>
            </div>

            {loadError && (
                <div className="rounded-lg border border-amber-800/50 bg-amber-950/20 px-3 py-2 text-xs text-amber">{loadError}</div>
            )}
            {!WS_ID && (
                <div className="rounded-lg border border-red-800/50 bg-red-950/20 px-3 py-2 text-xs text-red">NEXT_PUBLIC_DEFAULT_WORKSPACE not set — changes will not be persisted.</div>
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
            <div className="flex flex-col md:flex-row gap-4 flex-1 min-h-0 pt-2 pb-4 md:pb-0">
                {/* Left panel — provider grid */}
                <div className="w-full md:w-[280px] shrink-0 flex flex-row md:flex-col gap-2 overflow-x-auto md:overflow-x-hidden md:overflow-y-auto pb-2 md:pb-0 snap-x snap-mandatory [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
                    {displayedProviders.length === 0 ? (
                        <div className="flex flex-col items-center justify-center py-12 gap-2 text-sm text-text-muted text-center px-4 w-full">
                            {lf.hasFilters ? 'No providers match your filters' : 'No providers found'}
                            {lf.hasFilters && (
                                <button
                                    onClick={clearAll}
                                    className="mt-2 text-xs text-azure hover:text-azure min-h-[44px] px-2"
                                >
                                    Clear filters
                                </button>
                            )}
                        </div>
                    ) : (<>
                    {displayedProviders.map((p) => {
                        const pState = providerStates[p.key as ProviderKey] ?? { selectedModel: '', status: 'unconfigured' as ProviderStatus, enabled: true }
                        const active = p.key === selectedProvider
                        const modelLabel = pState.selectedModel || null
                        const isDisabled = pState.status !== 'unconfigured' && !pState.enabled
                        return (
                            <button
                                key={p.key}
                                onClick={() => setSelectedProvider(p.key as ProviderKey)}
                                className={`text-left rounded-xl border p-3 transition-all shrink-0 w-[280px] sm:w-[320px] md:w-auto snap-start ${active
                                    ? 'border-azure/50 bg-surface-1 shadow-sm shadow-azure/10'
                                    : 'border-border bg-surface-1/40 hover:border-border hover:bg-surface-1/70'
                                    } ${isDisabled ? 'opacity-50' : ''}`}
                            >
                                <div className="flex items-start justify-between gap-2">
                                    <div className="flex items-center gap-2.5">
                                        <div className={`flex h-8 w-8 items-center justify-center rounded-lg bg-surface-2 text-xs font-bold ${isDisabled ? 'text-text-muted' : 'text-text-secondary'}`}>
                                            {p.name.slice(0, 2).toUpperCase()}
                                        </div>
                                        <div>
                                            <div className="flex items-center gap-1.5">
                                                <p className={`text-sm font-medium ${isDisabled ? 'text-text-muted line-through decoration-zinc-600' : 'text-text-primary'}`}>{p.name}</p>
                                                {primaryProvider === p.key && !isDisabled && (
                                                    <Star className="h-3 w-3 text-azure fill-azure" />
                                                )}
                                                {isDisabled && (
                                                    <span className="text-[9px] font-semibold tracking-wide rounded px-1 py-px bg-surface-2 text-text-muted border border-border">DISABLED</span>
                                                )}
                                            </div>
                                            {'badge' in p && p.badge && (
                                                <span className={`text-[10px] font-semibold tracking-wide rounded px-1.5 py-0.5 ${'badgeColor' in p ? p.badgeColor : ''}`}>
                                                    {p.badge}
                                                </span>
                                            )}
                                        </div>
                                    </div>
                                    <StatusDot status={pState.status} />
                                </div>
                                {modelLabel ? (
                                    <p className={`mt-1.5 text-[10px] font-mono pl-10 truncate ${isDisabled ? 'text-zinc-700' : 'text-text-muted'}`} title={modelLabel}>{modelLabel}</p>
                                ) : (
                                    <p className="mt-1.5 text-xs text-text-muted pl-10 truncate">{p.description}</p>
                                )}
                            </button>
                        )
                    })}
                    <button
                        onClick={() => setShowAddCustom(true)}
                        className="flex items-center gap-3 rounded-lg border border-dashed border-zinc-700 p-3 text-text-muted hover:border-azure hover:text-azure transition-colors shrink-0 w-[280px] sm:w-[320px] md:w-auto snap-start"
                    >
                        <Plus className="h-5 w-5" />
                        <span className="text-sm">Add Provider</span>
                    </button>
                    </>)}
                </div>

                {/* Right panel — provider config */}
                <div className="flex-1 rounded-xl border border-border bg-surface-1/40 p-5 overflow-y-auto">
                    {/* Header */}
                    <div className="flex items-center justify-between mb-5">
                        <div className="flex items-center gap-3">
                            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-surface-2 text-sm font-bold text-text-secondary">
                                {selected.name.slice(0, 2).toUpperCase()}
                            </div>
                            <div>
                                <h2 className="text-base font-semibold text-text-primary">{selected.name}</h2>
                                <div className="flex items-center gap-1.5">
                                    <StatusDot status={state.status} />
                                    <span className="text-xs text-text-muted capitalize">{state.status}</span>
                                </div>
                            </div>
                        </div>
                        <div className="flex items-center gap-2">
                            {/* Enabled toggle — only shown when provider has been configured */}
                            {state.status !== 'unconfigured' && (
                                <button
                                    id={`toggle-enabled-${selectedProvider}`}
                                    onClick={async () => {
                                        const next = !state.enabled
                                        updateState(selectedProvider, { enabled: next })
                                        await handleSave({ [selectedProvider]: { enabled: next } } as Partial<Record<ProviderKey, Partial<ProviderState>>>)
                                    }}
                                    title={state.enabled ? 'Disable this provider' : 'Enable this provider'}
                                    className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors focus:outline-none focus:ring-2 focus:ring-azure/40 ${
                                        state.enabled ? 'bg-azure' : 'bg-zinc-700'
                                    }`}
                                >
                                    <span
                                        className={`inline-block h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${
                                            state.enabled ? 'translate-x-5' : 'translate-x-0'
                                        }`}
                                    />
                                </button>
                            )}
                            <button
                                onClick={() => { setPrimaryProvider(selectedProvider); setFallbackOrder(prev => [selectedProvider, ...prev.filter(k => k !== selectedProvider)]); setModelRouting({ ...getDefaultModelsForProvider(selectedProvider) }) }}
                                disabled={!state.enabled && state.status !== 'unconfigured'}
                                className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${primaryProvider === selectedProvider
                                    ? 'border-azure/50 bg-azure-dim text-azure'
                                    : 'border-border bg-surface-2 text-text-secondary hover:border-zinc-600 hover:text-text-primary'
                                    }`}
                            >
                                <Star className={`h-3.5 w-3.5 ${primaryProvider === selectedProvider ? 'fill-azure' : ''}`} />
                                {primaryProvider === selectedProvider ? 'Primary provider' : 'Set as primary'}
                            </button>
                        </div>
                    </div>

                    {/* Credential fields */}
                    <div className="flex flex-col gap-4">
                        {selected.requiresKey ? (
                            <div className="flex flex-col gap-4">

                                {/* OpenRouter-specific: free tier notice */}
                                {selectedProvider === 'openrouter' && editingKey[selectedProvider] && (
                                    <div className="flex flex-col gap-2 rounded-xl border border-azure/20 bg-azure/5 p-4">
                                        <div className="flex items-start gap-3">
                                            <CheckCircle2 className="h-4 w-4 shrink-0 mt-0.5 text-azure" />
                                            <div>
                                                <p className="text-sm font-medium text-azure-300">Free tier available — no credits required</p>
                                                <p className="mt-1 text-xs text-text-muted leading-relaxed">
                                                    OpenRouter blocks accounts with no purchase history from paid models (402 error).
                                                    Free models with the <code className="text-text-secondary">:free</code> suffix work with any key — no credit card needed.
                                                    Plexo tries multiple free models in order until one works.
                                                </p>
                                                <p className="mt-1.5 text-xs text-text-muted leading-relaxed">
                                                    <strong className="text-text-secondary">Privacy note:</strong> Some free models require{' '}
                                                    <a href="https://openrouter.ai/settings/privacy" target="_blank" rel="noopener noreferrer" className="text-azure hover:text-azure underline underline-offset-2">Model Training</a>
                                                    {' '}enabled in your OR settings. If all free models fail, enable it or add credits.
                                                    Free limit: ~50 req/day ($10+ in credits raises it to 1,000/day).
                                                </p>
                                            </div>
                                        </div>
                                    </div>
                                )}

                                {/* Anthropic-specific: subscription token policy notice */}
                                {selectedProvider === 'anthropic' && editingKey[selectedProvider] && (
                                    <div className="flex flex-col gap-2 rounded-xl border border-amber-500/25 bg-amber/5 p-4">
                                        <div className="flex items-start gap-3">
                                            <AlertCircle className="h-4 w-4 shrink-0 mt-0.5 text-amber" />
                                            <div>
                                                <p className="text-sm font-medium text-amber-300">API key required — subscription tokens are blocked</p>
                                                <p className="mt-1 text-xs text-text-muted leading-relaxed">
                                                    As of January 2026, Anthropic blocks OAuth tokens (<code className="text-text-secondary">sk-ant-oat01-*</code>) obtained
                                                    from Claude Free, Pro, or Max subscriptions from being used in third-party tools.
                                                    This is enforced server-side and violates their ToS. Attempting to use one will result in a 405 error.
                                                </p>
                                                <p className="mt-1.5 text-xs text-text-muted leading-relaxed">
                                                    Use a paid API key (<code className="text-text-secondary">sk-ant-api03-*</code>) from{' '}
                                                    <a href="https://console.anthropic.com/account/keys" target="_blank" rel="noopener noreferrer" className="text-azure hover:text-azure underline underline-offset-2">console.anthropic.com</a>.
                                                    These bill per token.
                                                </p>
                                            </div>
                                        </div>
                                    </div>
                                )}

                                {/* Ollama Cloud: free tier + key info */}
                                {selectedProvider === 'ollama_cloud' && editingKey[selectedProvider] && (
                                    <div className="flex flex-col gap-2 rounded-xl border border-sky-500/20 bg-sky-500/5 p-4">
                                        <div className="flex items-start gap-3">
                                            <CheckCircle2 className="h-4 w-4 shrink-0 mt-0.5 text-sky-400" />
                                            <div>
                                                <p className="text-sm font-medium text-sky-300">Free tier available — sign in at ollama.com</p>
                                                <p className="mt-1 text-xs text-text-muted leading-relaxed">
                                                    Ollama Cloud gives you access to large hosted models (gpt-oss, deepseek, kimi, glm…)
                                                    without running them locally. The free plan covers light usage — chat, quick
                                                    questions, and trying models.
                                                </p>
                                                <p className="mt-1.5 text-xs text-text-muted leading-relaxed">
                                                    Get your API key at{' '}
                                                    <a href="https://ollama.com/settings/keys" target="_blank" rel="noopener noreferrer" className="text-azure hover:text-azure underline underline-offset-2">ollama.com/settings/keys</a>.
                                                    After saving, Plexo will fetch your available cloud models automatically.
                                                </p>
                                            </div>
                                        </div>
                                    </div>
                                )}

                                {/* API key / subscription token field */}
                                <div className="flex flex-col gap-1.5 min-h-[44px]">
                                    <div className="flex items-center justify-between min-h-[44px]">
                                        <label className="text-sm font-medium text-text-secondary">API Key</label>
                                        {PROVIDER_LINKS[selectedProvider] && (
                                            <a
                                                href={PROVIDER_LINKS[selectedProvider]!.url}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                className="flex items-center gap-1 min-h-[44px] px-2 text-xs text-text-muted hover:text-azure transition-colors"
                                            >
                                                {PROVIDER_LINKS[selectedProvider]!.label}
                                                <ExternalLink className="h-3 w-3" />
                                            </a>
                                        )}
                                    </div>

                                    {/* Configured pill — shown when a key is stored and not editing */}
                                    {state.status !== 'unconfigured' && !editingKey[selectedProvider] ? (
                                        <div className="flex flex-col gap-1.5">
                                            {/* Key pill */}
                                            <div className="flex items-center gap-3 rounded-lg border border-border/50 bg-surface-2/40 px-3 py-2">
                                                <span className="text-text-muted tracking-[0.3em] text-sm select-none flex-1">••••••••••••••••••••</span>
                                                <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded shrink-0 ${
                                                    state.status === 'configured'
                                                        ? 'bg-azure-900/40 text-azure'
                                                        : 'bg-amber-900/40 text-amber'
                                                }`}>
                                                    {state.status === 'configured' ? 'Verified' : 'Saved'}
                                                </span>
                                            </div>
                                            {/* Actions row */}
                                            {clearConfirm === selectedProvider ? (
                                                <div className="flex items-center gap-2 mt-2">
                                                    <span className="text-[11px] text-text-muted">Remove stored key?</span>
                                                    <button
                                                        onClick={async () => {
                                                            setClearConfirm(null)
                                                            updateState(selectedProvider, { apiKey: '__CLEAR__', status: 'unconfigured', testResult: null })
                                                            await handleSave({ [selectedProvider]: { apiKey: '__CLEAR__', status: 'unconfigured' } } as Partial<Record<ProviderKey, Partial<ProviderState>>>)
                                                            updateState(selectedProvider, { apiKey: '' })
                                                        }}
                                                        className="text-[11px] min-h-[44px] px-3 font-medium text-red hover:text-red-300 transition-colors border border-red-900/50 rounded-lg hover:bg-red-950/20"
                                                    >
                                                        Remove
                                                    </button>
                                                    <button
                                                        onClick={() => setClearConfirm(null)}
                                                        className="text-[11px] min-h-[44px] px-3 text-text-secondary hover:text-text-primary transition-colors border border-border/50 rounded-lg hover:bg-surface-2"
                                                    >
                                                        Cancel
                                                    </button>
                                                </div>
                                            ) : (
                                                <div className="flex items-center gap-3">
                                                    <button
                                                        onClick={() => setEditingKey((prev) => ({ ...prev, [selectedProvider]: true }))}
                                                        className="text-[12px] min-h-[44px] px-3 border border-azure/20 bg-azure-dim rounded-lg font-medium text-azure hover:bg-azure-dim transition-colors"
                                                    >
                                                        Change key
                                                    </button>
                                                    <button
                                                        onClick={() => setClearConfirm(selectedProvider)}
                                                        className="text-[12px] min-h-[44px] px-3 border border-border rounded-lg text-text-secondary hover:bg-surface-2 hover:text-red transition-colors"
                                                    >
                                                        Remove
                                                    </button>
                                                </div>
                                            )}
                                        </div>
                                    ) : (
                                        /* Edit mode — show real input */
                                        <div className="flex items-center gap-2">
                                            <input
                                                type="password"
                                                value={state.apiKey}
                                                onChange={(e) => updateState(selectedProvider, { apiKey: e.target.value })}
                                                onKeyDown={(e) => e.key === 'Enter' && void handleTest()}
                                                placeholder="sk-ant-api03-••••••••"
                                                autoFocus
                                                autoComplete="new-password"
                                                className="flex-1 rounded-lg border border-border bg-surface-1 px-3 min-h-[44px] text-[16px] md:text-sm text-text-primary placeholder:text-text-muted focus:border-azure focus:outline-none focus:ring-1 focus:ring-azure/30"
                                            />
                                            {editingKey[selectedProvider] && (
                                                <button
                                                    onClick={() => {
                                                        setEditingKey((prev) => ({ ...prev, [selectedProvider]: false }))
                                                        updateState(selectedProvider, { apiKey: '' })
                                                    }}
                                                    className="text-text-muted hover:text-text-secondary transition-colors min-h-[44px] min-w-[44px] flex justify-center items-center"
                                                    title="Cancel"
                                                >
                                                    <X className="h-4 w-4" />
                                                </button>
                                            )}
                                        </div>
                                    )}

                                    <p className="text-xs text-text-muted">
                                        Encrypted at rest (AES-256-GCM). Leave blank to keep the existing key.
                                    </p>
                                </div>
                            </div>
                        ) : (
                            <div className="flex flex-col gap-3">
                                <div className="flex flex-col gap-1.5">
                                    <div className="flex items-center justify-between">
                                        <label className="text-sm font-medium text-text-secondary">Base URL</label>
                                        <span className="text-[10px] text-text-muted">Local or remote — any reachable Ollama instance</span>
                                    </div>
                                    {state.status === 'borrowed' ? (
                                        /* Read-only URL for borrowed providers */
                                        <div className="flex items-center gap-2 rounded-lg border border-azure-800/30 bg-azure/10 px-3 py-2">
                                            <span className="flex-1 text-sm font-mono text-text-secondary">{state.baseUrl || 'http://localhost:11434'}</span>
                                            <span className="text-[10px] text-azure">from source workspace</span>
                                        </div>
                                    ) : (
                                        <div className="flex gap-2">
                                            <input
                                                type="text"
                                                value={state.baseUrl}
                                                onChange={(e) => updateState(selectedProvider, { baseUrl: e.target.value, dynamicModels: [], status: 'unconfigured' })}
                                                onKeyDown={(e) => e.key === 'Enter' && void handleConnect()}
                                                placeholder="http://localhost:11434"
                                                className="flex-1 rounded-lg border border-border bg-surface-1 px-3 min-h-[44px] text-[16px] md:text-sm text-text-primary placeholder:text-text-muted focus:border-azure focus:outline-none focus:ring-1 focus:ring-azure/30 w-full"
                                            />
                                            {state.dynamicModels.length === 0 && (
                                                <button
                                                    onClick={() => void handleConnect()}
                                                    disabled={connecting || !state.baseUrl}
                                                    className="flex items-center gap-2 rounded-lg border border-border bg-surface-2 px-4 min-h-[44px] text-sm font-medium text-text-primary hover:bg-zinc-700 transition-colors disabled:opacity-50 shrink-0"
                                                >
                                                    {connecting
                                                        ? <><RefreshCw className="h-3.5 w-3.5 animate-spin" />Connecting…</>
                                                        : 'Connect'
                                                    }
                                                </button>
                                            )}
                                        </div>
                                    )}
                                    {state.status !== 'borrowed' && (
                                        <p className="text-xs text-text-muted">
                                            Plexo will call <code className="text-text-muted">/api/tags</code> to discover models and <code className="text-text-muted">/v1</code> for inference.
                                            No API key required — network connectivity is sufficient.
                                        </p>
                                    )}
                                </div>
                            </div>
                        )}

                        {(selected.staticModels || state.dynamicModels.length > 0) && (
                            <div className="flex flex-col gap-2">
                                <label className="text-sm font-medium text-text-secondary mt-2">Default model</label>
                                <select
                                    value={state.selectedModel}
                                    onChange={(e) => updateState(selectedProvider, { selectedModel: e.target.value })}
                                    className="rounded-lg border border-border bg-surface-1 px-3 min-h-[44px] text-[16px] md:text-sm text-text-primary focus:border-azure focus:outline-none focus:ring-1 focus:ring-azure/30"
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
                                    <p className="text-xs text-text-muted">
                                        {state.dynamicModels.length} models available {selectedProvider === 'ollama_cloud' ? 'from Ollama Cloud' : 'from your Ollama instance'}.
                                    </p>
                                )}
                            </div>
                        )}

                        {/* Ensemble quality judge badge — Ollama only (configured or borrowed) */}
                        {selectedProvider === 'ollama' && (state.status === 'configured' || state.status === 'borrowed') && state.dynamicModels.length > 0 && (
                            <div className="rounded-lg border border-azure-800/30 bg-azure/20 px-3 py-3 flex flex-col gap-1.5">
                                <div className="flex items-center gap-2">
                                    <Users className="h-3.5 w-3.5 text-azure" />
                                    <p className="text-xs font-semibold text-azure">Used for quality ensemble</p>
                                    <span className="ml-auto text-[10px] rounded px-1.5 py-0.5 bg-azure-900/40 text-azure">
                                        up to {Math.min(3, state.dynamicModels.length)} judges
                                    </span>
                                </div>
                                <p className="text-[11px] text-text-muted leading-relaxed">
                                    After each task, Plexo runs the deliverable through {Math.min(3, state.dynamicModels.length)} local model
                                    {Math.min(3, state.dynamicModels.length) !== 1 ? 's' : ''} in
                                    parallel and aggregates a consensus quality score. If judges disagree, a cloud model arbitrates.
                                </p>
                                {state.dynamicModels.slice(0, 5).length > 0 && (
                                    <div className="flex flex-wrap gap-1 mt-0.5">
                                        {state.dynamicModels.slice(0, 5).map((m) => (
                                            <span key={m} className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] font-mono text-text-secondary">{m}</span>
                                        ))}
                                        {state.dynamicModels.length > 5 && (
                                            <span className="text-[10px] text-text-muted">+{state.dynamicModels.length - 5} more</span>
                                        )}
                                    </div>
                                )}
                            </div>
                        )}

                        {/* Custom provider extras — base URL, re-scan, remove */}
                        {selectedProvider.startsWith('custom_') && (() => {
                            const cp = customProviders.find(c => c.key === selectedProvider)
                            if (!cp) return null
                            return (
                                <div className="flex flex-col gap-3 pt-2 border-t border-border/60">
                                    <div className="flex flex-col gap-1.5">
                                        <label className="text-sm font-medium text-text-secondary">Base URL</label>
                                        <input
                                            type="text"
                                            value={state?.baseUrl ?? cp.baseUrl}
                                            onChange={(e) => updateState(selectedProvider, { baseUrl: e.target.value })}
                                            placeholder="https://api.example.com/v1"
                                            className="rounded-lg border border-border bg-surface-1 px-3 min-h-[44px] text-[16px] md:text-sm text-text-primary placeholder:text-text-muted focus:border-azure focus:outline-none focus:ring-1 focus:ring-azure/30"
                                        />
                                        <p className="text-[10px] text-text-muted">
                                            Protocol: <span className="font-mono text-text-secondary">{cp.compatMode}</span>
                                            {cp.staticModels.length > 0 && <> · {cp.staticModels.length} models discovered</>}
                                        </p>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <button
                                            onClick={() => void handleRescanCustom(selectedProvider)}
                                            disabled={connecting}
                                            className="flex items-center gap-1.5 rounded-lg border border-border bg-surface-2 px-3 min-h-[44px] text-xs font-medium text-text-secondary hover:bg-zinc-700 transition-colors disabled:opacity-50"
                                        >
                                            <RefreshCw className={`h-3 w-3 ${connecting ? 'animate-spin' : ''}`} />
                                            Re-scan Models
                                        </button>
                                        <button
                                            onClick={() => handleRemoveCustom(selectedProvider)}
                                            className="flex items-center gap-1.5 rounded-lg border border-red-900/50 px-3 min-h-[44px] text-xs font-medium text-red hover:bg-red-950/30 transition-colors"
                                        >
                                            <Trash2 className="h-3 w-3" />
                                            Remove Provider
                                        </button>
                                    </div>
                                </div>
                            )
                        })()}

                        {/* Primary action — only show Save & Test when ready */}
                        {(!selected.requiresKey ? state.dynamicModels.length > 0 : true) && (
                            <div className="flex items-center mt-2">
                                <button
                                    onClick={() => void handleTest()}
                                    disabled={testing || saving}
                                    className="flex items-center justify-center w-full md:w-auto gap-2 rounded-lg bg-azure px-6 min-h-[44px] text-sm font-medium text-text-primary hover:bg-azure/90 transition-colors disabled:opacity-50"
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
                                ? 'border-azure/30 bg-azure/30 text-azure'
                                : 'border-red-800/50 bg-red-950/30 text-red'
                                }`}>
                                {state.testResult}
                            </div>
                        )}

                        {/* ── Borrowed badge (target workspace UI) ── */}
                        {(() => {
                            const borrow = borrowing.find((s) => s.providerKey === selectedProvider)
                            if (!borrow) return null
                            return (
                                <div className="flex items-center gap-3 rounded-xl border border-azure-800/30 bg-azure/10 px-4 py-3">
                                    <Link2 className="h-4 w-4 text-azure shrink-0" />
                                    <div className="flex-1 min-w-0">
                                        <p className="text-xs font-medium text-azure">Borrowed from <span className="font-semibold">{borrow.sourceWorkspace?.name ?? 'another workspace'}</span></p>
                                        <p className="text-[10px] text-text-muted mt-0.5">Key stays encrypted in the source workspace — not copied here.</p>
                                    </div>
                                    <button
                                        onClick={() => void handleStopBorrowing(selectedProvider)}
                                        className="text-[12px] min-h-[44px] px-3 border border-red-900/50 rounded-lg text-red hover:bg-red-950/30 transition-colors shrink-0"
                                    >
                                        Stop borrowing
                                    </button>
                                </div>
                            )
                        })()}

                        {/* ── Key sharing (source workspace UI) ── */}
                        {state.status !== 'unconfigured' && !borrowing.find((s) => s.providerKey === selectedProvider) && (() => {
                            const sharedCount = lending.filter((s) => s.providerKey === selectedProvider).length
                            const sharingOn = sharedCount > 0
                            return (
                                <div className="flex flex-col gap-2 pt-1 border-t border-border/60">
                                    <div className="flex items-center gap-2">
                                        <p className="text-xs font-medium text-text-muted">Share with workspaces</p>
                                        {sharedCount > 0 && (
                                            <span className="text-[10px] rounded-full px-1.5 py-0.5 bg-azure-900/40 text-azure font-medium">{sharedCount}</span>
                                        )}
                                        <button
                                            role="switch"
                                            aria-checked={sharingOn}
                                            onClick={() => {
                                                if (sharingOn) {
                                                    lending
                                                        .filter((s) => s.providerKey === selectedProvider)
                                                        .forEach((s) => void handleRevokeShare(s.id))
                                                }
                                            }}
                                            className={`ml-auto relative inline-flex h-6 w-11 md:h-5 md:w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none ${
                                                sharingOn ? 'bg-azure' : 'bg-zinc-700'
                                            }`}
                                        >
                                            <span className={`pointer-events-none inline-block h-5 w-5 md:h-4 md:w-4 rounded-full bg-white shadow transform transition-transform duration-200 ${
                                                sharingOn ? 'translate-x-5 md:translate-x-4' : 'translate-x-0'
                                            }`} />
                                        </button>
                                    </div>

                                    {ownWorkspaces.length === 0 ? (
                                        <p className="text-[11px] text-zinc-700">
                                            No other workspaces.{' '}
                                            <a href="/settings" className="text-azure hover:text-azure">Create one in Settings.</a>
                                        </p>
                                    ) : (
                                        <div className="flex flex-col gap-1 max-w-xs">
                                            {ownWorkspaces.map((ws) => {
                                                const isShared = lending.some((s) => s.providerKey === selectedProvider && s.targetWorkspace?.id === ws.id)
                                                const busy = sharingWs.has(ws.id)
                                                return (
                                                    <label
                                                        key={ws.id}
                                                        className={`flex items-center gap-3 rounded-lg border px-3 py-3 md:py-2 min-h-[44px] cursor-pointer transition-colors ${
                                                            isShared
                                                                ? 'border-azure/40 bg-azure-500/5'
                                                                : 'border-border bg-surface-1/40 hover:border-border'
                                                        } ${busy ? 'opacity-60 pointer-events-none' : ''}`}
                                                    >
                                                        <input
                                                            type="checkbox"
                                                            checked={isShared}
                                                            disabled={busy}
                                                            onChange={() => void handleToggleShare(ws.id, selectedProvider)}
                                                            className="accent-azure h-4 w-4 md:h-3.5 md:w-3.5 shrink-0 cursor-pointer"
                                                        />
                                                        <span className="text-xs text-text-secondary flex-1 truncate">{ws.name}</span>
                                                        {busy && <RefreshCw className="h-3 w-3 text-text-muted animate-spin shrink-0" />}
                                                        {isShared && !busy && <span className="text-[10px] text-azure shrink-0">Shared</span>}
                                                    </label>
                                                )
                                            })}
                                        </div>
                                    )}
                                </div>
                            )
                        })()}
                    </div>
                </div>
            </div>

            {/* ── Global Routing ─────────────────────────────────── */}
            {configuredProviders.length > 0 && (
                <div className="rounded-xl border border-border bg-surface-1/40 overflow-hidden">
                    <button
                        onClick={() => setShowFallback((v) => !v)}
                        className="w-full flex items-center justify-between px-5 py-3.5 hover:bg-surface-2/30 transition-colors"
                    >
                        <div className="flex items-center gap-3 min-w-0 flex-1">
                            <h2 className="text-sm font-semibold text-text-primary shrink-0">Fallback Chain</h2>
                            {/* Inline chain pill strip — always visible */}
                            <div className="flex items-center gap-1 flex-wrap min-w-0">
                                {activeChainProviders.map((p, idx) => (
                                    <div key={p.key} className="flex items-center gap-1">
                                        {idx > 0 && <span className="text-zinc-700 text-[10px] select-none">›</span>}
                                        <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium border ${
                                            primaryProvider === p.key
                                                ? 'border-azure/40 bg-azure-dim text-azure'
                                                : 'border-border/80 bg-surface-2/80 text-text-secondary'
                                        }`}>
                                            {borrowing.find((s) => s.providerKey === p.key)
                                                ? <Link2 className="h-2.5 w-2.5 text-azure shrink-0" />
                                                : <span className="h-1.5 w-1.5 rounded-full bg-azure/80 shrink-0" />}
                                            {p.name}
                                        </span>
                                    </div>
                                ))}
                                {warnChainProviders.map((p) => (
                                    <div key={p.key} className="flex items-center gap-1">
                                        <span className="text-zinc-700 text-[10px] select-none">›</span>
                                        <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium border border-border text-text-muted opacity-50">
                                            <span className="h-1.5 w-1.5 rounded-full bg-amber/50 shrink-0" />
                                            {p.name}
                                        </span>
                                    </div>
                                ))}
                            </div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0 ml-2">
                            <button
                                onClick={(e) => { e.stopPropagation(); setShowFallback(true); setShowRouting((v) => !v) }}
                                className="flex items-center gap-1 text-[10px] text-text-muted hover:text-text-secondary transition-colors px-2 min-h-[44px] md:min-h-0 md:py-1 rounded hover:bg-surface-2"
                            >
                                Model routing
                                {showRouting ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                            </button>
                            {showFallback ? <ChevronDown className="h-3.5 w-3.5 text-text-muted" /> : <ChevronRight className="h-3.5 w-3.5 text-text-muted" />}
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
                                        ? 'border-azure/40 bg-azure-500/8'
                                        : 'border-border bg-surface-1/60'
                                    }`}
                            >
                                <span className="text-xs text-text-muted font-mono w-4 text-center">{idx + 1}</span>
                                <StatusDot status={providerStates[p.key].status} />
                                <span className="text-sm text-text-secondary">{p.name}</span>
                                {primaryProvider === p.key && (
                                    <span className="text-[10px] text-azure font-medium">primary</span>
                                )}
                                <div className="flex ml-1 gap-1">
                                    <button onClick={() => moveFallback(p.key, -1)} disabled={idx === 0} className="text-text-muted hover:text-text-secondary disabled:opacity-20 flex items-center justify-center min-w-[40px] md:min-w-0 md:px-0.5" aria-label="Move earlier">◀</button>
                                    <button onClick={() => moveFallback(p.key, 1)} disabled={idx === activeChainProviders.length - 1} className="text-text-muted hover:text-text-secondary disabled:opacity-20 flex items-center justify-center min-w-[40px] md:min-w-0 md:px-0.5" aria-label="Move later">▶</button>
                                    <button onClick={() => removeFromFallback(p.key)} className="text-text-muted hover:text-red flex items-center justify-center min-w-[40px] md:min-w-0 md:ml-1 md:px-0.5 transition-colors" aria-label="Remove from chain" title="Remove from chain">×</button>
                                </div>
                            </div>
                        ))}
                        {warnChainProviders.map((p) => (
                            <div key={p.key} className="flex items-center gap-2 rounded-lg border border-border bg-surface-1/30 px-3 py-2 opacity-50" title={`${p.name} — not tested. Click to configure.`}>
                                <StatusDot status={providerStates[p.key].status} />
                                <button onClick={() => setSelectedProvider(p.key)} className="text-sm text-text-muted hover:text-text-secondary transition-colors">{p.name}</button>
                                <button onClick={() => removeFromFallback(p.key)} className="ml-1 text-text-muted hover:text-red leading-none px-0.5 transition-colors" aria-label="Remove from chain" title="Remove from chain">×</button>
                            </div>
                        ))}
                    </div>
                    {/* Model routing — collapsible */}
                    {showRouting && (() => {
                        // Models to populate the routing dropdowns — primary provider's list.
                        const primaryConfig = allProviders.find((p) => p.key === primaryProvider)
                        const primaryState = providerStates[primaryProvider]
                        const routingModels: string[] = [
                            ...(primaryConfig?.staticModels ?? []),
                            ...(primaryState?.dynamicModels ?? []),
                        ]
                        const defaults = getDefaultModelsForProvider(primaryProvider)
                        return (
                            <div className="mt-4 rounded-xl border border-border bg-surface-1/40 overflow-hidden">
                                <div className="px-4 py-2.5 border-b border-border flex items-center justify-between">
                                    <p className="text-xs text-text-muted">Per-task model override. Defaults are chosen for your active provider.</p>
                                    <button
                                        onClick={() => setModelRouting({ ...getDefaultModelsForProvider(primaryProvider) })}
                                        className="text-[10px] text-text-muted hover:text-text-secondary transition-colors"
                                    >Reset to defaults</button>
                                </div>
                                <table className="w-full text-sm">
                                    <thead><tr className="border-b border-border"><th className="px-4 py-2.5 text-left text-xs font-medium text-text-muted">Task type</th><th className="px-4 py-2.5 text-left text-xs font-medium text-text-muted">Model</th></tr></thead>
                                    <tbody>
                                        {(Object.entries(TASK_LABELS) as [TaskType, string][]).map(([taskType, label]) => (
                                            <tr key={taskType} className="border-b border-border-subtle last:border-0">
                                                <td className="px-4 py-2.5 text-text-secondary whitespace-nowrap">{label}</td>
                                                <td className="px-4 py-2.5">
                                                    <select
                                                        value={modelRouting[taskType]}
                                                        onChange={(e) => setModelRouting((prev) => ({ ...prev, [taskType]: e.target.value }))}
                                                        className="w-[200px] md:w-full rounded border border-border bg-surface-1 px-2 min-h-[44px] md:min-h-[32px] text-[16px] md:text-sm text-text-primary focus:border-azure focus:outline-none"
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
            <div className="rounded-xl border border-border bg-surface-1/40 overflow-hidden">
                <button
                    onClick={() => setShowCostDefaults((v) => !v)}
                    className="w-full flex items-center justify-between px-5 py-3.5 hover:bg-surface-2/30 transition-colors"
                >
                    <div className="flex items-center gap-4 min-w-0 flex-1">
                        <h2 className="text-sm font-semibold text-text-primary shrink-0">Cost Defaults</h2>
                        {/* Inline stat summary — always visible */}
                        <div className="flex items-center gap-3">
                            <div className="flex items-center gap-1.5">
                                <span className="text-[10px] text-text-muted uppercase tracking-wide font-medium">ceiling</span>
                                <span className={`text-xs font-mono font-medium ${
                                    wsDefaultCostCeiling && parseFloat(wsDefaultCostCeiling) > 0
                                        ? 'text-text-secondary'
                                        : 'text-text-muted'
                                }`}>
                                    {wsDefaultCostCeiling && parseFloat(wsDefaultCostCeiling) > 0
                                        ? `$${parseFloat(wsDefaultCostCeiling).toFixed(2)}`
                                        : '—'}
                                </span>
                            </div>
                            <span className="text-zinc-800 text-[10px]">·</span>
                            <div className="flex items-center gap-1.5">
                                <span className="text-[10px] text-text-muted uppercase tracking-wide font-medium">tokens</span>
                                <span className={`text-xs font-mono font-medium ${
                                    wsDefaultTokenBudget && parseInt(wsDefaultTokenBudget, 10) > 0
                                        ? 'text-text-secondary'
                                        : 'text-text-muted'
                                }`}>
                                    {wsDefaultTokenBudget && parseInt(wsDefaultTokenBudget, 10) > 0
                                        ? parseInt(wsDefaultTokenBudget, 10).toLocaleString()
                                        : '—'}
                                </span>
                            </div>
                        </div>
                    </div>
                    {showCostDefaults ? <ChevronDown className="h-3.5 w-3.5 text-text-muted shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 text-text-muted shrink-0" />}
                </button>
                {showCostDefaults && <div className="px-5 pb-5">
                <div className="grid grid-cols-2 gap-4 mt-1">
                    <div className="flex flex-col gap-1.5">
                        <label htmlFor="ws-cost-ceiling" className="text-xs font-medium text-text-secondary">Cost ceiling per task (USD)</label>
                        <div className="relative">
                            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted text-sm">$</span>
                            <input
                                id="ws-cost-ceiling"
                                type="number"
                                min="0.01"
                                step="0.10"
                                placeholder="0.50"
                                value={wsDefaultCostCeiling}
                                onChange={(e) => setWsDefaultCostCeiling(e.target.value)}
                                className="w-full rounded-lg border border-border bg-surface-1 pl-7 pr-3 min-h-[44px] text-[16px] md:text-sm text-text-primary placeholder:text-text-muted focus:border-azure focus:outline-none focus:ring-1 focus:ring-azure/30"
                            />
                        </div>
                        <p className="text-[11px] text-text-muted">Chat &amp; channel tasks with no explicit ceiling. Hierarchy: task › project › workspace.</p>
                    </div>
                    <div className="flex flex-col gap-1.5">
                        <label htmlFor="ws-token-budget" className="text-xs font-medium text-text-secondary">Token budget per call (output)</label>
                        <input
                            id="ws-token-budget"
                            type="number"
                            min="256"
                            step="512"
                            placeholder="8192"
                            value={wsDefaultTokenBudget}
                            onChange={(e) => setWsDefaultTokenBudget(e.target.value)}
                            className="w-full rounded-lg border border-border bg-surface-1 px-3 min-h-[44px] text-[16px] md:text-sm text-text-primary placeholder:text-text-muted focus:border-azure focus:outline-none focus:ring-1 focus:ring-azure/30"
                        />
                        <p className="text-[11px] text-text-muted">Max output tokens per LLM call. 0 = no cap (model default).</p>
                    </div>
                </div>
                <div className="mt-4 flex flex-col md:flex-row md:items-center justify-between gap-4">
                    <p className="text-[11px] text-text-muted">
                        Ceiling hierarchy: task explicit › project › workspace › weekly cap.
                    </p>
                    <button
                        onClick={() => void handleSave()}
                        disabled={saving}
                        className="flex w-full md:w-auto items-center justify-center gap-2 rounded-lg bg-azure px-3.5 py-1.5 min-h-[44px] md:min-h-[32px] text-[16px] md:text-xs font-medium text-text-primary hover:bg-azure/90 transition-colors disabled:opacity-50 shrink-0"
                    >
                        <Save className="h-4 w-4 md:h-3 md:w-3" />
                        {saving ? 'Saving…' : saved ? 'Saved ✓' : 'Save'}
                    </button>
                </div>
                </div>}
            </div>
        </div>

        {/* ── Add Custom Provider Modal ─────────────────────────── */}
        {showAddCustom && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
                <div className="w-full max-w-lg rounded-xl border border-border bg-surface-0 shadow-2xl">
                    <div className="flex items-center justify-between border-b border-border px-5 py-4">
                        <h2 className="text-base font-semibold text-text-primary">Add Custom Provider</h2>
                        <button
                            onClick={() => { setShowAddCustom(false); setProbeName(''); setProbeUrl(''); setProbeKey(''); setProbeResult(null) }}
                            className="text-text-muted hover:text-text-secondary transition-colors p-1"
                        >
                            <X className="h-4 w-4" />
                        </button>
                    </div>
                    <div className="flex flex-col gap-4 px-5 py-5">
                        <div className="flex flex-col gap-1.5">
                            <label className="text-sm font-medium text-text-secondary">Name</label>
                            <input
                                type="text"
                                value={probeName}
                                onChange={(e) => setProbeName(e.target.value)}
                                placeholder="Together AI"
                                autoFocus
                                className="rounded-lg border border-border bg-surface-1 px-3 min-h-[44px] text-[16px] md:text-sm text-text-primary placeholder:text-text-muted focus:border-azure focus:outline-none focus:ring-1 focus:ring-azure/30"
                            />
                        </div>
                        <div className="flex flex-col gap-1.5">
                            <label className="text-sm font-medium text-text-secondary">Base URL</label>
                            <input
                                type="text"
                                value={probeUrl}
                                onChange={(e) => setProbeUrl(e.target.value)}
                                placeholder="https://api.together.xyz/v1"
                                className="rounded-lg border border-border bg-surface-1 px-3 min-h-[44px] text-[16px] md:text-sm text-text-primary placeholder:text-text-muted focus:border-azure focus:outline-none focus:ring-1 focus:ring-azure/30"
                            />
                            {/mcp[-_]?(config|server|sse)|\/sse$|\/mcp$/i.test(probeUrl) && (
                                <div className="rounded-lg border border-amber-800/50 bg-amber-950/20 px-3 py-2.5 text-xs text-amber flex flex-col gap-1">
                                    <p className="font-semibold">This looks like an MCP server, not an LLM provider.</p>
                                    <p>MCP servers provide tools, not model inference. Add it in{' '}
                                        <a href="/connections" className="text-azure hover:underline font-medium">Connections</a>{' '}
                                        instead.
                                    </p>
                                </div>
                            )}
                        </div>
                        <div className="flex flex-col gap-1.5">
                            <label className="text-sm font-medium text-text-secondary">API Key</label>
                            <input
                                type="password"
                                value={probeKey}
                                onChange={(e) => setProbeKey(e.target.value)}
                                placeholder="sk-••••••••"
                                autoComplete="new-password"
                                className="rounded-lg border border-border bg-surface-1 px-3 min-h-[44px] text-[16px] md:text-sm text-text-primary placeholder:text-text-muted focus:border-azure focus:outline-none focus:ring-1 focus:ring-azure/30"
                            />
                            <p className="text-xs text-text-muted">Encrypted at rest (AES-256-GCM).</p>
                        </div>
                        <button
                            onClick={() => void handleProbe()}
                            disabled={probing || !probeUrl.trim()}
                            className="flex items-center justify-center gap-2 rounded-lg border border-border bg-surface-2 px-4 min-h-[44px] text-sm font-medium text-text-primary hover:bg-zinc-700 transition-colors disabled:opacity-50"
                        >
                            {probing
                                ? <><RefreshCw className="h-3.5 w-3.5 animate-spin" />Detecting…</>
                                : 'Auto-Detect'
                            }
                        </button>
                        {probeResult && (
                            <div className="rounded-lg border border-border bg-surface-1/60 px-3 py-3">
                                <div className="flex items-center gap-2 mb-2">
                                    <span className="text-xs font-medium text-text-secondary">Protocol:</span>
                                    <span className="text-xs font-mono text-text-primary">{probeResult.protocol}</span>
                                    <span className="text-xs text-text-muted ml-auto">{probeResult.models.length} models</span>
                                </div>
                                {probeResult.models.length > 0 && (
                                    <div className="flex flex-wrap gap-1 max-h-32 overflow-y-auto">
                                        {probeResult.models.slice(0, 20).map((m) => (
                                            <span key={m} className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] font-mono text-text-secondary">{m}</span>
                                        ))}
                                        {probeResult.models.length > 20 && (
                                            <span className="text-[10px] text-text-muted">+{probeResult.models.length - 20} more</span>
                                        )}
                                    </div>
                                )}
                                {probeResult.models.length === 0 && probeResult.protocol === 'unknown' && (
                                    <p className="text-xs text-amber">Could not detect protocol or models. You can still add the provider manually.</p>
                                )}
                            </div>
                        )}
                    </div>
                    <div className="flex items-center justify-end gap-3 border-t border-border px-5 py-4">
                        <button
                            onClick={() => { setShowAddCustom(false); setProbeName(''); setProbeUrl(''); setProbeKey(''); setProbeResult(null) }}
                            className="rounded-lg border border-border px-4 min-h-[44px] text-sm font-medium text-text-secondary hover:bg-surface-2 transition-colors"
                        >
                            Cancel
                        </button>
                        <button
                            onClick={handleAddCustom}
                            disabled={!probeName.trim() || !probeUrl.trim()}
                            className="rounded-lg bg-azure px-4 min-h-[44px] text-sm font-medium text-text-primary hover:bg-azure/90 transition-colors disabled:opacity-50"
                        >
                            Add Provider
                        </button>
                    </div>
                </div>
            </div>
        )}

        </>
    )
}
