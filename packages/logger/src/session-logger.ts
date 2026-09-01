// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

import type { SessionLogStore, SessionLogInsert } from './ports'

export type { SessionLogStore, SessionLogInsert } from './ports'

type InsertSessionLog = SessionLogInsert

export class SessionLogger {
    private sessionId: string
    private personaId?: string
    private store: SessionLogStore

    // `store` is required: choosing the persistence adapter is a composition
    // decision, and defaulting to the drizzle one here would drag @plexo/db
    // back into this package.
    constructor(opts: { sessionId?: string; personaId?: string; store: SessionLogStore }) {
        this.sessionId = opts.sessionId ?? crypto.randomUUID()
        this.personaId = opts.personaId
        this.store = opts.store
    }

    async log(eventOpts: Omit<InsertSessionLog, 'id' | 'sessionId' | 'personaId' | 'createdAt'>): Promise<void> {
        try {
            await this.store.append({
                ...eventOpts,
                sessionId: this.sessionId,
                personaId: this.personaId,
            } as InsertSessionLog)
        } catch (e) {
            console.error('Failed to write session log to DB', e)
        }
    }
}
