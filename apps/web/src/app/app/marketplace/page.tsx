// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Legacy redirect — the Hub now lives at /app/hub.
 * Preserved so any bookmark, doc, or agent-written link keeps working.
 */

import { redirect } from 'next/navigation'

export default function MarketplaceRedirect() {
    redirect('/app/hub')
}
