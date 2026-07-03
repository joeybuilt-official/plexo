// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Drizzle adapter for the Jex identity mesh (ADR-0016 B3).
 *
 * Implements JexRecognitionRepository. Writes go to the dedicated
 * `jex_recognitions` table (never the users FDW, whose ON CONFLICT 500s).
 * Profile reads join canonical email/name from `users` (a read of the FDW is
 * safe) with the distinct set of apps that recognized the user.
 */

import { desc, eq, sql } from 'drizzle-orm'
import { db, jexRecognitions, users } from '@plexo/db'
import type {
    CanonicalProfile,
    JexRecognitionRepository,
    RecognitionInput,
} from '../application/jex/ports.js'

export const drizzleJexRecognitionRepository: JexRecognitionRepository = {
    async record(input: RecognitionInput): Promise<void> {
        await db
            .insert(jexRecognitions)
            .values({
                appId: input.appId,
                userId: input.userId,
                email: input.email,
                credentialId: input.credentialId,
            })
            .onConflictDoUpdate({
                target: [jexRecognitions.appId, jexRecognitions.userId, jexRecognitions.credentialId],
                set: { email: input.email, seenAt: sql`now()` },
            })
    },

    async getProfile(userId: string): Promise<CanonicalProfile | null> {
        const [user] = await db
            .select({ email: users.email, name: users.name })
            .from(users)
            .where(eq(users.id, userId))
            .limit(1)

        const recs = await db
            .select({ appId: jexRecognitions.appId, email: jexRecognitions.email })
            .from(jexRecognitions)
            .where(eq(jexRecognitions.userId, userId))
            .orderBy(desc(jexRecognitions.seenAt))

        // Unknown identity: neither a Plexo user row nor any recognition.
        if (!user && recs.length === 0) return null

        return {
            userId,
            email: user?.email ?? recs[0]?.email ?? '',
            name: user?.name ?? '',
            apps: [...new Set(recs.map((r) => r.appId))],
        }
    },
}
