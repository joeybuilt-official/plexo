// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

import { redirect } from 'next/navigation'
import { QuickSend } from '../_components/quick-send'
import { Greeting } from '../_components/greeting'
import { HomeActivity } from '../_components/home-activity'
import { SetupWizardGate } from '@web/components/onboarding/setup-wizard'
import { apiFetch } from '@web/lib/api-server'

export const dynamic = 'force-dynamic'
export const revalidate = 0

async function isFirstRun(): Promise<boolean> {
    try {
        const res = await apiFetch(`/api/v1/workspaces`, { cache: 'no-store', signal: AbortSignal.timeout(2000) })
        if (!res.ok) return false
        const data = await res.json() as { items?: unknown[] }
        return (data.items?.length ?? 0) === 0
    } catch {
        return false // API unreachable — let dashboard render and fail gracefully
    }
}

export default async function HomePage() {
    if (await isFirstRun()) redirect('/setup')

    // UI-audit Phase 3: the DashboardRouter indirection is gone. The
    // runtime-based tauri / capacitor branches never shipped for a real
    // user (no tauri build target in apps/), and the browser branch just
    // fell through to this defaultContent block. Inlined directly.
    return (
        <SetupWizardGate>
            <div className="flex flex-col gap-6 pb-10">
                {/* Input-first hero: greeting + QuickSend */}
                <div className="flex flex-col items-center justify-center pt-6 md:pt-12 pb-2">
                    <Greeting />
                    <div className="w-full max-w-3xl">
                        <QuickSend />
                    </div>
                </div>

                {/* Activity feed: recent work + conversations */}
                <HomeActivity />

                {/* Version */}
                <p className="mt-4 text-center text-[11px] text-text-muted">
                    v{process.env.NEXT_PUBLIC_APP_VERSION ?? '0.8.0-beta.1'}{process.env.NODE_ENV === 'development' ? ' · dev' : ''}
                </p>
            </div>
        </SetupWizardGate>
    )
}

