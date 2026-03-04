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
])

export const taskStatusEnum = pgEnum('task_status', [
    'queued',
    'claimed',
    'running',
    'complete',
    'blocked',
    'cancelled',
])

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

export const pluginTypeEnum = pgEnum('plugin_type', [
    'agent',
    'skill',
    'channel',
    'tool',
    'mcp-server',
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

// ── Auth.js Tables ───────────────────────────────────────────────

export const users = pgTable('users', {
    id: uuid('id').defaultRandom().primaryKey(),
    email: text('email').unique().notNull(),
    emailVerified: timestamp('email_verified', { mode: 'date' }),
    name: text('name'),
    image: text('image'),
    passwordHash: text('password_hash'),
    role: userRoleEnum('role').default('member').notNull(),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
})

export const accounts = pgTable(
    'accounts',
    {
        userId: uuid('user_id')
            .notNull()
            .references(() => users.id, { onDelete: 'cascade' }),
        type: text('type').notNull(),
        provider: text('provider').notNull(),
        providerAccountId: text('provider_account_id').notNull(),
        refreshToken: text('refresh_token'),
        accessToken: text('access_token'),
        expiresAt: integer('expires_at'),
        tokenType: text('token_type'),
        scope: text('scope'),
        idToken: text('id_token'),
        sessionState: text('session_state'),
    },
    (table) => [
        primaryKey({ columns: [table.provider, table.providerAccountId] }),
    ]
)

export const sessions = pgTable('sessions', {
    sessionToken: text('session_token').primaryKey(),
    userId: uuid('user_id')
        .notNull()
        .references(() => users.id, { onDelete: 'cascade' }),
    expires: timestamp('expires', { mode: 'date' }).notNull(),
})

export const verificationTokens = pgTable(
    'verification_tokens',
    {
        identifier: text('identifier').notNull(),
        token: text('token').notNull(),
        expires: timestamp('expires', { mode: 'date' }).notNull(),
    },
    (table) => [
        primaryKey({ columns: [table.identifier, table.token] }),
    ]
)

export const authenticators = pgTable('authenticators', {
    credentialId: text('credential_id').notNull().unique(),
    userId: uuid('user_id')
        .notNull()
        .references(() => users.id, { onDelete: 'cascade' }),
    providerAccountId: text('provider_account_id').notNull(),
    credentialPublicKey: text('credential_public_key').notNull(),
    counter: integer('counter').notNull(),
    credentialDeviceType: text('credential_device_type').notNull(),
    credentialBackedUp: boolean('credential_backed_up').notNull(),
    transports: text('transports'),
}, (table) => [
    primaryKey({ columns: [table.userId, table.credentialId] }),
])

// ── Core Tables ──────────────────────────────────────────────────

export const workspaces = pgTable('workspaces', {
    id: uuid('id').defaultRandom().primaryKey(),
    name: text('name').notNull(),
    ownerId: uuid('owner_id')
        .notNull()
        .references(() => users.id),
    settings: jsonb('settings').default('{}').notNull(),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
})

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
}, (table) => [
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
    parentId: text('parent_id').references((): any => tasks.id), // eslint-disable-line @typescript-eslint/no-explicit-any -- self-ref
    context: jsonb('context').notNull(),
    qualityScore: real('quality_score'),
    confidenceScore: real('confidence_score'),
    tokensIn: integer('tokens_in'),
    tokensOut: integer('tokens_out'),
    costUsd: real('cost_usd'),
    promptVersion: text('prompt_version'),
    outcomeSummary: text('outcome_summary'),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
    claimedAt: timestamp('claimed_at', { mode: 'date' }),
    completedAt: timestamp('completed_at', { mode: 'date' }),
}, (table) => [
    index('tasks_workspace_status_idx').on(table.workspaceId, table.status),
    index('tasks_workspace_project_idx').on(table.workspaceId, table.project),
    index('tasks_project_id_idx').on(table.projectId),
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
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
}, (table) => [
    index('task_steps_task_idx').on(table.taskId),
])

export const sprints = pgTable('sprints', {
    id: text('id').primaryKey(), // ulid
    workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
    repo: text('repo').notNull(),
    request: text('request').notNull(),
    status: sprintStatusEnum('status').default('planning').notNull(),
    totalTasks: integer('total_tasks').default(0).notNull(),
    completedTasks: integer('completed_tasks').default(0).notNull(),
    failedTasks: integer('failed_tasks').default(0).notNull(),
    conflictCount: integer('conflict_count').default(0).notNull(),
    qualityScore: real('quality_score'),
    totalTokens: integer('total_tokens'),
    costUsd: real('cost_usd'),
    wallClockMs: integer('wall_clock_ms'),
    plannerIterations: integer('planner_iterations').default(0).notNull(),
    featuresCompleted: jsonb('features_completed').default('[]').notNull(),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
    completedAt: timestamp('completed_at', { mode: 'date' }),
}, (table) => [
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
}, (table) => [
    index('sprint_tasks_sprint_idx').on(table.sprintId),
])

export const plugins = pgTable('plugins', {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
    // Scoped package name — must match @scope/name format (§3.1)
    name: text('name').notNull(),
    version: text('version').notNull(),
    type: pluginTypeEnum('type').notNull(),
    // Kapsel spec version this manifest targets (e.g. '0.2.0')
    kapselVersion: text('kapsel_version').notNull().default('0.2.0'),
    // Relative path to the entry point (§3.1)
    entry: text('entry').notNull(),
    // Full kapsel.json contents (validated on install per §3.3)
    kapselManifest: jsonb('kapsel_manifest').notNull(),
    enabled: boolean('enabled').default(false).notNull(),
    // Extension-private settings storage (injected as sdk.storage via Redis)
    settings: jsonb('settings').default('{}').notNull(),
    installedAt: timestamp('installed_at', { mode: 'date' }).defaultNow().notNull(),
}, (table) => [
    index('plugins_workspace_idx').on(table.workspaceId),
])

export const dashboardCards = pgTable('dashboard_cards', {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
        .notNull()
        .references(() => users.id, { onDelete: 'cascade' }),
    cardType: text('card_type').notNull(),
    position: jsonb('position').notNull(), // { x, y, w, h }
    config: jsonb('config').default('{}').notNull(),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
}, (table) => [
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
    // pgvector column — raw SQL needed until drizzle-orm has native vector support
    // embedding: vector(1536) — added via custom migration SQL
    metadata: jsonb('metadata').default('{}').notNull(),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
}, (table) => [
    index('memory_entries_workspace_type_idx').on(table.workspaceId, table.type),
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
    completedAt: timestamp('completed_at', { mode: 'date' }).defaultNow().notNull(),
}, (table) => [
    index('work_ledger_workspace_idx').on(table.workspaceId),
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
}, (table) => [
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
    enabledTools: jsonb('enabled_tools').$type<string[] | null>().default(null), // null = all enabled
    scopesGranted: jsonb('scopes_granted').default('[]').notNull(),
    status: connectionStatusEnum('status').default('active').notNull(),
    lastVerifiedAt: timestamp('last_verified_at', { mode: 'date' }),
    errorDetail: text('error_detail'),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
}, (table) => [
    index('installed_connections_workspace_idx').on(table.workspaceId),
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
}, (table) => [
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
}, (table) => [
    primaryKey({ columns: [table.workspaceId, table.key] }),
    index('workspace_preferences_workspace_idx').on(table.workspaceId),
])

export const agentImprovementLog = pgTable('agent_improvement_log', {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
    patternType: text('pattern_type').notNull(), // failure_pattern | success_pattern | tool_preference | scope_adjustment
    description: text('description').notNull(),
    evidence: jsonb('evidence').default('[]').notNull(), // task IDs
    proposedChange: text('proposed_change'),
    applied: boolean('applied').default(false).notNull(),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
}, (table) => [
    index('agent_improvement_log_workspace_idx').on(table.workspaceId),
])

// ── Phase 11 — Workspace membership + invites ─────────────────────────────────

export const workspaceMembers = pgTable('workspace_members', {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
        .notNull()
        .references(() => users.id, { onDelete: 'cascade' }),
    role: memberRoleEnum('role').default('member').notNull(),
    invitedByUserId: uuid('invited_by_user_id').references(() => users.id),
    joinedAt: timestamp('joined_at', { mode: 'date' }).defaultNow().notNull(),
}, (table) => [
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
    invitedByUserId: uuid('invited_by_user_id')
        .notNull()
        .references(() => users.id),
    expiresAt: timestamp('expires_at', { mode: 'date' }).notNull(),
    usedAt: timestamp('used_at', { mode: 'date' }),
    usedByUserId: uuid('used_by_user_id').references(() => users.id),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
}, (table) => [
    uniqueIndex('workspace_invites_token_idx').on(table.token),
    index('workspace_invites_workspace_idx').on(table.workspaceId),
])

// ── Phase 21 — Kapsel Extension Registry (§12) ──────────────────────────────
// Public listing of extensions available for installation.
// Scoped: entries belong to a workspace (org/user namespace).

export const kapselRegistry = pgTable('kapsel_registry', {
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
    /** Full kapsel.json manifest for the latest version */
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
    publishedAt: timestamp('published_at', { mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { mode: 'date' }).defaultNow().notNull(),
}, (table) => [
    index('kapsel_registry_name_idx').on(table.name),
    index('kapsel_registry_publisher_idx').on(table.publisher),
    index('kapsel_registry_deprecated_idx').on(table.deprecated),
])

// ── Phase 13 — Audit log ──────────────────────────────────────────────────────

export const auditLog = pgTable('audit_log', {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
        .notNull()
        .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id),  // null for system events
    action: text('action').notNull(),                    // e.g. 'member.add', 'plugin.install', 'task.create'
    resource: text('resource').notNull(),                // table name or resource type
    resourceId: text('resource_id'),                     // optional target entity ID
    metadata: jsonb('metadata').default('{}').notNull(), // extra context (role, email, etc.)
    ip: text('ip'),
    createdAt: timestamp('created_at', { mode: 'date' }).defaultNow().notNull(),
}, (table) => [
    index('audit_log_workspace_idx').on(table.workspaceId),
    index('audit_log_action_idx').on(table.action),
    index('audit_log_created_idx').on(table.createdAt),
])

