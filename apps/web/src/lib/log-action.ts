// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

'use server'

import { SessionLogger } from '@plexo/logger'
import { DrizzleSessionLogStore } from '@plexo/db'

export async function logClientSideError(opts: {
    sessionId?: string
    personaId?: string
    route: string
    errorMessage: string
}) {
    const logger = new SessionLogger({
        sessionId: opts.sessionId,
        personaId: opts.personaId,
        store: new DrizzleSessionLogStore(),
    })

    await logger.log({
        eventType: 'error_boundary_hit',
        route: opts.route,
        action: 'react_error_boundary',
        errorMessage: opts.errorMessage,
    })
}
