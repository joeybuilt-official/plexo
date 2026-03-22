// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { cookies } from 'next/headers'
import { createServerClient } from '@web/auth'
import { Sidebar } from '@web/components/layout/sidebar'
import { MobileHeader } from '@web/components/layout/mobile-header'
import { DashboardRefresher } from './_components/dashboard-refresher'
import { WorkspaceProvider } from '@web/context/workspace'
import { UpdateModal } from '@web/components/update-modal'
import { DashboardMain } from './_components/dashboard-main'

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
    const [supabase, cookieStore] = await Promise.all([createServerClient(), cookies()])
    const { data: { user } } = await supabase.auth.getUser()
    const wsId = cookieStore.get('plexo_workspace_id')?.value
    const wsName = cookieStore.get('plexo_workspace_name')?.value

    // Adapt Supabase user to the shape the sidebar/header components expect
    const sessionUser = user ? {
        id: user.id,
        email: user.email,
        name: user.user_metadata?.full_name ?? user.user_metadata?.name ?? user.email?.split('@')[0],
        image: user.user_metadata?.avatar_url,
    } : undefined

    return (
        <WorkspaceProvider
            initialId={wsId}
            initialName={wsName ? decodeURIComponent(wsName) : undefined}
            initialUserName={sessionUser?.name ?? undefined}
        >
            <div className="flex h-screen flex-col overflow-hidden bg-canvas">
                <MobileHeader user={sessionUser} />
                <div className="flex flex-1 overflow-hidden">
                    <Sidebar user={sessionUser} />
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

