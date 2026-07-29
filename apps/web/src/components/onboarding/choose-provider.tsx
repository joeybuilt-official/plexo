// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

'use client'

/**
 * Onboarding step: "Choose your AI provider"
 *
 * Three recommended free providers (Cerebras, Groq, Ollama) with
 * inline API key entry and one-click save via the provider instances API.
 */

import { useState } from 'react'
import { Zap, Cloud, Server, Loader2, ExternalLink, Check, AlertTriangle } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

// ── Types ────────────────────────────────────────────────────────────────────

interface ProviderCard {
    id: string
    name: string
    icon: LucideIcon
    tagline: string
    freeLimit: string
    keyLink: string | null
    providerType: string
    needsKey: boolean
}

interface Props {
    workspaceId: string
    apiBase?: string
    onComplete: () => void
    onSkip: () => void
    onGoToSettings: () => void
}

// ── Provider definitions ─────────────────────────────────────────────────────

const PROVIDERS: ProviderCard[] = [
    {
        id: 'cerebras',
        name: 'Cerebras',
        icon: Zap,
        tagline: 'Fastest free AI',
        freeLimit: '60K tokens/min free',
        keyLink: 'https://cloud.cerebras.ai/',
        providerType: 'cerebras',
        needsKey: true,
    },
    {
        id: 'groq',
        name: 'Groq',
        icon: Cloud,
        tagline: 'Versatile free AI',
        freeLimit: '30K tokens/min free',
        keyLink: 'https://console.groq.com/keys',
        providerType: 'groq',
        needsKey: true,
    },
    {
        id: 'ollama',
        name: 'Ollama',
        icon: Server,
        tagline: 'Private & self-hosted',
        freeLimit: 'No limits, no API key',
        keyLink: null,
        providerType: 'ollama',
        needsKey: false,
    },
]

// ── Component ────────────────────────────────────────────────────────────────

export function ChooseProvider({ workspaceId, apiBase = '', onComplete, onSkip, onGoToSettings }: Props) {
    const [apiKeys, setApiKeys] = useState<Record<string, string>>({})
    const [ollamaEnabled, setOllamaEnabled] = useState(false)
    const [saving, setSaving] = useState<string | null>(null)
    const [saved, setSaved] = useState<Set<string>>(new Set())
    const [errors, setErrors] = useState<Record<string, string>>({})

    function setKey(providerId: string, value: string) {
        setApiKeys(prev => ({ ...prev, [providerId]: value }))
        setErrors(prev => {
            const next = { ...prev }
            delete next[providerId]
            return next
        })
    }

    async function handleConfigure(provider: ProviderCard) {
        if (saving) return

        const key = apiKeys[provider.id]?.trim()
        if (provider.needsKey && !key) return

        setSaving(provider.id)
        setErrors(prev => {
            const next = { ...prev }
            delete next[provider.id]
            return next
        })

        try {
            // For cloud providers, test the key first
            if (provider.needsKey && key) {
                const testRes = await fetch(`${apiBase}/api/v1/workspaces/${workspaceId}/providers/test`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ providerType: provider.providerType, apiKey: key }),
                })
                const testData = await testRes.json()
                if (!testData.ok) {
                    setErrors(prev => ({ ...prev, [provider.id]: testData.error || 'Connection test failed.' }))
                    setSaving(null)
                    return
                }
            }

            // For Ollama, test local connectivity
            if (provider.providerType === 'ollama') {
                const testRes = await fetch(`${apiBase}/api/v1/workspaces/${workspaceId}/providers/test`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ providerType: 'ollama', endpointUrl: 'http://localhost:11434' }),
                })
                const testData = await testRes.json()
                // Don't block on Ollama test failure — it might not be running yet
                if (!testData.ok) {
                    // Save anyway, user can install Ollama later
                }
            }

            // Save the provider instance
            const body: Record<string, string> = {
                nickname: provider.name,
                providerType: provider.providerType,
            }
            if (provider.needsKey && key) {
                body.apiKey = key
            }
            if (provider.providerType === 'ollama') {
                body.endpointUrl = 'http://localhost:11434'
            }

            const saveRes = await fetch(`${apiBase}/api/v1/workspaces/${workspaceId}/providers`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            })
            const saveData = await saveRes.json()
            if (!saveRes.ok) {
                setErrors(prev => ({ ...prev, [provider.id]: saveData.error || 'Failed to save provider.' }))
                setSaving(null)
                return
            }

            setSaved(prev => new Set(prev).add(provider.id))
            setSaving(null)

            // Auto-advance after a brief moment
            setTimeout(onComplete, 800)
        } catch {
            setErrors(prev => ({ ...prev, [provider.id]: 'Something went wrong. Try again.' }))
            setSaving(null)
        }
    }

    return (
        <div className="flex flex-col p-6 space-y-6 max-w-lg mx-auto h-full justify-center">
            {/* Header */}
            <div className="text-center space-y-2">
                <h1 className="text-2xl font-semibold text-text-primary">Choose your AI provider</h1>
                <p className="text-sm text-text-muted leading-relaxed">
                    Plexo needs an AI model to think. Pick a free option to get started, or bring your own.
                </p>
            </div>

            {/* Provider cards */}
            <div className="space-y-3">
                {PROVIDERS.map(provider => {
                    const Icon = provider.icon
                    const isSaving = saving === provider.id
                    const isSaved = saved.has(provider.id)
                    const error = errors[provider.id]
                    const key = apiKeys[provider.id] || ''

                    return (
                        <div
                            key={provider.id}
                            className={`rounded border p-4 transition-colors ${
                                isSaved
                                    ? 'border-signal-green/40 bg-signal-green/5'
                                    : 'border-border bg-surface-1'
                            }`}
                        >
                            {/* Card header */}
                            <div className="flex items-start gap-3">
                                <div className="flex h-10 w-10 items-center justify-center rounded bg-azure/10 shrink-0">
                                    <Icon className="h-5 w-5 text-azure" />
                                </div>
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2">
                                        <span className="text-sm font-semibold text-text-primary">{provider.name}</span>
                                        {isSaved && <Check className="h-4 w-4 text-emerald-400" />}
                                    </div>
                                    <p className="text-xs text-text-muted">{provider.tagline}</p>
                                    <p className="text-xs text-text-muted/70 mt-0.5">{provider.freeLimit}</p>
                                </div>
                            </div>

                            {/* Key input or Ollama toggle */}
                            {!isSaved && (
                                <div className="mt-3 space-y-2">
                                    {provider.needsKey ? (
                                        <>
                                            <div className="flex gap-2">
                                                <input
                                                    type="password"
                                                    value={key}
                                                    onChange={e => setKey(provider.id, e.target.value)}
                                                    placeholder="Paste your API key"
                                                    className="flex-1 rounded border border-border bg-surface-1 px-3 py-2 text-sm text-text-primary font-mono placeholder:text-text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-azure focus-visible:border-azure"
                                                    autoComplete="off"
                                                    disabled={isSaving}
                                                />
                                                <button
                                                    onClick={() => void handleConfigure(provider)}
                                                    disabled={isSaving || !key.trim()}
                                                    className="focus-ring px-4 py-2 text-sm font-medium bg-azure text-white rounded hover:bg-azure/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center gap-1.5 shrink-0"
                                                >
                                                    {isSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Configure'}
                                                </button>
                                            </div>
                                            {provider.keyLink && (
                                                <a
                                                    href={provider.keyLink}
                                                    target="_blank"
                                                    rel="noopener noreferrer"
                                                    className="focus-ring inline-flex items-center gap-1 text-[11px] text-azure hover:text-azure/80 transition-colors rounded"
                                                >
                                                    Get API key <ExternalLink className="h-3 w-3" />
                                                </a>
                                            )}
                                        </>
                                    ) : (
                                        <div className="flex items-center gap-3">
                                            <label className="flex items-center gap-2 cursor-pointer">
                                                <input
                                                    type="checkbox"
                                                    checked={ollamaEnabled}
                                                    onChange={e => setOllamaEnabled(e.target.checked)}
                                                    className="accent-azure h-4 w-4"
                                                />
                                                <span className="text-xs text-text-primary">Enable Ollama</span>
                                            </label>
                                            <span className="text-[11px] text-text-muted bg-surface-1 border border-border rounded-sm px-2 py-0.5">
                                                Included with Plexo
                                            </span>
                                            {ollamaEnabled && (
                                                <button
                                                    onClick={() => void handleConfigure(provider)}
                                                    disabled={isSaving}
                                                    className="focus-ring ml-auto px-4 py-2 text-sm font-medium bg-azure text-white rounded hover:bg-azure/90 disabled:opacity-40 transition-colors flex items-center gap-1.5 shrink-0"
                                                >
                                                    {isSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Configure'}
                                                </button>
                                            )}
                                        </div>
                                    )}

                                    {error && (
                                        <div className="flex items-start gap-2 rounded bg-red-500/5 border border-red-500/20 px-3 py-2">
                                            <AlertTriangle className="h-3.5 w-3.5 text-red-400 shrink-0 mt-0.5" />
                                            <p className="text-xs text-red-400">{error}</p>
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    )
                })}
            </div>

            {/* Footer links */}
            <div className="flex flex-col items-center gap-2 pt-2">
                <button
                    onClick={onSkip}
                    className="focus-ring text-sm text-text-muted hover:text-text-primary transition-colors rounded"
                >
                    Skip for now
                </button>
                <button
                    onClick={onGoToSettings}
                    className="focus-ring text-xs text-azure hover:text-azure/80 transition-colors rounded"
                >
                    I already have a provider
                </button>
            </div>
        </div>
    )
}
