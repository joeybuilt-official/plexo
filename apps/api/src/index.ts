// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { config as dotenvConfig } from 'dotenv'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dir = dirname(fileURLToPath(import.meta.url))
// src/ → api/ → apps/ → monorepo root (three levels)
const monorepoRoot = resolve(__dir, '../../../')
dotenvConfig({ path: resolve(monorepoRoot, '.env'), override: false })
dotenvConfig({ path: resolve(monorepoRoot, '.env.local'), override: true })
import { validateEnv } from './env.js'
validateEnv()
import { initSentry, captureException } from './sentry.js'
initSentry()
import express, { type Express } from 'express'
import cors from 'cors'
import { logger } from './logger.js'
import { healthRouter } from './routes/health.js'
import { sseRouter } from './routes/sse.js'
import { authRouter } from './routes/auth.js'
import { oauthRouter } from './routes/oauth.js'
import { tasksRouter } from './routes/tasks.js'
import { sprintsRouter } from './routes/sprints.js'
import { dashboardRouter } from './routes/dashboard.js'
import { telegramRouter, initTelegramWebhook } from './routes/telegram.js'
import { slackRouter } from './routes/slack.js'
import { discordRouter } from './routes/discord.js'
import { owdRouter } from './routes/approvals.js'
import { sprintRunnerRouter } from './routes/sprint-runner.js'
import { memoryRouter } from './routes/memory.js'
import { connectionsRouter } from './routes/connections.js'
import { workspacesRouter } from './routes/workspaces.js'
import { apiKeysRouter } from './routes/api-keys.js'
import { aiProvidersRouter } from './routes/ai-providers.js'
import { aiProviderCredsRouter } from './routes/ai-provider-creds.js'
import { keySharesRouter } from './routes/key-shares.js'
import { channelsRouter } from './routes/channels.js'
import { cronRouter } from './routes/cron.js'
import { usersRouter } from './routes/users.js'
import { membersRouter, invitesRouter } from './routes/members.js'
import { pluginsRouter } from './routes/plugins.js'
import { auditRouter } from './routes/audit.js'
import { kapselAuditRouter } from './routes/kapsel-audit.js'
import { standingApprovalsRouter } from './routes/standing-approvals.js'
import { userSelfRouter } from './routes/user-self.js'
import { registryRouter } from './routes/registry.js'
import { telemetryRouter } from './telemetry/router.js'
import { configureTelemetry } from './telemetry/posthog.js'
import { clarificationRouter } from './routes/clarification.js'
import { sentryWebhookRouter } from './routes/sentry-webhook.js'
import { terminateAll } from '@plexo/agent/persistent-pool'
import { eventBus, TOPICS } from '@plexo/agent/event-bus'
import { emitToWorkspace } from './sse-emitter.js'
import { initSprintLogger } from '@plexo/agent/sprint/logger'


import { debugRouter } from './routes/debug.js'
import { chatRouter } from './routes/chat.js'
import { conversationsRouter } from './routes/conversations.js'
import { behaviorRouter } from './routes/behavior.js'
import { promptsRouter } from './routes/prompts.js'
import { contextRouter } from './routes/context.js'
import { systemRouter } from './routes/system.js'
import { voiceRouter } from './routes/voice.js'
import { introspectRouter } from './routes/introspect.js'
import { codeRouter } from './routes/code.js'
import { rsiRouter } from './routes/rsi.js'
import { parallelRouter } from './routes/parallel.js'
import { requireSupabaseAuth } from './middleware/supabase-auth.js'
import { requireSuperAdmin } from './middleware/super-admin.js'
import { cmdCenterAuth } from './middleware/cmd-center-auth.js'
import { adminRouter } from './routes/admin.js'
import { cmdCenterRouter } from './routes/cmd-center/index.js'
import { traceMiddleware } from './middleware/trace.js'
import { generalLimiter, authLimiter, taskCreationLimiter } from './middleware/rate-limit.js'
import { workspaceRateLimit } from './middleware/workspace-rate-limit.js'
import { sessionLogMiddleware } from './middleware/session-log.middleware.js'
import { startAgentLoop, stopAgentLoop } from './agent-loop.js'
import { db, eq, sql } from '@plexo/db'
import { sprints } from '@plexo/db'
import { runCronJobs, scheduleMemoryConsolidation, runRSIMonitor } from './cron.js'
import { emitHeartbeat } from './telemetry/events.js'

const app: Express = express()
const port = parseInt(process.env.PORT ?? '3001', 10)

// ── Middleware ───────────────────────────────────────────────

// CORS origins: localhost in dev, PUBLIC_URL + any CORS_ORIGINS in production
const allowedOrigins = new Set<string>([
    'http://localhost:3000',
    'http://localhost:3001',
    'http://127.0.0.1:3000',
    'http://127.0.0.1:3001',
    ...(process.env.PUBLIC_URL ? [process.env.PUBLIC_URL] : []),
    ...(process.env.CORS_ORIGINS?.split(',').map(s => s.trim()).filter(Boolean) ?? []),
])

app.set('trust proxy', 1) // required for rate limiter behind Caddy/nginx
app.use(cors({
    origin: (origin, cb) => {
        // Allow non-browser requests (curl, health checks) and listed origins
        if (!origin || allowedOrigins.has(origin)) return cb(null, true)
        cb(new Error(`CORS: origin "${origin}" not allowed`))
    },
    credentials: true,
}))
app.use(express.json({ limit: '1mb' }))
app.use(traceMiddleware)
app.use(sessionLogMiddleware)
app.use(generalLimiter) // default: 300/15min

// ── Routes (/api/v1/ canonical + /api/ aliases) ──────────────

// Health — always available, no rate limit (exempt via skip fn)
app.use('/health', healthRouter)



// Build a v1 sub-router so we can mount once at both prefixes
const v1 = express.Router()

v1.use('/health', healthRouter)
v1.use('/sse', sseRouter)
v1.use('/auth', authLimiter, authRouter)
v1.use('/oauth', oauthRouter)
v1.use('/tasks', taskCreationLimiter, workspaceRateLimit, tasksRouter)
v1.use('/parallel', parallelRouter)
v1.use('/tasks/:taskId/clarification', clarificationRouter)
v1.use('/sprints', sprintsRouter)
v1.use('/sprints', sprintRunnerRouter)
v1.use('/dashboard', dashboardRouter)
v1.use('/approvals', owdRouter)
v1.use('/channels/telegram', telegramRouter)
v1.use('/channels/slack', slackRouter)
v1.use('/channels/discord', discordRouter)
v1.use('/memory', memoryRouter)
v1.use('/connections', connectionsRouter)
v1.use('/workspaces', workspacesRouter)
v1.use('/workspaces/:workspaceId/api-keys', apiKeysRouter)
v1.use('/workspaces/:id/ai-providers', aiProviderCredsRouter)
v1.use('/workspaces/:id/key-shares', keySharesRouter)
v1.use('/settings/ai-providers', aiProvidersRouter)
v1.use('/channels', channelsRouter)
v1.use('/cron', cronRouter)
v1.use('/users', usersRouter)
v1.use('/workspaces/:id/members', membersRouter)
v1.use('/invites', invitesRouter)
v1.use('/plugins', workspaceRateLimit, pluginsRouter)
v1.use('/registry', registryRouter)
v1.use('/audit', auditRouter)
v1.use('/kapsel-audit', kapselAuditRouter)
v1.use('/standing-approvals', standingApprovalsRouter)
v1.use('/user-self', userSelfRouter)
v1.use('/telemetry', telemetryRouter)
v1.use('/webhooks', sentryWebhookRouter)

// Admin routes — super-admin only (Command Center)
v1.use('/admin', requireSupabaseAuth, requireSuperAdmin, adminRouter)

// Command Center data aggregation routes — accepts Supabase JWT (super-admin) OR service key
v1.use('/cmd-center', cmdCenterAuth, cmdCenterRouter)

v1.use('/debug', debugRouter)
v1.use('/chat', chatRouter)
v1.use('/conversations', conversationsRouter)
v1.use('/voice', voiceRouter)
v1.use('/behavior/:workspaceId', behaviorRouter)
v1.use('/prompts/:workspaceId', promptsRouter)
v1.use('/context/:workspaceId', contextRouter)
v1.use('/system', systemRouter)
    v1.use('/workspaces/:id/introspect', introspectRouter)
    v1.use('/workspaces/:id/rsi', rsiRouter)
    v1.use('/code', codeRouter)

v1.get('/agent/status', async (req, res) => {
    const { workspaceId } = req.query as { workspaceId?: string }
    try {
        // Get active task from the running loop
        const { getAgentStatus } = await import('./agent-loop.js')
        const status = getAgentStatus()

        // Resolve current model from workspace if workspaceId provided
        let currentModel: string | null = status.currentModel ?? null
        if (!currentModel && workspaceId) {
            try {
                const { loadDecryptedAIProviders } = await import('./routes/ai-provider-creds.js')
                const ap = await loadDecryptedAIProviders(workspaceId)
                if (ap?.primary && ap?.providers?.[ap.primary]) {
                    const p = ap.providers[ap.primary] as Record<string, unknown>
                    currentModel = (p.selectedModel ?? p.defaultModel ?? ap.primary) as string
                }
            } catch { /* non-fatal */ }
        }

        res.json({
            status: status.activeTaskId ? 'running' : 'idle',
            currentTask: status.activeTaskId ?? null,
            currentModel,
            sessionCount: status.sessionCount,
            lastActivity: status.lastActivity,
        })
    } catch {
        res.json({ status: 'idle', currentTask: null, currentModel: null, sessionCount: 0, lastActivity: null })
    }
})

// Canonical versioned prefix
app.use('/api/v1', v1)

// OAuth callbacks are constructed as /api/oauth/:provider/callback (no v1 prefix)
// by the redirect_uri builder in oauth.ts. Mount directly so Google/Slack/etc.
// can complete the OAuth flow regardless of API versioning.
app.use('/api/oauth', oauthRouter)

// ── Error Handler ────────────────────────────────────────────

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logger.error({ err }, 'Unhandled error')
    captureException(err, { context: 'express_error_handler' })
    res.status(500).json({
        error: {
            code: 'INTERNAL_ERROR',
            message: 'An unexpected error occurred',
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- express locals
            requestId: (res as any).locals?.requestId ?? 'unknown',
        },
    })
})

// ── Start ────────────────────────────────────────────────────

const server = app.listen(port, '0.0.0.0', () => {
    logger.info({ port }, 'Plexo API server started')
    // Init telemetry — off by default; config loaded from workspace settings if available
    configureTelemetry({
        enabled: false,
        instanceId: process.env.PLEXO_INSTANCE_ID ?? crypto.randomUUID(),
        plexoVersion: process.env.npm_package_version ?? '0.1.0',
        redisUrl: process.env.REDIS_URL,
    })
    // On startup: reset any sprints left in 'running' state by a previous process.
    // Fire-and-forget async runners die with the process, leaving DB rows orphaned.
    void db.update(sprints)
        .set({ status: 'failed', completedAt: new Date() })
        .where(eq(sprints.status, 'running'))
        .then(() => {
            // Drizzle update doesn't expose rowCount directly — log unconditionally
            logger.info('Startup: orphaned running sprints reset to failed')
        })
        .catch((err: unknown) => logger.error({ err }, 'Startup: failed to reset orphaned sprints'))

    startAgentLoop()
    void initTelegramWebhook().catch((err) => logger.error({ err }, 'Telegram init failed'))

    // Background Sync
    void runCronJobs()
    setInterval(() => { void runCronJobs() }, 24 * 60 * 60 * 1000)

    // Schedule automatic memory consolidation (every 6h, first run after 5m)
    scheduleMemoryConsolidation()

    // Schedule RSI monitor every 6h (first run after 7m so it doesn't contend with memory consolidation)
    setTimeout(() => {
        void runRSIMonitor()
        setInterval(() => { void runRSIMonitor() }, 6 * 60 * 60 * 1000)
    }, 7 * 60 * 1000)

    // Seed default "Memory consolidation" cron job row per workspace so it's visible in UI
    void db.execute(sql`
        SELECT id FROM workspaces LIMIT 50
    `).then(async (wsRows) => {
        for (const ws of wsRows as unknown as { id: string }[]) {
            await db.execute(sql`
                INSERT INTO cron_jobs (id, workspace_id, name, schedule, enabled, created_at)
                SELECT
                    gen_random_uuid(),
                    ${ws.id}::uuid,
                    'Memory consolidation',
                    '0 */6 * * *',
                    true,
                    now()
                WHERE NOT EXISTS (
                    SELECT 1 FROM cron_jobs
                    WHERE workspace_id = ${ws.id}::uuid AND name = 'Memory consolidation'
                )
            `)
        }
    }).catch((err: unknown) => logger.warn({ err }, 'Startup: failed to seed memory cron rows — non-fatal'))

    // Seed RSI monitor cron row per workspace
    void db.execute(sql`SELECT id FROM workspaces LIMIT 50`)
        .then(async (wsRows) => {
            for (const ws of wsRows as unknown as { id: string }[]) {
                await db.execute(sql`
                    INSERT INTO cron_jobs (id, workspace_id, name, schedule, enabled, created_at)
                    SELECT gen_random_uuid(), ${ws.id}::uuid, 'RSI Monitor', '0 */6 * * *', true, now()
                    WHERE NOT EXISTS (
                        SELECT 1 FROM cron_jobs
                        WHERE workspace_id = ${ws.id}::uuid AND name = 'RSI Monitor'
                    )
                `)
            }
        }).catch((err: unknown) => logger.warn({ err }, 'Startup: failed to seed RSI cron rows — non-fatal'))

    // Wire sprint activity logger → SSE emitter so runner events stream to Control Room
    initSprintLogger((workspaceId: string, event: Record<string, unknown>) => emitToWorkspace(workspaceId, event as import('./sse-emitter.js').AgentEvent))

    // OWD → SSE: when an agent requests approval, push a real-time notification
    // to all connected SSE clients in that workspace so the approval banner appears
    eventBus.subscribe(TOPICS.OWD_PENDING, (payload) => {
        const record = payload as { workspaceId: string;[key: string]: unknown }
        emitToWorkspace(record.workspaceId, { type: 'owd.pending', data: record })
    })

    // Daily heartbeat — 10 min after startup then every 24h
    // Queries the DB; will be a no-op if telemetry is disabled
    const HEARTBEAT_INTERVAL_MS = 24 * 60 * 60 * 1000
    const sendHeartbeat = async () => {
        try {
            const [taskVolume] = await db.execute(sql`
                SELECT COUNT(*) AS count FROM tasks
                WHERE completed_at >= NOW() - INTERVAL '7 days'
            `)
            const taskCount = Number((taskVolume as { count?: string })?.count ?? 0)

            const [memCount] = await db.execute(sql`SELECT COUNT(*) AS count FROM memory_entries`)
            const memEntryCount = Number((memCount as { count?: string })?.count ?? 0)

            // Feature flags — booleans derived from installed connections table
            const connRows = await db.execute(sql`
                SELECT LOWER(type) AS type FROM installed_connections LIMIT 100
            `) as { type: string }[]
            const connTypes = new Set(connRows.map((r) => r.type ?? ''))

            const [telegramRow] = await db.execute(sql`
                SELECT 1 FROM telegram_chats LIMIT 1
            `)
            const [sprintRow] = await db.execute(sql`
                SELECT 1 FROM sprints WHERE status = 'complete' LIMIT 1
            `)

            const [rsiRow] = await db.execute(sql`
                SELECT 1 FROM rsi_proposals LIMIT 1
            `)

            await emitHeartbeat({
                taskVolumeThisWeek: taskCount,
                memoryEntryCount: memEntryCount,
                activeIntegrations: {
                    telegram: !!telegramRow,
                    slack: connTypes.has('slack'),
                    discord: connTypes.has('discord'),
                    github: connTypes.has('github'),
                    sentry: !!process.env.SENTRY_DSN,
                    memory: memEntryCount > 0,
                    sprints: !!sprintRow,
                    rsi: !!rsiRow,
                },
            })
            logger.debug('Telemetry heartbeat sent')
        } catch (err) {
            logger.debug({ err }, 'Telemetry heartbeat failed — suppressed')
        }
    }
    setTimeout(() => {
        void sendHeartbeat()
        setInterval(() => void sendHeartbeat(), HEARTBEAT_INTERVAL_MS)
    }, 10 * 60 * 1000) // first ping 10m after startup
})

process.on('SIGTERM', () => {
    stopAgentLoop()
    terminateAll()
    server.close(() => process.exit(0))
})

process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'Uncaught exception — shutting down')
    captureException(err, { context: 'uncaughtException' })
    process.exit(1)
})

process.on('unhandledRejection', (reason) => {
    logger.error({ reason }, 'Unhandled promise rejection')
    captureException(reason, { context: 'unhandledRejection' })
})

export { app }
