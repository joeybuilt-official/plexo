// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Session Fabric contract (Phase 1a) — the boundary/port for the fabric.
 *
 * Clean Architecture: this file is a pure DTO/domain boundary. It imports Zod
 * (a validation lib, no IO) only — never Drizzle, never a db client. The Drizzle
 * persistence adapter lives in `@plexo/db` (session-fabric-schema.ts) and is
 * column-for-column derived from these schemas.
 *
 * Field set is LOCKED for 1a. Dates are modelled as `Date` (persistence shape);
 * Phase 1b wire encoding (SSE/REST) reuses `SessionEventWire` and serialises at
 * the transport edge.
 */

import { z } from 'zod'

// ── Shared ───────────────────────────────────────────────────────

/** Arbitrary JSON payload — kept opaque at the contract; narrowed by consumers. */
export const jsonValue: z.ZodType<unknown> = z.unknown()

// ── Enums ────────────────────────────────────────────────────────

export const sessionStatus = z.enum(['active', 'paused', 'blocked', 'closed'])
export type SessionStatus = z.infer<typeof sessionStatus>

export const policyTier = z.enum(['observe', 'steer', 'drive'])
export type PolicyTier = z.infer<typeof policyTier>

export const sessionEventKind = z.enum([
    'message',
    'tool_call',
    'tool_result',
    'plan',
    'approval_request',
    'approval_decision',
    'status',
    'handoff',
    'usage',
    'outcome',
])
export type SessionEventKind = z.infer<typeof sessionEventKind>

export const actorType = z.enum(['user', 'agent', 'runner', 'system'])
export type ActorType = z.infer<typeof actorType>

export const outcomeKind = z.enum(['test', 'ci', 'gate', 'human', 'judge'])
export type OutcomeKind = z.infer<typeof outcomeKind>

export const participantKind = z.enum(['head', 'runner'])
export type ParticipantKind = z.infer<typeof participantKind>

export const participantSurface = z.enum(['cli', 'mobile', 'desktop', 'channel'])
export type ParticipantSurface = z.infer<typeof participantSurface>

export const participantRole = z.enum(['observer', 'steerer', 'driver'])
export type ParticipantRole = z.infer<typeof participantRole>

export const runnerBackend = z.enum(['agent-sdk', 'generic'])
export type RunnerBackend = z.infer<typeof runnerBackend>

export const runnerStatus = z.enum(['online', 'draining', 'offline'])
export type RunnerStatus = z.infer<typeof runnerStatus>

// ── Session ──────────────────────────────────────────────────────

export const session = z.object({
    id: z.string(), // ulid
    workspaceId: z.string().uuid(),
    title: z.string().nullable(),
    status: sessionStatus,
    driverId: z.string().nullable(),
    policyTier: policyTier.default('steer'),
    createdBy: z.string().uuid(),
    createdAt: z.date(),
    updatedAt: z.date(),
    closedAt: z.date().nullable(),
})
export type Session = z.infer<typeof session>

// ── SessionEvent (append-only) ───────────────────────────────────

/**
 * Ordering key is `seq` (per-session, gap-free at the app layer), NOT `id`.
 * `id` is an opaque global primary key and must never be used to order events.
 */
export const sessionEvent = z.object({
    id: z.string(), // opaque global PK — NOT an ordering key
    sessionId: z.string(),
    seq: z.number().int(),
    schemaVersion: z.number().int(),
    kind: sessionEventKind,
    actorType,
    actorId: z.string().nullable(),
    payload: jsonValue,

    // usage (nullable — only populated on usage/outcome-bearing events)
    model: z.string().nullable(),
    provider: z.string().nullable(),
    tokensIn: z.number().int().nullable(),
    tokensOut: z.number().int().nullable(),
    costUsd: z.number().nullable(),

    // learning-loop slots (all nullable — resolved asynchronously)
    outcomeKind: outcomeKind.nullable(),
    reward: z.number().min(-1).max(1).nullable(),
    /** Encodes the grader/gate VERSION that produced `reward` (e.g. "judge@v3"). */
    reward_source: z.string().nullable(),
    /** ids of memory/rules/decisions that influenced this event (json). */
    provenance: jsonValue.nullable(),
    /** Back-pointer: on a resolving outcome event, the `seq` of the cause event. */
    outcomeOfSeq: z.number().int().nullable(),
    resolvedAt: z.date().nullable(),

    createdAt: z.date(),
})
export type SessionEvent = z.infer<typeof sessionEvent>

/**
 * Event-sourced wire type — same shape as persisted, discriminated on `kind`
 * so REST/SSE (Phase 1b) can narrow per event kind without a separate schema.
 */
const sessionEventVariants = sessionEventKind.options.map((k) =>
    sessionEvent.extend({ kind: z.literal(k) }),
)
export const sessionEventWire = z.discriminatedUnion(
    'kind',
    sessionEventVariants as [
        (typeof sessionEventVariants)[number],
        ...(typeof sessionEventVariants)[number][],
    ],
)
export type SessionEventWire = z.infer<typeof sessionEventWire>

// ── SessionParticipant ───────────────────────────────────────────

export const sessionParticipant = z.object({
    sessionId: z.string(),
    participantId: z.string(),
    kind: participantKind,
    surface: participantSurface.nullable(),
    capabilities: jsonValue,
    role: participantRole.default('observer'),
    lastHeartbeat: z.date(),
    joinedAt: z.date(),
})
export type SessionParticipant = z.infer<typeof sessionParticipant>

// ── Runner ───────────────────────────────────────────────────────

export const runner = z.object({
    id: z.string(),
    workspaceId: z.string().uuid().nullable(),
    backend: runnerBackend,
    capabilities: jsonValue,
    status: runnerStatus,
    lastHeartbeat: z.date(),
    registeredAt: z.date(),
})
export type Runner = z.infer<typeof runner>

// ── Lease (one active lease per session) ─────────────────────────

export const lease = z.object({
    sessionId: z.string(), // PK — one active lease per session
    runnerId: z.string(),
    claimedAt: z.date(),
    claimedUntil: z.date(),
})
export type Lease = z.infer<typeof lease>
