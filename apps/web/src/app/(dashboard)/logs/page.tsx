interface LogEntry {
    id: string
    taskId: string | null
    type: string
    qualityScore: number | null
    tokensIn: number | null
    tokensOut: number | null
    costUsd: number | null
    wallClockMs: number | null
    calibration: string | null
    completedAt: string
    workspaceId: string
}

async function fetchLogs(workspaceId: string) {
    const apiBase = process.env.INTERNAL_API_URL ?? 'http://localhost:3001'
    const res = await fetch(
        `${apiBase}/api/dashboard/activity?workspaceId=${encodeURIComponent(workspaceId)}&limit=50`,
        { cache: 'no-store' }
    )
    if (!res.ok) return []
    const data = await res.json() as { items: LogEntry[] }
    return data.items ?? []
}

const CALIBRATION_COLOR: Record<string, string> = {
    under: 'text-emerald-400',
    over: 'text-amber-400',
    spot: 'text-zinc-400',
}

export const dynamic = 'force-dynamic'
export const revalidate = 0

export default async function LogsPage() {
    const workspaceId = process.env.DEV_WORKSPACE_ID ?? ''
    const logs = await fetchLogs(workspaceId)

    return (
        <div className="flex flex-col gap-6">
            <div>
                <h1 className="text-xl font-bold text-zinc-50">Logs</h1>
                <p className="mt-0.5 text-sm text-zinc-500">Agent work ledger — {logs.length} recent entries</p>
            </div>

            {logs.length === 0 ? (
                <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 py-16 text-center">
                    <p className="text-sm text-zinc-500">No log entries yet</p>
                </div>
            ) : (
                <div className="overflow-x-auto rounded-xl border border-zinc-800">
                    <table className="w-full text-xs">
                        <thead>
                            <tr className="border-b border-zinc-800 bg-zinc-900/80">
                                {['Time', 'Task', 'Type', 'Quality', 'Tokens', 'Cost', 'Duration', 'Calibration'].map((h) => (
                                    <th key={h} className="px-3 py-2.5 text-left font-medium text-zinc-500 whitespace-nowrap">{h}</th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {logs.map((log) => (
                                <tr key={log.id} className="border-b border-zinc-800/50 hover:bg-zinc-900/40 transition-colors">
                                    <td className="px-3 py-2.5 text-zinc-500 whitespace-nowrap">
                                        {log.completedAt
                                            ? new Date(log.completedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
                                            : <span className="text-zinc-700">—</span>}
                                    </td>
                                    <td className="px-3 py-2.5">
                                        {log.taskId ? (
                                            <a href={`/tasks/${log.taskId}`} className="font-mono text-zinc-400 hover:text-zinc-200 transition-colors">
                                                {log.taskId.slice(0, 8)}
                                            </a>
                                        ) : <span className="text-zinc-700">—</span>}
                                    </td>
                                    <td className="px-3 py-2.5">
                                        <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-500 capitalize">{log.type ?? '—'}</span>
                                    </td>
                                    <td className="px-3 py-2.5">
                                        {log.qualityScore !== null ? (
                                            <span className={log.qualityScore >= 0.8 ? 'text-emerald-400' : log.qualityScore >= 0.5 ? 'text-amber-400' : 'text-red-400'}>
                                                {Math.round(log.qualityScore * 100)}%
                                            </span>
                                        ) : <span className="text-zinc-700">—</span>}
                                    </td>
                                    <td className="px-3 py-2.5 text-zinc-500 whitespace-nowrap">
                                        {log.tokensIn !== null
                                            ? `${log.tokensIn?.toLocaleString()}↑ ${log.tokensOut?.toLocaleString()}↓`
                                            : '—'}
                                    </td>
                                    <td className="px-3 py-2.5 whitespace-nowrap">
                                        {log.costUsd !== null
                                            ? <span className="text-zinc-400">${log.costUsd.toFixed(5)}</span>
                                            : <span className="text-zinc-700">—</span>}
                                    </td>
                                    <td className="px-3 py-2.5 text-zinc-500 whitespace-nowrap">
                                        {log.wallClockMs != null && !isNaN(log.wallClockMs) ? `${(log.wallClockMs / 1000).toFixed(1)}s` : <span className="text-zinc-700">—</span>}
                                    </td>
                                    <td className="px-3 py-2.5">
                                        {log.calibration ? (
                                            <span className={`capitalize ${CALIBRATION_COLOR[log.calibration] ?? 'text-zinc-500'}`}>
                                                {log.calibration}
                                            </span>
                                        ) : <span className="text-zinc-700">—</span>}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    )
}
