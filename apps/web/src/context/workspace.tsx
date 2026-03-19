// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

/**
 * WorkspaceContext — provides the active workspace ID across the app.
 *
 * Resolution order:
 * 1. Cookie 'plexo_workspace_id' (read by server component → passed as initialId)
 * 2. localStorage key 'plexo_workspace_id' (client-side warm cache)
 * 3. NEXT_PUBLIC_DEFAULT_WORKSPACE env var
 *
 * The only way to switch workspace is via setWorkspace(), which
 * persists to cookie + localStorage and reloads the page so all
 * server components and SSE streams start fresh.
 */

import { createContext, useContext, useState, useEffect, useLayoutEffect, type ReactNode } from 'react'

// useLayoutEffect on client, noop on server (avoids SSR warning)
const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect

interface WorkspaceContextValue {
    workspaceId: string
    workspaceName: string
    userName: string
    setWorkspace: (id: string, name: string) => void
}

const STORAGE_KEY = 'plexo_workspace_id'
const NAME_CACHE_KEY = 'plexo_workspace_name'
const USER_NAME_CACHE_KEY = 'plexo_user_name'

/** Persist workspace ID + name to both cookie (for SSR) and localStorage (for warm cache). */
function persistWorkspaceId(id: string, name?: string) {
    if (typeof document !== 'undefined') {
        document.cookie = `${STORAGE_KEY}=${encodeURIComponent(id)};path=/;max-age=31536000;SameSite=Lax`
        if (name) document.cookie = `${NAME_CACHE_KEY}=${encodeURIComponent(name)};path=/;max-age=31536000;SameSite=Lax`
    }
    try {
        localStorage.setItem(STORAGE_KEY, id)
        if (name) localStorage.setItem(NAME_CACHE_KEY, name)
    } catch { /* non-fatal */ }
}

const WorkspaceContext = createContext<WorkspaceContextValue>({
    workspaceId: '',
    workspaceName: '',
    userName: '',
    setWorkspace: () => undefined,
})

export function WorkspaceProvider({ 
    children,
    initialId,
    initialName,
    initialUserName,
}: { 
    children: ReactNode
    initialId?: string
    initialName?: string
    initialUserName?: string
}) {
    const envId = process.env.NEXT_PUBLIC_DEFAULT_WORKSPACE ?? ''

    const [workspaceId, setWorkspaceId] = useState(initialId || envId)
    const [workspaceName, setWorkspaceNameRaw] = useState(initialName || '')
    const [userName, setUserName] = useState(initialUserName || '')

    // Wrap setWorkspaceName to also persist to localStorage
    function setWorkspaceName(name: string) {
        setWorkspaceNameRaw(name)
        try { localStorage.setItem(NAME_CACHE_KEY, name) } catch {}
    }

    // Warm-cache: hydrate from localStorage BEFORE first paint to avoid CLS.
    // useLayoutEffect fires synchronously after DOM mutation but before the
    // browser paints, so the user never sees the empty/default values.
    useIsomorphicLayoutEffect(() => {
        const storedId = localStorage.getItem(STORAGE_KEY)
        const cachedName = localStorage.getItem(NAME_CACHE_KEY)
        const cachedUserName = localStorage.getItem(USER_NAME_CACHE_KEY)
        if (storedId && storedId !== workspaceId) setWorkspaceId(storedId)
        if (cachedName && !workspaceName) setWorkspaceNameRaw(cachedName)
        if (cachedUserName && !userName) setUserName(cachedUserName)
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    // Persist userName to localStorage for warm cache on next load
    useEffect(() => {
        if (initialUserName) {
            try { localStorage.setItem(USER_NAME_CACHE_KEY, initialUserName) } catch {}
        }
    }, [initialUserName])

    // Hydrate: if no workspace ID at all, fetch one from the API
    useEffect(() => {
        if (workspaceId) return // already resolved from props, env, or localStorage
        const api = (typeof window !== 'undefined' ? '' : (process.env.INTERNAL_API_URL || 'http://localhost:3001'))
        fetch(`${api}/api/v1/workspaces`, { cache: 'no-store' })
            .then((r) => r.ok ? r.json() : null)
            .then((d: { items?: { id: string, name: string }[] } | null) => {
                const first = d?.items?.[0]
                if (first) {
                    persistWorkspaceId(first.id, first.name)
                    setWorkspaceId(first.id)
                    setWorkspaceName(first.name)
                }
            })
            .catch(() => { /* non-fatal */ })
    }, [workspaceId])

    // Fetch workspace name whenever id changes; handle stale/deleted workspaces
    useEffect(() => {
        if (!workspaceId) return
        let cancelled = false
        const api = (typeof window !== 'undefined' ? '' : (process.env.INTERNAL_API_URL || 'http://localhost:3001'))
        fetch(`${api}/api/v1/workspaces/${workspaceId}`, { cache: 'no-store' })
            .then((r) => {
                if (r.ok) return r.json()
                // Workspace no longer exists (404) or forbidden (403) — fall back
                if (r.status === 404 || r.status === 403) {
                    return { __stale: true }
                }
                return null
            })
            .then((d: { name?: string; __stale?: boolean } | null) => {
                if (cancelled) return
                if (d && '__stale' in d && d.__stale) {
                    // Clear the stale workspace ID and resolve a valid one
                    try { localStorage.removeItem(STORAGE_KEY) } catch {}
                    fetch(`${api}/api/v1/workspaces`, { cache: 'no-store' })
                        .then((r) => r.ok ? r.json() : null)
                        .then((list: { items?: { id: string; name: string }[] } | null) => {
                            if (cancelled) return
                            const first = list?.items?.[0]
                            if (first) {
                                persistWorkspaceId(first.id, first.name)
                                setWorkspaceId(first.id)
                                setWorkspaceName(first.name)
                            } else {
                                // No workspaces at all — clear state so the app can show setup
                                setWorkspaceId('')
                                setWorkspaceName('')
                            }
                        })
                        .catch(() => { /* non-fatal */ })
                    return
                }
                if (d && 'name' in d && d.name) setWorkspaceName(d.name)
            })
            .catch(() => { /* non-fatal */ })
        return () => { cancelled = true }
    }, [workspaceId])

    function setWorkspace(id: string, name: string) {
        persistWorkspaceId(id, name)
        // Full reload so server components re-fetch with new context
        window.location.reload()
    }

    return (
        <WorkspaceContext.Provider value={{ workspaceId, workspaceName, userName, setWorkspace }}>
            {children}
        </WorkspaceContext.Provider>
    )
}

export function useWorkspace() {
    return useContext(WorkspaceContext)
}
