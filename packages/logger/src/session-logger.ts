// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

import { DrizzleSessionLogStore } from './drizzle-session-log-store'
import type { SessionLogStore, SessionLogInsert } from './ports'

export type { SessionLogStore, SessionLogInsert } from './ports'

type InsertSessionLog = SessionLogInsert

export class SessionLogger {
    private sessionId: string
    private personaId?: string
    private store: SessionLogStore

    constructor(opts: { sessionId?: string; personaId?: string; store?: SessionLogStore }) {
        this.sessionId = opts.sessionId ?? crypto.randomUUID()
        this.personaId = opts.personaId
        // Default adapter is drizzle; tests inject a fake via `store`.
        this.store = opts.store ?? new DrizzleSessionLogStore()
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
