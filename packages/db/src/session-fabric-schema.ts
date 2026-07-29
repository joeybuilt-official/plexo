// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Session Fabric — persistence adapter (Phase 1a).
 *
 * Drizzle table defs, column-for-column matching the fabric contract in
 * `@plexo/session-fabric` (src/contract.ts). This is the outer/adapter ring:
 * the contract knows nothing about these tables. Re-exported from `schema.ts`
 * so drizzle-kit (config points at ./src/schema.ts) emits their migrations.
 */

import {
    pgTable,
    uuid,
    text,
    integer,
    bigserial,
    real,
    jsonb,
    pgEnum,
    timestamp,
    index,
    uniqueIndex,
    primaryKey,
} from 'drizzle-orm/pg-core'
import { workspaces } from './schema'

// ── Enums ────────────────────────────────────────────────────────

export const sessionStatusEnum = pgEnum('session_status', ['active', 'paused', 'blocked', 'closed'])
export const policyTierEnum = pgEnum('policy_tier', ['observe', 'steer', 'drive'])
export const sessionEventKindEnum = pgEnum('session_event_kind', [
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
export const sessionActorTypeEnum = pgEnum('session_actor_type', ['user', 'agent', 'runner', 'system'])
export const sessionOutcomeKindEnum = pgEnum('session_outcome_kind', ['test', 'ci', 'gate', 'human', 'judge'])
export const participantKindEnum = pgEnum('session_participant_kind', ['head', 'runner'])
export const participantSurfaceEnum = pgEnum('session_participant_surface', ['cli', 'mobile', 'desktop', 'channel'])
export const participantRoleEnum = pgEnum('session_participant_role', ['observer', 'steerer', 'driver'])
export const runnerBackendEnum = pgEnum('runner_backend', ['agent-sdk', 'generic'])
export const runnerStatusEnum = pgEnum('runner_status', ['online', 'draining', 'offline'])

// ── sessions ─────────────────────────────────────────────────────

export const sessions = pgTable('sessions', {
    id: text('id').primaryKey(), // ulid
    workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
    title: text('title'),
    status: sessionStatusEnum('status').default('active').notNull(),
    driverId: text('driver_id'),
    policyTier: policyTierEnum('policy_tier').default('steer').notNull(),
    // No FK: prod public.users is an FDW foreign table (-> pushd.auth.user);
    // Postgres cannot FK-reference a foreign table.
    createdBy: uuid('created_by').notNull(),
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { mode: 'date', withTimezone: true }).defaultNow().notNull(),
    closedAt: timestamp('closed_at', { mode: 'date', withTimezone: true }),
}, (table) => [
    index('sessions_workspace_status_idx').on(table.workspaceId, table.status),
])

// ── session_events (append-only) ─────────────────────────────────

export const sessionEvents = pgTable('session_events', {
    // Opaque global PK — NOT an ordering key. Order events by (session_id, seq).
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    sessionId: text('session_id')
        .notNull()
        .references(() => sessions.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    schemaVersion: integer('schema_version').default(1).notNull(),
    kind: sessionEventKindEnum('kind').notNull(),
    actorType: sessionActorTypeEnum('actor_type').notNull(),
    actorId: text('actor_id'),
    payload: jsonb('payload').notNull(),

    model: text('model'),
    provider: text('provider'),
    tokensIn: integer('tokens_in'),
    tokensOut: integer('tokens_out'),
    costUsd: real('cost_usd'),

    outcomeKind: sessionOutcomeKindEnum('outcome_kind'),
    reward: real('reward'),
    rewardSource: text('reward_source'),
    provenance: jsonb('provenance'),
    outcomeOfSeq: integer('outcome_of_seq'),
    resolvedAt: timestamp('resolved_at', { mode: 'date', withTimezone: true }),

    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true }).defaultNow().notNull(),
}, (table) => [
    uniqueIndex('session_events_session_seq_uq').on(table.sessionId, table.seq),
])

// ── session_participants ─────────────────────────────────────────

export const sessionParticipants = pgTable('session_participants', {
    sessionId: text('session_id')
        .notNull()
        .references(() => sessions.id, { onDelete: 'cascade' }),
    participantId: text('participant_id').notNull(),
    kind: participantKindEnum('kind').notNull(),
    surface: participantSurfaceEnum('surface'),
    capabilities: jsonb('capabilities').notNull(),
    role: participantRoleEnum('role').default('observer').notNull(),
    lastHeartbeat: timestamp('last_heartbeat', { mode: 'date', withTimezone: true }).defaultNow().notNull(),
    joinedAt: timestamp('joined_at', { mode: 'date', withTimezone: true }).defaultNow().notNull(),
}, (table) => [
    primaryKey({ columns: [table.sessionId, table.participantId] }),
    index('session_participants_heartbeat_idx').on(table.lastHeartbeat),
])

// ── runners ──────────────────────────────────────────────────────

export const runners = pgTable('runners', {
    id: text('id').primaryKey(),
    workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
    backend: runnerBackendEnum('backend').notNull(),
    capabilities: jsonb('capabilities').notNull(),
    status: runnerStatusEnum('status').default('online').notNull(),
    lastHeartbeat: timestamp('last_heartbeat', { mode: 'date', withTimezone: true }).defaultNow().notNull(),
    registeredAt: timestamp('registered_at', { mode: 'date', withTimezone: true }).defaultNow().notNull(),
}, (table) => [
    index('runners_status_idx').on(table.status),
])

// ── leases (one active lease per session) ────────────────────────

export const leases = pgTable('leases', {
    sessionId: text('session_id')
        .primaryKey()
        .references(() => sessions.id, { onDelete: 'cascade' }),
    runnerId: text('runner_id')
        .notNull()
        .references(() => runners.id, { onDelete: 'cascade' }),
    claimedAt: timestamp('claimed_at', { mode: 'date', withTimezone: true }).defaultNow().notNull(),
    claimedUntil: timestamp('claimed_until', { mode: 'date', withTimezone: true }).notNull(),
}, (table) => [
    index('leases_runner_idx').on(table.runnerId),
])

export type SessionRow = typeof sessions.$inferSelect
export type SessionEventRow = typeof sessionEvents.$inferSelect
export type SessionParticipantRow = typeof sessionParticipants.$inferSelect
export type RunnerRow = typeof runners.$inferSelect
export type LeaseRow = typeof leases.$inferSelect
