// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Plexo Google Messages connector — private schema (ADR-0003).
 *
 * Connector-private state lives in the `plexo_gmessages` Postgres schema so the
 * future Signal / WhatsApp paired-session connectors can establish their own
 * `plexo_<name>` namespaces without colliding in `public`. Public-shared enums
 * (channel_type, auth_type, task_source) are extended in `schema.ts`.
 *
 * Setup: migration `0116_gmessages_phase2.sql`.
 */

import { pgSchema, uuid, text, integer, boolean, timestamp, primaryKey, index } from 'drizzle-orm/pg-core'
import { workspaces, installedConnections, channels } from './schema.js'

const gmessagesSchema = pgSchema('plexo_gmessages')

export const pairedSessionStateEnum = gmessagesSchema.enum('paired_session_state', [
    'paired',
    'active',
    'refreshing',
    'expired',
    'revoked',
    'errored',
])

export const pairedSessions = gmessagesSchema.table('paired_sessions', {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
    installedConnectionId: uuid('installed_connection_id')
        .notNull()
        .references(() => installedConnections.id, { onDelete: 'cascade' }),
    channelId: uuid('channel_id')
        .notNull()
        .references(() => channels.id, { onDelete: 'cascade' }),
    state: pairedSessionStateEnum('state').notNull().default('paired'),
    stateChangedAt: timestamp('state_changed_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    /** Flow heartbeat — last inbound message observed by the sidecar (ADR-0004). */
    lastInboundAt: timestamp('last_inbound_at', { withTimezone: true, mode: 'date' }),
    /** Liveness signal — accumulating decode-error count from the libgmessages session. */
    decodeErrorCount: integer('decode_error_count').default(0).notNull(),
    pairStartedAt: timestamp('pair_started_at', { withTimezone: true, mode: 'date' }),
    pairedAt: timestamp('paired_at', { withTimezone: true, mode: 'date' }),
    expiredAt: timestamp('expired_at', { withTimezone: true, mode: 'date' }),
    errorDetail: text('error_detail'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
}, (table: any) => [
    index('paired_sessions_workspace_idx').on(table.workspaceId),
    index('paired_sessions_state_inbound_idx').on(table.state, table.lastInboundAt),
])

export const messageDedupe = gmessagesSchema.table('message_dedupe', {
    workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** Google Messages canonical message ID. */
    gmessagesMsgId: text('gmessages_msg_id').notNull(),
    threadId: text('thread_id').notNull(),
    ingestedAt: timestamp('ingested_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
}, (table: any) => [
    primaryKey({ columns: [table.workspaceId, table.gmessagesMsgId] }),
    index('message_dedupe_ingested_at_idx').on(table.ingestedAt),
])

export const rcsFeatureCache = gmessagesSchema.table('rcs_feature_cache', {
    workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
    threadId: text('thread_id').notNull(),
    isRcs: boolean('is_rcs').notNull().default(false),
    supportsTyping: boolean('supports_typing').notNull().default(false),
    supportsReceipts: boolean('supports_receipts').notNull().default(false),
    supportsRichCards: boolean('supports_rich_cards').notNull().default(false),
    refreshedAt: timestamp('refreshed_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
}, (table: any) => [
    primaryKey({ columns: [table.workspaceId, table.threadId] }),
])

export type PairedSession = typeof pairedSessions.$inferSelect
export type PairedSessionInsert = typeof pairedSessions.$inferInsert
export type MessageDedupeRow = typeof messageDedupe.$inferSelect
export type RcsFeatureCacheRow = typeof rcsFeatureCache.$inferSelect
