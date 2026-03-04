import Link from 'next/link'
import { ChevronRight } from 'lucide-react'
import { RefreshButton } from './refresh-button'

// ── Types ─────────────────────────────────────────────────────────────────────

interface LogEntry {
    id: string
    type: string
    status: string
    source: string
    project: string | null
    context: Record<string, unknown>
    qualityScore: number | null
    tokensIn: number | null
    tokensOut: number | null
    costUsd: number | null
    outcomeSummary: string | null
    createdAt: string | null
    claimedAt: string | null
    completedAt: string | null
}

const STATUS_STYLES: Record<string, string> = {
    complete: 'bg-emerald-950 text-emerald-400 border-emerald-800',
    running: 'bg-blue-950 text-blue-400 border-blue-800',
    queued: 'bg-zinc-800 text-zinc-400 border-zinc-700',
    blocked: 'bg-amber-950 text-amber-400 border-amber-800',
    failed: 'bg-red-950 text-red-400 border-red-800',
    cancelled: 'bg-zinc-900 text-zinc-600 border-zinc-800',
}

const SOURCE_COLOR: Record<string, string> = {
    chat: 'text-violet-400',
    telegram: 'text-sky-400',
    cron: 'text-amber-400',
    api: 'text-zinc-400',
    sprint: 'text-emerald-400',
}

function taskDescription(ctx: Record<string, unknown>): string {
    for (const k of ['description', 'prompt', 'message', 'input']) {
        if (typeof ctx[k] === 'string' && (ctx[k] as string).length > 0) return ctx[k] as string
    }
    return ''
}

function elapsedStr(start: string | null, end: string | null): string | null {
    if (!start || !end) return null
    const ms = new Date(end).getTime() - new Date(start).getTime()
    if (isNaN(ms) || ms < 0) return null
    return ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${(ms / 60_000).toFixed(1)}m`
}

function relativeTime(iso: string | null): string {
    if (!iso) return '—'
    const diff = Date.now() - new Date(iso).getTime()
    if (isNaN(diff)) return '—'
    if (diff < 60_000) return 'just now'
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
    return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' })
}

async function fetchLogs(): Promise<LogEntry[]> {
    const INTERNAL = process.env.INTERNAL_API_URL ?? 'http://localhost:3001'
    const WS = process.env.DEV_WORKSPACE_ID ?? ''
    if (!WS) return []
    try {
        const res = await fetch(
            `${INTERNAL}/api/dashboard/activity?workspaceId=${encodeURIComponent(WS)}&limit=100`,
            { cache: 'no-store' }
        )
        if (!res.ok) return []
        const data = await res.json() as { items?: LogEntry[] }
        return data.items ?? []
    } catch { return [] }
}

export const dynamic = 'force-dynamic'
export const revalidate = 0

export default async function LogsPage() {
    const logs = await fetchLogs()

    return (
        <div className="flex flex-col gap-6">
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-xl font-bold text-zinc-50">Logs</h1>
                    <p className="mt-0.5 text-sm text-zinc-500">Agent work ledger — {logs.length} entries</p>
                </div>
                <RefreshButton />
            </div>

            {logs.length === 0 ? (
                <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 py-16 text-center">
                    <p className="text-sm text-zinc-500">No log entries yet</p>
                </div>
            ) : (
                <div className="flex flex-col gap-2">
                    {logs.map((log) => {
                        const dur = elapsedStr(log.claimedAt ?? log.createdAt, log.completedAt)
                        const desc = taskDescription(log.context ?? {})
                        const ts = log.completedAt ?? log.claimedAt ?? log.createdAt
                        return (
                            <Link
                                key={log.id}
                                href={`/logs/${log.id}`}
                                className="group flex items-center gap-4 rounded-xl border border-zinc-800 bg-zinc-900/40 px-4 py-3.5 transition-colors hover:border-zinc-700 hover:bg-zinc-900/80"
                            >
                                <span className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium capitalize ${STATUS_STYLES[log.status] ?? 'bg-zinc-800 text-zinc-500 border-zinc-700'}`}>
                                    {log.status}
                                </span>

                                <span className={`shrink-0 w-16 text-xs font-medium capitalize ${SOURCE_COLOR[log.source] ?? 'text-zinc-500'}`}>
                                    {log.source}
                                </span>

                                <span className="shrink-0 rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-500 capitalize">
                                    {log.type}
                                </span>

                                <span className="flex-1 truncate text-sm text-zinc-400 group-hover:text-zinc-200 transition-colors">
                                    {desc ? desc.slice(0, 120) : <span className="italic text-zinc-600">{log.type} task</span>}
                                </span>

                                {log.outcomeSummary && (
                                    <span className="hidden xl:block max-w-xs truncate text-xs text-zinc-600">
                                        {log.outcomeSummary.slice(0, 80)}
                                    </span>
                                )}

                                <div className="flex shrink-0 items-center gap-4 text-xs text-zinc-600">
                                    {log.tokensIn != null && (
                                        <span className="hidden sm:block">
                                            {((log.tokensIn ?? 0) + (log.tokensOut ?? 0)).toLocaleString()} tok
                                        </span>
                                    )}
                                    {log.costUsd != null && log.costUsd > 0 && (
                                        <span className="hidden sm:block text-zinc-500">${log.costUsd.toFixed(4)}</span>
                                    )}
                                    {dur && <span>{dur}</span>}
                                    {log.qualityScore != null && (
                                        <span className={log.qualityScore >= 0.8 ? 'text-emerald-500' : log.qualityScore >= 0.5 ? 'text-amber-500' : 'text-red-500'}>
                                            {Math.round(log.qualityScore * 100)}%
                                        </span>
                                    )}
                                    <span className="text-zinc-700 min-w-[4rem] text-right">{relativeTime(ts)}</span>
                                </div>

                                <ChevronRight size={14} className="shrink-0 text-zinc-700 group-hover:text-zinc-500 transition-colors" />
                            </Link>
                        )
                    })}
                </div>
            )}
        </div>
    )
}
