// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Hub page — in-app browseable catalog of Plexo extensions.
 *
 * Shows the full library from `extension_registry` (same source as
 * hub.getplexo.com) joined with the workspace's install status.
 * Layout mirrors Channels / Integrations / AI Models via ConfigListLayout.
 *
 * UI-audit Phase 2: the workspaceId is resolved from the client
 * workspace context inside HubClient now — no more env fallback to a
 * zero-uuid, which silently made the Hub read from the wrong workspace
 * for anyone browsing without a dev env override.
 */

import HubClient from './HubClient'

export const dynamic = 'force-dynamic'

export default function HubPage() {
    return <HubClient />
}
