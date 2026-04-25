// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

/**
 * Personality setup modal — shown once for users who have a workspace
 * but haven't configured a persona. Wraps PersonalityChooser in a
 * dismissible overlay.
 *
 * Mount in the app layout (like SetupWizardGate).
 * Check: workspace.settings.agentPersona is empty/default AND
 *        workspace.settings.personalityConfigured is falsy.
 */

import { useState, useEffect } from 'react'
import { X, Sparkles } from 'lucide-react'
import { useWorkspace } from '@web/context/workspace'
import { PersonalityChooser } from './personality-chooser'
import { useFocusTrap } from '@web/hooks/use-focus-trap'

const API = typeof window !== 'undefined' ? '' : (process.env.INTERNAL_API_URL || 'http://localhost:3001')

function useNeedsPersonality(workspaceId: string): { loading: boolean; needsSetup: boolean } {
    const [loading, setLoading] = useState(true)
    const [needsSetup, setNeedsSetup] = useState(false)

    useEffect(() => {
        if (!workspaceId) { setLoading(false); return }
        let cancelled = false

        // Check localStorage first for fast dismissal
        const dismissKey = `plexo_personality_done_${workspaceId}`
        if (typeof window !== 'undefined' && localStorage.getItem(dismissKey) === 'true') {
            setNeedsSetup(false)
            setLoading(false)
            return
        }

        fetch(`${API}/api/v1/workspaces/${workspaceId}`, { cache: 'no-store' })
            .then(r => r.ok ? r.json() : null)
            .then((data: { settings?: { agentPersona?: string; personalityConfigured?: boolean } } | null) => {
                if (cancelled) return
                const s = data?.settings
                // Already configured via quiz or manually set a persona
                if (s?.personalityConfigured || (s?.agentPersona && s.agentPersona.length > 10)) {
                    setNeedsSetup(false)
                } else {
                    setNeedsSetup(true)
                }
                setLoading(false)
            })
            .catch(() => { if (!cancelled) { setNeedsSetup(false); setLoading(false) } })

        return () => { cancelled = true }
    }, [workspaceId])

    return { loading, needsSetup }
}

export function PersonalityModalGate({ children }: { children: React.ReactNode }) {
    const { workspaceId } = useWorkspace()
    const { loading, needsSetup } = useNeedsPersonality(workspaceId)
    const [dismissed, setDismissed] = useState(false)

    const dismissKey = `plexo_personality_done_${workspaceId}`
    const trapRef = useFocusTrap<HTMLDivElement>(!loading && needsSetup && !dismissed)

    function markDone() {
        setDismissed(true)
        try { localStorage.setItem(dismissKey, 'true') } catch { /* non-fatal */ }
        // Also persist to workspace settings so it doesn't show on other devices
        fetch(`${API}/api/v1/workspaces/${workspaceId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ settings: { personalityConfigured: true } }),
        }).catch(() => { /* best effort */ })
    }

    // UI-audit Phase 7 — Escape key dismissal for WCAG 2.1.2 (no keyboard trap).
    useEffect(() => {
        if (loading || !needsSetup || dismissed) return
        const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') markDone() }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [loading, needsSetup, dismissed])

    if (loading || !needsSetup || dismissed) return <>{children}</>

    return (
        <>
            <div
                ref={trapRef}
                className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
                role="dialog"
                aria-modal="true"
                aria-labelledby="personality-modal-title"
            >
                <div className="relative w-full max-w-lg mx-4 rounded border border-border bg-surface-1 overflow-hidden">
                    {/* Dismiss */}
                    <button
                        onClick={markDone}
                        className="absolute top-4 right-4 p-1.5 rounded text-text-muted hover:text-text-secondary hover:bg-surface-2 transition-colors z-10"
                        title="Skip for now"
                        aria-label="Skip for now"
                    >
                        <X className="h-4 w-4" aria-hidden="true" />
                    </button>

                    {/* Header */}
                    <div className="px-7 pt-6 pb-2 text-center">
                        <div className="flex items-center justify-center gap-2 mb-2">
                            <Sparkles className="h-5 w-5 text-azure" aria-hidden="true" />
                            <span className="text-xs font-medium text-azure uppercase tracking-wider">30 seconds</span>
                        </div>
                        <h1 id="personality-modal-title" className="text-xl font-semibold text-text-primary">Make Plexo yours</h1>
                        <p className="text-sm text-text-muted mt-1">Quick personality quiz — shape how your agent talks and works.</p>
                    </div>

                    {/* Quiz */}
                    <div className="px-7 pb-7 pt-4">
                        <PersonalityChooser
                            onComplete={markDone}
                            onSkip={markDone}
                        />
                    </div>
                </div>
            </div>
            {children}
        </>
    )
}

/**
 * Standalone personality chooser in a modal — used from Settings > Agent
 * "Reconfigure personality" button.
 */
export function PersonalityReconfigureModal({ open, onClose }: { open: boolean; onClose: () => void }) {
    // UI-audit Phase 7 — Escape dismisses (WCAG 2.1.2).
    useEffect(() => {
        if (!open) return
        const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
    }, [open, onClose])

    const reconfigTrapRef = useFocusTrap<HTMLDivElement>(true)

    if (!open) return null

    return (
        <div
            ref={reconfigTrapRef}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
            role="dialog"
            aria-modal="true"
            aria-labelledby="personality-reconfigure-title"
        >
            <div className="relative w-full max-w-lg mx-4 rounded border border-border bg-surface-1 overflow-hidden">
                <button
                    onClick={onClose}
                    className="absolute top-4 right-4 p-1.5 rounded text-text-muted hover:text-text-secondary hover:bg-surface-2 transition-colors z-10"
                    aria-label="Close"
                >
                    <X className="h-4 w-4" aria-hidden="true" />
                </button>

                <div className="px-7 pt-6 pb-2 text-center">
                    <h1 id="personality-reconfigure-title" className="text-xl font-semibold text-text-primary">Reconfigure personality</h1>
                    <p className="text-sm text-text-muted mt-1">Re-run the quiz to change how your agent communicates.</p>
                </div>

                <div className="px-7 pb-7 pt-4">
                    <PersonalityChooser
                        onComplete={onClose}
                        hideSkip
                    />
                </div>
            </div>
        </div>
    )
}
