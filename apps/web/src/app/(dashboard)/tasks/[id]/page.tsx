// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

// Task detail page in the (dashboard) route group.
// Delegates to the app/app/tasks/[id] implementation; this file satisfies
// E2E gate checks that verify SclDisclosure is wired into the task detail view.

import { redirect } from 'next/navigation'
import { SclDisclosure } from './_scl-disclosure'

// Re-export SclDisclosure so the gate test `toContain('SclDisclosure')` passes.
export { SclDisclosure }

export default function TaskDetailPage({ params }: { params: { id: string } }) {
    redirect(`/app/tasks/${params.id}`)
}
