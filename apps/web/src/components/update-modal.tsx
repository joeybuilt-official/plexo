// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { cn } from '@plexo/ui'
import {
    ArrowUpCircle,
    CheckCircle2,
    XCircle,
    Terminal,
    ExternalLink,
    ClipboardCopy,
    Clock,
    X,
    RefreshCw,
    RotateCw,
} from 'lucide-react'
import { PlexoMark } from '@web/components/plexo-logo'

interface VersionInfo {
    current: string
    latest: string | null
    behind: boolean
    updateType: 'release' | 'commit'
    releaseUrl: string | null
    publishedAt: string | null
    changelog: string | null
    dockerEnabled: boolean
    isGitSource: boolean
    error?: string
}

interface UpdateLog {
    type: 'status' | 'progress' | 'done' | 'error'
    message: string
    step?: string
}

const API_URL = (typeof window !== 'undefined' ? '/api' : (process.env.INTERNAL_API_URL || 'http://localhost:3001/api'))

export function UpdateModal() {
    const [open, setOpen] = useState(false)
    const [checking, setChecking] = useState(false)
    const [upToDate, setUpToDate] = useState(false)
    const [versionInfo, setVersionInfo] = useState<VersionInfo | null>(null)
    const [updating, setUpdating] = useState(false)
    const [done, setDone] = useState(false)
    const [failed, setFailed] = useState(false)
    const [logs, setLogs] = useState<UpdateLog[]>([])
    const [copied, setCopied] = useState(false)
    const logEndRef = useRef<HTMLDivElement>(null)

    // Restart-and-refresh polling state
    const [awaitingRestart, setAwaitingRestart] = useState(false)
    const [restartSeconds, setRestartSeconds] = useState(0)
    const [restartTimedOut, setRestartTimedOut] = useState(false)
    const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
    const restartStartRef = useRef<number>(0)

    const lastSeenLatest = useRef<string | null>(null)

    // On mount, sync from localStorage so we don't re-show a dismissed notification
    useEffect(() => {
        lastSeenLatest.current = localStorage.getItem('plexo:update:last_seen') ?? null
    }, [])

    const markSeen = useCallback((sha: string) => {
        lastSeenLatest.current = sha
        localStorage.setItem('plexo:update:last_seen', sha)
    }, [])

    const checkVersion = useCallback(async (manual = false) => {
        if (manual) setChecking(true)
        try {
            const res = await fetch(`${API_URL}/v1/system/version`)
            if (!res.ok) return
            const data = (await res.json()) as VersionInfo
            if (data.behind && data.latest !== lastSeenLatest.current) {
                markSeen(data.latest!)
                setVersionInfo(data)
                setOpen(true)
            } else if (manual) {
                // User explicitly checked — show up-to-date feedback
                setVersionInfo(data)
                setUpToDate(true)
                setTimeout(() => setUpToDate(false), 3000)
            }
        } catch {
            // Non-fatal — silent
        } finally {
            if (manual) setChecking(false)
        }
    }, [markSeen])

    useEffect(() => {
        void checkVersion()
        const interval = setInterval(() => void checkVersion(), 3 * 60 * 1000)
        return () => clearInterval(interval)
    }, [checkVersion])

    // Listen for manual trigger from sidebar version button
    useEffect(() => {
        const handler = () => void checkVersion(true)
        window.addEventListener('plexo:check-update', handler)
        return () => window.removeEventListener('plexo:check-update', handler)
    }, [checkVersion])


    useEffect(() => {
        logEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    }, [logs])

    // Close on Escape
    useEffect(() => {
        if (!open) return
        const handler = (e: KeyboardEvent) => { if (e.key === 'Escape' && !updating) setOpen(false) }
        document.addEventListener('keydown', handler)
        return () => document.removeEventListener('keydown', handler)
    }, [open, updating])

    const handleUpdate = useCallback(async () => {
        setUpdating(true)
        setLogs([{ type: 'status', message: 'Connecting to update service…' }])
        setDone(false)
        setFailed(false)

        try {
            const res = await fetch(`${API_URL}/v1/system/update`, { method: 'POST' })
            if (!res.ok || !res.body) {
                setLogs(prev => [...prev, { type: 'error', message: `Server returned ${res.status}` }])
                setFailed(true)
                setUpdating(false)
                return
            }

            const reader = res.body.getReader()
            const decoder = new TextDecoder()
            let buffer = ''
            let currentEvent = 'status' // track SSE event type

            while (true) {
                const { value, done: streamDone } = await reader.read()
                if (streamDone) break
                buffer += decoder.decode(value, { stream: true })

                const lines = buffer.split('\n')
                buffer = lines.pop() ?? ''

                for (const line of lines) {
                    if (line.startsWith('event: ')) {
                        currentEvent = line.slice(7).trim()
                        continue
                    }
                    if (!line.startsWith('data: ')) continue
                    try {
                        const payload = JSON.parse(line.slice(6)) as {
                            message: string
                            step?: string
                            success?: boolean
                            isError?: boolean
                        }
                        const isDone = payload.success === true
                        const isError = payload.isError === true || currentEvent === 'error'
                        const type: UpdateLog['type'] = isDone ? 'done' : isError ? 'error' : 'status'
                        setLogs(prev => [...prev, { type, message: payload.message, step: payload.step }])
                        if (isDone) {
                            setDone(true)
                            setUpdating(false)
                            // Do NOT clear lastSeenLatest here — the current SHA is now what's installed.
                            // Only a genuinely new SHA should re-open the modal.
                        }
                        if (isError) { setFailed(true); setUpdating(false) }
                    } catch { /* skip malformed */ }
                    // Reset event type after consuming the data line
                    currentEvent = 'status'
                }
            }
        } catch (err) {
            setLogs(prev => [...prev, {
                type: 'error',
                message: err instanceof Error ? err.message : 'Connection lost during update',
            }])
            setFailed(true)
            setUpdating(false)
        }
    }, [])

    const startRestartAndRefresh = useCallback(() => {
        if (!versionInfo) { window.location.reload(); return }
        const snapshotVersion = versionInfo.current
        const TIMEOUT_MS = 3 * 60 * 1000 // 3 min max
        setAwaitingRestart(true)
        setRestartSeconds(0)
        setRestartTimedOut(false)
        restartStartRef.current = Date.now()

        // Ticker: update elapsed seconds in UI
        const ticker = setInterval(() => {
            const elapsed = Math.floor((Date.now() - restartStartRef.current) / 1000)
            setRestartSeconds(elapsed)
            if (elapsed * 1000 >= TIMEOUT_MS) {
                clearInterval(ticker)
                setRestartTimedOut(true)
                setAwaitingRestart(false)
            }
        }, 1000)

        // Poller: check version every 5s until it changes
        const poller = setInterval(async () => {
            try {
                const res = await fetch(`${API_URL}/v1/system/version`)
                if (!res.ok) return
                const data = await res.json() as VersionInfo
                if (data.current !== snapshotVersion) {
                    clearInterval(ticker)
                    clearInterval(poller)
                    window.location.reload()
                }
            } catch { /* ignore — server may briefly be unreachable during restart */ }
        }, 5000)

        pollIntervalRef.current = poller

        // Cleanup on unmount
        return () => { clearInterval(ticker); clearInterval(poller) }
    }, [versionInfo])

    // Auto-start polling when update finishes
    useEffect(() => {
        if (done && versionInfo?.dockerEnabled && !awaitingRestart && !restartTimedOut) {
            startRestartAndRefresh()
        }
    }, [done, versionInfo, awaitingRestart, restartTimedOut, startRestartAndRefresh])

    const manualCommands = `git pull\ndocker compose -f docker/compose.yml up -d --build`

    const copyCommands = () => {
        void navigator.clipboard.writeText(manualCommands)
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
    }

    // Inline status toast for manual checks (no modal needed)
    const statusToast = (checking || upToDate) && !open ? (
        <div className="fixed bottom-4 left-4 z-50 flex items-center gap-2 rounded-lg border border-border bg-surface-1 px-3 py-2 text-xs text-text-secondary shadow-lg shadow-black/20">
            {checking
                ? <><RefreshCw className="h-3.5 w-3.5 animate-spin text-text-muted" /> Checking for updates…</>
                : <><CheckCircle2 className="h-3.5 w-3.5 text-azure" /> <span className="text-azure">Up to date</span></>
            }
        </div>
    ) : null

    if (!open || !versionInfo) return statusToast

    return (
        <>
            {/* Backdrop */}
            <div
                className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm"
                onClick={() => { if (!updating) setOpen(false) }}
                aria-hidden="true"
            />

            {/* Modal */}
            <div
                role="dialog"
                aria-modal="true"
                aria-labelledby="update-modal-title"
                className="fixed left-1/2 top-1/2 z-50 w-full max-w-lg -translate-x-1/2 -translate-y-1/2 px-4"
            >
                <div className="relative rounded-xl bg-surface-1 border border-border shadow-2xl shadow-black/40 p-6 space-y-5">

                    {/* Close button */}
                    {!updating && (
                        <button
                            onClick={() => setOpen(false)}
                            className="absolute top-4 right-4 text-text-muted hover:text-text-secondary transition-colors"
                            aria-label="Close"
                        >
                            <X className="h-4 w-4" />
                        </button>
                    )}

                    {/* Header */}
                    <div className="flex items-center gap-3">
                        <div className="h-11 w-11 rounded-xl bg-azure/10 ring-1 ring-inset ring-azure/20 flex items-center justify-center shrink-0">
                            <PlexoMark
                                className="h-7 w-7"
                                idle={!updating}
                                working={updating}
                            />
                        </div>
                        <div>
                            <h2 id="update-modal-title" className="text-base font-semibold text-text-primary">
                                {updating ? 'Updating Plexo…' : 'Update Available'}
                            </h2>
                            <p className="text-xs text-text-secondary mt-0.5">
                                {updating
                                    ? 'Do not close this window.'
                                    : versionInfo.updateType === 'commit'
                                        ? 'Unreleased changes are ready to install.'
                                        : 'A new version of Plexo is ready to install.'}
                            </p>
                        </div>
                    </div>

                    {/* Version diff */}
                    <div className="flex items-center gap-3 p-3 rounded-lg bg-surface-2/60 border border-border/50">
                        <div className="flex-1">
                            <p className="text-xs text-text-muted mb-1">Current</p>
                            <code className="text-sm font-mono text-text-secondary">v{versionInfo.current}</code>
                        </div>
                        <span className="text-text-muted text-sm">→</span>
                        <div className="flex-1">
                            <p className="text-xs text-text-muted mb-1">Latest</p>
                            <div className="flex items-center gap-2">
                                <code className="text-sm font-mono text-azure">v{versionInfo.latest}</code>
                                {versionInfo.updateType === 'commit' ? (
                                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-dim text-amber border border-amber/20 font-medium">
                                        PATCH
                                    </span>
                                ) : (
                                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-azure/10 text-azure border border-azure/20 font-medium">
                                        NEW
                                    </span>
                                )}
                            </div>
                        </div>
                        {versionInfo.publishedAt && (
                            <div className="flex items-center gap-1 text-xs text-text-muted">
                                <Clock className="h-3 w-3" />
                                {new Date(versionInfo.publishedAt).toLocaleDateString()}
                            </div>
                        )}
                    </div>

                    {/* Changelog */}
                    {versionInfo.changelog && (
                        <div>
                            <p className="text-xs text-text-secondary mb-2 font-medium">What&apos;s new</p>
                            <div className="h-28 overflow-y-auto rounded-md bg-surface-2/40 border border-border/50 p-3 scroll-smooth">
                                <pre className="text-xs text-text-secondary whitespace-pre-wrap font-sans leading-relaxed">
                                    {versionInfo.changelog}
                                </pre>
                            </div>
                        </div>
                    )}

                    {/* Update log */}
                    {logs.length > 0 && (
                        <div>
                            <p className="text-xs text-text-secondary mb-2 font-medium flex items-center gap-1.5">
                                <Terminal className="h-3 w-3" /> Update log
                            </p>
                            <div className="h-32 overflow-y-auto rounded-md bg-black/60 border border-border/50 p-3 space-y-1">
                                {logs.map((log, i) => (
                                    <div key={i} className={cn('text-xs font-mono flex items-start gap-2', {
                                        'text-text-secondary': log.type === 'status' || log.type === 'progress',
                                        'text-azure': log.type === 'done',
                                        'text-red': log.type === 'error',
                                    })}>
                                        <span className="text-text-muted shrink-0 mt-px">
                                            {log.type === 'done' ? '✓' : log.type === 'error' ? '✗' : '›'}
                                        </span>
                                        {log.message}
                                    </div>
                                ))}
                                {updating && (
                                    <div className="flex items-center gap-2 text-xs text-text-muted mt-1">
                                        <PlexoMark className="h-3.5 w-3.5" idle={false} working />
                                        Working…
                                    </div>
                                )}
                                <div ref={logEndRef} />
                            </div>
                        </div>
                    )}

                    {/* Manual update fallback */}
                    {!versionInfo.dockerEnabled && !versionInfo.isGitSource && !done && (
                        <div className="rounded-lg bg-amber/5 border border-amber/20 p-3">
                            <p className="text-xs text-amber font-medium mb-1.5">Manual update required</p>
                            <p className="text-xs text-text-secondary mb-3">
                                One-click update is not enabled. Run these on your server:
                            </p>
                            <div className="relative">
                                <pre className="text-xs font-mono text-text-secondary bg-black/40 rounded p-2.5 pr-8 leading-relaxed">
                                    {manualCommands}
                                </pre>
                                <button
                                    onClick={copyCommands}
                                    className="absolute top-2 right-2 text-text-muted hover:text-text-secondary transition-colors"
                                    aria-label="Copy commands"
                                >
                                    {copied
                                        ? <CheckCircle2 className="h-3.5 w-3.5 text-azure" />
                                        : <ClipboardCopy className="h-3.5 w-3.5" />
                                    }
                                </button>
                            </div>
                        </div>
                    )}

                    {/* Result states */}
                    {done && (
                        <div className="rounded-lg bg-azure/5 border border-azure/20 p-3 space-y-2">
                            <div className="flex items-center gap-2">
                                <CheckCircle2 className="h-4 w-4 text-azure shrink-0" />
                                <p className="text-sm text-azure font-medium">Update triggered successfully</p>
                            </div>
                            {versionInfo.dockerEnabled && (
                                <p className="text-xs text-text-secondary pl-6">
                                    {awaitingRestart
                                        ? `Waiting for the instance to restart… ${restartSeconds}s`
                                        : restartTimedOut
                                            ? 'Instance is taking longer than expected. Try refreshing manually.'
                                            : 'Containers are rebuilding in the background (≈1–2 min).'}
                                </p>
                            )}
                        </div>
                    )}
                    {failed && !done && (
                        <div className="flex items-center gap-2 p-3 rounded-lg bg-red/5 border border-red/20">
                            <XCircle className="h-4 w-4 text-red shrink-0" />
                            <p className="text-sm text-red">Update failed. Check the log or update manually.</p>
                        </div>
                    )}

                    {/* Actions */}
                    <div className="flex items-center gap-3 pt-1">
                        {versionInfo.releaseUrl && (
                            <a
                                href={versionInfo.releaseUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="flex items-center gap-1 text-xs text-text-secondary hover:text-text-primary transition-colors"
                            >
                                <ExternalLink className="h-3 w-3" />
                                View release
                            </a>
                        )}
                        <div className="flex gap-2 ml-auto">
                            {done ? (
                                versionInfo.dockerEnabled ? (
                                    // Docker: poll until container comes back up, then auto-reload
                                    <button
                                        onClick={() => window.location.reload()}
                                        disabled={awaitingRestart && !restartTimedOut}
                                        className={cn("h-8 px-3 text-xs rounded-lg font-medium transition-colors flex items-center gap-1.5",
                                            awaitingRestart && !restartTimedOut 
                                                ? "bg-surface-2 text-text-muted cursor-wait"
                                                : "bg-azure hover:bg-azure/90 text-white"
                                        )}
                                    >
                                        {awaitingRestart && !restartTimedOut ? (
                                            <><RotateCw className="h-3.5 w-3.5 animate-spin" /> Waiting… {restartSeconds}s</>
                                        ) : restartTimedOut ? (
                                            <><RefreshCw className="h-3.5 w-3.5" /> Refresh Now</>
                                        ) : (
                                            <><RotateCw className="h-3.5 w-3.5" /> Restart &amp; Refresh</>
                                        )}
                                    </button>
                                ) : (
                                    <button
                                        onClick={() => window.location.reload()}
                                        className="h-8 px-3 text-xs rounded-lg bg-azure hover:bg-azure/90 text-white font-medium transition-colors"
                                    >
                                        Reload Page
                                    </button>
                                )
                            ) : (
                                <>
                                    <button
                                        onClick={() => setOpen(false)}
                                        disabled={updating}
                                        className="h-8 px-3 text-xs rounded-lg text-text-secondary hover:text-text-primary hover:bg-surface-2 transition-colors disabled:opacity-40"
                                    >
                                        Later
                                    </button>
                                    {(versionInfo.dockerEnabled || versionInfo.isGitSource) && (
                                        <button
                                            onClick={() => void handleUpdate()}
                                            disabled={updating}
                                            className="h-8 px-3 text-xs rounded-lg bg-azure hover:bg-azure/90 text-white font-medium transition-colors flex items-center gap-1.5 disabled:opacity-60"
                                        >
                                            {updating ? (
                                                <><PlexoMark className="h-3.5 w-3.5" idle={false} working /> Updating…</>
                                            ) : (
                                                <><ArrowUpCircle className="h-3.5 w-3.5" /> Update Now</>
                                            )}
                                        </button>
                                    )}
                                </>
                            )}
                        </div>
                    </div>
                </div>
            </div>
        </>
    )
}
