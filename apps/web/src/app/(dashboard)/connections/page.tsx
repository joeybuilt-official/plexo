// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Connections page — promoted from /settings/connections to top-level.
 * Kapsel v0.3.0: Connection is a first-class pillar alongside Extension and Agent.
 *
 * Re-exports the existing ConnectionsPage component from settings.
 * The actual implementation remains in settings/connections for now.
 */

'use client'

export const dynamic = 'force-dynamic'

import dynamic_ from 'next/dynamic'

const ConnectionsContent = dynamic_(
    () => import('../settings/connections/page'),
    { loading: () => <div className="flex items-center justify-center py-16"><div className="h-5 w-5 animate-spin rounded-full border-2 border-border border-t-azure" /></div> }
)

export default function ConnectionsPage() {
    return <ConnectionsContent />
}
