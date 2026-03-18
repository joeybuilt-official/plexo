// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { auth } from '@web/auth'
import { Sidebar } from '@web/components/layout/sidebar'
import { MobileHeader } from '@web/components/layout/mobile-header'
import { DashboardRefresher } from './_components/dashboard-refresher'
import { WorkspaceProvider } from '@web/context/workspace'
import { UpdateModal } from '@web/components/update-modal'
import { DashboardMain } from './_components/dashboard-main'

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
    const session = await auth()
    return (
        <WorkspaceProvider initialUserName={session?.user?.name ?? undefined}>
            <div className="flex h-screen flex-col overflow-hidden bg-canvas">
                <MobileHeader user={session?.user ?? undefined} />
                <div className="flex flex-1 overflow-hidden">
                    <Sidebar user={session?.user ?? undefined} />
                    <DashboardMain>
                        <DashboardRefresher />
                        <UpdateModal />
                        {children}
                    </DashboardMain>
                </div>
            </div>
        </WorkspaceProvider>
    )
}

