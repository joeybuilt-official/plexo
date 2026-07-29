// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { useWorkspaceId } from '@web/context/workspace'
import { ActiveAgentsLive } from '../_components/active-agents-live'

export default function AgentsLivePage() {
    const workspaceId = useWorkspaceId()

    return (
        <div className="flex flex-col gap-4 p-4 md:p-6 max-w-3xl mx-auto w-full">
            <div>
                <h1 className="text-lg font-medium text-text-primary">Agents in action</h1>
                <p className="text-[12px] text-text-muted">
                    Live view of what each agent is working on right now. Expand an agent to follow its steps.
                </p>
            </div>
            {workspaceId ? (
                <ActiveAgentsLive workspaceId={workspaceId} />
            ) : (
                <p className="text-[11px] text-text-muted">Select a workspace to see active agents.</p>
            )}
        </div>
    )
}
