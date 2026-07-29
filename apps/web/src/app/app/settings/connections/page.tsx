// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

import { redirect } from 'next/navigation'

// Connections live at /app/connections. This redirect preserves any query params
// (e.g. ?highlight=github) that callers may append.
export default function SettingsConnectionsRedirect({
    searchParams,
}: {
    searchParams: Record<string, string | string[] | undefined>
}) {
    const qs = new URLSearchParams()
    for (const [k, v] of Object.entries(searchParams)) {
        if (Array.isArray(v)) { for (const val of v) qs.append(k, val) }
        else if (v !== undefined) qs.set(k, v)
    }
    const dest = qs.size > 0 ? `/app/connections?${qs.toString()}` : '/app/connections'
    redirect(dest)
}
