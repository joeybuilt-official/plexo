// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * `/app/functions` → `/app/extensions` redirect.
 *
 * The old Functions page was replaced by `/app/extensions` in Phase 7.
 * This stub preserves bookmarks and any hard-coded links.
 */

import { redirect } from 'next/navigation'

export default function FunctionsRedirect() {
    redirect('/app/extensions')
}
