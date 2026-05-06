// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Inngest Express handler. Mounted by apps/api at /api/inngest. The
 * Inngest dev server registered with INNGEST_BASE_URL discovers the
 * functions via this endpoint at boot.
 *
 * Kept in @plexo/queue (not @plexo/api) so the api workspace doesn't need
 * to add `inngest` as a direct dep — it already lives in this package.
 */

import { serve } from 'inngest/express'
import { inngest } from './client.js'
import { inngestFunctions } from './index.js'

export const inngestExpressHandler = serve({
    client: inngest,
    functions: [...inngestFunctions],
})
