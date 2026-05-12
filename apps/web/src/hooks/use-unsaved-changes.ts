'use client'

import { useEffect } from 'react'

/**
 * Registers a `beforeunload` handler when `dirty` is true,
 * prompting the user before they navigate away or close the tab.
 */
export function useUnsavedChanges(dirty: boolean) {
    useEffect(() => {
        if (!dirty) return
        const handler = (e: BeforeUnloadEvent) => {
            e.preventDefault()
        }
        window.addEventListener('beforeunload', handler)
        return () => window.removeEventListener('beforeunload', handler)
    }, [dirty])
}
