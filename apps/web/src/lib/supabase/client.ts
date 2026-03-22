// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { createBrowserClient } from '@supabase/ssr'

export function createClient() {
    return createBrowserClient(
        process.env.NEXT_PUBLIC_SUPABASE_AUTH_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_AUTH_ANON_KEY!,
    )
}
