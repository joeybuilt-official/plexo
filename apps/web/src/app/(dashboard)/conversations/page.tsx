import { getWorkspaceId } from '@web/lib/workspace'
import { MessageSquare, ArrowRight } from 'lucide-react'
import Link from 'next/link'
import { ConversationsList } from './conversations-list'

async function fetchInitialActivity(workspaceId: string) {
    const apiBase = process.env.INTERNAL_API_URL ?? 'http://localhost:3001'
    try {
        const res = await fetch(
            `${apiBase}/api/v1/dashboard/activity?workspaceId=${encodeURIComponent(workspaceId)}&limit=50`,
            { cache: 'no-store' },
        )
        if (!res.ok) return []
        const data = (await res.json()) as { items: unknown[] }
        return data.items ?? []
    } catch {
        return []
    }
}

export default async function ConversationsPage() {
    const workspaceId = await getWorkspaceId()

    if (!workspaceId) {
        return (
            <div className="flex flex-col gap-6 max-w-3xl">
                <div>
                    <h1 className="text-xl font-bold text-zinc-50">Conversations</h1>
                    <p className="mt-0.5 text-sm text-zinc-500">Agent task history from all channels</p>
                </div>
                <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 py-16 text-center flex flex-col items-center gap-4">
                    <MessageSquare className="h-8 w-8 text-zinc-700" />
                    <div>
                        <p className="text-sm font-medium text-zinc-400">No workspace configured</p>
                        <p className="mt-1 text-xs text-zinc-600">Create a workspace to start sending tasks and tracking conversations.</p>
                    </div>
                    <div className="flex flex-col items-center gap-2 mt-1">
                        <Link
                            href="/setup"
                            className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 transition-colors"
                        >
                            Create workspace <ArrowRight className="h-3.5 w-3.5" />
                        </Link>
                        <Link
                            href="/settings/ai-providers"
                            className="text-xs text-zinc-600 hover:text-zinc-400 transition-colors"
                        >
                            or configure an AI provider first
                        </Link>
                    </div>
                </div>
            </div>
        )
    }


    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const initialItems = (await fetchInitialActivity(workspaceId)) as any[]

    return <ConversationsList workspaceId={workspaceId} initialItems={initialItems} />
}
