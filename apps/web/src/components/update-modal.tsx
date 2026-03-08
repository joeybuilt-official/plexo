'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { cn } from '@plexo/ui'
import {
    ArrowUpCircle,
    CheckCircle2,
    XCircle,
    Loader2,
    Terminal,
    ExternalLink,
    ClipboardCopy,
    Clock,
    X,
} from 'lucide-react'

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
    const [versionInfo, setVersionInfo] = useState<VersionInfo | null>(null)
    const [updating, setUpdating] = useState(false)
    const [done, setDone] = useState(false)
    const [failed, setFailed] = useState(false)
    const [logs, setLogs] = useState<UpdateLog[]>([])
    const [copied, setCopied] = useState(false)
    const logEndRef = useRef<HTMLDivElement>(null)

    const lastSeenLatest = useRef<string | null>(null)

    // On mount, sync from localStorage so we don't re-show a dismissed notification
    useEffect(() => {
        lastSeenLatest.current = localStorage.getItem('plexo:update:last_seen') ?? null
    }, [])

    const markSeen = useCallback((sha: string) => {
        lastSeenLatest.current = sha
        localStorage.setItem('plexo:update:last_seen', sha)
    }, [])

    const checkVersion = useCallback(async () => {
        try {
            const res = await fetch(`${API_URL}/v1/system/version`)
            if (!res.ok) return
            const data = (await res.json()) as VersionInfo
            if (data.behind && data.latest !== lastSeenLatest.current) {
                markSeen(data.latest!)
                setVersionInfo(data)
                setOpen(true)
            }
        } catch {
            // Non-fatal — silent
        }
    }, [markSeen])

    useEffect(() => {
        void checkVersion()
        const interval = setInterval(() => void checkVersion(), 3 * 60 * 1000)
        return () => clearInterval(interval)
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

    const manualCommands = `git pull\ndocker compose -f docker/compose.yml up -d --build`

    const copyCommands = () => {
        void navigator.clipboard.writeText(manualCommands)
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
    }

    if (!open || !versionInfo) return null

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
                <div className="relative rounded-xl bg-zinc-900 border border-zinc-800 shadow-2xl p-6 space-y-5">

                    {/* Close button */}
                    {!updating && (
                        <button
                            onClick={() => setOpen(false)}
                            className="absolute top-4 right-4 text-zinc-500 hover:text-zinc-300 transition-colors"
                            aria-label="Close"
                        >
                            <X className="h-4 w-4" />
                        </button>
                    )}

                    {/* Header */}
                    <div className="flex items-center gap-3">
                        <div className="h-10 w-10 rounded-full bg-violet-500/10 border border-violet-500/20 flex items-center justify-center shrink-0">
                            <ArrowUpCircle className="h-5 w-5 text-violet-400" />
                        </div>
                        <div>
                            <h2 id="update-modal-title" className="text-base font-semibold text-white">
                                Update Available
                            </h2>
                            <p className="text-xs text-zinc-400 mt-0.5">
                                {versionInfo.updateType === 'commit'
                                    ? 'Unreleased changes are ready to install.'
                                    : 'A new version of Plexo is ready to install.'}
                            </p>
                        </div>
                    </div>

                    {/* Version diff */}
                    <div className="flex items-center gap-3 p-3 rounded-lg bg-zinc-800/60 border border-zinc-700/50">
                        <div className="flex-1">
                            <p className="text-xs text-zinc-500 mb-1">Current</p>
                            <code className="text-sm font-mono text-zinc-300">v{versionInfo.current}</code>
                        </div>
                        <span className="text-zinc-600 text-sm">→</span>
                        <div className="flex-1">
                            <p className="text-xs text-zinc-500 mb-1">Latest</p>
                            <div className="flex items-center gap-2">
                                <code className="text-sm font-mono text-violet-400">v{versionInfo.latest}</code>
                                {versionInfo.updateType === 'commit' ? (
                                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20 font-medium">
                                        PATCH
                                    </span>
                                ) : (
                                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-violet-500/10 text-violet-400 border border-violet-500/20 font-medium">
                                        NEW
                                    </span>
                                )}
                            </div>
                        </div>
                        {versionInfo.publishedAt && (
                            <div className="flex items-center gap-1 text-xs text-zinc-500">
                                <Clock className="h-3 w-3" />
                                {new Date(versionInfo.publishedAt).toLocaleDateString()}
                            </div>
                        )}
                    </div>

                    {/* Changelog */}
                    {versionInfo.changelog && (
                        <div>
                            <p className="text-xs text-zinc-400 mb-2 font-medium">What&apos;s new</p>
                            <div className="h-28 overflow-y-auto rounded-md bg-zinc-800/40 border border-zinc-700/50 p-3 scroll-smooth">
                                <pre className="text-xs text-zinc-300 whitespace-pre-wrap font-sans leading-relaxed">
                                    {versionInfo.changelog}
                                </pre>
                            </div>
                        </div>
                    )}

                    {/* Update log */}
                    {logs.length > 0 && (
                        <div>
                            <p className="text-xs text-zinc-400 mb-2 font-medium flex items-center gap-1.5">
                                <Terminal className="h-3 w-3" /> Update log
                            </p>
                            <div className="h-32 overflow-y-auto rounded-md bg-black/60 border border-zinc-700/50 p-3 space-y-1">
                                {logs.map((log, i) => (
                                    <div key={i} className={cn('text-xs font-mono flex items-start gap-2', {
                                        'text-zinc-400': log.type === 'status' || log.type === 'progress',
                                        'text-green-400': log.type === 'done',
                                        'text-red-400': log.type === 'error',
                                    })}>
                                        <span className="text-zinc-600 shrink-0 mt-px">
                                            {log.type === 'done' ? '✓' : log.type === 'error' ? '✗' : '›'}
                                        </span>
                                        {log.message}
                                    </div>
                                ))}
                                {updating && (
                                    <div className="flex items-center gap-2 text-xs text-zinc-500 mt-1">
                                        <Loader2 className="h-3 w-3 animate-spin" />
                                        Working…
                                    </div>
                                )}
                                <div ref={logEndRef} />
                            </div>
                        </div>
                    )}

                    {/* Manual update fallback */}
                    {!versionInfo.dockerEnabled && !versionInfo.isGitSource && !done && (
                        <div className="rounded-lg bg-amber-500/5 border border-amber-500/20 p-3">
                            <p className="text-xs text-amber-400 font-medium mb-1.5">Manual update required</p>
                            <p className="text-xs text-zinc-400 mb-3">
                                One-click update is not enabled. Run these on your server:
                            </p>
                            <div className="relative">
                                <pre className="text-xs font-mono text-zinc-300 bg-black/40 rounded p-2.5 pr-8 leading-relaxed">
                                    {manualCommands}
                                </pre>
                                <button
                                    onClick={copyCommands}
                                    className="absolute top-2 right-2 text-zinc-500 hover:text-zinc-300 transition-colors"
                                    aria-label="Copy commands"
                                >
                                    {copied
                                        ? <CheckCircle2 className="h-3.5 w-3.5 text-green-400" />
                                        : <ClipboardCopy className="h-3.5 w-3.5" />
                                    }
                                </button>
                            </div>
                        </div>
                    )}

                    {/* Result states */}
                    {done && (
                        <div className="flex items-center gap-2 p-3 rounded-lg bg-green-500/5 border border-green-500/20">
                            <CheckCircle2 className="h-4 w-4 text-green-400 shrink-0" />
                            <p className="text-sm text-green-400">
                                {versionInfo.dockerEnabled ? 'Update complete — reload the page to use the new version.' : 'Update pulled. Server may restart automatically.'}
                            </p>
                        </div>
                    )}
                    {failed && !done && (
                        <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/5 border border-red-500/20">
                            <XCircle className="h-4 w-4 text-red-400 shrink-0" />
                            <p className="text-sm text-red-400">Update failed. Check the log or update manually.</p>
                        </div>
                    )}

                    {/* Actions */}
                    <div className="flex items-center gap-3 pt-1">
                        {versionInfo.releaseUrl && (
                            <a
                                href={versionInfo.releaseUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-200 transition-colors"
                            >
                                <ExternalLink className="h-3 w-3" />
                                View release
                            </a>
                        )}
                        <div className="flex gap-2 ml-auto">
                            {done ? (
                                <button
                                    onClick={() => window.location.reload()}
                                    className="h-8 px-3 text-xs rounded-lg bg-green-600 hover:bg-green-500 text-white font-medium transition-colors"
                                >
                                    Reload Page
                                </button>
                            ) : (
                                <>
                                    <button
                                        onClick={() => setOpen(false)}
                                        disabled={updating}
                                        className="h-8 px-3 text-xs rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors disabled:opacity-40"
                                    >
                                        Later
                                    </button>
                                    {(versionInfo.dockerEnabled || versionInfo.isGitSource) && (
                                        <button
                                            onClick={() => void handleUpdate()}
                                            disabled={updating}
                                            className="h-8 px-3 text-xs rounded-lg bg-violet-600 hover:bg-violet-500 text-white font-medium transition-colors flex items-center gap-1.5 disabled:opacity-60"
                                        >
                                            {updating ? (
                                                <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Updating…</>
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
