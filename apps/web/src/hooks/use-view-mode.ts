// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { useCallback, useSyncExternalStore } from 'react'

export type ViewMode = 'simple' | 'advanced'

const STORAGE_KEY = 'plexo:viewMode'
const DEFAULT_MODE: ViewMode = 'simple'

// Shared listeners for cross-component sync
const listeners = new Set<() => void>()

function getSnapshot(): ViewMode {
    if (typeof window === 'undefined') return DEFAULT_MODE
    return (localStorage.getItem(STORAGE_KEY) as ViewMode) ?? DEFAULT_MODE
}

function getServerSnapshot(): ViewMode {
    return DEFAULT_MODE
}

function subscribe(cb: () => void): () => void {
    listeners.add(cb)
    // Also listen for storage events from other tabs
    const handler = (e: StorageEvent) => {
        if (e.key === STORAGE_KEY) cb()
    }
    window.addEventListener('storage', handler)
    return () => {
        listeners.delete(cb)
        window.removeEventListener('storage', handler)
    }
}

function notify() {
    listeners.forEach((cb) => cb())
}

/**
 * Shared view mode hook. All components using this hook stay in sync.
 * Persists to localStorage. Cross-tab sync via storage events.
 */
export function useViewMode() {
    const mode = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)

    const setMode = useCallback((m: ViewMode) => {
        localStorage.setItem(STORAGE_KEY, m)
        notify()
    }, [])

    const toggle = useCallback(() => {
        const current = getSnapshot()
        const next = current === 'simple' ? 'advanced' : 'simple'
        localStorage.setItem(STORAGE_KEY, next)
        notify()
    }, [])

    const isAdvanced = mode === 'advanced'
    const isSimple = mode === 'simple'

    return { mode, setMode, toggle, isAdvanced, isSimple }
}
