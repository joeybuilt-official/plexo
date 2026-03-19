// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

/**
 * WorkspaceContext — provides the active workspace ID across the app.
 *
 * Resolution order:
 * 1. localStorage key 'plexo_workspace_id'
 * 2. NEXT_PUBLIC_DEFAULT_WORKSPACE env var
 *
 * The only way to switch workspace is via setWorkspaceId(), which
 * persists to localStorage and reloads the page so all server
 * components and SSE streams start fresh.
 */

import { createContext, useContext, useState, useEffect, type ReactNode } from 'react'

interface WorkspaceContextValue {
    workspaceId: string
    workspaceName: string
    userName: string
    setWorkspace: (id: string, name: string) => void
}

const STORAGE_KEY = 'plexo_workspace_id'

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
    const [workspaceName, setWorkspaceName] = useState(initialName || '')
    const [userName] = useState(initialUserName || '')

    // Hydrate from localStorage after mount (avoids SSR mismatch)
    useEffect(() => {
        const stored = localStorage.getItem(STORAGE_KEY)
        if (stored && stored !== workspaceId) {
            setTimeout(() => setWorkspaceId(stored), 0)
        } else if (!stored && !workspaceId) {
            const api = (typeof window !== 'undefined' ? '' : (process.env.INTERNAL_API_URL || 'http://localhost:3001'))
            fetch(`${api}/api/v1/workspaces`, { cache: 'no-store' })
                .then((r) => r.ok ? r.json() : null)
                .then((d: { items?: { id: string, name: string }[] } | null) => {
                    const first = d?.items?.[0]
                    if (first) {
                        localStorage.setItem(STORAGE_KEY, first.id)
                        setWorkspaceId(first.id)
                        setWorkspaceName(first.name)
                    }
                })
                .catch(() => { /* non-fatal */ })
        }
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
                    localStorage.removeItem(STORAGE_KEY)
                    fetch(`${api}/api/v1/workspaces`, { cache: 'no-store' })
                        .then((r) => r.ok ? r.json() : null)
                        .then((list: { items?: { id: string; name: string }[] } | null) => {
                            if (cancelled) return
                            const first = list?.items?.[0]
                            if (first) {
                                localStorage.setItem(STORAGE_KEY, first.id)
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
        localStorage.setItem(STORAGE_KEY, id)
        setWorkspaceId(id)
        setWorkspaceName(name)
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
