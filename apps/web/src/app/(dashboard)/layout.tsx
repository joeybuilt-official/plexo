// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

// The (dashboard) route group (routines, insights, tasks) had no layout, so its
// top-level URLs rendered on the bare root layout — no sidebar, no workspace
// context. Reuse the exact same shell as /app/* so these pages live in the
// standard framework (Sidebar + WorkspaceProvider + app chrome).
export { default } from '../app/layout'
