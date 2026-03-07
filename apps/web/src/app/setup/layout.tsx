import { redirect } from 'next/navigation'
import { auth } from '@web/auth'

const API_BASE = process.env.INTERNAL_API_URL ?? 'http://localhost:3001'

export default async function SetupLayout({ children }: { children: React.ReactNode }) {
    // Calling auth() on the server forces NextAuth to decode the token
    // and execute the jwt callback, which synchronously processes our
    // sync-oauth logic and inserts the GitHub user into the database
    // BEFORE the setup wizard mounts or any API calls are made.
    const session = await auth()
    const userId = session?.user?.id

    // If the user already has a workspace, setup is complete — redirect.
    if (userId) {
        try {
            const res = await fetch(
                `${API_BASE}/api/v1/workspaces?ownerId=${encodeURIComponent(userId)}&limit=1`,
                { cache: 'no-store' },
            )
            if (res.ok) {
                const data = await res.json() as { items?: Array<{ id: string }>; workspaces?: Array<{ id: string }> }
                const items = data.items ?? data.workspaces ?? []
                if (items[0]?.id) redirect('/')
            }
        } catch {
            // API unreachable — let them through so setup can self-recover
        }
    }

    return children
}
