// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'

const CONSENT_KEY = 'plexo:cookie-consent'

export function CookieConsent() {
    const [visible, setVisible] = useState(false)

    useEffect(() => {
        let consent: string | null = null
        try { consent = localStorage.getItem(CONSENT_KEY) } catch { /* unavailable */ }
        if (consent) return
        setVisible(true)

        // UX13: this notice is informational (essential cookies, no opt-out), but
        // anchored at the bottom it overlays bottom-fixed UI — most visibly the
        // chat composer at 390px. Dismiss on the user's first interaction so it
        // never blocks input; they've seen it, and there's nothing to consent to.
        const dismiss = () => accept()
        const opts = { once: true, capture: true } as const
        window.addEventListener('pointerdown', dismiss, opts)
        window.addEventListener('keydown', dismiss, opts)
        window.addEventListener('scroll', dismiss, opts)
        return () => {
            window.removeEventListener('pointerdown', dismiss, opts)
            window.removeEventListener('keydown', dismiss, opts)
            window.removeEventListener('scroll', dismiss, opts)
        }
    }, [])

    function accept() {
        try { localStorage.setItem(CONSENT_KEY, 'accepted') } catch {}
        setVisible(false)
    }

    if (!visible) return null

    return (
        // Corner toast on ≥sm so it never covers a centered composer / controls;
        // full-width pill on mobile but auto-dismissed on first interaction.
        <div data-testid="cookie-consent" className="fixed bottom-4 left-4 right-4 z-50 mx-auto max-w-lg sm:left-auto sm:right-4 sm:mx-0 sm:max-w-sm rounded border border-border bg-surface-1 px-4 py-3 animate-in slide-in-from-bottom-4 duration-300">
            <div className="flex items-start gap-3">
                <div className="flex-1 min-w-0">
                    <p className="text-xs text-text-secondary leading-relaxed">
                        We use essential cookies for authentication and session management. No tracking or advertising cookies are used.
                        See our{' '}
                        <Link href="/privacy" className="text-azure hover:underline">Privacy Policy</Link>.
                    </p>
                </div>
                <button
                    onClick={accept}
                    className="shrink-0 rounded bg-azure px-3 py-1.5 text-xs font-medium text-text-primary hover:bg-azure/90 transition-colors"
                >
                    Got it
                </button>
            </div>
        </div>
    )
}
