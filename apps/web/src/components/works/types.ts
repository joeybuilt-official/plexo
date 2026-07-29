// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

import type { Work } from '@web/app/app/chat/_components/types'
import type { WorkKind } from './infer-kind-client'

export type { Work, WorkKind }

/**
 * WorkAction — events a renderer can emit back to the surrounding panel so
 * the panel owns all side-effects (toast, navigation, install, apply).
 * Phase 3 wires the shape; most renderers use `copy` only. Phase 4+ will
 * use `navigate` / `install` / `apply` / `run`.
 */
export type WorkAction =
    | { type: 'navigate', href: string, internal: boolean }
    | { type: 'copy', content: string }
    | { type: 'apply', target: string, payload: unknown }
    | { type: 'run', command: string }
    | { type: 'install', kind: 'tool' | 'connection', id: string }
    | { type: 'workbench', workId: string, kind: WorkKind, title: string }

export interface WorkRendererProps {
    work: Work
    viewMode?: 'preview' | 'code'
    onAction?: (action: WorkAction) => void
}
