// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { useEffect, useState } from 'react'
import { useFocusTrap } from '@web/hooks/use-focus-trap'

const API_BASE = typeof window !== 'undefined' ? '' : (process.env.INTERNAL_API_URL ?? 'http://localhost:3001')

interface AnalyticsConfig {
    errorsEnabled: boolean
    usageEnabled: boolean
    instanceId: string
}

async function fetchConfig(): Promise<AnalyticsConfig | null> {
    try {
        const r = await fetch(`${API_BASE}/api/v1/analytics`, { cache: 'no-store' })
        if (!r.ok) return null
        return await r.json() as AnalyticsConfig
    } catch {
        return null
    }
}

async function updateConsent(enabled: boolean): Promise<void> {
    await fetch(`${API_BASE}/api/v1/analytics`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ errorsEnabled: enabled, usageEnabled: enabled }),
    }).catch(() => {})
}

export function AnalyticsPreviewModal() {
    const [visible, setVisible] = useState(false)
    const [optedOut, setOptedOut] = useState(false)
    const [config, setConfig] = useState<AnalyticsConfig | null>(null)

    useEffect(() => {
        if (process.env.NEXT_PUBLIC_ANALYTICS_DISABLED === 'true') return
        if (localStorage.getItem('plexo_analytics_ack')) return

        void fetchConfig().then((c) => {
            setConfig(c)
            setVisible(true)
        })
    }, [])

    function handleConfirm() {
        if (optedOut) {
            void updateConsent(false)
        }
        localStorage.setItem('plexo_analytics_ack', optedOut ? 'opted-out' : 'opted-in')
        setVisible(false)
    }

    useEffect(() => {
        if (!visible) return
        function handler(e: KeyboardEvent) { if (e.key === 'Escape') handleConfirm() }
        document.addEventListener('keydown', handler)
        return () => document.removeEventListener('keydown', handler)
    }) // eslint-disable-line react-hooks/exhaustive-deps

    const trapRef = useFocusTrap<HTMLDivElement>(true)

    if (!visible) return null

    const samplePayload = JSON.stringify({
        app: 'plexo',
        event_name: 'plexo_task_completed',
        instance_uuid: config?.instanceId ?? 'anonymous-uuid',
        properties: { task_type: 'ops', duration_ms: 1234 }
    }, null, 2)

    return (
        <div
            ref={trapRef}
            data-testid="analytics-modal"
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
            role="dialog"
            aria-modal="true"
            aria-labelledby="analytics-modal-title"
        >
            <div className="w-full max-w-lg rounded border border-border bg-surface-1 p-6">
                <h2 id="analytics-modal-title" className="text-lg font-semibold text-text-primary">Anonymous Usage Data</h2>
                <p className="mt-2 text-sm text-text-muted">
                    Plexo collects anonymous usage data to improve the product.
                    No task content, no user names, no emails — only event counts
                    and an anonymous instance UUID.
                </p>

                <details className="mt-4">
                    <summary className="cursor-pointer text-sm font-medium text-text-primary">
                        Preview what gets sent
                    </summary>
                    <pre className="mt-2 max-h-48 overflow-auto rounded bg-black/10 p-3 text-xs text-text-muted">
                        {samplePayload}
                    </pre>
                </details>

                <label className="mt-4 flex items-center gap-2 text-sm text-text-primary">
                    <input
                        data-testid="analytics-optout"
                        type="checkbox"
                        checked={optedOut}
                        onChange={(e) => setOptedOut(e.target.checked)}
                        className="rounded border-border"
                    />
                    Opt out of anonymous analytics
                </label>

                <button
                    data-testid="analytics-confirm"
                    onClick={handleConfirm}
                    className="mt-4 w-full rounded bg-azure px-4 py-2 text-sm font-medium text-text-primary"
                >
                    Got it
                </button>
            </div>
        </div>
    )
}
