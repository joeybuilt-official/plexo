// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import type { Page } from 'playwright'
import type { SimulationSession } from '../session.js'

export type PersonaWorker = (page: Page, session: SimulationSession) => Promise<void>

export interface Persona {
    id: string
    name: string
    description: string
    run: PersonaWorker
    viewport?: { width: number; height: number }
    userAgent?: string
}

export * from './new-user'
export * from './power-user'
export * from './mobile-mo'
export * from './others'
