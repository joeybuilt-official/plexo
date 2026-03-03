import Link from 'next/link'

interface ImprovementEntry {
    id: string
    pattern_type: string
    description: string
    evidence: unknown
    proposed_change: string | null
    applied: boolean
    created_at: string
}

interface PrefEntry {
    key: string
    value: unknown
}

const PATTERN_STYLE: Record<string, { dot: string; label: string }> = {
    failure_pattern: { dot: 'bg-red-500', label: 'Failure pattern' },
    success_pattern: { dot: 'bg-emerald-500', label: 'Success pattern' },
    tool_preference: { dot: 'bg-blue-500', label: 'Tool preference' },
    scope_adjustment: { dot: 'bg-amber-500', label: 'Scope adjustment' },
}

async function fetchData(workspaceId: string) {
    const apiBase = process.env.INTERNAL_API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'

    const [impRes, prefRes] = await Promise.all([
        fetch(`${apiBase}/api/memory/improvements?workspaceId=${workspaceId}&limit=30`, { cache: 'no-store' }),
        fetch(`${apiBase}/api/memory/preferences?workspaceId=${workspaceId}`, { cache: 'no-store' }),
    ])

    const improvements: ImprovementEntry[] = impRes.ok
        ? ((await impRes.json()) as { items: ImprovementEntry[] }).items
        : []

    const preferences: Record<string, unknown> = prefRes.ok
        ? ((await prefRes.json()) as { preferences: Record<string, unknown> }).preferences
        : {}

    return { improvements, preferences }
}

export default async function InsightsPage() {
    const workspaceId = process.env.DEV_WORKSPACE_ID ?? '00000000-0000-0000-0000-000000000000'
    const { improvements, preferences } = await fetchData(workspaceId)

    const prefEntries: PrefEntry[] = Object.entries(preferences).map(([key, value]) => ({ key, value }))

    return (
        <div className="flex flex-col gap-6">
            <div>
                <h1 className="text-xl font-bold text-zinc-50">Insights</h1>
                <p className="mt-0.5 text-sm text-zinc-500">
                    Agent memory, learned preferences, and self-improvement proposals
                </p>
            </div>

            {/* Preferences */}
            <section>
                <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-zinc-500">
                    Workspace Preferences
                    <span className="ml-2 rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] font-medium text-zinc-400">
                        {prefEntries.length}
                    </span>
                </h2>

                {prefEntries.length === 0 ? (
                    <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-6 text-center text-sm text-zinc-500">
                        No preferences learned yet. Preferences accumulate as the agent completes tasks.
                    </div>
                ) : (
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                        {prefEntries.map(({ key, value }) => (
                            <div
                                key={key}
                                className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3"
                            >
                                <p className="text-[10px] font-mono text-zinc-500 truncate">{key}</p>
                                <p className="mt-1 text-xs font-medium text-zinc-300 break-all">
                                    {typeof value === 'object' ? JSON.stringify(value) : String(value)}
                                </p>
                            </div>
                        ))}
                    </div>
                )}
            </section>

            {/* Improvement log */}
            <section>
                <div className="mb-3 flex items-center justify-between">
                    <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
                        Improvement Log
                        <span className="ml-2 rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] font-medium text-zinc-400">
                            {improvements.length}
                        </span>
                    </h2>
                </div>

                {improvements.length === 0 ? (
                    <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-6 text-center text-sm text-zinc-500">
                        <p>No improvement proposals yet.</p>
                        <p className="mt-1 text-xs text-zinc-600">
                            Run a self-improvement cycle after completing tasks via the API:
                        </p>
                        <code className="mt-2 block rounded bg-zinc-900 px-3 py-2 text-left text-[11px] font-mono text-zinc-400">
                            {`POST /api/memory/improvements/run\n{ "workspaceId": "${workspaceId}" }`}
                        </code>
                    </div>
                ) : (
                    <div className="flex flex-col gap-2">
                        {improvements.map((entry) => {
                            const style = PATTERN_STYLE[entry.pattern_type] ?? { dot: 'bg-zinc-600', label: entry.pattern_type }
                            return (
                                <div key={entry.id} className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
                                    <div className="flex items-start justify-between gap-3">
                                        <div className="flex items-start gap-2">
                                            <span className={`mt-1.5 h-2 w-2 rounded-full shrink-0 ${style.dot}`} />
                                            <div>
                                                <p className="text-xs font-medium text-zinc-500">{style.label}</p>
                                                <p className="mt-0.5 text-sm text-zinc-200">{entry.description}</p>
                                            </div>
                                        </div>
                                        {entry.applied && (
                                            <span className="shrink-0 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-400">
                                                applied
                                            </span>
                                        )}
                                    </div>
                                    {entry.proposed_change && (
                                        <p className="mt-2 ml-4 text-xs text-zinc-500 italic">
                                            → {entry.proposed_change}
                                        </p>
                                    )}
                                    <p className="mt-2 ml-4 text-[10px] text-zinc-600">
                                        {new Date(entry.created_at).toLocaleString()}
                                    </p>
                                </div>
                            )
                        })}
                    </div>
                )}
            </section>
        </div>
    )
}
