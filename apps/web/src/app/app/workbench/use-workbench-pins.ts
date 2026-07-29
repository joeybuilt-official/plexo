// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { useCallback, useEffect, useState } from 'react'
import type { TaskAsset, WorkKind } from '@web/app/app/chat/_components/types'

export interface WorkbenchPin {
    pinId: string
    position: number
    pinnedAt: string
    work: TaskAsset & { kind?: WorkKind }
}

/**
 * useWorkbenchPins — client-side hook over /api/v1/workbench/pins.
 * Hosts pin list state + CRUD actions. Called from the /app/workbench
 * page and from the "Send to workbench" button in the ArtifactPanel.
 *
 * Storage: `workbench_pins` table (slot 0074). The API joins in the
 * current-version content so each pin is render-ready without a second
 * round trip.
 */
export function useWorkbenchPins(workspaceId: string | null | undefined) {
    const [pins, setPins] = useState<WorkbenchPin[]>([])
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const refetch = useCallback(async () => {
        if (!workspaceId) return
        setLoading(true)
        try {
            const res = await fetch(`/api/v1/workbench/pins?workspaceId=${encodeURIComponent(workspaceId)}`, {
                credentials: 'include',
            })
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            const data = await res.json()
            setPins(Array.isArray(data.items) ? data.items : [])
            setError(null)
        } catch (e) {
            setError((e as Error).message)
        } finally {
            setLoading(false)
        }
    }, [workspaceId])

    useEffect(() => { refetch() }, [refetch])

    const pin = useCallback(async (workId: string) => {
        if (!workspaceId) return
        const res = await fetch(`/api/v1/workbench/pins`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ workspaceId, workId }),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        await refetch()
    }, [workspaceId, refetch])

    const unpin = useCallback(async (pinId: string) => {
        const res = await fetch(`/api/v1/workbench/pins/${pinId}`, {
            method: 'DELETE',
            credentials: 'include',
        })
        if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}`)
        setPins(prev => prev.filter(p => p.pinId !== pinId))
    }, [])

    const move = useCallback(async (pinId: string, position: number) => {
        const res = await fetch(`/api/v1/workbench/pins/${pinId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ position }),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        await refetch()
    }, [refetch])

    return { pins, loading, error, pin, unpin, move, refetch }
}
