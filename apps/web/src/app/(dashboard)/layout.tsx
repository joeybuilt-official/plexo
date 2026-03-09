// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { auth } from '@web/auth'
import { Sidebar } from '@web/components/layout/sidebar'
import { DashboardRefresher } from './_components/dashboard-refresher'
import { WorkspaceProvider } from '@web/context/workspace'
import { UpdateModal } from '@web/components/update-modal'
import { getWorkspaceId } from '@web/lib/workspace'

import { AppShell } from '@plexo/ui/components/layout/AppShell'

export default async function DashboardLayout({
    children,
}: {
    children: React.ReactNode
}) {
    const session = await auth()
    const workspaceId = await getWorkspaceId()
    let workspaceName = ''

    if (workspaceId) {
        try {
            const api = process.env.INTERNAL_API_URL || 'http://localhost:3001'
            const res = await fetch(`${api}/api/v1/workspaces/${workspaceId}`, { cache: 'no-store' })
            if (res.ok) {
                const data = await res.json()
                workspaceName = data.name || ''
            }
        } catch { }
    }

    return (
        <WorkspaceProvider initialId={workspaceId ?? undefined} initialName={workspaceName}>
            <div className="flex h-screen overflow-hidden">
                <Sidebar user={session?.user} />
                <main 
                    className="flex-1 overflow-auto bg-zinc-925 relative z-0 p-4 pt-[calc(4.5rem+var(--safe-top))] pb-[calc(72px+1rem+var(--safe-bottom))] md:p-6 md:pb-[calc(1.5rem+var(--safe-bottom))] md:pt-[calc(1.5rem+var(--safe-top))]"
                    style={{
                        '--safe-top': 'env(safe-area-inset-top)',
                        '--safe-bottom': 'env(safe-area-inset-bottom)'
                    } as React.CSSProperties}
                >
                    {/* SSE listener — refreshes server components on task events */}
                    <DashboardRefresher />
                    {/* Version check — opens modal automatically when behind */}
                    <UpdateModal />
                    {children}
                </main>
            </div>
        </WorkspaceProvider>
    )
}
