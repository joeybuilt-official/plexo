// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { auth } from '@web/auth'
import { Sidebar } from '@web/components/layout/sidebar'
import { MobileHeader } from '@web/components/layout/mobile-header'
import { DashboardRefresher } from './_components/dashboard-refresher'
import { WorkspaceProvider } from '@web/context/workspace'
import { UpdateModal } from '@web/components/update-modal'
import { getWorkspaceId } from '@web/lib/workspace'
import { DashboardMain } from './_components/dashboard-main'

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
        <WorkspaceProvider initialId={workspaceId ?? undefined} initialName={workspaceName} initialUserName={session?.user?.name ?? undefined}>
            <div className="flex h-screen flex-col overflow-hidden bg-canvas">
                <MobileHeader user={session?.user ?? undefined} />
                <div className="flex flex-1 overflow-hidden">
                    <Sidebar user={session?.user ?? undefined} />
                    <DashboardMain>
                        {/* SSE listener — refreshes server components on task events */}
                        <DashboardRefresher />
                        {/* Version check — opens modal automatically when behind */}
                        <UpdateModal />
                        {children}
                    </DashboardMain>
                </div>
            </div>
        </WorkspaceProvider>
    )
}

