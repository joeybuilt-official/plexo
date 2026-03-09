// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { redirect } from 'next/navigation'

// Sprints are managed under /projects — redirect for backwards compatibility
export default function SprintsPage() {
    redirect('/projects')
}
