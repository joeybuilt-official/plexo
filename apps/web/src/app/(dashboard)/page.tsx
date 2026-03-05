import { redirect } from 'next/navigation'
import { CommandCenter } from './_components/command-center'
import { SystemHealth } from './_components/system-health'
import { QuickSend } from './_components/quick-send'

export const dynamic = 'force-dynamic'
export const revalidate = 0

async function isFirstRun(): Promise<boolean> {
    const apiBase = process.env.INTERNAL_API_URL ?? 'http://localhost:3001'
    try {
        const res = await fetch(`${apiBase}/api/v1/workspaces`, { cache: 'no-store', signal: AbortSignal.timeout(2000) })
        if (!res.ok) return false
        const data = await res.json() as { items?: unknown[] }
        return (data.items?.length ?? 0) === 0
    } catch {
        return false // API unreachable — let dashboard render and fail gracefully
    }
}

export default async function HomePage() {
    if (await isFirstRun()) redirect('/setup')

    return (
        <div>
            {/* Header */}
            <div className="mb-6">
                <h1 className="text-xl font-semibold tracking-tight">Dashboard</h1>
                <p className="mt-1 text-sm text-zinc-500">Your AI agent — live</p>
            </div>

            {/* User-focused overview: projects, tasks, blockers, approvals */}
            <CommandCenter />

            {/* Quick Send */}
            <div className="mt-6">
                <QuickSend />
            </div>

            {/* System Health — collapsible, below the user-focused overview */}
            <div className="mt-6">
                <SystemHealth />
            </div>

            {/* Version */}
            <p className="mt-6 text-center text-[10px] text-zinc-700">
                {process.env.NEXT_PUBLIC_APP_VERSION ?? 'v0.7.0'} · dev
            </p>
        </div>
    )
}
