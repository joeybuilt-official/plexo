import { getWorkspaceId } from '@web/lib/workspace'
import { MessageSquare } from 'lucide-react'
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
                <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 py-16 text-center">
                    <MessageSquare className="mx-auto h-8 w-8 text-zinc-700 mb-3" />
                    <p className="text-sm text-zinc-500">No workspace configured</p>
                    <p className="mt-1 text-xs text-zinc-600">Set up a workspace to see conversations.</p>
                </div>
            </div>
        )
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const initialItems = (await fetchInitialActivity(workspaceId)) as any[]

    return <ConversationsList workspaceId={workspaceId} initialItems={initialItems} />
}
