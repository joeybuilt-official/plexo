// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

// SEC-028: No Postgres RLS — workspace isolation is enforced at the application layer
// (all queries filter by workspaceId via middleware). This is a deliberate decision:
// Drizzle ORM does not support RLS policies, and the API already validates workspace
// membership before every query. If migrating to a framework with RLS support, revisit.

import {
    pgTable,
    uuid,
    text,
    timestamp,
    boolean,
    integer,
    real,
    jsonb,
    pgEnum,
    date,
    index,
    uniqueIndex,
    primaryKey,
    varchar,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'

// ── Enums ────────────────────────────────────────────────────────

export const userRoleEnum = pgEnum('user_role', ['admin', 'member'])
export const memberRoleEnum = pgEnum('member_role', ['owner', 'admin', 'member', 'viewer'])

export const channelTypeEnum = pgEnum('channel_type', [
    'telegram',
    'slack',
    'discord',
    'whatsapp',
    'signal',
    'matrix',
    'irc',
    'webchat',
])

export const taskTypeEnum = pgEnum('task_type', [
    'coding',
    'deployment',
    'research',
    'ops',
    'opportunity',
    'monitoring',
    'report',
    'online',
    'automation',
    'writing',
    'general',
    'data',
    'marketing',
])

export type TaskType = (typeof taskTypeEnum.enumValues)[number]

export const taskStatusEnum = pgEnum('task_status', [
    'queued',
    'claimed',
    'running',
    'complete',
    'failed',
    'blocked',
    'cancelled',
])

export type TaskStatus = (typeof taskStatusEnum.enumValues)[number]

export const taskSourceEnum = pgEnum('task_source', [
    'telegram',
    'slack',
    'discord',
    'scanner',
    'github',
    'cron',
    'dashboard',
    'api',
    'extension',
    'sentry',
    'a2a',
    'webhook',
])

export const sprintStatusEnum = pgEnum('sprint_status', [
    'planning',
    'running',
    'finalizing',
    'complete',
    'failed',
    'cancelled',
])

export const sprintTaskStatusEnum = pgEnum('sprint_task_status', [
    'queued',
    'running',
    'complete',
    'blocked',
    'failed',
])

export const extensionTypeEnum = pgEnum('extension_type', [
    'agent',
    'skill',
    'channel',
    'tool',
    'connector',
    'mcp-server',
    'function',
])

export const memoryTypeEnum = pgEnum('memory_type', [
    'task',
    'incident',
    'session',
    'pattern',
])

export const docTypeEnum = pgEnum('doc_type', [
    'spec',
    'features',
    'decisions',
    'agents',
    'readme',
    'custom',
])

export const authTypeEnum = pgEnum('auth_type', [
    'oauth2',
    'api_key',
    'webhook',
    'none',
])

export const connectionStatusEnum = pgEnum('connection_status', [
    'active',
    'error',
    'expired',
    'disconnected',
])

export const calibrationEnum = pgEnum('calibration', [
    'over',
    'correct',
    'under',
])

export const cronRunStatusEnum = pgEnum('cron_run_status', [
    'success',
    'failure',
])

export const rsiStatusEnum = pgEnum('rsi_status', [
    'pending',
    'approved',
    'rejected',
])

export const sprintFileEventTypeEnum = pgEnum('sprint_file_event_type', ['lock', 'conflict', 'change', 'build_error', 'ts_error'])
export const sprintPatternTypeEnum = pgEnum('sprint_pattern_type', ['conflict_hotspot', 'complexity_signal', 'recurring_error'])


export const rsiRiskEnum = pgEnum('rsi_risk', [
    'low',
    'medium',
    'high',
])

// ── Users (FOREIGN TABLE) ────────────────────────────────────────
// `public.users` is a postgres_fdw foreign table mapped to `auth.user` in the
// `pushd` database (the Joeybuilt SSO identity store, managed by Better Auth).
//
// DO NOT insert/update/delete through this table from Plexo — writes happen in
// the auth service. Drizzle sees it as a normal table but the underlying object
// is a foreign table, which means:
//   - No defaultRandom() (id comes from Better Auth, text not uuid)
//   - No FK constraints CAN target this table (postgres limitation)
//   - Joins/selects work transparently via the FDW connection
//
// See docs/architecture/identity.md and scripts/setup-fdw.sql.
export const users = pgTable('users', {
    id: text('id').primaryKey(),           // Better Auth user id (text; current values happen to be UUIDs)
    name: text('name').notNull(),
    email: text('email').unique().notNull(),
    emailVerified: boolean('emailVerified').notNull(),
    image: text('image'),
    createdAt: timestamp('createdAt', { mode: 'date', withTimezone: true }).notNull(),
    updatedAt: timestamp('updatedAt', { mode: 'date', withTimezone: true }).notNull(),
    role: text('role'),
    banned: boolean('banned'),
    banReason: text('banReason'),
    banExpires: timestamp('banExpires', { mode: 'date', withTimezone: true }),
})

// ── Core Tables ──────────────────────────────────────────────────

export const workspaces = pgTable('workspaces', {
    id: uuid('id').defaultRandom().primaryKey(),
    name: text('name').notNull(),
    // owner_id → users.id (foreign table, no FK possible at DB level)
    ownerId: text('owner_id').notNull(),
    settings: jsonb('settings').default('{}').notNull(),
    /**
     * Phase 0 of the intelligence overhaul (slot 0076). Workspace-level
     * intelligence stack configuration: inference mode, cost ceiling,
     * SCL tunables, re-embed job state. Subsequent phases populate keys
     * inside this JSONB; Phase 0 just lands the column.
     *
     * Shape (partial; phases extend):
     *   {
     *     inferenceMode?: 'auto' | 'byok' | 'proxy' | 'override'
     *     costCeilingUsd?: number      // monthly
     *     costCeilingMode?: 'soft_warn' | 'hard_block'
     *     scl?: { enabled, driftThreshold, expandDepth, expandWidth, ... }
     *     reembed?: { inProgressJobId?, lastRunAt? }
     *   }
     */
    intelligenceSettings: jsonb('intelligence_settings').default('{}').notNull(),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
})

export const workspaceKeyShares = pgTable('workspace_key_shares', {
    id: text('id').primaryKey(),  // ulid
    sourceWsId: uuid('source_ws_id')
        .notNull()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
    targetWsId: uuid('target_ws_id')
        .notNull()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
    providerKey: text('provider_key').notNull(),  // 'openai' | 'anthropic' | etc.
    // granted_by → users.id (foreign table)
    grantedBy: text('granted_by').notNull(),
    grantedAt: timestamp('granted_at', { mode: 'date' }).defaultNow().notNull(),
}, (table: any) => [
    index('key_shares_source_idx').on(table.sourceWsId),
    index('key_shares_target_idx').on(table.targetWsId),
    uniqueIndex('key_shares_unique_idx').on(table.sourceWsId, table.targetWsId, table.providerKey),
])

export const channels = pgTable('channels', {
    id: uuid('id').defaultRandom().primaryKey(),

    workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
    type: channelTypeEnum('type').notNull(),
    name: text('name').notNull(),
    config: jsonb('config').notNull(),
    enabled: boolean('enabled').default(true).notNull(),
    lastMessageAt: timestamp('last_message_at', { mode: 'date' }),
    errorCount: integer('error_count').default(0).notNull(),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
}, (table: any) => [
    index('channels_workspace_idx').on(table.workspaceId),
])

export const tasks = pgTable('tasks', {
    id: text('id').primaryKey(), // ulid
    workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
    type: taskTypeEnum('type').notNull(),
    status: taskStatusEnum('status').default('queued').notNull(),
    priority: integer('priority').default(1).notNull(),
    source: taskSourceEnum('source').notNull(),
    project: text('project'),
    // projectId links this task to the sprint/project that spawned it.
    // Null for standalone tasks (chat, cron, API). ON DELETE SET NULL so
    // deleting a sprint doesn't cascade-delete the task history.
    projectId: text('project_id').references((): any => sprints.id, { onDelete: 'set null' }), // eslint-disable-line @typescript-eslint/no-explicit-any
    parentId: text('parent_id').references((): any => tasks.id, { onDelete: 'set null' }), // eslint-disable-line @typescript-eslint/no-explicit-any -- self-ref
    context: jsonb('context').notNull(),
    qualityScore: real('quality_score'),
    confidenceScore: real('confidence_score'),
    tokensIn: integer('tokens_in'),
    tokensOut: integer('tokens_out'),
    costUsd: real('cost_usd'),
    /** Max USD this task may spend. null = use workspace default. */
    costCeilingUsd: real('cost_ceiling_usd'),
    /** Max output tokens. null = no per-task token cap. Maps to generateText maxTokens. */
    tokenBudget: integer('token_budget'),
    promptVersion: text('prompt_version'),
    outcomeSummary: text('outcome_summary'),
    /** Number of execution attempts — incremented when slot expires and task is requeued */
    attemptCount: integer('attempt_count').default(0).notNull(),
    /** Structured deliverable output — populated by task_complete tool */
    deliverable: jsonb('deliverable'),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
    claimedAt: timestamp('claimed_at', { mode: 'date' }),
    completedAt: timestamp('completed_at', { mode: 'date' }),
    /** Backoff: task not claimable until this time. Null = immediately available. */
    retryAfter: timestamp('retry_after', { mode: 'date' }),
}, (table: any) => [
    index('tasks_workspace_status_idx').on(table.workspaceId, table.status),
    index('tasks_workspace_project_idx').on(table.workspaceId, table.project),
    index('tasks_project_id_idx').on(table.projectId),
    index('tasks_parent_id_idx').on(table.parentId),
    index('tasks_status_retry_idx').on(table.status, table.retryAfter),
])

/**
 * conversations — chat/channel interaction log.
 * Separate from tasks: a conversation is a logged exchange, not an agent work item.
 * Tasks are only created when a user explicitly triggers agent execution.
 */
export const conversations = pgTable('conversations', {
    id: text('id').primaryKey(), // ulid
    workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
    sessionId: text('session_id'),
    source: text('source').notNull().default('dashboard'), // dashboard | telegram | slack | discord | api | widget
    message: text('message').notNull(),
    reply: text('reply'),
    errorMsg: text('error_msg'),
    status: text('status').notNull().default('complete'), // complete | failed | pending
    intent: text('intent'), // CONVERSATION | TASK | PROJECT — classifier output
    taskId: text('task_id').references((): any => tasks.id, { onDelete: 'set null' }), // eslint-disable-line @typescript-eslint/no-explicit-any
    /**
     * Origin channel reference — stored when the conversation started in an external channel.
     * Shape: { channel: 'telegram'|'slack'|'discord', channelId: string, chatId: string }
     * Used to route web-initiated replies back to the originating channel.
     */
    channelRef: jsonb('channel_ref').$type<{ channel: string; channelId: string; chatId: string } | null>().default(null),
    attachments: jsonb('attachments').$type<{ url: string; type: string; alt?: string }[]>().default([]).notNull(),
    /**
     * Running topic embedding for the session this turn belongs to.
     * Populated by the session resolver; used to decide continuity of future turns.
     * Stored as jsonb (number[]) — portable, no pgvector dependency.
     */
    sessionEmbedding: jsonb('session_embedding').$type<number[] | null>().default(null),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
}, (table: any) => [
    index('conversations_workspace_idx').on(table.workspaceId),
    index('conversations_workspace_created_idx').on(table.workspaceId, table.createdAt),
    index('conversations_session_idx').on(table.sessionId),
    index('conversations_ws_source_session_created_idx').on(table.workspaceId, table.source, table.sessionId, table.createdAt),
    index('conversations_ws_source_created_idx').on(table.workspaceId, table.source, table.createdAt),
])

export const taskSteps = pgTable('task_steps', {
    id: uuid('id').defaultRandom().primaryKey(),
    taskId: text('task_id')
        .notNull()
        .references(() => tasks.id, { onDelete: 'cascade' }),
    stepNumber: integer('step_number').notNull(),
    model: text('model'),
    tokensIn: integer('tokens_in'),
    tokensOut: integer('tokens_out'),
    toolCalls: jsonb('tool_calls'),
    outcome: text('outcome'),
    /** Serialized message context needed to resume from this step */
    stepState: jsonb('step_state'),
    /** True when task_complete was called in this step */
    isTerminal: boolean('is_terminal').default(false).notNull(),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
}, (table: any) => [
    index('task_steps_task_idx').on(table.taskId),
])

export const sprints = pgTable('sprints', {
    id: text('id').primaryKey(), // ulid
    workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
    repo: text('repo'),  // null for non-code projects
    // DEPRECATED: project-type card grid removed from UI. Column kept for
    // back-compat with existing rows and CLI/e2e sprint creation flows.
    // No new UI writes it; new web-initiated projects default to 'general'.
    category: text('category').notNull().default('code'),
    metadata: jsonb('metadata').notNull().default('{}'), // category-specific structured fields
    request: text('request').notNull(),
    status: sprintStatusEnum('status').default('planning').notNull(),
    totalTasks: integer('total_tasks').default(0).notNull(),
    completedTasks: integer('completed_tasks').default(0).notNull(),
    failedTasks: integer('failed_tasks').default(0).notNull(),
    conflictCount: integer('conflict_count').default(0).notNull(),
    qualityScore: real('quality_score'),
    totalTokens: integer('total_tokens'),
    costUsd: real('cost_usd'),
    /** Max USD the entire project (all tasks combined) may spend. null = unlimited within workspace ceiling. */
    costCeilingUsd: real('cost_ceiling_usd'),
    wallClockMs: integer('wall_clock_ms'),
    plannerIterations: integer('planner_iterations').default(0).notNull(),
    featuresCompleted: jsonb('features_completed').default('[]').notNull(),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
    completedAt: timestamp('completed_at', { mode: 'date' }),
}, (table: any) => [
    index('sprints_workspace_idx').on(table.workspaceId),
])

export const sprintTasks = pgTable('sprint_tasks', {
    id: text('id').primaryKey(), // ulid
    sprintId: text('sprint_id')
        .notNull()
        .references(() => sprints.id, { onDelete: 'cascade' }),
    description: text('description').notNull(),
    scope: jsonb('scope').notNull(), // string[]
    acceptance: text('acceptance').notNull(),
    branch: text('branch').notNull(),
    priority: integer('priority').default(1).notNull(),
    status: sprintTaskStatusEnum('status').default('queued').notNull(),
    handoff: jsonb('handoff'),
    workerContainerId: text('worker_container_id'),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
    completedAt: timestamp('completed_at', { mode: 'date' }),
}, (table: any) => [
    index('sprint_tasks_sprint_idx').on(table.sprintId),
    index('sprint_tasks_sprint_status_idx').on(table.sprintId, table.status),
])

export const sprintHandoffs = pgTable('sprint_handoffs', {
    id: text('id').primaryKey(),
    sprintId: text('sprint_id')
        .notNull()
        .references(() => sprints.id, { onDelete: 'cascade' }),
    taskId: text('task_id')
        .references(() => sprintTasks.id, { onDelete: 'cascade' }),
    summary: text('summary').notNull(),
    filesChanged: jsonb('files_changed').default('[]').notNull(),
    concerns: jsonb('concerns').default('[]').notNull(),
    suggestions: jsonb('suggestions').default('[]').notNull(),
    tokensUsed: integer('tokens_used').default(0).notNull(),
    toolCalls: integer('tool_calls').default(0).notNull(),
    durationMs: integer('duration_ms').default(0).notNull(),
    suspicious: boolean('suspicious').default(false).notNull(),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
}, (table: any) => [
    index('sprint_handoffs_sprint_idx').on(table.sprintId),
])

export const sprintFileEvents = pgTable('sprint_file_events', {
    id: text('id').primaryKey(),
    sprintId: text('sprint_id')
        .notNull()
        .references(() => sprints.id, { onDelete: 'cascade' }),
    repo: text('repo').notNull(),
    eventType: sprintFileEventTypeEnum('event_type').notNull(),
    filePath: text('file_path').notNull(),
    message: text('message'),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
}, (table: any) => [
    index('sprint_file_events_sprint_idx').on(table.sprintId),
    index('sprint_file_events_repo_path_idx').on(table.repo, table.filePath),
])

export const sprintPatterns = pgTable('sprint_patterns', {
    id: text('id').primaryKey(),
    repo: text('repo').notNull(),
    patternType: sprintPatternTypeEnum('pattern_type').notNull(),
    subject: text('subject').notNull(),
    occurrences: integer('occurrences').default(1).notNull(),
    avgDurationMs: integer('avg_duration_ms'),
    avgQuality: real('avg_quality'),
    data: jsonb('data').default('{}').notNull(),
    lastSeenAt: timestamp('last_seen_at', { mode: 'date' }).defaultNow().notNull(),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
}, (table: any) => [
    index('sprint_patterns_repo_idx').on(table.repo),
    uniqueIndex('sprint_patterns_repo_type_subject_idx').on(table.repo, table.patternType, table.subject),
])

export const extensions = pgTable('extensions', {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
    // Scoped package name — must match @scope/name format (§3.1)
    name: text('name').notNull(),
    version: text('version').notNull(),
    type: extensionTypeEnum('type').notNull(),
    // PEX spec version this manifest targets (e.g. '0.4.0')
    pexVersion: text('pex_version').notNull().default('0.4.0'),
    // Relative path to the entry point (§3.1)
    entry: text('entry').notNull(),
    // Full plexo.json contents (validated on install per §3.3)
    manifest: jsonb('manifest').notNull(),
    enabled: boolean('enabled').default(false).notNull(),
    // Extension-private settings storage (injected as sdk.storage via Redis)
    settings: jsonb('settings').default('{}').notNull(),
    /** 'pex' (plexo.json) or 'skillmd' (SKILL.md / Skill+) */
    source: text('source').default('pex').notNull(),
    /** Original SKILL.md file path (reference only, not used at runtime) */
    skillPath: text('skill_path'),
    /** Raw markdown body of SKILL.md (for prompt injection in standard mode) */
    skillContent: text('skill_content'),
    /** Parsed YAML frontmatter from SKILL.md (Skill+ extended fields stored here) */
    skillFrontmatter: jsonb('skill_frontmatter'),
    installedAt: timestamp('installed_at', { mode: 'date' }).defaultNow().notNull(),
}, (table: any) => [
    index('extensions_workspace_idx').on(table.workspaceId),
    // Unique per workspace — enables upsert during re-synthesis
    uniqueIndex('extensions_workspace_name_uq').on(table.workspaceId, table.name),
])

export const dashboardCards = pgTable('dashboard_cards', {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
    // user_id → users.id (foreign table; cascade enforced at app level)
    userId: text('user_id').notNull(),
    cardType: text('card_type').notNull(),
    position: jsonb('position').notNull(), // { x, y, w, h }
    config: jsonb('config').default('{}').notNull(),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
}, (table: any) => [
    index('dashboard_cards_user_idx').on(table.userId, table.workspaceId),
])

export const cronJobs = pgTable('cron_jobs', {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    schedule: text('schedule').notNull(),
    enabled: boolean('enabled').default(true).notNull(),
    /** Task type pushed to the queue when this job fires. Default: 'general' */
    taskType: text('task_type').notNull().default('general'),
    /** Arbitrary task context passed to queue.push() when this job fires. */
    taskContext: jsonb('task_context').notNull().default('{}'),
    /** Pre-computed next fire time. Updated after each run and on schedule change. */
    nextRunAt: timestamp('next_run_at', { mode: 'date' }),
    lastRunAt: timestamp('last_run_at', { mode: 'date' }),
    lastRunStatus: cronRunStatusEnum('last_run_status'),
    consecutiveFailures: integer('consecutive_failures').default(0).notNull(),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
})

export const memoryEntries = pgTable('memory_entries', {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
    type: memoryTypeEnum('type').notNull(),
    content: text('content').notNull(),
    /** 
     * AI-generated shorthand/facts/principles extraction. 
     * Minimizes token consumption when injected into agent prompts.
     */
    shorthand: text('shorthand'),
    // pgvector column — raw SQL needed until drizzle-orm has native vector support
    // embedding: vector(1536) — added via custom migration SQL
    metadata: jsonb('metadata').default('{}').notNull(),
    /**
     * Memory Gradient tier. Controls retrieval priority and eviction.
     * 'hot'    — recently accessed or high-signal; retrieved first
     * 'active' — default; standard retrieval
     * 'cold'   — aged-out; excluded from most retrievals unless explicitly requested
     */
    tier: text('tier').notNull().default('active'),
    /**
     * Phase 10 — Memory namespacing. Per-agent memory slices inside a
     * workspace. Existing rows default to 'default'; per-agent writes use
     * `agent-${agentId}`; the literal 'shared' namespace is read by any
     * agent but only written via the explicit writeShared helper.
     */
    namespace: text('namespace').notNull().default('default'),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
}, (table: any) => [
    index('memory_entries_workspace_type_idx').on(table.workspaceId, table.type),
    index('memory_entries_workspace_namespace_idx').on(table.workspaceId, table.namespace),
    index('memory_entries_workspace_namespace_type_idx').on(table.workspaceId, table.namespace, table.type),
    // FTS index created via migration 0089_audit_p1_schema.sql (Drizzle 0.39 does not support expression indexes inline)
])

export const workLedger = pgTable('work_ledger', {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
    taskId: text('task_id').references(() => tasks.id),
    type: text('type').notNull(),
    source: text('source').notNull(),
    tokensIn: integer('tokens_in'),
    tokensOut: integer('tokens_out'),
    costUsd: real('cost_usd'),
    qualityScore: real('quality_score'),
    confidenceScore: real('confidence_score'),
    calibration: calibrationEnum('calibration'),
    deliverables: jsonb('deliverables').default('[]').notNull(),
    wallClockMs: integer('wall_clock_ms'),
    /** Domain mastery: LLM-inferred domain tag (ADR-001). Nullable, feature-flagged. */
    domainTag: text('domain_tag'),
    /** Domain mastery: context hash for credit assignment (ADR-003). */
    contextHash: text('context_hash'),
    /** Domain mastery: rule keys + attractor IDs in prompt for invertible credit (Panel 2). */
    contextRuleKeys: jsonb('context_rule_keys').$type<string[] | null>(),
    completedAt: timestamp('completed_at', { mode: 'date' }).defaultNow().notNull(),
}, (table: any) => [
    index('work_ledger_workspace_idx').on(table.workspaceId),
    index('work_ledger_task_idx').on(table.taskId),
    index('work_ledger_type_idx').on(table.type),
    index('work_ledger_domain_tag_idx').on(table.workspaceId, table.domainTag),
])

// ── Domain Mastery (ADR-002) ────────────────────────────────────────────────

/** learning_events — normalized record of every learning mutation across all paths. */
export const learningEvents = pgTable('learning_events', {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
    domainTag: text('domain_tag'),
    /** reflection_rule | scl_mutation | improvement_proposal | correction_rule */
    eventType: text('event_type').notNull(),
    /** Source file: reflect.ts | reflect-scl.ts | self-improvement.ts | corrections.ts */
    sourceSurface: text('source_surface').notNull(),
    /** Rule key, attractor ID, or proposal ID — informational link back to the learning store. */
    sourceRef: text('source_ref'),
    /** Quality score of the task that triggered this event. */
    qualityContext: real('quality_context'),
    /** Context hash at time of triggering task — for credit assignment (ADR-003). */
    contextHash: text('context_hash'),
    /** Privacy flag: false = never shareable cross-workspace (Panel 7). */
    shareable: boolean('shareable').notNull().default(false),
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true }).defaultNow().notNull(),
}, (table: any) => [
    index('learning_events_workspace_idx').on(table.workspaceId),
    index('learning_events_workspace_domain_idx').on(table.workspaceId, table.domainTag),
    index('learning_events_context_hash_idx').on(table.contextHash),
])

/** plexo_ops_domain_metrics — per-domain quality aggregates, refreshed weekly by cron. */
export const domainMetrics = pgTable('plexo_ops_domain_metrics', {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
    domainTag: text('domain_tag').notNull(),
    periodStart: date('period_start').notNull(),
    avgQuality: real('avg_quality'),
    taskCount: integer('task_count').notNull().default(0),
    learningEventCount: integer('learning_event_count').notNull().default(0),
    qualityDelta: real('quality_delta'),
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true }).defaultNow().notNull(),
}, (table: any) => [
    uniqueIndex('domain_metrics_ws_domain_period_uq').on(table.workspaceId, table.domainTag, table.periodStart),
    index('domain_metrics_workspace_idx').on(table.workspaceId),
])

export const projectDocs = pgTable('project_docs', {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
    project: text('project').notNull(),
    type: docTypeEnum('type').notNull(),
    filename: text('filename').notNull(),
    content: text('content').notNull(),
    version: integer('version').default(1).notNull(),
    committedAt: timestamp('committed_at', { mode: 'date' }),
    commitSha: text('commit_sha'),
    autoGenerated: boolean('auto_generated').default(false).notNull(),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { mode: 'date' }).defaultNow().notNull(),
}, (table: any) => [
    index('project_docs_workspace_project_idx').on(table.workspaceId, table.project),
])

export const connectionsRegistry = pgTable('connections_registry', {
    id: text('id').primaryKey(), // e.g. 'github', 'stripe'
    name: text('name').notNull(),
    description: text('description').notNull(),
    category: text('category').notNull(),
    logoUrl: text('logo_url'),
    authType: authTypeEnum('auth_type').notNull(),
    oauthScopes: jsonb('oauth_scopes').default('[]').notNull(),
    setupFields: jsonb('setup_fields').default('[]').notNull(),
    toolsProvided: jsonb('tools_provided').default('[]').notNull(),
    cardsProvided: jsonb('cards_provided').default('[]').notNull(),
    isCore: boolean('is_core').default(false).notNull(),
    /** True for connections auto-generated by the agent synthesizer */
    isGenerated: boolean('is_generated').default(false).notNull(),
    docUrl: text('doc_url'),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
})

export const installedConnections = pgTable('installed_connections', {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
    registryId: text('registry_id')
        .notNull()
        .references(() => connectionsRegistry.id),
    name: text('name').notNull(),
    credentials: jsonb('credentials').notNull(), // encrypted at rest
    label: text('label').notNull().default('default'), // nickname for multi-account (unique per workspace+registry+label)
    enabledTools: jsonb('enabled_tools').$type<string[] | null>().default(null), // null = all enabled
    scopesGranted: jsonb('scopes_granted').default('[]').notNull(),
    status: connectionStatusEnum('status').default('active').notNull(),
    lastVerifiedAt: timestamp('last_verified_at', { mode: 'date' }),
    errorDetail: text('error_detail'),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
}, (table: any) => [
    uniqueIndex('installed_connections_workspace_registry_label_uq').on(table.workspaceId, table.registryId, table.label),
    index('installed_connections_workspace_idx').on(table.workspaceId),
    index('installed_connections_registry_idx').on(table.registryId),
])

export const apiCostTracking = pgTable('api_cost_tracking', {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
    weekStart: date('week_start').notNull(),
    costUsd: real('cost_usd').default(0).notNull(),
    ceilingUsd: real('ceiling_usd').default(10).notNull(),
    alerted80: boolean('alerted_80').default(false).notNull(),
    paused: boolean('paused').default(false).notNull(),
}, (table: any) => [
    uniqueIndex('api_cost_workspace_week_idx').on(table.workspaceId, table.weekStart),
])

// ── Memory + self-improvement tables (Phase 6) ───────────────────

export const workspacePreferences = pgTable('workspace_preferences', {
    workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    value: jsonb('value').notNull(),
    confidence: real('confidence').default(0.5).notNull(),
    evidenceCount: integer('evidence_count').default(1).notNull(),
    lastUpdated: timestamp('last_updated', { mode: 'date' }).defaultNow().notNull(),
    /**
     * Phase 10 — Memory namespacing. Scopes preferences per-agent while
     * preserving the existing (workspace_id, key) primary key so legacy
     * rows remain addressable without migration. New reads/writes may
     * filter on namespace; un-namespaced callers still see 'default'.
     */
    namespace: text('namespace').notNull().default('default'),
}, (table: any) => [
    primaryKey({ columns: [table.workspaceId, table.key] }),
    index('workspace_preferences_workspace_idx').on(table.workspaceId),
    index('workspace_preferences_workspace_namespace_idx').on(table.workspaceId, table.namespace),
])

export const agentImprovementLog = pgTable('agent_improvement_log', {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
    patternType: text('pattern_type').notNull(), // failure_pattern | success_pattern | tool_preference | scope_adjustment | skill_proposal | extension_proposal | agent_proposal — use 'extension_proposal' for new writes (replaces legacy 'plugin_proposal')
    description: text('description').notNull(),
    evidence: jsonb('evidence').default('[]').notNull(), // task IDs
    proposedChange: text('proposed_change'),
    applied: boolean('applied').default(false).notNull(),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
}, (table: any) => [
    index('agent_improvement_log_workspace_idx').on(table.workspaceId),
])

// ── Phase 11 — Workspace membership + invites ─────────────────────────────────

export const workspaceMembers = pgTable('workspace_members', {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
    // user_id → users.id (foreign table; cascade enforced at app level)
    userId: text('user_id').notNull(),
    role: memberRoleEnum('role').default('member').notNull(),
    // invited_by_user_id → users.id (foreign table)
    invitedByUserId: text('invited_by_user_id'),
    joinedAt: timestamp('joined_at', { mode: 'date' }).defaultNow().notNull(),
}, (table: any) => [
    uniqueIndex('workspace_members_workspace_user_idx').on(table.workspaceId, table.userId),
    index('workspace_members_workspace_idx').on(table.workspaceId),
    index('workspace_members_user_idx').on(table.userId),
])

export const workspaceInvites = pgTable('workspace_invites', {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
    token: text('token').notNull().unique(),
    invitedEmail: text('invited_email'),
    role: memberRoleEnum('role').default('member').notNull(),
    // invited_by_user_id → users.id (foreign table)
    invitedByUserId: text('invited_by_user_id').notNull(),
    expiresAt: timestamp('expires_at', { mode: 'date' }).notNull(),
    usedAt: timestamp('used_at', { mode: 'date' }),
    // used_by_user_id → users.id (foreign table)
    usedByUserId: text('used_by_user_id'),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
}, (table: any) => [
    uniqueIndex('workspace_invites_token_idx').on(table.token),
    index('workspace_invites_workspace_idx').on(table.workspaceId),
])

// ── Extension Registry (§12) ─────────────────────────────────────────────────
// Public listing of extensions available for installation.
// Scoped: entries belong to a workspace (org/user namespace).

export const extensionRegistry = pgTable('extension_registry', {
    id: uuid('id').defaultRandom().primaryKey(),
    /** Scoped package name e.g. @acme/stripe-monitor */
    name: text('name').notNull().unique(),
    /** Display name */
    displayName: text('display_name').notNull(),
    /** Short description */
    description: text('description').notNull(),
    /** Publisher workspace or user handle */
    publisher: text('publisher').notNull(),
    /** Latest published version */
    latestVersion: text('latest_version').notNull(),
    /** All published versions (ordered newest first) */
    versions: jsonb('versions').$type<string[]>().default([]).notNull(),
    /** Full plexo.json manifest for the latest version */
    manifest: jsonb('manifest').notNull(),
    /** Tags for discovery */
    tags: text('tags').array().default([]).notNull(),
    /** Install count (approximate, not trusted for billing) */
    installCount: integer('install_count').default(0).notNull(),
    /** Deprecated: set by publisher, hidden from search */
    deprecated: boolean('deprecated').default(false).notNull(),
    /** SHA-256 of the published bundle (for integrity verification) */
    checksum: text('checksum'),
    /** Source repository URL */
    repositoryUrl: text('repository_url'),
    /** Primary category for Hub browse filtering */
    category: text('category').default('other').notNull(),
    /** Full README markdown content */
    readme: text('readme').default('').notNull(),
    /** Icon image URL */
    iconUrl: text('icon_url'),
    /** Extension package signature payload (base64 ECDSA or Sigstore bundle JSON). Null = unsigned. */
    signature: text('signature'),
    /** 'sigstore' | 'ecdsa-p256' | null. See packages/sdk/src/validation/signature.ts. */
    signatureType: text('signature_type'),
    /** Human-readable signer identity, e.g. plexo-bot@your-org. */
    signerIdentity: text('signer_identity'),
    /** Timestamp the package was signed (set by publisher pipeline, not verified by host). */
    signedAt: timestamp('signed_at', { mode: 'date', withTimezone: true }),
    // ── Attribution for imported third-party items (slot 0075) ──
    /** Direct link to the upstream source file the item was imported from. */
    sourceUrl: text('source_url'),
    /** Upstream author name/handle. */
    sourceAuthor: text('source_author'),
    /** Upstream license string (e.g. "MIT", "Apache-2.0"). */
    sourceLicense: text('source_license'),
    /** Upstream repository root URL. */
    sourceRepo: text('source_repo'),
    publishedAt: timestamp('published_at', { mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { mode: 'date' }).defaultNow().notNull(),
}, (table: any) => [
    index('extension_registry_name_idx').on(table.name),
    index('extension_registry_publisher_idx').on(table.publisher),
    index('extension_registry_deprecated_idx').on(table.deprecated),
    index('extension_registry_signer_idx').on(table.signerIdentity),
])

// ── Phase 13 — Audit log ──────────────────────────────────────────────────────

export const auditLog = pgTable('audit_log', {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: text('user_id'),  // → users.id (foreign table). null for system events.
    action: text('action').notNull(),                    // e.g. 'member.add', 'plugin.install', 'task.create'
    resource: text('resource').notNull(),                // table name or resource type
    resourceId: text('resource_id'),                     // optional target entity ID
    metadata: jsonb('metadata').default('{}').notNull(), // extra context (role, email, etc.)
    ip: text('ip'),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
}, (table: any) => [
    index('audit_log_workspace_idx').on(table.workspaceId),
    index('audit_log_action_idx').on(table.action),
    index('audit_log_created_idx').on(table.createdAt),
])

// ── Phase 5 — Agent Behavior Configuration ───────────────────────────────────

export const ruleTypeEnum = pgEnum('rule_type', [
    'safety_constraint',
    'operational_rule',
    'communication_style',
    'domain_knowledge',
    'persona_trait',
    'tool_preference',
    'quality_gate',
])

export const ruleSourceEnum = pgEnum('rule_source', [
    'platform',
    'workspace',
    'project',
    'task',
    'extension',
    'reflection',
])

export const artifactPriorityEnum = pgEnum('artifact_priority', [
    'low',
    'normal',
    'high',
    'critical',
])

/**
 * behavior_rules — structured agent behavior rules with inheritance.
 * Source hierarchy: platform → workspace → project → task (later wins).
 */
export const behaviorRules = pgTable('behavior_rules', {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** null = workspace-level rule */
    projectId: uuid('project_id'),
    type: ruleTypeEnum('type').notNull(),
    /** Machine-readable key, unique within (workspace, project) scope */
    key: text('key').notNull(),
    label: text('label').notNull(),
    description: text('description').notNull().default(''),
    /** Typed value: { type: 'boolean'|'string'|'number'|'enum'|'text_block'|'json', value, ...meta } */
    value: jsonb('value').notNull(),
    /** Safety constraints cannot be deleted or toggled off */
    locked: boolean('locked').notNull().default(false),
    source: ruleSourceEnum('source').notNull().default('workspace'),
    /** Self-referential: which parent rule this overrides */
    overridesRuleId: uuid('overrides_rule_id'),
    tags: text('tags').array().notNull().default(sql`'{}'`),
    /** Privacy: false = never shareable cross-workspace (Panel 7, People's Model Commons prep). */
    shareable: boolean('shareable').notNull().default(false),
    /** Soft delete */
    deletedAt: timestamp('deleted_at', { mode: 'date' }),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { mode: 'date' }).defaultNow().notNull(),
}, (table: any) => [
    index('behavior_rules_workspace_idx').on(table.workspaceId),
    index('behavior_rules_project_idx').on(table.projectId),
    index('behavior_rules_type_idx').on(table.type),
    index('behavior_rules_deleted_idx').on(table.deletedAt),
    /** Partial unique: one active (non-deleted) rule per workspace+key. Used by reflect.ts ON CONFLICT upsert. */
    uniqueIndex('behavior_rules_ws_key').on(table.workspaceId, table.key).where(sql`deleted_at IS NULL`),
])

/**
 * behavior_groups — card groups shown in UI (seeded, not user-editable).
 */
export const behaviorGroups = pgTable('behavior_groups', {
    id: text('id').primaryKey(), // e.g. 'safety', 'communication'
    label: text('label').notNull(),
    description: text('description').notNull().default(''),
    icon: text('icon').notNull().default('Circle'),
    ruleTypes: ruleTypeEnum('rule_types').array().notNull(),
    locked: boolean('locked').notNull().default(false),
    color: text('color').notNull().default('zinc'),
    displayOrder: integer('display_order').notNull().default(0),
})

// ── MCP Tokens ──────────────────────────────────────────────────────────────
// Hashed API tokens for MCP transport. Raw value shown once on creation.
// SHA-256 with per-token random salt. type='mcp' required for MCP transport.

export const mcpTokens = pgTable('mcp_tokens', {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    tokenHash: text('token_hash').notNull(),   // SHA-256(raw + salt)
    tokenSalt: text('token_salt').notNull(),   // random 32-byte hex
    scopes: text('scopes').array().notNull().default(sql`'{}'`),
    type: text('type').notNull().default('mcp'),
    revoked: boolean('revoked').notNull().default(false),
    expiresAt: timestamp('expires_at', { mode: 'date' }),
    lastUsedAt: timestamp('last_used_at', { mode: 'date' }),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
}, (table: any) => [
    index('mcp_tokens_workspace_idx').on(table.workspaceId),
    index('mcp_tokens_hash_idx').on(table.tokenHash),
])

/**
 * behavior_snapshots — version history, one per task/sprint start or manual preview.
 */
export const behaviorSnapshots = pgTable('behavior_snapshots', {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id'),
    /** Full resolved rule set at time of snapshot */
    snapshot: jsonb('snapshot').notNull(),
    /** Compiled system prompt fragment from this snapshot */
    compiledPrompt: text('compiled_prompt').notNull().default(''),
    /** 'manual' | 'task_start' | 'sprint_start' */
    triggeredBy: text('triggered_by').notNull().default('manual'),
    /** Task/sprint ID that triggered this snapshot */
    triggerResourceId: text('trigger_resource_id'),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
}, (table: any) => [
    index('behavior_snapshots_workspace_idx').on(table.workspaceId),
    index('behavior_snapshots_created_idx').on(table.createdAt),
])

// ── Sprint Logs (Real-time activity feed) ───────────────────────────────────────

export const sprintLogs = pgTable('sprint_logs', {
    id: uuid('id').defaultRandom().primaryKey(),
    sprintId: text('sprint_id')
        .notNull()
        .references(() => sprints.id, { onDelete: 'cascade' }),
    level: text('level').notNull().default('info'), // info | warn | error
    event: text('event').notNull(), // planning_start | task_queued | wave_start | task_running | task_complete | task_failed | sprint_complete | sprint_failed | conflict_detected | pr_created | budget_check
    message: text('message').notNull(),
    metadata: jsonb('metadata').default('{}').notNull(),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
}, (table: any) => [
    index('sprint_logs_sprint_idx').on(table.sprintId, table.createdAt),
    index('sprint_logs_sprint_level_idx').on(table.sprintId, table.level),
])

// ── Models Knowledge Base (Automated Routing) ──────────────────────────────────
export const modelsKnowledge = pgTable('models_knowledge', {
    id: text('id').primaryKey(),
    provider: text('provider').notNull(),
    modelId: text('model_id').notNull(),
    contextWindow: integer('context_window').default(128000).notNull(),
    costPerMIn: real('cost_per_m_in').notNull(),
    costPerMOut: real('cost_per_m_out').notNull(),
    strengths: jsonb('strengths').$type<string[]>().default([]).notNull(),
    reliabilityScore: real('reliability_score').default(1.0).notNull(),
    lastSyncedAt: timestamp('last_synced_at', { mode: 'date' }).defaultNow().notNull(),
}, (table: any) => [
    index('models_knowledge_provider_idx').on(table.provider),
    index('models_knowledge_model_idx').on(table.modelId),
])

// ── Provider Instances (Intelligence Page) ───────────────────────────────────────

export const providerInstances = pgTable('provider_instances', {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
    nickname: text('nickname').notNull(),
    providerType: text('provider_type').notNull(),
    endpointUrl: text('endpoint_url'),
    encryptedKey: text('encrypted_key'),
    capabilities: jsonb('capabilities').$type<{
        supportsChat: boolean
        supportsEmbeddings: boolean
        chatModels: string[]
        embeddingModels: string[]
        discoveryError: string | null
    }>().default({
        supportsChat: false,
        supportsEmbeddings: false,
        chatModels: [],
        embeddingModels: [],
        discoveryError: null,
    }).notNull(),
    preferenceOrder: integer('preference_order').default(0).notNull(),
    chatPreferenceOrder: integer('chat_preference_order'),
    embeddingPreferenceOrder: integer('embedding_preference_order'),
    managed: boolean('managed').default(false).notNull(),
    enabled: boolean('enabled').default(true).notNull(),
    selectedModel: text('selected_model'),
    /** Phase 1 — per-instance embedding model selection (e.g. text-embedding-3-small). */
    embeddingModel: text('embedding_model'),
    /** Phase 1 — dimension count captured at last successful embedding resolution. */
    embeddingDimensions: integer('embedding_dimensions'),
    /** Phase 1 — last time this provider successfully served an embedding call. */
    embeddingLastUsedAt: timestamp('embedding_last_used_at', { mode: 'date', withTimezone: true }),
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { mode: 'date', withTimezone: true }).defaultNow().notNull(),
    lastDiscoveredAt: timestamp('last_discovered_at', { mode: 'date', withTimezone: true }),
}, (table: any) => [
    index('idx_provider_instances_workspace').on(table.workspaceId, table.preferenceOrder),
    index('idx_provider_instances_type').on(table.workspaceId, table.providerType),
])

// ── Routing Chains (Phase 2b — intelligence overhaul) ─────────────────────────
//
// Per-task-type ranked fallback chains. Each (workspace, task_type) row set
// is the ordered list the IntelligentRouter walks. Smart-default seeded at
// API container startup; user-edited via the chain editor in
// `/app/settings/intelligence`. Idempotent via the unique index.

export const routingChains = pgTable('routing_chains', {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
    taskType: text('task_type').notNull(),
    providerId: uuid('provider_id')
        .notNull()
        .references(() => providerInstances.id, { onDelete: 'cascade' }),
    modelId: text('model_id').notNull(),
    position: integer('position').notNull(),
    createdAt: timestamp('created_at', { mode: 'date', withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { mode: 'date', withTimezone: true }).defaultNow().notNull(),
}, (table: any) => [
    uniqueIndex('routing_chains_ws_task_pos').on(table.workspaceId, table.taskType, table.position),
    index('routing_chains_ws_task').on(table.workspaceId, table.taskType),
])

export type RoutingChainRow = typeof routingChains.$inferSelect

// ── RSI (Real-Time Self-Inspection) ────────────────────────────────────────────

export const rsiProposals = pgTable('rsi_proposals', {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
    anomalyType: text('anomaly_type').notNull(),
    hypothesis: text('hypothesis').notNull(),
    proposedChange: jsonb('proposed_change').default('{}').notNull(),
    risk: rsiRiskEnum('risk').default('medium').notNull(),
    status: rsiStatusEnum('status').default('pending').notNull(),
    /** Domain mastery: domain_tag of the tasks that contributed to this anomaly (ADR-001). */
    domainTag: text('domain_tag'),
    approvedAt: timestamp('approved_at', { mode: 'date' }),
    rejectedAt: timestamp('rejected_at', { mode: 'date' }),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
}, (table: any) => [
    index('rsi_proposals_workspace_idx').on(table.workspaceId),
    index('rsi_proposals_status_idx').on(table.status),
])

export const rsiTestResults = pgTable('rsi_test_results', {
    id: uuid('id').defaultRandom().primaryKey(),
    proposalId: uuid('proposal_id')
        .notNull()
        .references(() => rsiProposals.id, { onDelete: 'cascade' }),
    taskId: text('task_id').references(() => tasks.id),
    isShadow: boolean('is_shadow').default(true).notNull(),
    baselineQuality: real('baseline_quality'),
    shadowQuality: real('shadow_quality'),
    tokenDelta: integer('token_delta'),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
}, (table: any) => [
    index('rsi_test_results_proposal_idx').on(table.proposalId),
    index('rsi_test_results_task_idx').on(table.taskId),
])

// NOTE: FUN-043 — Indexes added (migration 0082). Retention policy runs weekly via data_retention cron job.
// Indexes added in migration 0082_session_work_indexes.sql (FUN-042, FUN-043)
// ── Phase 1 ─ Session Logs ────────────────────────────────────────────────────────
export const sessionLogs = pgTable('session_logs', {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id').notNull(),
    userId: text('user_id'),  // → users.id (foreign table)
    personaId: varchar('persona_id', { length: 64 }),
    eventType: varchar('event_type', { length: 64 }).notNull(),
    route: varchar('route', { length: 512 }),
    action: varchar('action', { length: 256 }),
    payload: jsonb('payload'),
    responseCode: integer('response_code'),
    responseBody: jsonb('response_body'),
    errorMessage: text('error_message'),
    errorStack: text('error_stack'),
    durationMs: integer('duration_ms'),
    llmModel: varchar('llm_model', { length: 128 }),
    llmPromptTokens: integer('llm_prompt_tokens'),
    llmCompletionTokens: integer('llm_completion_tokens'),
    outputType: varchar('output_type', { length: 64 }),
    outputSummary: text('output_summary'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

// ── Artifacts System (Phase 4) ────────────────────────────────────────────────

export const artifacts = pgTable('artifacts', {
    id: text('id').primaryKey(), // ulid
    workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
    taskId: text('task_id').references(() => tasks.id, { onDelete: 'set null' }),
    projectId: text('project_id').references(() => sprints.id, { onDelete: 'set null' }),
    filename: text('filename').notNull(),
    type: text('type').notNull(), // legacy — coarse classification; kept for back-compat
    // Phase 2 — rich WorkKind taxonomy. Open string so extensions can add kinds.
    // Nullable because existing rows pre-date this column. Inferred at read time
    // when missing (see apps/api/src/routes/tasks.ts and packages/db/src/work-kind.ts).
    kind: text('kind'),
    // Renderer-specific payload (e.g. { language, previewMode, tableColumns }).
    meta: jsonb('meta').default(sql`'{}'::jsonb`),
    currentVersion: integer('current_version').default(1).notNull(),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { mode: 'date' }).defaultNow().notNull(),
}, (table: any) => [
    index('artifacts_workspace_idx').on(table.workspaceId),
    index('artifacts_task_idx').on(table.taskId),
    index('artifacts_project_idx').on(table.projectId),
])

export const artifactVersions = pgTable('artifact_versions', {
    id: uuid('id').defaultRandom().primaryKey(),
    artifactId: text('artifact_id')
        .notNull()
        .references(() => artifacts.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    content: text('content').notNull(),
    changeDescription: text('change_description'),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
}, (table: any) => [
    index('artifact_versions_artifact_idx').on(table.artifactId),
    uniqueIndex('artifact_versions_artifact_version_uq').on(table.artifactId, table.version),
])

// ── PEX — Governance Tables ─────────────────────────────────────────

/** §18 — Extension/agent audit trail (immutable) */
export const extensionAuditLog = pgTable('extension_audit_log', {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
    extensionId: text('extension_id').notNull(),
    /** Phase 7 — display name frozen at call time (falls back to extensionId). */
    extensionName: text('extension_name'),
    /** Phase 7 — semver frozen at call time. Nullable when caller is 'system'. */
    extensionVersion: text('extension_version'),
    agentId: text('agent_id'),
    sessionId: text('session_id').notNull(),
    action: text('action').notNull(),
    target: text('target').notNull(),
    payloadHash: text('payload_hash').notNull(),
    outcome: text('outcome').notNull(),
    modelContext: jsonb('model_context'),
    escalationOutcome: text('escalation_outcome'),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
}, (table: any) => [
    index('ext_audit_workspace_time_idx').on(table.workspaceId, table.createdAt),
    index('ext_audit_extension_idx').on(table.extensionId, table.createdAt),
    index('ext_audit_workspace_extension_time_idx').on(table.workspaceId, table.extensionId, table.createdAt),
])

/** §23 — Standing approval rules (user-owned) */
export const standingApprovals = pgTable('standing_approvals', {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
    trigger: text('trigger').notNull(),
    actionPattern: text('action_pattern').notNull(),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
    expiresAt: timestamp('expires_at', { mode: 'date' }),
}, (table: any) => [
    index('standing_approvals_workspace_idx').on(table.workspaceId),
])

/** §20 — Persistent UserSelf graph */
export const userSelf = pgTable('user_self', {
    workspaceId: uuid('workspace_id')
        .primaryKey()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
    identity: jsonb('identity').notNull().default({}),
    preferences: jsonb('preferences').notNull().default({}),
    relationships: text('relationships').array().notNull().default([]),
    contexts: jsonb('contexts').notNull().default({}),
    communicationStyle: jsonb('communication_style').notNull().default({}),
    updatedAt: timestamp('updated_at', { mode: 'date' }).defaultNow().notNull(),
})

// ── Prompt Library (§7.6) ────────────────────────────────────────────────────
// Extension-contributed prompt templates. Disabled by default; users enable per-workspace.

export const extensionPrompts = pgTable('extension_prompts', {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** Extension name, e.g. @acme/coding-standards */
    extensionName: text('extension_name').notNull(),
    /** Prompt artifact ID within the extension */
    promptId: text('prompt_id').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    /** Template text with {{variable}} placeholders */
    template: text('template').notNull(),
    /** Declared variables schema */
    variables: jsonb('variables').notNull().default('[]'),
    /** Resolved variable defaults set by the user */
    variableDefaults: jsonb('variable_defaults').notNull().default('{}'),
    tags: text('tags').array().notNull().default(sql`'{}'`),
    /** Semver version of this prompt artifact */
    version: text('version').notNull(),
    priority: artifactPriorityEnum('priority').notNull().default('normal'),
    /** Artifact dependencies */
    dependencies: text('dependencies').array().notNull().default(sql`'{}'`),
    /** Users must explicitly enable prompts from extensions */
    enabled: boolean('enabled').notNull().default(false),
    /** Soft delete on extension uninstall */
    deletedAt: timestamp('deleted_at', { mode: 'date' }),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { mode: 'date' }).defaultNow().notNull(),
}, (table: any) => [
    index('ext_prompts_workspace_idx').on(table.workspaceId),
    index('ext_prompts_extension_idx').on(table.extensionName),
    index('ext_prompts_enabled_idx').on(table.workspaceId, table.enabled),
    uniqueIndex('ext_prompts_unique_idx').on(table.workspaceId, table.extensionName, table.promptId),
])

// ── Context Layer (§7.7) ─────────────────────────────────────────────────────
// Extension-contributed context blocks injected into system prompt at execution time.

export const extensionContexts = pgTable('extension_contexts', {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** Extension name */
    extensionName: text('extension_name').notNull(),
    /** Context artifact ID within the extension */
    contextId: text('context_id').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    /** Context content (static or dynamically updated via SDK) */
    content: text('content').notNull(),
    contentType: text('content_type').notNull().default('text/plain'),
    priority: artifactPriorityEnum('priority').notNull().default('normal'),
    /** TTL in seconds. null = no expiry. */
    ttl: integer('ttl'),
    tags: text('tags').array().notNull().default(sql`'{}'`),
    /** Estimated token count for budget allocation */
    estimatedTokens: integer('estimated_tokens'),
    /** Last time content was refreshed (for TTL calculation) */
    lastRefreshedAt: timestamp('last_refreshed_at', { mode: 'date' }).defaultNow().notNull(),
    /** Users can disable context from specific extensions */
    enabled: boolean('enabled').notNull().default(true),
    /** Soft delete on extension uninstall */
    deletedAt: timestamp('deleted_at', { mode: 'date' }),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { mode: 'date' }).defaultNow().notNull(),
}, (table: any) => [
    index('ext_contexts_workspace_idx').on(table.workspaceId),
    index('ext_contexts_extension_idx').on(table.extensionName),
    index('ext_contexts_priority_idx').on(table.workspaceId, table.priority),
    uniqueIndex('ext_contexts_unique_idx').on(table.workspaceId, table.extensionName, table.contextId),
])

// ── PAX Registrations (PAX Protocol §5) ──────────────────────────────────────
// External app registrations via the PAX (Plexo Application eXchange) protocol.

export const paxRegistrations = pgTable('pax_registrations', {
    id: uuid('id').defaultRandom().primaryKey(),
    appName: text('app_name').notNull(),
    workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
    version: text('version').notNull(),
    manifestHash: text('manifest_hash').notNull(),
    capabilities: text('capabilities').array().notNull().default(sql`'{}'`),
    /** Reference to mcp_tokens row — PAX tokens stored there with type='pax' */
    tokenId: uuid('token_id')
        .notNull()
        .references(() => mcpTokens.id, { onDelete: 'cascade' }),
    tokenExpiresAt: timestamp('token_expires_at', { mode: 'date' }),
    issuedAt: timestamp('issued_at', { mode: 'date' }).defaultNow().notNull(),
    lastUsedAt: timestamp('last_used_at', { mode: 'date' }),
    revokedAt: timestamp('revoked_at', { mode: 'date' }),
}, (table: any) => [
    uniqueIndex('pax_registrations_app_workspace_uq').on(table.workspaceId, table.appName),
    index('pax_registrations_workspace_idx').on(table.workspaceId),
    index('pax_registrations_token_idx').on(table.tokenId),
])

// ── Analytics Digest Dead Letter ──────────────────────────────────────────────
// Stores weekly error digest attempts that failed to post to GitHub.
// Written by the digest worker when the GitHub API is unavailable after retries.

export const analyticsDigestFailures = pgTable('analytics_digest_failures', {
    id: uuid('id').defaultRandom().primaryKey(),
    weekOf: date('week_of').notNull(),
    attempt: integer('attempt').notNull(),
    error: text('error').notNull(),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
}, (table: any) => [
    index('idx_digest_failures_week').on(table.weekOf),
])

// ── App Profiles & Federation ─────────────────────────────────────────────────
// App profiles register external Joeybuilt apps (fylo, fonto, levio, etc.)
// with this Core instance. Each app declares a PG schema namespace it owns,
// the PEX extensions it contributes, and the event types it emits.

export const appProfiles = pgTable('app_profiles', {
    id: uuid('id').defaultRandom().primaryKey(),
    appId: text('app_id').notNull().unique(),
    schemaNamespace: text('schema_namespace').notNull(),
    displayName: text('display_name').notNull(),
    eventContracts: jsonb('event_contracts').default('[]').notNull(),
    registeredAt: timestamp('registered_at', { mode: 'date' }).defaultNow().notNull(),
    lastSeenAt: timestamp('last_seen_at', { mode: 'date' }),
})

// Nodes represent Plexo instances in a federation mesh.
// The self-record (is_self = true) is inserted on first migration run.

export const nodes = pgTable('nodes', {
    id: uuid('id').defaultRandom().primaryKey(),
    did: text('did').notNull().unique(),
    displayName: text('display_name'),
    url: text('url'),
    isSelf: boolean('is_self').default(false).notNull(),
    syncToken: text('sync_token'),
    status: text('status').default('active').notNull(),
    lastPingAt: timestamp('last_ping_at', { mode: 'date' }),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
})

// Node trust edges — each scope (memory sync, agent routing, event propagation)
// is an independent opt-in. Both sides must establish trust for it to be active.

export const nodeTrust = pgTable('node_trust', {
    id: uuid('id').defaultRandom().primaryKey(),
    localNodeId: uuid('local_node_id')
        .notNull()
        .references(() => nodes.id, { onDelete: 'cascade' }),
    remoteNodeId: uuid('remote_node_id')
        .notNull()
        .references(() => nodes.id, { onDelete: 'cascade' }),
    memorySync: boolean('memory_sync').default(false).notNull(),
    agentRouting: boolean('agent_routing').default(false).notNull(),
    eventPropagation: boolean('event_propagation').default(false).notNull(),
    establishedAt: timestamp('established_at', { mode: 'date' }).defaultNow().notNull(),
    revokedAt: timestamp('revoked_at', { mode: 'date' }),
}, (table: any) => [
    uniqueIndex('node_trust_pair_uq').on(table.localNodeId, table.remoteNodeId),
    index('node_trust_local_idx').on(table.localNodeId),
    index('node_trust_remote_idx').on(table.remoteNodeId),
])

// Inbound events from federated nodes or local app profiles.
// source_node_did is the DID of the emitting node ('self' for local).

export const nodeEvents = pgTable('node_events', {
    id: uuid('id').defaultRandom().primaryKey(),
    sourceNodeDid: text('source_node_did').notNull(),
    eventType: text('event_type').notNull(),
    payload: jsonb('payload').default('{}').notNull(),
    workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'set null' }),
    processed: boolean('processed').default(false).notNull(),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
}, (table: any) => [
    index('node_events_source_idx').on(table.sourceNodeDid),
    index('node_events_type_idx').on(table.eventType),
    index('node_events_workspace_idx').on(table.workspaceId),
    index('node_events_processed_idx').on(table.processed, table.createdAt),
])

// Per-user, per-workspace grants for a registered app profile.
// Grants the app the right to act on behalf of this user within this workspace.

export const userAppAuthorizations = pgTable('user_app_authorizations', {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: text('user_id').notNull(),  // → users.id (foreign table); cascade enforced at app level
    appId: text('app_id').notNull(),
    workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    scopes: text('scopes').array().notNull().default(sql`'{}'`),
    grantedAt: timestamp('granted_at', { mode: 'date' }).defaultNow().notNull(),
    revokedAt: timestamp('revoked_at', { mode: 'date' }),
}, (table: any) => [
    uniqueIndex('user_app_auth_uq').on(table.userId, table.appId, table.workspaceId),
    index('user_app_auth_user_idx').on(table.userId),
    index('user_app_auth_workspace_idx').on(table.workspaceId),
    index('user_app_auth_app_idx').on(table.appId),
])

// ── SCL Foundation ──────────────────────────────────────────────────

export const inferenceLogs = pgTable('inference_logs', {
    id: uuid('id').defaultRandom().primaryKey(),
    instanceUuid: text('instance_uuid'),
    workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'set null' }),
    model: text('model').notNull(),
    provider: text('provider'),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    latencyMs: integer('latency_ms').notNull().default(0),
    domainRegion: text('domain_region'),
    regionsActivated: text('regions_activated').array(),
    resolutionLevel: text('resolution_level'),
    contextBudgetUsed: integer('context_budget_used'),
    taskType: text('task_type').notNull().default('unknown'),
    success: boolean('success').notNull().default(true),
    accepted: boolean('accepted'),
    scrubInputPattern: text('scrub_input_pattern'),
    scrubOutputPattern: text('scrub_output_pattern'),
    trainingConsent: boolean('training_consent').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table: any) => [
    index('inference_logs_domain_idx').on(table.domainRegion),
    index('inference_logs_created_idx').on(table.createdAt),
    index('inference_logs_model_idx').on(table.model),
])

export const workspaceMindsets = pgTable('workspace_mindsets', {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }).unique(),
    mindsetObject: jsonb('mindset_object').notNull().default({}),
    goldenRecord: jsonb('golden_record'),
    goldenRecordVersion: text('golden_record_version'),
    version: integer('version').notNull().default(1),
    taskCount: integer('task_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
})

export const sclConceptGraphs = pgTable('scl_concept_graphs', {
    id: uuid('id').defaultRandom().primaryKey(),
    sourceLogId: uuid('source_log_id').references(() => inferenceLogs.id, { onDelete: 'set null' }),
    workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'set null' }),
    domainRegion: text('domain_region'),
    graphJson: jsonb('graph_json').default({}),
    mindsetObject: jsonb('mindset_object'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (table: any) => [
    index('idx_scl_concept_graphs_domain').on(table.domainRegion),
    index('idx_scl_concept_graphs_workspace').on(table.workspaceId),
])

export const sclDriftWarnings = pgTable('scl_drift_warnings', {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    attractorId: text('attractor_id').notNull(),
    attractorLabel: text('attractor_label').notNull(),
    currentPosition: jsonb('current_position').notNull(),
    proposedPosition: jsonb('proposed_position').notNull(),
    semanticDistance: real('semantic_distance').notNull(),
    threshold: real('threshold').notNull(),
    source: text('source').notNull(),
    status: text('status').notNull().default('pending'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
})

// ── Model Foundry ────────────────────────────────────────────────────────────

export const foundryModels = pgTable('foundry_models', {
    id: text('id').primaryKey(),
    workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'set null' }),
    domainBucket: text('domain_bucket').notNull(),
    baseModel: text('base_model').notNull(),
    trainingExamples: integer('training_examples').notNull().default(0),
    trainedAt: timestamp('trained_at', { withTimezone: true }),
    status: text('status').notNull().default('pending'),
    shadowAgreementRate: real('shadow_agreement_rate'),
    shadowComparisons: integer('shadow_comparisons').notNull().default(0),
    ollamaModelName: text('ollama_model_name'),
    providerModelId: text('provider_model_id'),
    provider: text('provider'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

export const foundryShadowResults = pgTable('foundry_shadow_results', {
    id: text('id').primaryKey(),
    modelId: text('model_id').notNull().references(() => foundryModels.id, { onDelete: 'cascade' }),
    inferenceLogId: uuid('inference_log_id').references(() => inferenceLogs.id, { onDelete: 'set null' }),
    primaryOutputHash: text('primary_output_hash'),
    shadowOutputHash: text('shadow_output_hash'),
    agreementScore: real('agreement_score'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

/**
 * message_deliveries — tracks every outbound message send attempt to external channels.
 * Fire-and-forget recording from channel adapters. Captures success, failure, empty
 * response, and markdown-retry cases so delivery problems surface without manual log reading.
 */
export const messageDeliveries = pgTable('message_deliveries', {
    id: text('id').primaryKey(), // ulid
    workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
    channel: text('channel').notNull(), // telegram | slack | discord
    chatId: text('chat_id').notNull(), // recipient identifier
    status: text('status').notNull(), // sent | failed | rejected | empty_response
    errorMessage: text('error_message'),
    messageLength: integer('message_length').notNull(),
    latencyMs: integer('latency_ms'),
    conversationId: text('conversation_id'), // optional link to conversations table
    markdownRetry: boolean('markdown_retry').default(false).notNull(),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
}, (table: any) => [
    index('message_deliveries_workspace_idx').on(table.workspaceId),
    index('message_deliveries_workspace_created_idx').on(table.workspaceId, table.createdAt),
    index('message_deliveries_status_idx').on(table.status),
    index('message_deliveries_channel_idx').on(table.channel),
])

export const foundryTrainingRuns = pgTable('foundry_training_runs', {
    id: text('id').primaryKey(),
    modelId: text('model_id').notNull().references(() => foundryModels.id, { onDelete: 'cascade' }),
    domainBucket: text('domain_bucket').notNull(),
    exampleCount: integer('example_count').notNull(),
    baseModel: text('base_model').notNull(),
    provider: text('provider').notNull(),
    providerJobId: text('provider_job_id'),
    status: text('status').notNull().default('pending'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

// === workbench_pins (slot 0074, works phase 7) ===
//
// Pins a work (artifact row) to a user's workbench pane. User id is text
// (Better Auth id behind postgres_fdw — no FK possible). work_id is text
// because artifacts.id is ulid-text, not uuid. Workspace scopes visibility
// and enforces cascade cleanup on workspace deletion.
export const workbenchPins = pgTable('workbench_pins', {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: text('user_id').notNull(),
    workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
    workId: text('work_id')
        .notNull()
        .references(() => artifacts.id, { onDelete: 'cascade' }),
    position: integer('position').notNull().default(0),
    pinnedAt: timestamp('pinned_at', { withTimezone: true }).defaultNow().notNull(),
}, (table: any) => [
    uniqueIndex('workbench_pins_user_work_idx').on(table.userId, table.workId),
    index('workbench_pins_user_position_idx').on(table.userId, table.position),
    index('workbench_pins_workspace_idx').on(table.workspaceId),
])

export type WorkbenchPin = typeof workbenchPins.$inferSelect
export type NewWorkbenchPin = typeof workbenchPins.$inferInsert

// === user_subscriptions (slot 0071, auth phase) ===
// Tracks each Plexo user's billing tier and Stripe subscription linkage.
// user_id is `text` (Better Auth id) — no FK because the users table is a
// postgres_fdw foreign table and Postgres cannot FK to foreign tables.
// Uniqueness enforced at DB level (one subscription row per user).
export const userSubscriptions = pgTable('user_subscriptions', {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id').notNull(),
    tier: text('tier').notNull().default('free'),
    status: text('status').notNull().default('active'),
    stripeCustomerId: text('stripe_customer_id'),
    stripeSubscriptionId: text('stripe_subscription_id'),
    currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
    trialEndsAt: timestamp('trial_ends_at', { withTimezone: true }),
    metadata: jsonb('metadata').default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table: any) => [
    uniqueIndex('user_subscriptions_user_id_idx').on(table.userId),
    index('user_subscriptions_stripe_customer_idx').on(table.stripeCustomerId),
])

export type UserSubscription = typeof userSubscriptions.$inferSelect
export type NewUserSubscription = typeof userSubscriptions.$inferInsert

// === escalation_requests (slot 0072, agents phase 8) ===
// Per-invocation human-in-the-loop approval queue. The executor inserts a
// row before running any tool flagged as irreversible (manifest
// `requiresEscalation` hint) or above the workspace auto-approve cost
// threshold. The row's status transitions pending → approved | rejected |
// timeout. The in-memory manager resolves the waiting promise; on process
// restart the sweeper ages out stale pending rows.
export const escalationRequests = pgTable('escalation_requests', {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
    sessionId: text('session_id').notNull(),
    agentId: text('agent_id'),
    toolName: text('tool_name').notNull(),
    payload: jsonb('payload').notNull().default(sql`'{}'::jsonb`),
    reason: text('reason'),
    /** 'pending' | 'approved' | 'rejected' | 'timeout' */
    status: text('status').notNull().default('pending'),
    requestedAt: timestamp('requested_at', { withTimezone: true }).defaultNow().notNull(),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    /** Better Auth user id (text) that approved or rejected the request. */
    decidedBy: text('decided_by'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    decisionNote: text('decision_note'),
}, (table: any) => [
    index('escalation_requests_workspace_status_idx').on(table.workspaceId, table.status),
    index('escalation_requests_session_idx').on(table.sessionId),
])

export type EscalationRequestRow = typeof escalationRequests.$inferSelect
export type NewEscalationRequestRow = typeof escalationRequests.$inferInsert

// === extension_votes (slot 0075, hub voting) ===
// Per-user up/down votes on extension_registry items. extension_id is the
// text `name` of the registry row (not its uuid) because the hub catalog and
// Hub browse pages key by package name, and this keeps the column FDW-safe.
// user_id is a Better Auth user id (text, no FK because users live on the
// auth schema via postgres_fdw). Unique index on (user_id, extension_id)
// enforces one vote per user per item; the UPSERT path flips vote_type in
// place. The companion view `extension_vote_counts` materialises upvote /
// downvote / score aggregates for fast JOINs from the catalog query.
export const extensionVotes = pgTable('extension_votes', {
    id: uuid('id').defaultRandom().primaryKey(),
    extensionId: text('extension_id').notNull(),
    userId: text('user_id').notNull(),
    /** 'up' | 'down' — CHECK constraint enforced at DB level. */
    voteType: text('vote_type').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table: any) => [
    uniqueIndex('extension_votes_user_extension_idx').on(table.userId, table.extensionId),
    index('extension_votes_extension_idx').on(table.extensionId),
])

export type ExtensionVote = typeof extensionVotes.$inferSelect
export type NewExtensionVote = typeof extensionVotes.$inferInsert

// === artifact_shares (slot 0083, shareable links) ===
// Public shareable links for works/artifacts. Share IDs are short 12-char
// text tokens used in /s/:shareId public URLs. Only one active (non-revoked)
// share per artifact enforced by partial unique index. created_by is a
// Better Auth user id (text, no FK — users live behind postgres_fdw).
export const artifactShares = pgTable('artifact_shares', {
    id: text('id').primaryKey(),
    artifactId: text('artifact_id')
        .notNull()
        .references(() => artifacts.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
    createdBy: text('created_by').notNull(),
    visibility: text('visibility').notNull().default('unlisted'),
    passwordHash: text('password_hash'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    versionPin: integer('version_pin'),
    viewCount: integer('view_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, (table: any) => [
    index('artifact_shares_artifact_idx').on(table.artifactId),
    // Partial unique: only one active share per artifact
    uniqueIndex('artifact_shares_active_uq').on(table.artifactId),
])

export type ArtifactShare = typeof artifactShares.$inferSelect
export type NewArtifactShare = typeof artifactShares.$inferInsert
