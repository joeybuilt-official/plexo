// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { CommandCenter } from '../_components/command-center'
import { SystemHealth } from '../_components/system-health'
import { RSIProposalsPanel } from '../_components/rsi-proposals-panel'

export const dynamic = 'force-dynamic'

export default function OverviewPage() {
    return (
        <div className="flex flex-col gap-6 w-full max-w-5xl mx-auto pt-8 pb-10">
            <h1 className="text-2xl font-bold text-text-primary px-1">Overview</h1>
            <RSIProposalsPanel />
            <CommandCenter />
            <SystemHealth />
        </div>
    )
}
