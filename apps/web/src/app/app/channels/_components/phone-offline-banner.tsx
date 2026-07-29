// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Phone offline banner — copy locked by ADR-0005 §"Copy lock".
 * Sourced from `paired_sessions.state IN ('expired','errored','revoked')`.
 * Reconnect link deep-links to the gmessages pair flow.
 */

import Link from 'next/link'
import { AlertTriangle } from 'lucide-react'

export type ConnectionState =
    | 'paired'
    | 'active'
    | 'refreshing'
    | 'expired'
    | 'revoked'
    | 'errored'
    | null

const OFFLINE_STATES: ReadonlySet<ConnectionState> = new Set(['expired', 'revoked', 'errored'])

export function PhoneOfflineBanner({ state }: { state: ConnectionState }) {
    if (!OFFLINE_STATES.has(state)) return null
    return (
        <div className="flex items-start gap-3 rounded-md border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
            <div className="flex flex-col gap-1">
                <p className="text-text-primary">Your phone is offline. Messages will arrive when it reconnects.</p>
                <Link
                    href="/app/connections/gmessages/pair"
                    className="text-xs font-medium text-amber-400 hover:text-amber-300"
                >
                    Reconnect
                </Link>
            </div>
        </div>
    )
}
