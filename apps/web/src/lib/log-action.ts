// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use server'

import { SessionLogger } from '@plexo/logger'

export async function logClientSideError(opts: {
    sessionId?: string
    personaId?: string
    route: string
    errorMessage: string
}) {
    const logger = new SessionLogger({
        sessionId: opts.sessionId,
        personaId: opts.personaId,
    })

    await logger.log({
        eventType: 'error_boundary_hit',
        route: opts.route,
        action: 'react_error_boundary',
        errorMessage: opts.errorMessage,
    })
}
