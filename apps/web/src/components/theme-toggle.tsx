// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { useTheme } from 'next-themes'
import { Sun, Moon } from 'lucide-react'
import { useEffect, useState } from 'react'

/**
 * ThemeToggle — sun/moon icon button.
 *
 * Gated behind NEXT_PUBLIC_THEME_TOGGLE=true.
 * Renders nothing when the flag is unset, so existing dark-only UX is
 * completely unchanged until design signs off on the light palette.
 */
export function ThemeToggle({ className = '' }: { className?: string }) {
    const [mounted, setMounted] = useState(false)
    const { theme, setTheme, resolvedTheme } = useTheme()

    // Must be mounted before reading theme to avoid SSR mismatch
    useEffect(() => { setMounted(true) }, [])

    // Feature-flag gate — remove this check when light mode is approved
    if (process.env.NEXT_PUBLIC_THEME_TOGGLE !== 'true') return null

    if (!mounted) {
        // Placeholder preserves layout space while hydrating
        return <div className={`h-7 w-7 ${className}`} aria-hidden />
    }

    const isDark = resolvedTheme === 'dark'

    function toggle() {
        setTheme(isDark ? 'light' : 'dark')
    }

    return (
        <button
            id="theme-toggle"
            onClick={toggle}
            aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
            aria-pressed={!isDark}
            title={isDark ? 'Light mode' : 'Dark mode'}
            className={`flex items-center justify-center rounded-lg p-1.5 text-text-muted transition-colors hover:bg-surface-1 hover:text-text-primary ${className}`}
        >
            {isDark
                ? <Sun className="h-4 w-4" />
                : <Moon className="h-4 w-4" />
            }
        </button>
    )
}

/**
 * AppearanceSection — full control row for the Settings page.
 * Shows current/system theme with a segmented control.
 */
export function AppearanceSection() {
    const [mounted, setMounted] = useState(false)
    const { theme, setTheme, resolvedTheme } = useTheme()

    useEffect(() => { setMounted(true) }, [])

    if (process.env.NEXT_PUBLIC_THEME_TOGGLE !== 'true') return null

    const options: { value: string; label: string }[] = [
        { value: 'system', label: 'System' },
        { value: 'light', label: 'Light' },
        { value: 'dark', label: 'Dark' },
    ]

    return (
        <div className="flex flex-col gap-6">
            <div>
                <h2 className="text-lg font-bold text-text-primary">Appearance</h2>
                <p className="mt-0.5 text-sm text-text-muted">
                    Choose how Plexo looks. &ldquo;System&rdquo; follows your OS preference.
                </p>
            </div>

            <div className="rounded-xl border border-border bg-surface-1/40 p-5 flex flex-col gap-4">
                <div className="flex flex-col gap-2">
                    <p className="text-[11px] uppercase tracking-widest text-text-muted font-medium">Theme</p>
                    {mounted ? (
                        <div className="flex items-center gap-1 rounded-lg border border-border bg-canvas p-1 self-start">
                            {options.map((opt) => (
                                <button
                                    key={opt.value}
                                    type="button"
                                    onClick={() => setTheme(opt.value)}
                                    className={`rounded-md px-4 py-1.5 text-sm font-medium transition-colors ${
                                        theme === opt.value
                                            ? 'bg-surface-2 text-text-primary shadow-sm'
                                            : 'text-text-muted hover:text-text-secondary'
                                    }`}
                                >
                                    {opt.label}
                                </button>
                            ))}
                        </div>
                    ) : (
                        <div className="h-9 w-52 rounded-lg border border-border bg-canvas animate-pulse" />
                    )}
                    {mounted && theme === 'system' && (
                        <p className="text-xs text-text-muted">
                            Currently showing: <span className="text-text-secondary font-medium capitalize">{resolvedTheme}</span>
                        </p>
                    )}
                </div>

                <div className="rounded-lg border border-amber-800/40 bg-amber-950/20 px-3 py-2.5">
                    <p className="text-xs text-amber-400 font-medium">Light mode preview</p>
                    <p className="mt-0.5 text-[11px] text-amber-400/70">
                        Light mode is under review. Some surfaces may not render optimally until the palette is finalised.
                    </p>
                </div>
            </div>
        </div>
    )
}
