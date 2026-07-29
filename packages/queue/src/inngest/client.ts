// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Inngest client (ADR-0006).
 *
 * Inngest is the durable-work substrate for cron + workflow chaining
 * (gmessages session refresh, stale-session monitor, libgmessages bump
 * canary, Levio smart-reply pipeline). Single-shot ordered work continues
 * to use the `tasks` queue; this client is for fan-out + retry + step
 * chaining, where the existing queue is awkward.
 *
 * Self-host posture: Inngest dev server runs as a compose service (see
 * docker-compose.yml). No SaaS dependency; durability lives in the same
 * Postgres as Plexo.
 */

import { Inngest, EventSchemas } from 'inngest'

/**
 * Event catalogue. Phase 4 + 5 + L will fill these in. Declared up-front so
 * function authors get type-checked event payloads from day one.
 */
export type GmessagesEvents = {
    'gmessages.message.received': {
        data: {
            workspaceId: string
            channelId: string
            threadId: string
            gmessagesMsgId: string
        }
    }
    'gmessages.session.refresh-requested': {
        data: { pairedSessionId: string; workspaceId: string }
    }
    'gmessages.session.stale-detected': {
        data: { pairedSessionId: string; workspaceId: string; staleSinceIso: string }
    }
    'levio.smart-reply.requested': {
        data: { workspaceId: string; channelId: string; threadId: string }
    }
    'memory.extract.requested': {
        data: {
            workspaceId: string
            userMessage: string
            assistantReply: string
            sessionId: string
            source: string
        }
    }
}

export const inngest = new Inngest({
    id: 'plexo',
    schemas: new EventSchemas().fromRecord<GmessagesEvents>(),
    eventKey: process.env.INNGEST_EVENT_KEY,
    // The dev server URL is read from INNGEST_BASE_URL when set; otherwise
    // the Inngest SDK auto-discovers via the standard env contract.
})
