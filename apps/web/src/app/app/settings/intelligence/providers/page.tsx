// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

'use client'

export const dynamic = 'force-dynamic'

/**
 * Providers sub-page (the old megapage chat-chain surface, extracted).
 *
 * Renders the provider-chain strip + a two-column catalog/detail view.
 * The outer intelligence layout owns the page-level nav chrome; this
 * file is only responsible for the chain + 15-provider catalog UI.
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import useSWR from 'swr'
import { jsonFetcher } from '@web/lib/swr'
import { useWorkspaceId } from '@web/context/workspace'
import {
    BrainCircuit,
    ArrowUp, ArrowDown, RefreshCw, Loader2,
    Zap, ExternalLink, Cloud, Brain, Sparkles,
    MessageSquare, Globe, Wind, ArrowLeftRight, Users,
    Flame, Search, Bot, BookOpen, Cpu, Trash2,
    CheckCircle2, AlertCircle, Circle, Link2, AlertTriangle,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { toast } from 'sonner'
import { useListFilter, ListToolbar } from '@web/components/list-toolbar'
import type { FilterDimension } from '@web/components/list-toolbar'
import { ProviderChain, type ChainCardData, type ChainHealth } from '../provider-chain'
import { ModelCompatBadge, type ModelCompatStatus } from '@web/components/model-compat-badge'
import { getDeploymentMode, shouldShowBYOKModelCompat } from '@web/lib/feature-flags'

// ── Types ────────────────────────────────────────────────────────────────────

interface ProviderCapabilities {
    supportsChat: boolean
    supportsEmbeddings: boolean
    chatModels: string[]
    embeddingModels: string[]
    discoveryError: string | null
}

interface ProviderInstance {
    id: string
    workspaceId: string
    nickname: string
    providerType: string
    endpointUrl: string | null
    capabilities: ProviderCapabilities
    preferenceOrder: number
    chatPreferenceOrder: number | null
    embeddingPreferenceOrder: number | null
    managed: boolean
    enabled: boolean
    selectedModel: string | null
    createdAt: string
    updatedAt: string
    lastDiscoveredAt: string | null
    modelCompatStatus?: ModelCompatStatus
    modelCompatValidatedAt?: string | null
}

// ── Error extraction helper ─────────────────────────────────────────────────

function extractErrorMessage(err: unknown): string {
    if (!err) return 'Unknown error'
    if (typeof err === 'string') return err
    if (typeof err === 'object') {
        const obj = err as Record<string, unknown>
        if (typeof obj.message === 'string') return obj.message
        if (typeof obj.error === 'string') return obj.error
        if (typeof obj.error === 'object' && obj.error && typeof (obj.error as Record<string, unknown>).message === 'string') {
            return (obj.error as Record<string, unknown>).message as string
        }
        try { return JSON.stringify(err) } catch { return 'Unknown error' }
    }
    return String(err)
}

// ── Status helpers ───────────────────────────────────────────────────────────

type HealthStatus = 'healthy' | 'degraded' | 'broken' | 'managed'

function getProviderHealth(p: ProviderInstance): HealthStatus {
    if (p.managed) return 'managed'
    if (p.capabilities?.discoveryError) return 'broken'
    if (!p.lastDiscoveredAt) return 'degraded'
    const staleMs = Date.now() - new Date(p.lastDiscoveredAt).getTime()
    if (staleMs > 30 * 60 * 1000) return 'degraded'
    return 'healthy'
}

// ── Banner state ─────────────────────────────────────────────────────────────

type BannerState = 'working' | 'degraded' | 'no-config' | 'builtin-only'

function deriveBannerState(providers: ProviderInstance[]): { state: BannerState; model?: string; provider?: string; error?: string } {
    const userProviders = providers.filter(p => !p.managed && p.enabled)
    const managedProviders = providers.filter(p => p.managed && p.enabled)

    const healthyChat = userProviders.filter(p =>
        p.capabilities?.supportsChat &&
        !p.capabilities?.discoveryError &&
        p.lastDiscoveredAt
    ).sort((a, b) => (a.chatPreferenceOrder ?? a.preferenceOrder) - (b.chatPreferenceOrder ?? b.preferenceOrder))

    if (healthyChat.length > 0) {
        const top = healthyChat[0]!
        const model = top.selectedModel || top.capabilities.chatModels[0] || top.providerType
        return { state: 'working', model, provider: top.nickname }
    }

    if (userProviders.filter(p => p.capabilities?.supportsChat).length > 0) {
        const broken = userProviders.find(p => p.capabilities?.discoveryError)
        return { state: 'degraded', error: broken?.capabilities?.discoveryError || 'Provider not responding' }
    }

    if (managedProviders.length > 0) {
        return { state: 'builtin-only' }
    }

    return { state: 'no-config' }
}

// ── Provider catalog (rich metadata) ────────────────────────────────────────

interface ProviderCatalogEntry {
    type: string
    name: string
    icon: LucideIcon
    free: boolean
    pricing: string
    description: string
    bestFor: string
    keyPrefix: string
    getKeyUrl: string
    docsUrl: string
    sampleModels: string[]
    /** Optional hint shown below the API key input to clarify common confusion. */
    keyHint?: string
    /**
     * Controls which fields the connect form renders.
     * - 'api-key' (default): standard API key input only.
     * - 'base-url': base URL input only (no API key).
     * - 'base-url-and-key': base URL input + optional API key.
     */
    authType?: 'api-key' | 'base-url' | 'base-url-and-key'
}

const PROVIDER_CATALOG: ProviderCatalogEntry[] = [
    {
        type: 'cerebras',
        name: 'Cerebras',
        icon: Zap,
        free: true,
        pricing: 'Free tier: 60K tokens/min. No credit card required.',
        description: 'Fastest AI inference. Purpose-built hardware for LLM inference. Great for low-latency tasks.',
        bestFor: 'Speed-critical tasks, low-latency chat',
        keyPrefix: 'csk-',
        getKeyUrl: 'https://cloud.cerebras.ai',
        docsUrl: 'https://inference-docs.cerebras.ai/',
        sampleModels: ['llama3.1-8b', 'llama-3.3-70b', 'gpt-oss-120b'],
    },
    {
        type: 'groq',
        name: 'Groq',
        icon: Cloud,
        free: true,
        pricing: 'Free tier: 30K tokens/min on llama-4-scout.',
        description: 'Fast LPU-based inference. Good variety of open models.',
        bestFor: 'Fast inference of open-source models',
        keyPrefix: 'gsk_',
        getKeyUrl: 'https://console.groq.com/keys',
        docsUrl: 'https://console.groq.com/docs',
        sampleModels: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'openai/gpt-oss-120b'],
    },
    {
        type: 'deepseek',
        name: 'DeepSeek',
        icon: Brain,
        free: false,
        pricing: 'Pay-as-you-go. Typically <$1/month for most users.',
        description: 'State-of-the-art reasoning model at a fraction of the cost of OpenAI.',
        bestFor: 'Complex reasoning, coding, math',
        keyPrefix: 'sk-',
        getKeyUrl: 'https://platform.deepseek.com/api_keys',
        docsUrl: 'https://api-docs.deepseek.com/',
        sampleModels: ['deepseek-chat', 'deepseek-reasoner'],
    },
    {
        type: 'openai',
        name: 'OpenAI',
        icon: Sparkles,
        free: false,
        pricing: 'Pay-as-you-go. Starts at $0.15/M tokens (gpt-4o-mini).',
        description: 'The most widely-used AI provider. Reliable, well-documented.',
        bestFor: 'General purpose, production workloads',
        keyPrefix: 'sk-proj-',
        getKeyUrl: 'https://platform.openai.com/api-keys',
        docsUrl: 'https://platform.openai.com/docs',
        sampleModels: ['gpt-4o', 'gpt-4o-mini', 'o1', 'o3-mini'],
    },
    {
        type: 'anthropic',
        name: 'Anthropic',
        icon: MessageSquare,
        free: false,
        pricing: 'Pay-as-you-go. Claude Haiku starts at $1/M tokens.',
        description: 'Makers of Claude. Strong at reasoning, writing, and coding.',
        bestFor: 'Writing, coding, complex reasoning',
        keyPrefix: 'sk-ant-',
        getKeyUrl: 'https://console.anthropic.com/keys',
        docsUrl: 'https://docs.anthropic.com',
        sampleModels: ['claude-sonnet-4-5', 'claude-haiku-4-5', 'claude-opus-4-5'],
        keyHint: 'Claude Pro/Max subscriptions (claude.ai) do not include API access. You need a separate API key from console.anthropic.com with its own billing.',
    },
    {
        type: 'anthropic_subscription',
        name: 'Claude (Max subscription)',
        icon: MessageSquare,
        free: false,
        pricing: 'Uses your Claude Max subscription credits — no per-token API billing.',
        description: 'Run Claude on your existing Claude Max plan via an OAuth token. Coexists with a separate Anthropic API key.',
        bestFor: 'Using Claude Max credits instead of pay-as-you-go API billing',
        keyPrefix: 'sk-ant-oat01-',
        getKeyUrl: 'https://docs.claude.com/en/docs/claude-code/setup',
        docsUrl: 'https://docs.claude.com/en/docs/claude-code/setup',
        sampleModels: ['claude-sonnet-4-5', 'claude-haiku-4-5', 'claude-opus-4-5'],
        keyHint: 'Requires a Claude Max plan. In a terminal, run `claude setup-token` and paste the sk-ant-oat01-… token here. This is NOT a console.anthropic.com API key.',
    },
    {
        type: 'google',
        name: 'Google (Gemini)',
        icon: Globe,
        free: false,
        pricing: 'Free tier via Google AI Studio. Paid at $0.075/M tokens (Flash).',
        description: "Google's Gemini models. Large context windows, multimodal.",
        bestFor: 'Long context, multimodal tasks',
        keyPrefix: 'AIzaSy',
        getKeyUrl: 'https://aistudio.google.com/apikey',
        docsUrl: 'https://ai.google.dev/docs',
        sampleModels: ['gemini-2.5-flash', 'gemini-2.5-pro'],
    },
    {
        type: 'mistral',
        name: 'Mistral',
        icon: Wind,
        free: false,
        pricing: 'Pay-as-you-go. Mistral Small starts at $0.20/M tokens.',
        description: 'European AI company. Privacy-focused, strong open-source models.',
        bestFor: 'EU data residency, open models',
        keyPrefix: '',
        getKeyUrl: 'https://console.mistral.ai/api-keys',
        docsUrl: 'https://docs.mistral.ai',
        sampleModels: ['mistral-large-latest', 'mistral-small-latest'],
    },
    {
        type: 'xai',
        name: 'xAI (Grok)',
        icon: Bot,
        free: false,
        pricing: 'Pay-as-you-go. Grok models starting at $2/M tokens.',
        description: "Elon Musk's AI. Grok models with web search capability.",
        bestFor: 'Real-time information, X/Twitter data',
        keyPrefix: 'xai-',
        getKeyUrl: 'https://console.x.ai',
        docsUrl: 'https://docs.x.ai/api',
        sampleModels: ['grok-3', 'grok-3-mini'],
    },
    {
        type: 'openrouter',
        name: 'OpenRouter',
        icon: ArrowLeftRight,
        free: false,
        pricing: 'Pay-per-token. Single API key for 100+ models.',
        description: 'One API key, access to any model from any provider.',
        bestFor: 'Flexibility, testing multiple models',
        keyPrefix: 'sk-or-',
        getKeyUrl: 'https://openrouter.ai/keys',
        docsUrl: 'https://openrouter.ai/docs',
        sampleModels: ['Any model from any provider'],
    },
    {
        type: 'together',
        name: 'Together AI',
        icon: Users,
        free: false,
        pricing: 'Pay-as-you-go. Open models at competitive prices.',
        description: 'Fast inference for open-source models (Llama, Mixtral, etc.).',
        bestFor: 'Open-source models at scale',
        keyPrefix: '',
        getKeyUrl: 'https://api.together.xyz/settings/api-keys',
        docsUrl: 'https://docs.together.ai',
        sampleModels: ['meta-llama/Llama-3.3-70B-Instruct-Turbo'],
    },
    {
        type: 'fireworks',
        name: 'Fireworks AI',
        icon: Flame,
        free: false,
        pricing: 'Pay-as-you-go. Serverless inference for open models.',
        description: 'Fast, affordable serverless inference for open models.',
        bestFor: 'Production-ready open model hosting',
        keyPrefix: '',
        getKeyUrl: 'https://fireworks.ai/api-keys',
        docsUrl: 'https://docs.fireworks.ai',
        sampleModels: ['llama-v3p3-70b-instruct'],
    },
    {
        type: 'perplexity',
        name: 'Perplexity',
        icon: Search,
        free: false,
        pricing: 'Pay-as-you-go. Sonar models starting at $1/M tokens.',
        description: 'AI-powered web search and research. Grounded in real-time data.',
        bestFor: 'Research, current events, citations',
        keyPrefix: 'pplx-',
        getKeyUrl: 'https://www.perplexity.ai/settings/api',
        docsUrl: 'https://docs.perplexity.ai',
        sampleModels: ['sonar', 'sonar-pro'],
    },
    {
        type: 'cohere',
        name: 'Cohere',
        icon: BookOpen,
        free: false,
        pricing: 'Trial tier available. Pay-as-you-go after.',
        description: 'Enterprise-grade NLP. Strong at RAG, retrieval, classification.',
        bestFor: 'Enterprise RAG, text classification',
        keyPrefix: '',
        getKeyUrl: 'https://dashboard.cohere.com/api-keys',
        docsUrl: 'https://docs.cohere.com',
        sampleModels: ['command-a-03-2025', 'command-r-plus', 'command-r'],
    },
    {
        type: 'sambanova',
        name: 'SambaNova',
        icon: Cpu,
        free: false,
        pricing: 'Free tier available. Pay-as-you-go after.',
        description: 'Custom hardware for fast open-model inference.',
        bestFor: 'Fast inference at scale',
        keyPrefix: '',
        getKeyUrl: 'https://cloud.sambanova.ai/apis',
        docsUrl: 'https://docs.sambanova.ai',
        sampleModels: ['Meta-Llama-3.3-70B-Instruct', 'DeepSeek-V3-0324'],
    },
    {
        type: 'cloudflare',
        name: 'Cloudflare Workers AI',
        icon: Cloud,
        free: false,
        pricing: 'Pay-as-you-go. First 10K requests free daily.',
        description: "Run open models on Cloudflare's global network. Edge inference.",
        bestFor: 'Edge inference, low latency globally',
        keyPrefix: '',
        getKeyUrl: 'https://dash.cloudflare.com/profile/api-tokens',
        docsUrl: 'https://developers.cloudflare.com/workers-ai/',
        sampleModels: ['@cf/meta/llama-3.3-70b-instruct-fp8-fast'],
    },
    {
        type: 'ollama',
        name: 'Ollama',
        icon: Brain,
        free: true,
        pricing: 'Free. Runs on your own hardware.',
        description: 'Run open-source models locally. Connect to your Ollama instance for private, zero-cost inference.',
        bestFor: 'Privacy, zero-cost local inference',
        keyPrefix: '',
        getKeyUrl: 'https://ollama.com/download',
        docsUrl: 'https://ollama.com',
        sampleModels: ['llama3.2', 'mistral', 'codellama', 'gemma2'],
        keyHint: 'No API key needed. Enter the URL of your Ollama server (default: http://localhost:11434).',
        authType: 'base-url',
    },
    {
        type: 'ollama_cloud',
        name: 'Ollama Cloud',
        icon: Cloud,
        free: false,
        pricing: 'Depends on Ollama Cloud plan.',
        description: 'Remote Ollama instance. Connect to a cloud-hosted or team-shared Ollama server.',
        bestFor: 'Shared/remote Ollama deployments',
        keyPrefix: '',
        getKeyUrl: 'https://ollama.com/download',
        docsUrl: 'https://ollama.com',
        sampleModels: ['gpt-oss:20b-cloud', 'llama3.2'],
        keyHint: 'Enter the API key for your Ollama Cloud account. Get one at ollama.com/settings/keys.',
        authType: 'api-key',
    },
    {
        type: 'fal',
        name: 'fal.ai',
        icon: Sparkles,
        free: false,
        pricing: 'Pay-as-you-go. Image generation from $0.003/image (FLUX Schnell).',
        description: 'AI media generation platform. 1000+ models for image, video, audio, and 3D generation.',
        bestFor: 'Image generation, video generation, media AI',
        keyPrefix: '',
        getKeyUrl: 'https://fal.ai/dashboard/keys',
        docsUrl: 'https://fal.ai/docs',
        sampleModels: ['fal-ai/flux/schnell', 'fal-ai/flux/dev', 'fal-ai/flux-pro/v1.1', 'fal-ai/stable-diffusion-v35', 'fal-ai/recraft/v4/pro/text-to-image', 'bytedance/seedance-2.0/image-to-video', 'bytedance/seedance-2.0/text-to-video'],
        keyHint: 'fal.ai is an image/video generation provider. Chat/text generation is not supported.',
    },
]

function catalogFor(type: string): ProviderCatalogEntry | null {
    return PROVIDER_CATALOG.find(p => p.type === type) ?? null
}

// ── Main page ────────────────────────────────────────────────────────────────

const FILTER_KEYS = ['status', 'pricing'] as const

export default function ProvidersPage() {
    const [providers, setProviders] = useState<ProviderInstance[]>([])
    const [loading, setLoading] = useState(true)
    const [selectedType, setSelectedType] = useState<string | null>(null)

    // Connect-flow state (for unconnected providers)
    const [apiKeyInput, setApiKeyInput] = useState('')
    const [baseUrlInput, setBaseUrlInput] = useState('')
    const [connecting, setConnecting] = useState(false)
    const [connectError, setConnectError] = useState<string | null>(null)

    // Remove confirmation
    const [confirmRemove, setConfirmRemove] = useState(false)
    const [removing, setRemoving] = useState(false)

    // Key rotation (for connected providers)
    const [showRotateKey, setShowRotateKey] = useState(false)
    const [rotateKeyInput, setRotateKeyInput] = useState('')
    const [rotatingKey, setRotatingKey] = useState(false)

    // Model change saving
    const [savingModel, setSavingModel] = useState(false)

    // Per-instance model-compat re-validation state (instanceId → in-flight)
    const [revalidating, setRevalidating] = useState<Record<string, boolean>>({})

    // Test state — per instance
    const [testing, setTesting] = useState(false)
    const [testResult, setTestResult] = useState<{ message: string; ok: boolean; errorCode?: string } | null>(null)

    // Banner test state
    const [bannerTestResult, setBannerTestResult] = useState<{ message: string; ok: boolean; errorCode?: string; providerType?: string } | null>(null)
    const [bannerTesting, setBannerTesting] = useState(false)

    // Live model discovery state (for the connect flow).
    // `null` = not yet discovered (UI shows hardcoded catalog fallback).
    // `[]`   = discovered but the API key's tier has zero models.
    const [discoveredModels, setDiscoveredModels] = useState<string[] | null>(null)
    const [discovering, setDiscovering] = useState(false)
    const [discoveryFailed, setDiscoveryFailed] = useState(false)

    const initialSelectionMade = useRef(false)

    const WS_ID = useWorkspaceId()
    const API_BASE = typeof window !== 'undefined' ? '' : (process.env.INTERNAL_API_URL || 'http://localhost:3001')

    const lf = useListFilter(FILTER_KEYS, 'default')
    const { search, filterValues } = lf

    const providersKey = WS_ID ? `${API_BASE}/api/v1/workspaces/${WS_ID}/providers` : null
    const { data: providersData, mutate: refetchProviders } = useSWR<{ providers?: ProviderInstance[]; items?: ProviderInstance[] }>(
        providersKey,
        jsonFetcher,
        { refreshInterval: 60_000, revalidateOnFocus: true, dedupingInterval: 10_000 },
    )

    useEffect(() => {
        if (!WS_ID) { setLoading(false); return }
        if (providersData) {
            const list = providersData.providers ?? providersData.items ?? []
            setProviders(list.map(p => ({
                ...p,
                capabilities: p.capabilities ?? {
                    supportsChat: false,
                    supportsEmbeddings: false,
                    chatModels: [],
                    embeddingModels: [],
                    discoveryError: null,
                },
            })))
            setLoading(false)
        }
    }, [providersData, WS_ID])

    const loadProviders = useCallback(async () => {
        await refetchProviders()
    }, [refetchProviders])

    // Initial selection: honour ?highlight=<type> deep-link, else first connected, else first catalog entry
    useEffect(() => {
        if (initialSelectionMade.current || loading) return
        const highlightType = typeof window !== 'undefined'
            ? new URLSearchParams(window.location.search).get('highlight')
            : null
        if (highlightType && PROVIDER_CATALOG.some(p => p.type === highlightType)) {
            setSelectedType(highlightType)
        } else {
            const userProviders = providers.filter(p => !p.managed && p.enabled)
            const firstConnected = userProviders.sort((a, b) =>
                (a.chatPreferenceOrder ?? a.preferenceOrder) - (b.chatPreferenceOrder ?? b.preferenceOrder)
            )[0]
            if (firstConnected && PROVIDER_CATALOG.some(p => p.type === firstConnected.providerType)) {
                setSelectedType(firstConnected.providerType)
            } else {
                setSelectedType(PROVIDER_CATALOG[0]!.type)
            }
        }
        initialSelectionMade.current = true
    }, [loading, providers])

    // Reset connect form when selection changes
    useEffect(() => {
        setApiKeyInput('')
        setBaseUrlInput('')
        setConnectError(null)
        setConfirmRemove(false)
        setShowRotateKey(false)
        setRotateKeyInput('')
        setTestResult(null)
        setDiscoveredModels(null)
        setDiscoveryFailed(false)
        setDiscovering(false)
    }, [selectedType])

    // Debounced live-model discovery when the user types an API key for an
    // unconnected provider. We want the "AVAILABLE MODELS" pill list below
    // to reflect what the specific key actually has access to — not a
    // hardcoded tier-agnostic list. Soft-fails on every edge.
    const selectedCatalogForDiscovery = selectedType ? catalogFor(selectedType) : null
    const authTypeForDiscovery = selectedCatalogForDiscovery?.authType ?? 'api-key'

    useEffect(() => {
        if (!selectedType || !WS_ID) return
        const key = apiKeyInput.trim()
        const url = baseUrlInput.trim()

        // For base-url-only providers, trigger discovery once a URL is entered.
        // For api-key providers, require a plausibly-complete key (≥20 chars).
        // For base-url-and-key providers, need a URL at minimum.
        const hasInput = authTypeForDiscovery === 'base-url'
            ? url.length >= 10
            : authTypeForDiscovery === 'base-url-and-key'
                ? url.length >= 10
                : key.length >= 20

        if (!hasInput) {
            setDiscoveredModels(null)
            setDiscoveryFailed(false)
            return
        }
        let cancelled = false
        setDiscovering(true)
        const timer = setTimeout(async () => {
            try {
                const body: Record<string, string> = { providerType: selectedType }
                if (key) body.apiKey = key
                if (url) body.baseUrl = url
                const res = await fetch(`${API_BASE}/api/v1/workspaces/${WS_ID}/providers/discover-models`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                })
                const data = await res.json() as
                    | { ok: true; models: { id: string }[] }
                    | { ok: false; error: string; fallbackModels: string[] }
                if (cancelled) return
                if (data.ok) {
                    setDiscoveredModels(data.models.map(m => m.id))
                    setDiscoveryFailed(false)
                } else {
                    setDiscoveredModels(data.fallbackModels?.length ? data.fallbackModels : null)
                    setDiscoveryFailed(!data.fallbackModels?.length)
                }
            } catch {
                if (!cancelled) {
                    setDiscoveredModels(null)
                    setDiscoveryFailed(true)
                }
            } finally {
                if (!cancelled) setDiscovering(false)
            }
        }, 500)
        return () => {
            cancelled = true
            clearTimeout(timer)
            setDiscovering(false)
        }
    }, [apiKeyInput, baseUrlInput, selectedType, WS_ID, API_BASE, authTypeForDiscovery])

    // ── Derived state ───────────────────────────────────────────────────────

    const userProviders = useMemo(
        () => providers
            .filter(p => !p.managed && p.enabled)
            .sort((a, b) => (a.chatPreferenceOrder ?? a.preferenceOrder) - (b.chatPreferenceOrder ?? b.preferenceOrder)),
        [providers]
    )

    const providerByType = useMemo(() => {
        const map = new Map<string, ProviderInstance>()
        for (const p of userProviders) map.set(p.providerType, p)
        return map
    }, [userProviders])

    const chainPositionByType = useMemo(() => {
        const map = new Map<string, number>()
        userProviders.forEach((p, i) => map.set(p.providerType, i + 1))
        return map
    }, [userProviders])

    async function handleReorder(orderedIds: string[]) {
        const previous = providers
        const orderMap = new Map(orderedIds.map((id, idx) => [id, idx + 1]))
        setProviders(prev =>
            prev.map(p =>
                orderMap.has(p.id)
                    ? { ...p, chatPreferenceOrder: orderMap.get(p.id)!, preferenceOrder: orderMap.get(p.id)! }
                    : p,
            ),
        )
        try {
            const res = await fetch(`${API_BASE}/api/v1/workspaces/${WS_ID}/providers/reorder`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ orderedIds, capability: 'chat' }),
            })
            if (!res.ok) throw new Error('reorder failed')
            void loadProviders()
        } catch {
            setProviders(previous)
            toast('Failed to reorder.')
        }
    }

    function moveInChain(providerType: string, direction: -1 | 1) {
        const ids = userProviders.map(p => p.id)
        const target = providerByType.get(providerType)
        if (!target) return
        const index = ids.indexOf(target.id)
        const next = index + direction
        if (index < 0 || next < 0 || next >= ids.length) return
        ;[ids[index], ids[next]] = [ids[next]!, ids[index]!]
        void handleReorder(ids)
    }

    async function handleModelChange(providerId: string, model: string) {
        setSavingModel(true)
        try {
            await fetch(`${API_BASE}/api/v1/workspaces/${WS_ID}/providers/${providerId}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ selectedModel: model }),
            })
            await loadProviders()
        } catch { /* non-fatal */ }
        finally { setSavingModel(false) }
    }

    /**
     * Re-trigger the backend pre-flight model-compat check for an existing
     * instance. The backend runs the synthetic generateObject probe on every
     * PATCH, so a no-op PATCH (re-sending the current selectedModel) is
     * sufficient to refresh `modelCompatStatus` + `modelCompatValidatedAt`.
     */
    async function handleRevalidateCompat(instance: ProviderInstance) {
        setRevalidating(prev => ({ ...prev, [instance.id]: true }))
        try {
            const body: Record<string, string | null> = {}
            // Re-PATCH the current selectedModel (or first available chat
            // model) to force the compat probe to re-run.
            const model = instance.selectedModel
                ?? instance.capabilities?.chatModels?.[0]
                ?? null
            if (model) body.selectedModel = model
            await fetch(`${API_BASE}/api/v1/workspaces/${WS_ID}/providers/${instance.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            })
            await loadProviders()
        } catch {
            toast('Failed to re-test model compatibility.')
        } finally {
            setRevalidating(prev => ({ ...prev, [instance.id]: false }))
        }
    }

    async function handleTest(instance: ProviderInstance) {
        setTesting(true)
        setTestResult(null)
        try {
            const body: Record<string, string> = { providerType: instance.providerType, instanceId: instance.id }
            if (instance.endpointUrl) body.endpointUrl = instance.endpointUrl
            const res = await fetch(`${API_BASE}/api/v1/workspaces/${WS_ID}/providers/test`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            })
            const data = await res.json()
            if (!res.ok) {
                setTestResult({ message: extractErrorMessage(data.error || data), ok: false, errorCode: data.errorCode })
            } else if (data.ok) {
                setTestResult({ message: data.message || 'Connection OK', ok: true })
            } else {
                setTestResult({ message: extractErrorMessage(data.error || data.message || data), ok: false, errorCode: data.errorCode })
            }
        } catch {
            setTestResult({ message: 'Could not reach the server.', ok: false, errorCode: 'network' })
        } finally {
            setTesting(false)
        }
    }

    async function handleConnect(catalog: ProviderCatalogEntry) {
        const authType = catalog.authType ?? 'api-key'
        const key = apiKeyInput.trim()
        const url = baseUrlInput.trim()

        // Validate: base-url types need a URL; api-key types need a key.
        if (authType === 'base-url' && !url) return
        if (authType === 'base-url-and-key' && !url) return
        if (authType === 'api-key' && !key) return

        setConnecting(true)
        setConnectError(null)
        try {
            const testBody: Record<string, string> = { providerType: catalog.type }
            if (key) testBody.apiKey = key
            if (url) testBody.baseUrl = url
            const testRes = await fetch(`${API_BASE}/api/v1/workspaces/${WS_ID}/providers/test`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(testBody),
            })
            const testData = await testRes.json()
            if (!testData.ok) {
                setConnectError(extractErrorMessage(testData.error) || 'Connection test failed. Check your configuration.')
                setConnecting(false)
                return
            }

            const saveBody: Record<string, string> = {
                nickname: catalog.name,
                providerType: catalog.type,
            }
            if (key) saveBody.apiKey = key
            if (url) saveBody.endpointUrl = url
            const saveRes = await fetch(`${API_BASE}/api/v1/workspaces/${WS_ID}/providers`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(saveBody),
            })
            if (!saveRes.ok) {
                const saveData = await saveRes.json()
                setConnectError(extractErrorMessage(saveData.error) || 'Failed to save.')
                setConnecting(false)
                return
            }

            toast.success(`Connected ${catalog.name}`)
            setApiKeyInput('')
            setBaseUrlInput('')
            await loadProviders()
        } catch {
            setConnectError('Something went wrong. Try again in a moment.')
        } finally {
            setConnecting(false)
        }
    }

    async function handleRemove(instance: ProviderInstance) {
        setRemoving(true)
        try {
            await fetch(`${API_BASE}/api/v1/workspaces/${WS_ID}/providers/${instance.id}`, { method: 'DELETE' })
            toast(`Removed ${instance.nickname}`)
            setConfirmRemove(false)
            await loadProviders()
        } catch { toast('Failed to remove provider.') }
        finally { setRemoving(false) }
    }

    // Rotate the API key in place — PATCH { apiKey } re-encrypts server-side,
    // so key rotation no longer requires remove + re-add.
    async function handleRotateKey(instance: ProviderInstance) {
        const key = rotateKeyInput.trim()
        if (!key) return
        setRotatingKey(true)
        try {
            const res = await fetch(`${API_BASE}/api/v1/workspaces/${WS_ID}/providers/${instance.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ apiKey: key }),
            })
            const data = await res.json()
            if (!res.ok) {
                toast(extractErrorMessage(data.error) || 'Failed to update the key.')
                return
            }
            if (data.warning) toast(String(data.warning))
            else toast.success('API key updated')
            setShowRotateKey(false)
            setRotateKeyInput('')
            await loadProviders()
        } catch { toast('Failed to update the key.') }
        finally { setRotatingKey(false) }
    }

    // Status banner test (top of chain)
    async function handleBannerTest() {
        const userChat = userProviders.filter(p => p.capabilities?.supportsChat)
        const top = userChat[0]
        if (!top) return
        setBannerTesting(true)
        setBannerTestResult(null)
        try {
            const body: Record<string, string> = { providerType: top.providerType, instanceId: top.id }
            if (top.endpointUrl) body.endpointUrl = top.endpointUrl
            const res = await fetch(`${API_BASE}/api/v1/workspaces/${WS_ID}/providers/test`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            })
            const data = await res.json()
            if (!res.ok) {
                setBannerTestResult({ message: extractErrorMessage(data.error || data), ok: false, errorCode: data.errorCode, providerType: top.providerType })
            } else if (data.ok) {
                setBannerTestResult({ message: 'Connection OK', ok: true })
            } else {
                setBannerTestResult({ message: extractErrorMessage(data.error || data.message || data), ok: false, errorCode: data.errorCode, providerType: top.providerType })
            }
        } catch {
            setBannerTestResult({ message: 'Could not reach the server.', ok: false, errorCode: 'network' })
        } finally {
            setBannerTesting(false)
        }
    }

    // ── Status pill data ────────────────────────────────────────────────────
    const { state: bannerState, model: bannerModel, provider: bannerProvider, error: bannerError } = deriveBannerState(providers)
    const statusOk = bannerState === 'working' || bannerState === 'builtin-only'

    let statusLabel: string
    if (bannerState === 'working') statusLabel = `Active — ${bannerProvider} · ${bannerModel}`
    else if (bannerState === 'builtin-only') statusLabel = 'Active — built-in model'
    else if (bannerState === 'degraded') statusLabel = `Connection issue — ${bannerError}`
    else statusLabel = 'No AI model connected'

    // ── Filter/sort catalog ─────────────────────────────────────────────────

    const filtered = useMemo(() => {
        const s = search.toLowerCase()
        return PROVIDER_CATALOG.filter((c) => {
            const connected = providerByType.has(c.type)
            const matchStatus = (() => {
                if (!filterValues.status) return true
                if (filterValues.status === 'connected') return connected
                if (filterValues.status === 'unconnected') return !connected
                return true
            })()
            const matchPricing = (() => {
                if (!filterValues.pricing) return true
                if (filterValues.pricing === 'free') return c.free
                if (filterValues.pricing === 'paid') return !c.free
                return true
            })()
            const matchSearch = !s ||
                c.name.toLowerCase().includes(s) ||
                c.description.toLowerCase().includes(s) ||
                c.bestFor.toLowerCase().includes(s) ||
                c.type.toLowerCase().includes(s)
            return matchStatus && matchPricing && matchSearch
        })
    }, [search, filterValues, providerByType])

    const sorted = useMemo(() => {
        const copy = [...filtered]
        if (lf.sort === 'name_asc') return copy.sort((a, b) => a.name.localeCompare(b.name))
        if (lf.sort === 'name_desc') return copy.sort((a, b) => b.name.localeCompare(a.name))
        return copy.sort((a, b) => {
            const aPos = chainPositionByType.get(a.type) ?? Infinity
            const bPos = chainPositionByType.get(b.type) ?? Infinity
            if (aPos !== bPos) return aPos - bPos
            if (a.free !== b.free) return a.free ? -1 : 1
            return a.name.localeCompare(b.name)
        })
    }, [filtered, lf.sort, chainPositionByType])

    const dimensions: FilterDimension[] = [
        {
            key: 'status',
            label: 'Status',
            options: [
                { value: 'connected', label: 'Connected', dimmed: userProviders.length === 0 },
                { value: 'unconnected', label: 'Not connected' },
            ],
        },
        {
            key: 'pricing',
            label: 'Pricing',
            options: [
                { value: 'free', label: 'Free tier' },
                { value: 'paid', label: 'Paid' },
            ],
        },
    ]

    // ── Chain cards (top strip) ─────────────────────────────────────────────
    const chainCards: ChainCardData[] = useMemo(() => {
        return userProviders.map((p) => {
            const catalog = catalogFor(p.providerType)
            const h = getProviderHealth(p)
            const chainHealth: ChainHealth = h === 'healthy' ? 'healthy'
                : h === 'broken' ? 'broken'
                : 'degraded'
            return {
                id: p.id,
                providerType: p.providerType,
                nickname: catalog?.name ?? p.nickname,
                model: p.selectedModel
                    || p.capabilities?.chatModels?.[0]
                    || (p.endpointUrl ? 'self-hosted' : p.providerType),
                icon: catalog?.icon ?? BrainCircuit,
                free: catalog?.free ?? false,
                health: chainHealth,
            }
        })
    }, [userProviders])

    const activeProviderId: string | null = useMemo(() => {
        const firstHealthy = userProviders.find(p =>
            p.capabilities?.supportsChat
            && !p.capabilities?.discoveryError
            && p.lastDiscoveredAt,
        )
        return firstHealthy?.id ?? null
    }, [userProviders])

    function scrollToAddProvider() {
        const firstUnconnected = PROVIDER_CATALOG.find(c => !providerByType.has(c.type))
        if (firstUnconnected) setSelectedType(firstUnconnected.type)
    }

    const statusPill = (
        <ProviderChain
            cards={chainCards}
            activeProviderId={activeProviderId}
            selectedProviderType={selectedType}
            onReorder={(ids) => void handleReorder(ids)}
            onCardClick={(type) => setSelectedType(type)}
            onAdd={scrollToAddProvider}
            onTest={() => void handleBannerTest()}
            testing={bannerTesting}
            bannerLabel={statusLabel}
            bannerOk={statusOk}
            testResult={bannerTestResult}
        />
    )

    // ── Detail pane ─────────────────────────────────────────────────────────
    const selectedCatalog = selectedType ? catalogFor(selectedType) : null
    const selectedInstance = selectedType ? providerByType.get(selectedType) : undefined
    const isConnected = !!selectedInstance

    const detail = selectedCatalog ? (
        <>
            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 p-5 border-b border-border">
                <div className="flex items-start gap-3 min-w-0">
                    <div className="h-10 w-10 mt-1 sm:mt-0 rounded-sm bg-surface-2 flex items-center justify-center shrink-0">
                        <selectedCatalog.icon className="h-5 w-5 text-text-secondary" />
                    </div>
                    <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                            <h2 className="text-base font-medium text-text-primary">{selectedCatalog.name}</h2>
                            {selectedCatalog.free && (
                                <span className="text-[11px] font-medium px-1.5 py-0.5 rounded uppercase tracking-wide bg-signal-green/15 text-emerald-400 border border-signal-green/30">
                                    Free tier
                                </span>
                            )}
                            {!selectedCatalog.free && (
                                <span className="text-[11px] font-medium px-1.5 py-0.5 rounded uppercase tracking-wide bg-surface-2/40 text-text-secondary border border-border">
                                    Paid
                                </span>
                            )}
                            {isConnected && selectedInstance && (
                                <span className="inline-flex items-center gap-1 rounded-sm border border-azure/30 bg-azure/15 px-1.5 py-0.5 text-[11px] font-medium text-azure">
                                    <CheckCircle2 className="h-2.5 w-2.5" />
                                    Chain #{chainPositionByType.get(selectedCatalog.type)}
                                </span>
                            )}
                        </div>
                        <p className="text-xs text-text-muted mt-0.5 truncate">{selectedCatalog.pricing}</p>
                    </div>
                </div>
                <div className="flex items-center gap-2 shrink-0 w-full sm:w-auto flex-wrap">
                    {isConnected && selectedInstance && (
                        <button
                            onClick={() => void handleTest(selectedInstance)}
                            disabled={testing}
                            className="flex items-center justify-center gap-1 rounded-sm border border-border bg-surface-2 px-3 py-2 sm:px-2.5 sm:py-1.5 text-xs text-text-secondary hover:border-border hover:text-text-primary transition-colors disabled:opacity-50 min-h-[44px] sm:min-h-0"
                        >
                            {testing ? <Loader2 className="h-3 w-3 animate-spin" />
                                : testResult?.ok ? <CheckCircle2 className="h-3 w-3 text-azure" />
                                : testResult && !testResult.ok ? <AlertCircle className="h-3 w-3 text-red" />
                                : <RefreshCw className="h-3 w-3" />}
                            Test
                        </button>
                    )}
                    <a
                        href={selectedCatalog.docsUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center justify-center gap-1 rounded-sm border border-border bg-surface-2 px-3 py-2 sm:px-2.5 sm:py-1.5 text-xs text-text-secondary hover:border-border hover:text-text-primary transition-colors min-h-[44px] sm:min-h-0"
                    >
                        <ExternalLink className="h-3 w-3" />
                        Docs
                    </a>
                    {isConnected && selectedInstance ? (
                        confirmRemove ? (
                            <>
                                <button
                                    onClick={() => void handleRemove(selectedInstance)}
                                    disabled={removing}
                                    className="flex items-center justify-center gap-1.5 rounded-sm border border-red-800/50 bg-red-dim px-3 py-2 sm:px-2.5 sm:py-1.5 text-xs text-red hover:border-red-700 hover:bg-red-dim/50 transition-colors disabled:opacity-50 min-h-[44px] sm:min-h-0 whitespace-nowrap"
                                >
                                    <Trash2 className="h-3 w-3" />
                                    {removing ? 'Removing…' : 'Confirm'}
                                </button>
                                <button
                                    onClick={() => setConfirmRemove(false)}
                                    className="text-xs text-text-muted hover:text-text-primary px-2"
                                >
                                    Cancel
                                </button>
                            </>
                        ) : (
                            <button
                                onClick={() => setConfirmRemove(true)}
                                className="flex items-center justify-center gap-1.5 rounded-sm border border-red-800/50 bg-red-dim px-3 py-2 sm:px-2.5 sm:py-1.5 text-xs text-red hover:border-red-700 hover:bg-red-dim/50 transition-colors min-h-[44px] sm:min-h-0 whitespace-nowrap"
                            >
                                <Trash2 className="h-3 w-3" />
                                Remove
                            </button>
                        )
                    ) : null}
                </div>
            </div>

            <div className="flex-1 overflow-y-auto p-5 flex flex-col gap-5">
                <div>
                    <p className="text-sm text-text-secondary leading-relaxed">{selectedCatalog.description}</p>
                    <p className="text-xs text-text-muted mt-2">
                        <span className="font-medium text-text-secondary">Best for:</span> {selectedCatalog.bestFor}
                    </p>
                </div>

                {/* Test result — shown prominently right after description */}
                {testResult && (
                    <div className={`rounded-sm border px-4 py-3 ${testResult.ok ? 'border-signal-green/40 bg-signal-green/10' : 'border-red-500/40 bg-red-500/10'}`}>
                        <div className="flex items-start gap-2">
                            {testResult.ok
                                ? <CheckCircle2 className="h-4 w-4 text-emerald-400 mt-0.5 shrink-0" />
                                : <AlertCircle className="h-4 w-4 text-red-400 mt-0.5 shrink-0" />}
                            <div>
                                <p className={`text-sm font-medium ${testResult.ok ? 'text-emerald-300' : 'text-red-300'}`}>
                                    {testResult.ok ? 'Connected' : 'Connection failed'}
                                </p>
                                <p className={`text-xs mt-0.5 ${testResult.ok ? 'text-emerald-400/70' : 'text-red-400/70'}`}>
                                    {testResult.message}
                                </p>
                                {!testResult.ok && selectedCatalog.getKeyUrl && (
                                    <a href={selectedCatalog.getKeyUrl} target="_blank" rel="noopener noreferrer" className="mt-1.5 inline-block text-xs text-azure hover:text-azure/80 transition-colors">
                                        Get a new API key &rarr;
                                    </a>
                                )}
                            </div>
                        </div>
                    </div>
                )}

                {/* Model-compat status — BYOK path only. Hidden on managed-default
                    Cloud (gated upstream by getDeploymentMode + hasUserProvider). */}
                {isConnected && selectedInstance && !selectedInstance.managed
                    && shouldShowBYOKModelCompat(getDeploymentMode(), userProviders.length > 0)
                    && (
                    <ModelCompatBadge
                        status={selectedInstance.modelCompatStatus}
                        validatedAt={selectedInstance.modelCompatValidatedAt}
                        onRevalidate={() => void handleRevalidateCompat(selectedInstance)}
                        revalidating={revalidating[selectedInstance.id] === true}
                        hideWhenNative
                    />
                )}

                {isConnected && selectedInstance && (
                    <>
                        {(() => {
                            // Build model list for the dropdown: chat providers use chatModels,
                            // non-chat providers (fal.ai, voyage, etc.) fall back to discovered
                            // models or hardcoded catalog sampleModels.
                            const isChatProvider = selectedInstance.capabilities.chatModels.length > 0
                            const nonChatModels = !isChatProvider && !selectedInstance.capabilities.supportsChat
                                ? (discoveredModels ?? selectedCatalog.sampleModels)
                                : []
                            const modelOptions = isChatProvider
                                ? selectedInstance.capabilities.chatModels
                                : nonChatModels
                            if (modelOptions.length === 0) return null
                            return (
                                <div className="flex flex-col gap-1.5">
                                    <div className="flex items-center justify-between">
                                        <label className="text-xs font-medium uppercase tracking-wider text-text-muted">Active model</label>
                                        {savingModel && <span className="text-[10px] text-azure animate-pulse">Saving...</span>}
                                    </div>
                                    <select
                                        aria-label="Active model"
                                        value={selectedInstance.selectedModel || modelOptions[0]}
                                        onChange={(e) => void handleModelChange(selectedInstance.id, e.target.value)}
                                        className="w-full rounded-sm border border-border bg-surface-1 px-3 py-2 text-sm text-text-primary font-mono focus:border-azure focus-ring"
                                    >
                                        {modelOptions.map((m) => (
                                            <option key={m} value={m}>{m}</option>
                                        ))}
                                    </select>
                                </div>
                            )
                        })()}

                        {userProviders.length > 1 && (
                            <div className="flex flex-col gap-1.5">
                                <label className="text-xs font-medium uppercase tracking-wider text-text-muted">Chain position</label>
                                <div className="flex items-center gap-2 rounded-sm border border-border bg-surface-1/60 px-3 py-2">
                                    <span className="text-sm text-text-secondary flex-1">
                                        Position <span className="font-medium text-text-primary">{chainPositionByType.get(selectedCatalog.type)}</span> of {userProviders.length}
                                    </span>
                                    <button
                                        onClick={() => moveInChain(selectedCatalog.type, -1)}
                                        disabled={(chainPositionByType.get(selectedCatalog.type) ?? 1) === 1}
                                        className="flex items-center gap-1 rounded border border-border bg-surface-2 px-2 py-1 text-xs text-text-secondary hover:text-text-primary disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                                    >
                                        <ArrowUp className="h-3 w-3" />
                                        Up
                                    </button>
                                    <button
                                        onClick={() => moveInChain(selectedCatalog.type, 1)}
                                        disabled={(chainPositionByType.get(selectedCatalog.type) ?? userProviders.length) === userProviders.length}
                                        className="flex items-center gap-1 rounded border border-border bg-surface-2 px-2 py-1 text-xs text-text-secondary hover:text-text-primary disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                                    >
                                        <ArrowDown className="h-3 w-3" />
                                        Down
                                    </button>
                                </div>
                                <p className="text-[11px] text-text-muted">
                                    Plexo tries providers from top to bottom. Position 1 is tried first.
                                </p>
                            </div>
                        )}

                        {!selectedInstance.endpointUrl && (
                            <div className="flex flex-col gap-1.5">
                                <label className="text-xs font-medium uppercase tracking-wider text-text-muted">API key</label>
                                <div className="rounded-sm border border-border bg-surface-1/60 px-3 py-2 flex items-center justify-between gap-3">
                                    <span className="font-mono text-xs text-text-muted">
                                        {selectedCatalog.keyPrefix || ''}••••••••
                                    </span>
                                    <a
                                        href={selectedCatalog.getKeyUrl}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="text-[11px] text-azure hover:text-azure/80 transition-colors flex items-center gap-1"
                                    >
                                        Manage keys <ExternalLink className="h-2.5 w-2.5" />
                                    </a>
                                </div>
                                {!showRotateKey ? (
                                    <button
                                        onClick={() => setShowRotateKey(true)}
                                        className="self-start text-[11px] text-azure hover:text-azure/80 transition-colors"
                                    >
                                        Replace key…
                                    </button>
                                ) : (
                                    <div className="flex flex-col gap-2">
                                        <input
                                            type="password"
                                            value={rotateKeyInput}
                                            onChange={(e) => setRotateKeyInput(e.target.value)}
                                            placeholder={selectedCatalog.keyPrefix ? `${selectedCatalog.keyPrefix}...` : 'New API key'}
                                            autoComplete="off"
                                            className="min-h-[44px] rounded-sm border border-border bg-surface-1 px-3 py-2 text-[16px] sm:text-sm text-text-primary font-mono placeholder:text-text-muted focus:border-azure focus-ring"
                                        />
                                        <div className="flex items-center gap-2">
                                            <button
                                                onClick={() => void handleRotateKey(selectedInstance)}
                                                disabled={rotatingKey || !rotateKeyInput.trim()}
                                                className="flex items-center justify-center gap-1.5 rounded-sm bg-azure px-3 py-1.5 text-xs font-medium text-text-primary hover:bg-azure/90 transition-colors disabled:opacity-50"
                                            >
                                                {rotatingKey && <Loader2 className="h-3 w-3 animate-spin" />}
                                                {rotatingKey ? 'Saving…' : 'Save key'}
                                            </button>
                                            <button
                                                onClick={() => { setShowRotateKey(false); setRotateKeyInput('') }}
                                                disabled={rotatingKey}
                                                className="rounded-sm border border-border bg-surface-2 px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary transition-colors disabled:opacity-50"
                                            >
                                                Cancel
                                            </button>
                                        </div>
                                    </div>
                                )}
                            </div>
                        )}

                        {selectedInstance.endpointUrl && (
                            <div className="flex flex-col gap-1.5">
                                <label className="text-xs font-medium uppercase tracking-wider text-text-muted">Endpoint</label>
                                <div className="rounded-sm border border-border bg-surface-1/60 px-3 py-2">
                                    <span className="font-mono text-xs text-text-secondary">{selectedInstance.endpointUrl}</span>
                                </div>
                            </div>
                        )}

                        {/* Test result now shown above, near the top of the detail pane */}
                    </>
                )}

                {!isConnected && (
                    <>
                        {selectedCatalog.free && (
                            <div className="rounded-sm border border-emerald-800/40 bg-emerald-900/10 px-3 py-3">
                                <p className="text-xs font-medium text-emerald-400 mb-1">Free tier available</p>
                                <p className="text-[11px] text-emerald-400/80">{selectedCatalog.pricing}</p>
                            </div>
                        )}

                        <div className="flex flex-col gap-2">
                            {/* Base URL input — shown for base-url and base-url-and-key auth types */}
                            {(selectedCatalog.authType === 'base-url' || selectedCatalog.authType === 'base-url-and-key') && (
                                <div className="flex flex-col gap-1.5 mb-1">
                                    <label className="text-xs font-medium uppercase tracking-wider text-text-muted">
                                        Server URL
                                    </label>
                                    <input
                                        type="url"
                                        value={baseUrlInput}
                                        onChange={(e) => { setBaseUrlInput(e.target.value); setConnectError(null) }}
                                        placeholder="http://localhost:11434"
                                        autoComplete="off"
                                        className="min-h-[44px] rounded-sm border border-border bg-surface-1 px-3 py-2 text-[16px] sm:text-sm text-text-primary font-mono placeholder:text-text-muted focus:border-azure focus-ring"
                                    />
                                </div>
                            )}

                            {/* API key input — shown for api-key (default) and base-url-and-key auth types */}
                            {(selectedCatalog.authType ?? 'api-key') !== 'base-url' && (
                                <div className="flex flex-col gap-1.5">
                                    <label className="text-xs font-medium uppercase tracking-wider text-text-muted">
                                        {selectedCatalog.authType === 'base-url-and-key' ? 'API key (optional)' : 'API key'}
                                    </label>
                                    <input
                                        type="password"
                                        value={apiKeyInput}
                                        onChange={(e) => { setApiKeyInput(e.target.value); setConnectError(null) }}
                                        placeholder={selectedCatalog.keyPrefix ? `${selectedCatalog.keyPrefix}...` : 'Your API key'}
                                        autoComplete="off"
                                        className="min-h-[44px] rounded-sm border border-border bg-surface-1 px-3 py-2 text-[16px] sm:text-sm text-text-primary font-mono placeholder:text-text-muted focus:border-azure focus-ring"
                                    />
                                </div>
                            )}

                            <div className="flex flex-col gap-2">
                                <div className="flex items-center gap-2 flex-wrap">
                                    <a
                                        href={selectedCatalog.getKeyUrl}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="inline-flex items-center gap-1 rounded-sm border border-border bg-surface-2 px-3 py-2 text-xs text-text-secondary hover:border-border hover:text-text-primary transition-colors min-h-[44px]"
                                    >
                                        <ExternalLink className="h-3 w-3" />
                                        {selectedCatalog.authType === 'base-url' ? 'Download Ollama' : 'Get API key'}
                                    </a>
                                    <button
                                        onClick={() => void handleConnect(selectedCatalog)}
                                        disabled={connecting || !WS_ID || (discoveredModels !== null && discoveredModels.length === 0) || (
                                            selectedCatalog.authType === 'base-url' ? !baseUrlInput.trim()
                                                : selectedCatalog.authType === 'base-url-and-key' ? !baseUrlInput.trim()
                                                    : !apiKeyInput.trim()
                                        )}
                                        className="flex items-center justify-center gap-1.5 rounded-sm bg-azure px-4 py-2 text-sm font-medium text-text-primary hover:bg-azure/90 transition-colors disabled:opacity-50 min-h-[44px] flex-1 sm:flex-initial"
                                    >
                                        {connecting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />}
                                        {connecting ? 'Connecting…' : 'Connect'}
                                    </button>
                                </div>
                            </div>
                            {selectedCatalog.keyHint && (
                                <p className="text-[11px] text-text-muted leading-relaxed">
                                    {selectedCatalog.keyHint}
                                </p>
                            )}
                            {connectError && (
                                <div role="alert" className="rounded-sm border border-red-800/40 bg-red-dim px-3 py-2">
                                    <p className="text-xs text-red">{connectError}</p>
                                </div>
                            )}
                        </div>
                    </>
                )}

                {(() => {
                    // Pick the authoritative model list for the pill display:
                    // 1. If connected: the backend-discovered capabilities.chatModels.
                    // 2. If unconnected but the user is typing a key and we got live
                    //    discovery back: use those models (authoritative for this key).
                    // 3. Otherwise: the hardcoded catalog sampleModels (last-resort hint).
                    // For non-chat providers (fal.ai, voyage), chatModels is always empty.
                    // Use discoveredModels (from fallback catalog) or sampleModels instead.
                    const isNonChat = selectedInstance && !selectedInstance.capabilities.supportsChat
                    const liveModels = isConnected && selectedInstance
                        ? (isNonChat ? (discoveredModels ?? selectedCatalog.sampleModels) : selectedInstance.capabilities.chatModels)
                        : discoveredModels ?? null
                    const usingLive = liveModels !== null
                    const displayModels = usingLive && liveModels.length > 0
                        ? liveModels
                        : selectedCatalog.sampleModels
                    const catalogSet = new Set(selectedCatalog.sampleModels)
                    const emptyDiscovery = usingLive && liveModels.length === 0 && !isNonChat

                    // Empty state: live discovery returned 0 models — this key has
                    // literally no access to any chat model on this provider.
                    if (emptyDiscovery) {
                        return (
                            <div>
                                <h3 className="mb-2 text-xs font-medium uppercase tracking-wider text-text-muted">
                                    Available models
                                </h3>
                                <div className="rounded-sm border border-amber-800/40 bg-amber-900/10 px-3 py-2">
                                    <p className="text-xs text-amber-300">
                                        No models available on this API key — check your provider dashboard.
                                    </p>
                                </div>
                            </div>
                        )
                    }

                    if (displayModels.length === 0) return null

                    return (
                        <div>
                            <div className="mb-2 flex items-center gap-2">
                                <h3 className="text-xs font-medium uppercase tracking-wider text-text-muted">
                                    Available models
                                </h3>
                                {discovering && (
                                    <Loader2 className="h-3 w-3 animate-spin text-text-muted" />
                                )}
                                {!usingLive && !isConnected && (
                                    <span className="text-[10px] uppercase tracking-wider text-text-muted/70">
                                        Catalog hint
                                    </span>
                                )}
                                {usingLive && !isConnected && (
                                    <span className="text-[10px] uppercase tracking-wider text-azure">
                                        Live
                                    </span>
                                )}
                            </div>
                            <div className="flex flex-wrap gap-1.5">
                                {displayModels.map((m) => {
                                    const isNew = usingLive && !isConnected && !catalogSet.has(m)
                                    return (
                                        <span
                                            key={m}
                                            className="inline-flex items-center gap-1 rounded border border-border bg-surface-2/60 px-2 py-0.5 text-xs text-text-secondary font-mono"
                                        >
                                            {m}
                                            {isNew && (
                                                <span className="text-[9px] uppercase text-azure">new</span>
                                            )}
                                        </span>
                                    )
                                })}
                            </div>
                            {discoveryFailed && !isConnected && (
                                <p className="mt-1.5 text-[11px] text-amber-300">
                                    Couldn&apos;t verify models against your API key — showing the default catalog.
                                </p>
                            )}
                            {isConnected && selectedInstance && selectedInstance.selectedModel
                                && selectedInstance.capabilities.chatModels.length > 0
                                && !selectedInstance.capabilities.chatModels.includes(selectedInstance.selectedModel) && (
                                <p className="mt-1.5 text-[11px] text-amber-300">
                                    Active model &quot;{selectedInstance.selectedModel}&quot; is not in the current discovery list.
                                </p>
                            )}
                        </div>
                    )
                })()}

                {!selectedCatalog.free && (
                    <div className="rounded-sm border border-border/60 bg-surface-1/40 px-3 py-2.5">
                        <p className="text-[11px] font-medium uppercase tracking-wider text-text-muted mb-0.5">Pricing</p>
                        <p className="text-xs text-text-secondary">{selectedCatalog.pricing}</p>
                    </div>
                )}
            </div>
        </>
    ) : null

    const emptyDetail = (
        <div className="flex-1 flex items-center justify-center p-8">
            <div className="max-w-sm text-center flex flex-col gap-3">
                <BrainCircuit className="mx-auto h-10 w-10 text-text-muted/60" />
                <div>
                    <h2 className="text-base font-medium text-text-primary">Choose a provider</h2>
                    <p className="text-sm text-text-muted mt-1">
                        Pick an AI provider from the list to connect it or manage its settings.
                    </p>
                </div>
                <div className="text-xs text-text-muted leading-relaxed">
                    Plexo tries connected providers top-to-bottom. If the first fails,
                    it falls back to the next one in the chain automatically.
                </div>
            </div>
        </div>
    )

    // ── List item renderer ──────────────────────────────────────────────────
    function renderListItem(c: ProviderCatalogEntry) {
        const instance = providerByType.get(c.type)
        const chainPos = chainPositionByType.get(c.type)
        const Icon = c.icon
        const health: HealthStatus | null = instance ? getProviderHealth(instance) : null
        const selected = c.type === selectedType
        // Surface "failed" compat status as a tiny inline pill on the catalog
        // list — only the loudest signal here; native/repair stay in detail.
        // Gated by the C2 audience-split: BYOK paths only.
        const compatFailed = instance?.modelCompatStatus === 'failed'
            && shouldShowBYOKModelCompat(getDeploymentMode(), userProviders.length > 0)
        return (
            <button
                key={c.type}
                onClick={() => setSelectedType(c.type)}
                className={`text-left rounded-sm border px-3 py-2.5 transition-all text-sm shrink-0 min-w-[250px] md:min-w-0 md:w-full min-h-[44px] ${
                    selected
                        ? 'border-azure/50 bg-surface-1'
                        : 'border-border/60 bg-surface-1/30 hover:border-border hover:bg-surface-1/60'
                }`}
            >
                <div className="flex items-center justify-between gap-2 h-full">
                    <div className="flex items-center gap-2.5 min-w-0">
                        <Icon className="h-4 w-4 text-text-muted shrink-0" />
                        <span className="text-sm font-medium text-text-primary truncate">{c.name}</span>
                        {c.free && (
                            <span className="text-[10px] rounded px-1 py-0.5 bg-emerald-900/30 text-emerald-400 font-medium shrink-0">
                                FREE
                            </span>
                        )}
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                        {chainPos !== undefined && (
                            <span className="flex items-center justify-center h-5 w-5 rounded-full bg-azure/15 text-[10px] font-medium text-azure">
                                {chainPos}
                            </span>
                        )}
                        {compatFailed && (
                            <AlertTriangle
                                className="h-3.5 w-3.5 text-red"
                                aria-label="Model incompatible — structured output failed"
                                role="img"
                            />
                        )}
                        {instance ? (
                            health === 'healthy' ? <CheckCircle2 className="h-3.5 w-3.5 text-azure" aria-label="Healthy" role="img" />
                            : health === 'broken' ? <AlertCircle className="h-3.5 w-3.5 text-red" aria-label="Connection error" role="img" />
                            : <Circle className="h-3.5 w-3.5 text-amber-400" aria-label="Degraded" role="img" />
                        ) : (
                            <Circle className="h-3 w-3 text-text-muted" aria-label="Not connected" role="img" />
                        )}
                    </div>
                </div>
            </button>
        )
    }

    return (
        <div className="flex flex-col h-full min-h-0">
            {/* Chain strip + filters toolbar sit in a scrollable header band */}
            <div className="flex flex-col gap-3 p-4 border-b border-border shrink-0">
                {statusPill}
                <ListToolbar
                    hook={lf}
                    placeholder="Search providers…"
                    dimensions={dimensions}
                    sortOptions={[
                        { label: 'Priority (Connected first)', value: 'default' },
                        { label: 'Name (A-Z)', value: 'name_asc' },
                        { label: 'Name (Z-A)', value: 'name_desc' },
                    ]}
                />
            </div>

            {/* Two-column body: catalog list + detail pane */}
            <div className="flex flex-col md:flex-row gap-4 flex-1 min-h-0 p-4">
                <div className="w-full md:w-[280px] shrink-0 flex flex-row md:flex-col gap-2 overflow-x-auto md:overflow-y-auto pb-2 md:pb-0 [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
                    {loading ? (
                        <div className="flex items-center justify-center gap-2 py-8 min-w-[200px] shrink-0 text-xs text-text-muted">
                            <span className="font-mono text-azure animate-pulse" aria-hidden="true">_</span>
                            Loading providers…
                        </div>
                    ) : sorted.length === 0 ? (
                        <div className="text-center py-6 min-w-[200px] shrink-0">
                            <p className="text-xs text-text-muted">No providers match your filters</p>
                        </div>
                    ) : (
                        sorted.map((c) => renderListItem(c))
                    )}
                </div>

                <div className="flex-1 rounded-sm border border-border bg-surface-1/40 flex flex-col overflow-hidden min-h-0 max-w-[100vw] sm:max-w-none">
                    {detail ?? emptyDetail}
                </div>
            </div>
        </div>
    )
}
