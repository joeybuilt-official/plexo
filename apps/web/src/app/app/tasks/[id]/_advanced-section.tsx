// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { useViewMode } from '@web/hooks/use-view-mode'

/**
 * Renders children only when view mode is Advanced.
 * Used in server component pages to gate sections behind the toggle.
 */
export function AdvancedSection({ children }: { children: React.ReactNode }) {
    const { isAdvanced } = useViewMode()
    if (!isAdvanced) return null
    return <>{children}</>
}
