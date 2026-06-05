// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

/**
 * Phase 9 — Read-only mode banner.
 *
 * When the active workspace has `settings.readOnlyMode=true`, the agent's
 * write tools are stripped at the bridge layer (see
 * packages/agent/src/connections/bridge.ts → loadConnectionTools). The
 * banner here gives the user a clear, constant cue that the workspace
 * is in dry-run mode and links to Settings → Agent → Limits to disable.
 */

import Link from 'next/link'
import { Eye } from 'lucide-react'
import { useWorkspace } from '@web/context/workspace'

export function ReadOnlyBanner() {
    const { workspace } = useWorkspace()
    const readOnly = Boolean((workspace?.settings as { readOnlyMode?: boolean } | null)?.readOnlyMode)

    if (!readOnly) return null

    return (
        <div className="mb-3 flex items-center gap-2 rounded-sm border border-amber-800/40 bg-amber-900/10 px-3 py-2 text-xs text-amber">
            <Eye className="h-3.5 w-3.5 shrink-0" />
            <span className="flex-1">
                <strong className="font-medium">Read-only mode is on.</strong>{' '}
                The agent can read, search, and analyze — but every write tool
                (GitHub push, Slack send, Notion create, SSH exec, etc.) has
                been stripped from this workspace.
            </span>
            <Link
                href="/app/agents?tab=limits"
                className="shrink-0 rounded border border-amber-800/40 bg-amber-900/20 px-2 py-1 font-medium text-amber hover:bg-amber-900/30 transition-colors"
            >
                Manage
            </Link>
        </div>
    )
}
