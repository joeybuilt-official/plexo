// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { redirect } from 'next/navigation'
import { createServerClient } from '@web/auth'

const API_BASE = process.env.INTERNAL_API_URL ?? 'http://localhost:3001'

export default async function SetupLayout({ children }: { children: React.ReactNode }) {
    const supabase = await createServerClient()
    const { data: { user } } = await supabase.auth.getUser()
    const userId = user?.id

    // If the user already has a workspace, setup is complete — redirect.
    if (userId) {
        try {
            const res = await fetch(
                `${API_BASE}/api/v1/workspaces?ownerId=${encodeURIComponent(userId)}&limit=1`,
                { cache: 'no-store' },
            )
            if (res.ok) {
                const data = await res.json() as { items?: Array<{ id: string }>; workspaces?: Array<{ id: string }> }
                const items = data.items ?? data.workspaces ?? []
                if (items[0]?.id) redirect('/')
            }
        } catch {
            // API unreachable — let them through so setup can self-recover
        }
    }

    return children
}
