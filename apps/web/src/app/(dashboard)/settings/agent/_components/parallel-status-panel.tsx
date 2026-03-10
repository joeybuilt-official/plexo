'use client'

import { useState, useEffect } from 'react'
import { Server, Activity, ArrowRight, Play, Trash2, Shield } from 'lucide-react'
import { useWorkspace } from '@web/context/workspace'

interface ParallelSlot {
    taskId: string
    resourceKey: string
    expiresAt: number
}

interface ParallelStatus {
    slots: ParallelSlot[]
    maxSlots: number
}

const API = (typeof window !== 'undefined' ? '' : (process.env.INTERNAL_API_URL || 'http://localhost:3001'))

export function ParallelStatusPanel() {
    const { workspaceId } = useWorkspace()
    const [status, setStatus] = useState<ParallelStatus | null>(null)
    const [claiming, setClaiming] = useState(false)
    const [clearing, setClearing] = useState(false)

    const fetchStatus = async () => {
        try {
            const res = await fetch(`${API}/api/v1/parallel/status?workspaceId=${workspaceId}`)
            if (res.ok) setStatus(await res.json())
        } catch (e) {
            console.error('Failed to fetch parallel status', e)
        }
    }

    useEffect(() => {
        if (!workspaceId) return
        void fetchStatus()
        const t = setInterval(fetchStatus, 5000)
        return () => clearInterval(t)
    }, [workspaceId])

    const claimBatch = async () => {
        setClaiming(true)
        try {
            await fetch(`${API}/api/v1/parallel/claim-batch?workspaceId=${workspaceId}`, { method: 'POST' })
            await fetchStatus()
        } finally {
            setClaiming(false)
        }
    }

    const clearSlots = async () => {
        setClearing(true)
        try {
            await fetch(`${API}/api/v1/parallel/clear?workspaceId=${workspaceId}`, { method: 'POST' })
            await fetchStatus()
        } finally {
            setClearing(false)
        }
    }

    const releaseSlot = async (taskId: string) => {
        try {
            await fetch(`${API}/api/v1/parallel/release/${taskId}?workspaceId=${workspaceId}`, { method: 'POST' })
            await fetchStatus()
        } catch {}
    }

    if (!status) return null

    return (
        <div className="rounded-xl border border-border bg-surface-1/40 p-4 sm:p-5">
            <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                    <Server className="h-4 w-4 text-azure" />
                    <h2 className="text-sm font-semibold text-text-primary">Parallel Execution Control</h2>
                </div>
                <div className="flex items-center gap-2">
                    <span className="text-xs text-text-muted">{status.slots.length} / {status.maxSlots} slots</span>
                </div>
            </div>

            <div className="flex flex-col gap-3">
                {status.slots.length === 0 ? (
                    <div className="text-xs text-text-muted italic py-2 border border-border-subtle rounded-lg text-center bg-canvas/30">
                        No active parallel tasks. Empty slots ready.
                    </div>
                ) : (
                    status.slots.map((slot) => {
                        const remaining = Math.max(0, Math.floor(slot.expiresAt - Date.now() / 1000))
                        return (
                            <div key={slot.taskId} className="flex items-center justify-between p-3 rounded-lg border border-border/50 bg-surface-2/20">
                                <div className="flex items-center gap-3">
                                    <Activity className="h-4 w-4 text-azure" />
                                    <div>
                                        <p className="text-[13px] text-text-primary truncate max-w-[200px]">{slot.resourceKey}</p>
                                        <p className="text-[11px] text-text-muted">TTL: {remaining}s</p>
                                    </div>
                                </div>
                                <div className="flex gap-2">
                                    <a href={`/tasks/${slot.taskId}`} className="p-1.5 rounded hover:bg-zinc-700/50 text-text-secondary transition-colors">
                                        <ArrowRight className="h-4 w-4" />
                                    </a>
                                    <button onClick={() => void releaseSlot(slot.taskId)} className="p-1.5 rounded hover:bg-red-900/40 text-red hover:text-red-300 transition-colors">
                                        <Trash2 className="h-4 w-4" />
                                    </button>
                                </div>
                            </div>
                        )
                    })
                )}
            </div>

            <div className="flex items-center gap-3 mt-4 pt-4 border-t border-border/60">
                <button
                    onClick={() => void claimBatch()}
                    disabled={claiming}
                    className="flex-1 flex items-center justify-center gap-2 rounded-lg bg-azure-dim text-azure hover:bg-azure-dim hover:text-azure py-2 text-[13px] font-medium transition-colors disabled:opacity-50"
                >
                    <Play className={`h-3.5 w-3.5 ${claiming ? 'animate-pulse' : ''}`} />
                    Claim Batch
                </button>
                <button
                    onClick={() => void clearSlots()}
                    disabled={clearing}
                    className="flex items-center justify-center gap-2 rounded-lg bg-surface-2 text-text-secondary hover:bg-red-900/40 hover:text-red px-4 py-2 text-[13px] font-medium transition-colors disabled:opacity-50"
                >
                    <Shield className="h-3.5 w-3.5" />
                    Force Clear
                </button>
            </div>
        </div>
    )
}
