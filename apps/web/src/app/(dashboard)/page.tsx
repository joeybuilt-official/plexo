// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { redirect } from 'next/navigation'
import { QuickSend } from './_components/quick-send'
import { DashboardRouter } from './_components/dashboard-router'
import { Greeting } from './_components/greeting'
import { SetupWizardGate } from '@web/components/onboarding/setup-wizard'

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
        <SetupWizardGate>
            <DashboardRouter defaultContent={
                <div className="flex flex-col gap-8 pb-10">
                    {/* Claude-style Hero Section */}
                    <div className="flex flex-col items-center justify-center pt-8 md:pt-16 pb-4">
                        <Greeting />
                        <div className="w-full max-w-3xl">
                            <QuickSend />
                        </div>
                    </div>


                    {/* Version */}
                    <p className="mt-8 text-center text-[10px] text-zinc-700">
                        v{process.env.NEXT_PUBLIC_APP_VERSION ?? '0.8.0-beta.1'}{process.env.NODE_ENV === 'development' ? ' · dev' : ''}
                    </p>
                </div>
            } />
        </SetupWizardGate>
    )
}

