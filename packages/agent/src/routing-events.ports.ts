// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Routing-event persistence port (Stage 3, providers cluster).
 *
 * `providers/router-v2/telemetry.ts` records every routing decision so it
 * survives a deploy and can be dashboarded. The drizzle adapter
 * (`routing-events.repository.ts`) is the only telemetry module permitted to
 * import the ORM. The fire-and-forget call and the "telemetry must never break
 * routing" swallow stay in the use case — an adapter that cannot write says so
 * by rejecting, and the caller decides that is survivable.
 */

/**
 * One `routing_events` row. Hand-declared and already flattened: the caller
 * maps its own event shape onto this, so the adapter holds no knowledge of
 * `RoutedEvent`.
 */
export interface RoutingEventRecord {
    workspaceId: string | null
    /** Present when the call originates from a task row (executor dispatch). */
    taskId: string | null
    taskType: string
    provider: string | null
    model: string | null
    fallbackEngaged: boolean
    selectorDurationMs: number
    /**
     * Reserved for the shadow-routing comparison; nothing populates it yet.
     * Carried on the record rather than defaulted inside the adapter so the
     * column stays visible to the caller.
     */
    shadowModelChoice: string | null
    modelRouted: boolean
}

export interface RoutingEventStore {
    /** Append one routing decision. Rejects on a write failure. */
    append(event: RoutingEventRecord): Promise<void>
}
