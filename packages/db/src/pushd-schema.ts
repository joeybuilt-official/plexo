// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Pushd error tables — read-only foreign references
 *
 * These Drizzle definitions map to the postgres_fdw foreign tables imported
 * into the 'pushd' schema of the plexo_ops database.
 *
 * Setup: run infra/ops-db-setup.sh once after fresh postgres init.
 *
 * Plexo-Ops reads these for the autonomous improvement loop and ops dashboard.
 * NEVER write to these tables — they are views into Pushd's live data.
 */

import { pgSchema, uuid, text, integer, real, jsonb, timestamp } from 'drizzle-orm/pg-core'

const pushdSchema = pgSchema('pushd')

export const pushdErrors = pushdSchema.table('errors', {
    id: uuid('id').primaryKey(),
    appId: text('app_id').notNull(),
    fingerprint: text('fingerprint').notNull(),
    message: text('message').notNull(),
    type: text('type'),
    severity: text('severity').notNull().default('error'),
    occurrenceCount: integer('occurrence_count').notNull().default(1),
    affectedUsers: integer('affected_users').notNull().default(0),
    status: text('status').notNull().default('open'),
    stackTrace: text('stack_trace'),
    context: jsonb('context'),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
})

export const pushdErrorOccurrences = pushdSchema.table('error_occurrences', {
    id: uuid('id').primaryKey(),
    errorId: uuid('error_id').notNull(),
    appId: text('app_id').notNull(),
    url: text('url'),
    message: text('message'),
    stackTrace: text('stack_trace'),
    context: jsonb('context'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
})

export const pushdAnalyticsEvents = pushdSchema.table('analytics_events', {
    id: uuid('id').primaryKey(),
    appId: text('app_id').notNull(),
    eventName: text('event_name').notNull(),
    properties: jsonb('properties'),
    distinctId: text('distinct_id'),
    sessionId: text('session_id'),
    url: text('url'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
})

export const pushdDeployErrorSnapshots = pushdSchema.table('deploy_error_snapshots', {
    id: uuid('id').primaryKey(),
    deployId: uuid('deploy_id').notNull(),
    appId: text('app_id').notNull(),
    errorRateBefore: real('error_rate_before'),
    errorRateAfter: real('error_rate_after'),
    status: text('status').default('monitoring'),
    createdAt: timestamp('created_at', { withTimezone: true }),
})