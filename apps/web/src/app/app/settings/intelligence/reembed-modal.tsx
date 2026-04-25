// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

/**
 * Re-embed modal — Phase 1.
 *
 * Triggered when an embedding-model change either changes the dimension
 * count or moves to a different provider. Lets the user kick off a
 * background re-embed job and watch its progress.
 *
 * Polls `useReembedJob` once a job is started; closes itself when the
 * job reaches a terminal state.
 */

import { useState } from 'react'
import { AlertTriangle, CheckCircle2, Loader2, X } from 'lucide-react'
import { useReembedJob, startReembed } from '@web/lib/embeddings-client'
import { useFocusTrap } from '@web/hooks/use-focus-trap'

interface ReembedModalProps {
    workspaceId: string
    open: boolean
    onClose: () => void
    /** Source dims for the warning copy. */
    previousDimensions: number | null
    nextDimensions: number | null
    /** Provider name for the warning copy. */
    nextProvider: string
    nextModel: string
}

export function ReembedModal(props: ReembedModalProps) {
    const { workspaceId, open, onClose, previousDimensions, nextDimensions, nextProvider, nextModel } = props
    const [jobId, setJobId] = useState<string | null>(null)
    const [starting, setStarting] = useState(false)
    const [startError, setStartError] = useState<string | null>(null)

    const { data: jobData } = useReembedJob(workspaceId, jobId)
    const job = jobData?.job ?? null

    if (!open) return null

    const dimChanged = previousDimensions !== null && nextDimensions !== null && previousDimensions !== nextDimensions

    async function handleStart() {
        setStarting(true)
        setStartError(null)
        try {
            const result = await startReembed(workspaceId, { includeScl: true })
            setJobId(result.jobId)
        } catch (err) {
            setStartError(err instanceof Error ? err.message : 'Failed to start re-embed job')
        } finally {
            setStarting(false)
        }
    }

    const isRunning = job?.status === 'running' || job?.status === 'queued'
    const isDone = job?.status === 'completed'
    const isFailed = job?.status === 'failed' || job?.status === 'cancelled'

    const trapRef = useFocusTrap<HTMLDivElement>(open)

    return (
        <div
            ref={trapRef}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
            role="dialog"
            aria-modal="true"
            aria-labelledby="reembed-modal-title"
        >
            <div className="w-full max-w-md rounded-sm border border-border bg-surface-1">
                <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
                    <AlertTriangle className="h-4 w-4 text-amber-400" />
                    <h2 id="reembed-modal-title" className="text-sm font-medium text-text-primary flex-1">Re-embed required</h2>
                    <button
                        onClick={onClose}
                        className="text-text-muted hover:text-text-primary"
                        aria-label="Close"
                    >
                        <X className="h-4 w-4" />
                    </button>
                </div>

                <div className="px-4 py-3 space-y-3 text-xs text-text-muted">
                    <p>
                        You&apos;re switching embeddings to{' '}
                        <span className="font-mono text-text-primary">{nextModel}</span>{' '}
                        on <span className="text-text-primary">{nextProvider}</span>.
                    </p>
                    {dimChanged ? (
                        <p>
                            Dimension change: <span className="text-text-primary">{previousDimensions}</span> →{' '}
                            <span className="text-text-primary">{nextDimensions}</span>.
                            Existing memories must be re-embedded before search will work.
                        </p>
                    ) : (
                        <p>
                            Same dimension ({nextDimensions}). Existing memories may give degraded
                            results until re-embedded under the new model.
                        </p>
                    )}

                    {!job && !isRunning && (
                        <div className="flex justify-end gap-2 pt-2">
                            <button
                                onClick={onClose}
                                className="rounded-md border border-border px-3 py-1.5 text-xs text-text-muted hover:text-text-primary"
                            >
                                Run later
                            </button>
                            <button
                                onClick={() => void handleStart()}
                                disabled={starting}
                                className="rounded-md border border-azure bg-azure-dim px-3 py-1.5 text-xs font-medium text-text-primary hover:bg-surface-1 disabled:opacity-50"
                            >
                                {starting ? <Loader2 className="h-3 w-3 inline animate-spin" /> : null}
                                {starting ? ' Starting…' : 'Start re-embed'}
                            </button>
                        </div>
                    )}

                    {startError && <p className="text-red-400">{startError}</p>}

                    {job && (
                        <div className="rounded-md border border-border bg-surface-1 p-3 space-y-2">
                            <div className="flex items-center gap-2">
                                {isRunning && <Loader2 className="h-3 w-3 animate-spin text-text-muted" />}
                                {isDone && <CheckCircle2 className="h-3 w-3 text-emerald-400" />}
                                {isFailed && <AlertTriangle className="h-3 w-3 text-red-400" />}
                                <span className="text-text-primary capitalize">{job.status}</span>
                            </div>
                            <dl className="grid grid-cols-2 gap-x-4 gap-y-1">
                                <dt>Memories scanned</dt>
                                <dd className="text-text-primary tabular-nums">{job.rowsScanned}</dd>
                                <dt>Re-embedded</dt>
                                <dd className="text-text-primary tabular-nums">{job.rowsReembedded}</dd>
                                <dt>Skipped (already current)</dt>
                                <dd className="text-text-primary tabular-nums">{job.rowsSkipped}</dd>
                                <dt>Errored</dt>
                                <dd className="text-text-primary tabular-nums">{job.rowsErrored}</dd>
                                <dt>SCL re-tagged</dt>
                                <dd className="text-text-primary tabular-nums">{job.sclReembedded}</dd>
                            </dl>
                            {job.error && <p className="text-red-400">{job.error}</p>}
                            {(isDone || isFailed) && (
                                <div className="flex justify-end">
                                    <button
                                        onClick={onClose}
                                        className="rounded-md border border-border px-3 py-1 text-xs text-text-primary hover:bg-surface-1"
                                    >
                                        Close
                                    </button>
                                </div>
                            )}
                        </div>
                    )}
                </div>
            </div>
        </div>
    )
}
