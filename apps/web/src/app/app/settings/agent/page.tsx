// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

// Legacy redirect — the Agents experience is now unified at /app/agents.
// Preserves the `?tab=` query string so deep-links still land on the right tab.
import { redirect } from 'next/navigation'

export const dynamic = 'force-dynamic'

export default function LegacyAgentConfigRedirect({
    searchParams,
}: {
    searchParams: { tab?: string }
}) {
    const tab = searchParams?.tab
    redirect(tab ? `/app/agents?tab=${encodeURIComponent(tab)}` : '/app/agents')
}
