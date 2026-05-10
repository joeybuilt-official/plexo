// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { CodeRenderer } from './CodeRenderer'
import type { WorkRendererProps } from '../types'

/**
 * YamlRenderer — Phase 3 does not pull in a yaml parser (would be ~15KB
 * but the build currently has none). We render YAML as syntax-highlighted
 * code; Phase 4 or 6 can promote to a tree once the dep is budgeted.
 */
export function YamlRenderer({ work }: WorkRendererProps) {
    return <CodeRenderer work={{ ...work, meta: { ...(work.meta ?? {}), language: 'yaml' } }} />
}
