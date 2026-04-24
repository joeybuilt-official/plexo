// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { db, sessionLogs } from '@plexo/db'

type InsertSessionLog = typeof sessionLogs.$inferInsert

export class SessionLogger {
    private sessionId: string
    private personaId?: string

    constructor(opts: { sessionId?: string; personaId?: string }) {
        this.sessionId = opts.sessionId ?? crypto.randomUUID()
        this.personaId = opts.personaId
    }

    async log(eventOpts: Omit<InsertSessionLog, 'id' | 'sessionId' | 'personaId' | 'createdAt'>): Promise<void> {
        try {
            await db.insert(sessionLogs).values({
                ...eventOpts,
                sessionId: this.sessionId,
                personaId: this.personaId,
            })
        } catch (e) {
            console.error('Failed to write session log to DB', e)
        }
    }
}
