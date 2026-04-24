// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { useEffect } from 'react'
import { X, Server, Zap, Code2 } from 'lucide-react'
import { useFocusTrap } from '@web/hooks/use-focus-trap'

interface Props {
    addCustomType: 'mcp' | 'custom_api'
    customName: string
    setCustomName: (s: string) => void
    customUrl: string
    setCustomUrl: (s: string) => void
    customDescription: string
    setCustomDescription: (s: string) => void
    customAuthType: 'none' | 'api_key' | 'bearer' | 'basic'
    setCustomAuthType: (s: 'none' | 'api_key' | 'bearer' | 'basic') => void
    customAuthValue: string
    setCustomAuthValue: (s: string) => void
    customSaving: boolean
    onClose: () => void
    onSave: () => void
}

export default function CustomIntegrationModal({
    addCustomType,
    customName, setCustomName,
    customUrl, setCustomUrl,
    customDescription, setCustomDescription,
    customAuthType, setCustomAuthType,
    customAuthValue, setCustomAuthValue,
    customSaving, onClose, onSave,
}: Props) {
    const trapRef = useFocusTrap<HTMLDivElement>(true)

    // UI-audit Phase 7 — Escape dismisses (WCAG 2.1.2 no keyboard trap).
    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
    }, [onClose])

    return (
        <div
            ref={trapRef}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
            onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
            role="dialog"
            aria-modal="true"
            aria-labelledby="custom-integration-modal-title"
        >
            <div className="w-full max-w-lg rounded-xl border border-border bg-surface-0 shadow-2xl">
                <div className="flex items-center justify-between border-b border-border px-5 py-4">
                    <div className="flex items-center gap-2">
                        {addCustomType === 'mcp' ? (
                            <Server className="h-4 w-4 text-rose-400" aria-hidden="true" />
                        ) : (
                            <Zap className="h-4 w-4 text-emerald-400" aria-hidden="true" />
                        )}
                        <h2 id="custom-integration-modal-title" className="text-base font-semibold text-text-primary">
                            {addCustomType === 'mcp' ? 'Add Custom Connector' : 'Add Custom API'}
                        </h2>
                    </div>
                    <button
                        onClick={onClose}
                        className="text-text-muted hover:text-text-secondary transition-colors p-1"
                        aria-label="Close"
                    >
                        <X className="h-4 w-4" aria-hidden="true" />
                    </button>
                </div>
                <div className="flex flex-col gap-4 px-5 py-5">
                    <div className="flex flex-col gap-1.5">
                        <label className="text-sm font-medium text-text-secondary">Name</label>
                        <input
                            type="text"
                            value={customName}
                            onChange={(e) => setCustomName(e.target.value)}
                            placeholder={addCustomType === 'mcp' ? 'Lumi MCP' : 'Internal API'}
                            autoFocus
                            className="rounded-lg border border-border bg-surface-1 px-3 min-h-[44px] text-[16px] md:text-sm text-text-primary placeholder:text-text-muted focus:border-azure focus:outline-none focus:ring-1 focus:ring-azure/30"
                        />
                    </div>

                    <div className="flex flex-col gap-1.5">
                        <label className="text-sm font-medium text-text-secondary">
                            {addCustomType === 'mcp' ? 'Connector URL' : 'Base URL'}
                        </label>
                        <input
                            type="url"
                            value={customUrl}
                            onChange={(e) => setCustomUrl(e.target.value)}
                            placeholder={addCustomType === 'mcp' ? 'https://example.com/mcp-config' : 'https://api.example.com/v1'}
                            className="rounded-lg border border-border bg-surface-1 px-3 min-h-[44px] text-[16px] md:text-sm text-text-primary placeholder:text-text-muted focus:border-azure focus:outline-none focus:ring-1 focus:ring-azure/30"
                        />
                        {addCustomType === 'mcp' && (
                            <p className="text-[11px] text-text-muted">The SSE endpoint URL for the connector.</p>
                        )}
                    </div>

                    <div className="flex flex-col gap-1.5">
                        <label className="text-sm font-medium text-text-secondary">Description <span className="text-text-muted font-normal">(optional)</span></label>
                        <input
                            type="text"
                            value={customDescription}
                            onChange={(e) => setCustomDescription(e.target.value)}
                            placeholder="What does this service provide?"
                            className="rounded-lg border border-border bg-surface-1 px-3 min-h-[44px] text-[16px] md:text-sm text-text-primary placeholder:text-text-muted focus:border-azure focus:outline-none focus:ring-1 focus:ring-azure/30"
                        />
                    </div>

                    <div className="flex flex-col gap-1.5">
                        <label className="text-sm font-medium text-text-secondary">Authentication</label>
                        <select
                            value={customAuthType}
                            onChange={(e) => setCustomAuthType(e.target.value as typeof customAuthType)}
                            className="rounded-lg border border-border bg-surface-1 px-3 min-h-[44px] text-[16px] md:text-sm text-text-primary focus:border-azure focus:outline-none focus:ring-1 focus:ring-azure/30"
                        >
                            <option value="none">No Authentication</option>
                            <option value="api_key">API Key</option>
                            <option value="bearer">Bearer Token</option>
                            {addCustomType === 'custom_api' && <option value="basic">Basic Auth</option>}
                        </select>
                    </div>

                    {customAuthType !== 'none' && (
                        <div className="flex flex-col gap-1.5">
                            <label className="text-sm font-medium text-text-secondary">
                                {customAuthType === 'basic' ? 'Credentials (user:pass)' : 'Token / Key'}
                            </label>
                            <input
                                type="password"
                                value={customAuthValue}
                                onChange={(e) => setCustomAuthValue(e.target.value)}
                                placeholder={customAuthType === 'basic' ? 'user:password' : 'sk-••••••••'}
                                autoComplete="new-password"
                                className="rounded-lg border border-border bg-surface-1 px-3 min-h-[44px] text-[16px] md:text-sm text-text-primary placeholder:text-text-muted focus:border-azure focus:outline-none focus:ring-1 focus:ring-azure/30"
                            />
                            <p className="text-xs text-text-muted">Encrypted at rest (AES-256-GCM).</p>
                        </div>
                    )}

                    {addCustomType === 'mcp' && (
                        <div className="rounded-lg border border-rose-800/30 bg-red-dim px-3 py-3 flex flex-col gap-1.5">
                            <p className="text-xs font-semibold text-rose-400 flex items-center gap-1.5">
                                <Code2 className="h-3.5 w-3.5" />
                                Connector
                            </p>
                            <p className="text-[11px] text-rose-400/70 leading-relaxed">
                                Plexo will connect to this external MCP server via SSE transport and make its tools available to the agent at runtime. Tool discovery happens when the agent initializes.
                            </p>
                        </div>
                    )}
                </div>

                <div className="flex items-center justify-end gap-3 border-t border-border px-5 py-4">
                    <button
                        onClick={onClose}
                        className="rounded-lg border border-border px-4 min-h-[44px] text-sm font-medium text-text-secondary hover:bg-surface-2 transition-colors"
                    >
                        Cancel
                    </button>
                    <button
                        onClick={onSave}
                        disabled={!customName.trim() || !customUrl.trim() || customSaving}
                        className="rounded-lg bg-azure px-4 min-h-[44px] text-sm font-medium text-text-primary hover:bg-azure/90 transition-colors disabled:opacity-50"
                    >
                        {customSaving ? 'Saving...' : 'Connect'}
                    </button>
                </div>
            </div>
        </div>
    )
}
