// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

'use client'

/**
 * ProviderBalanceBanner — site-wide dismissible notice (Fix A).
 *
 * Shown across the dashboard when one of the active workspace's LLM providers
 * has run out of credit ("Insufficient Balance"). While exhausted, the router
 * has pulled that provider from the routing chain. Dismissing the notice clears
 * the flag server-side and re-arms the provider, so the operator dismisses it
 * once they've topped up (or to retry on purpose).
 */

import { useState } from 'react'
import { AlertTriangle, ExternalLink, X } from 'lucide-react'
import { useWorkspace } from '@web/context/workspace'
import { useProviderAlerts, dismissProviderAlert } from '@web/lib/provider-alerts-client'

const PROVIDER_LABELS: Record<string, string> = {
    deepseek: 'DeepSeek',
    openai: 'OpenAI',
    anthropic: 'Anthropic',
    groq: 'Groq',
    cerebras: 'Cerebras',
    google: 'Google',
    ollama_cloud: 'Ollama Cloud',
    litellm: 'LiteLLM Gateway',
}

/** Direct links to each provider's top-up / billing console, so "Add credit"
 * is one click instead of a scavenger hunt. Unknown providers just omit the
 * link — the notice still works. */
const PROVIDER_BILLING_URLS: Record<string, string> = {
    deepseek: 'https://platform.deepseek.com/top_up',
    openai: 'https://platform.openai.com/settings/organization/billing/overview',
    anthropic: 'https://console.anthropic.com/settings/billing',
    groq: 'https://console.groq.com/settings/billing',
    cerebras: 'https://cloud.cerebras.ai',
    google: 'https://console.cloud.google.com/billing',
    ollama_cloud: 'https://ollama.com/settings/billing',
}

export function ProviderBalanceBanner() {
    const { workspaceId } = useWorkspace()
    const { data, mutate } = useProviderAlerts(workspaceId || null)
    const [dismissing, setDismissing] = useState<string | null>(null)

    if (!workspaceId) return null
    const exhausted = data?.balanceExhausted ?? []
    if (exhausted.length === 0) return null

    const onDismiss = async (providerType: string) => {
        setDismissing(providerType)
        try {
            await dismissProviderAlert(workspaceId, providerType)
            await mutate()
        } catch {
            // leave the banner up on failure; next poll re-reflects server state
        } finally {
            setDismissing(null)
        }
    }

    return (
        <>
            {exhausted.map((p) => {
                const label = p.nickname || PROVIDER_LABELS[p.providerType] || p.providerType
                const billingUrl = PROVIDER_BILLING_URLS[p.providerType]
                return (
                    <div key={p.providerType} className="border-b border-amber/40 bg-amber/10 px-4 py-2">
                        <div className="flex items-center justify-between gap-3">
                            <div className="flex min-w-0 items-center gap-2">
                                <AlertTriangle className="h-4 w-4 shrink-0 text-amber" />
                                <div className="min-w-0 text-xs text-text-primary">
                                    <span className="font-medium">{label}</span> is out of balance and has
                                    been paused. Add credit to restore it, then dismiss this notice to re-enable routing.
                                </div>
                            </div>
                            <div className="flex shrink-0 items-center gap-2">
                                {billingUrl && (
                                    <a
                                        href={billingUrl}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="inline-flex items-center gap-1 rounded border border-amber/50 bg-amber/20 px-2.5 py-1 text-[11px] font-medium text-amber transition-colors hover:bg-amber/30"
                                    >
                                        Add credit <ExternalLink className="h-3 w-3" />
                                    </a>
                                )}
                                <button
                                    type="button"
                                    onClick={() => onDismiss(p.providerType)}
                                    disabled={dismissing === p.providerType}
                                    className="inline-flex shrink-0 items-center gap-1 rounded border border-amber/50 px-2.5 py-1 text-[11px] text-amber transition-colors hover:bg-amber/20 disabled:opacity-50"
                                >
                                    {dismissing === p.providerType ? 'Dismissing…' : (<>Dismiss <X className="h-3 w-3" /></>)}
                                </button>
                            </div>
                        </div>
                    </div>
                )
            })}
        </>
    )
}
