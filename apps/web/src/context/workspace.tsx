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
    setWorkspace: (id: string, name: string) => void
}

const STORAGE_KEY = 'plexo_workspace_id'

const WorkspaceContext = createContext<WorkspaceContextValue>({
    workspaceId: '',
    workspaceName: '',
    setWorkspace: () => undefined,
})

export function WorkspaceProvider({ children }: { children: ReactNode }) {
    const envId = process.env.NEXT_PUBLIC_DEFAULT_WORKSPACE ?? ''

    const [workspaceId, setWorkspaceId] = useState(envId)
    const [workspaceName, setWorkspaceName] = useState('')

    // Hydrate from localStorage after mount (avoids SSR mismatch)
    useEffect(() => {
        const stored = localStorage.getItem(STORAGE_KEY)
        if (stored && stored !== workspaceId) {
            setTimeout(() => setWorkspaceId(stored), 0)
        }
    }, [workspaceId])

    // Fetch workspace name whenever id changes
    useEffect(() => {
        if (!workspaceId) return
        const api = (typeof window !== 'undefined' ? '' : (process.env.INTERNAL_API_URL || 'http://localhost:3001'))
        fetch(`${api}/api/v1/workspaces/${workspaceId}`, { cache: 'no-store' })
            .then((r) => r.ok ? r.json() : null)
            .then((d: { name?: string } | null) => { if (d?.name) setWorkspaceName(d.name) })
            .catch(() => { /* non-fatal */ })
    }, [workspaceId])

    function setWorkspace(id: string, name: string) {
        localStorage.setItem(STORAGE_KEY, id)
        setWorkspaceId(id)
        setWorkspaceName(name)
        // Full reload so server components re-fetch with new context
        window.location.reload()
    }

    return (
        <WorkspaceContext.Provider value={{ workspaceId, workspaceName, setWorkspace }}>
            {children}
        </WorkspaceContext.Provider>
    )
}

export function useWorkspace() {
    return useContext(WorkspaceContext)
}
