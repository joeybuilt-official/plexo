// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { useTheme } from 'next-themes'
import { Sun, Monitor, Moon } from 'lucide-react'
import { useEffect, useState } from 'react'

type ThemeMode = { value: string; Icon: typeof Sun; label: string }

const modes: ThemeMode[] = [
    { value: 'light', Icon: Sun, label: 'Light' },
    { value: 'system', Icon: Monitor, label: 'System' },
    { value: 'dark', Icon: Moon, label: 'Dark' },
]

export function ThemeToggle({ className = '' }: { className?: string }) {
    const [mounted, setMounted] = useState(false)
    const { theme, setTheme } = useTheme()

    useEffect(() => { setMounted(true) }, [])

    if (!mounted) {
        return <div className={`h-7 w-20 ${className}`} aria-hidden />
    }

    return (
        <div className={`inline-flex items-center gap-0.5 rounded bg-surface-2 p-0.5 ${className}`}>
            {modes.map(({ value, Icon, label }) => (
                <button
                    key={value}
                    onClick={() => setTheme(value)}
                    aria-label={label}
                    title={label}
                    className={`rounded p-1.5 transition-colors ${
                        theme === value
                            ? 'bg-accent text-white'
                            : 'text-text-muted hover:text-text-primary'
                    }`}
                >
                    <Icon className="h-3.5 w-3.5" />
                </button>
            ))}
        </div>
    )
}

export function AppearanceSection() {
    const [mounted, setMounted] = useState(false)
    const { theme, setTheme, resolvedTheme } = useTheme()

    useEffect(() => { setMounted(true) }, [])

    const options: { value: string; label: string }[] = [
        { value: 'system', label: 'System' },
        { value: 'light', label: 'Light' },
        { value: 'dark', label: 'Dark' },
    ]

    return (
        <div className="flex flex-col gap-6">
            <div>
                <h2 className="text-lg font-semibold text-text-primary">Appearance</h2>
                <p className="mt-0.5 text-sm text-text-muted">
                    Choose how Plexo looks. &ldquo;System&rdquo; follows your OS preference.
                </p>
            </div>

            <div className="rounded border border-border bg-surface-1/40 p-5 flex flex-col gap-4">
                <div className="flex flex-col gap-2">
                    <p className="text-[11px] uppercase tracking-widest text-text-muted font-medium">Theme</p>
                    {mounted ? (
                        <div className="flex items-center gap-1 rounded border border-border bg-canvas p-1 self-start">
                            {options.map((opt) => (
                                <button
                                    key={opt.value}
                                    type="button"
                                    onClick={() => setTheme(opt.value)}
                                    className={`rounded-md px-4 py-1.5 text-sm font-medium transition-colors ${
                                        theme === opt.value
                                            ? 'bg-surface-2 text-text-primary'
                                            : 'text-text-muted hover:text-text-secondary'
                                    }`}
                                >
                                    {opt.label}
                                </button>
                            ))}
                        </div>
                    ) : (
                        <div className="h-9 w-52 rounded border border-border bg-canvas animate-pulse" />
                    )}
                    {mounted && theme === 'system' && (
                        <p className="text-xs text-text-muted">
                            Currently showing: <span className="text-text-secondary font-medium capitalize">{resolvedTheme}</span>
                        </p>
                    )}
                </div>
            </div>
        </div>
    )
}
