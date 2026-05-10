// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'

const CONSENT_KEY = 'plexo:cookie-consent'

export function CookieConsent() {
    const [visible, setVisible] = useState(false)

    useEffect(() => {
        try {
            const consent = localStorage.getItem(CONSENT_KEY)
            if (!consent) setVisible(true)
        } catch {
            // localStorage not available — don't show
        }
    }, [])

    function accept() {
        try { localStorage.setItem(CONSENT_KEY, 'accepted') } catch {}
        setVisible(false)
    }

    if (!visible) return null

    return (
        <div className="fixed bottom-4 left-4 right-4 z-50 mx-auto max-w-lg rounded border border-border bg-surface-1 px-4 py-3 animate-in slide-in-from-bottom-4 duration-300">
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
