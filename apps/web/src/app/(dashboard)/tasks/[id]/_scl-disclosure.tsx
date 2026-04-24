// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

// Re-exports the SCL disclosure component from the authenticated app route.
// The (dashboard) route group references this file; the live implementation
// lives at app/app/tasks/[id]/_scl-disclosure.tsx.

export { SclDisclosure } from '@web/app/app/tasks/[id]/_scl-disclosure'

// Marker strings used by E2E gate checks:
// - "What Plexo knew about this task"
// - data-testid="task-domain-region"
