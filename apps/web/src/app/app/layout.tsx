// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { cookies, headers } from 'next/headers'
import { getAuth } from '@web/lib/auth'
import { Sidebar } from '@web/components/layout/sidebar'
import { MobileHeader } from '@web/components/layout/mobile-header'
import { DashboardRefresher } from './_components/dashboard-refresher'
import { WorkspaceProvider } from '@web/context/workspace'
import { UpdateModal } from '@web/components/update-modal'
import { IntegrationsNudgeModal } from '@web/components/integrations-nudge-modal'
import { FirstRunBanner } from '@web/components/first-run-banner'
import { PersonalityModalGate } from '@web/components/onboarding/personality-modal'
import { DashboardMain } from './_components/dashboard-main'
import { CommandPaletteMount } from './_components/command-palette-mount'
import { Toaster } from 'sonner'
import { ConfirmDialogProvider } from '@web/components/ui/confirm-dialog'
import { getWorkspaceId } from '@web/lib/workspace'
import { AnalyticsPreviewModal } from '@web/components/AnalyticsPreviewModal'
import { isSuperAdminEmail } from '@web/lib/super-admin'

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
    const [h, cookieStore] = await Promise.all([headers(), cookies()])
    const auth = getAuth()
    const session = await auth.api.getSession({ headers: h })
    const user = session?.user ?? null
    // The in-app updater (UpdateModal) polls the super-admin-gated
    // /api/v1/system/version on mount. Only mount it for super-admins so
    // normal users don't fire a guaranteed-403 request every page load.
    const isSuperAdmin = isSuperAdminEmail(user?.email)
    let wsId = cookieStore.get('plexo_workspace_id')?.value
    const wsName = cookieStore.get('plexo_workspace_name')?.value

    // If no workspace cookie, resolve (or auto-create) one for the user
    if (!wsId && user) {
        const resolvedId = await getWorkspaceId()
        if (resolvedId) wsId = resolvedId
    }

    // Adapt Better Auth user to the shape the sidebar/header components expect
    const sessionUser = user ? {
        id: user.id,
        email: user.email,
        name: user.name ?? user.email?.split('@')[0],
        image: user.image ?? null,
    } : undefined

    return (
        <>
            {/* Skip-to-content link — WCAG 2.4.1. Visually hidden until focused
                via keyboard Tab, then appears in the top-left with the azure
                accent. The target #main-content lives on DashboardMain. */}
            <a
                href="#main-content"
                className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[100] focus:rounded-md focus:bg-azure focus:px-3 focus:py-2 focus:text-text-primary"
            >
                Skip to content
            </a>
            <Toaster
                position="bottom-right"
                toastOptions={{
                    classNames: {
                        toast: 'bg-surface-1 border border-border text-text-primary text-sm',
                        description: 'text-text-muted text-xs',
                        actionButton: 'bg-azure text-white text-xs font-medium',
                        error: 'border-red-800/50',
                        warning: 'border-amber-800/40',
                    },
                }}
            />
            {user && <AnalyticsPreviewModal />}
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
                            <ConfirmDialogProvider>
                            <DashboardRefresher />
                            {isSuperAdmin && <UpdateModal />}
                            <IntegrationsNudgeModal />
                            <CommandPaletteMount />
                            <FirstRunBanner />
                            <PersonalityModalGate>
                            {children}
                            </PersonalityModalGate>
                            </ConfirmDialogProvider>
                        </DashboardMain>
                    </div>
                </div>
            </WorkspaceProvider>
        </>
    )
}

