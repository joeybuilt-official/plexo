// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Inngest Express handler. Mounted by apps/api at /api/inngest. The
 * Inngest dev server registered with INNGEST_BASE_URL discovers the
 * functions via this endpoint at boot.
 *
 * Kept in @plexo/queue (not @plexo/api) so the api workspace doesn't need
 * to add `inngest` as a direct dep — it already lives in this package.
 *
 * Phase 1 of ADR-0010 (Graphiti adoption) added `createInngestExpressHandler`
 * so apps/api can register cross-package Inngest functions (e.g. memory
 * extract from @plexo/agent) without queue depending on agent.
 */

import { serve } from 'inngest/express'
import { inngest } from './client.js'
import { inngestFunctions } from './index.js'

type ServeFunctions = Parameters<typeof serve>[0]['functions']

export function createInngestExpressHandler(extra: ServeFunctions = []): ReturnType<typeof serve> {
    return serve({
        client: inngest,
        functions: [...inngestFunctions, ...extra],
    })
}

export const inngestExpressHandler = createInngestExpressHandler()
