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
import { channelsRouter } from './routes/channels.js'
import { cronRouter } from './routes/cron.js'
import { usersRouter } from './routes/users.js'
import { membersRouter, invitesRouter } from './routes/members.js'
import { pluginsRouter } from './routes/plugins.js'
import { auditRouter } from './routes/audit.js'
import { registryRouter } from './routes/registry.js'
import { telemetryRouter } from './telemetry/router.js'
import { configureTelemetry } from './telemetry/posthog.js'
import { terminateAll, workerStats } from '@plexo/agent/persistent-pool'
import { eventBus, TOPICS } from '@plexo/agent/event-bus'
import { emitToWorkspace } from './sse-emitter.js'


import { debugRouter } from './routes/debug.js'
import { chatRouter } from './routes/chat.js'
import { behaviorRouter } from './routes/behavior.js'
import { systemRouter } from './routes/system.js'
import { voiceRouter } from './routes/voice.js'
import { traceMiddleware } from './middleware/trace.js'
import { generalLimiter, authLimiter, taskCreationLimiter } from './middleware/rate-limit.js'
import { workspaceRateLimit } from './middleware/workspace-rate-limit.js'
import { startAgentLoop, stopAgentLoop } from './agent-loop.js'
import { runCronJobs } from './cron.js'

const app: Express = express()
const port = parseInt(process.env.PORT ?? '3001', 10)

// ── Middleware ───────────────────────────────────────────────

// Always allow localhost:3000 in dev; in production allow only PUBLIC_URL
const allowedOrigins = new Set<string>([
    'http://localhost:3000',
    'http://localhost:3001',
    'http://127.0.0.1:3000',
    'http://127.0.0.1:3001',
    ...(process.env.PUBLIC_URL ? [process.env.PUBLIC_URL] : []),
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
app.use(generalLimiter) // default: 300/15min

// ── Routes (/api/v1/ canonical + /api/ aliases) ──────────────

// Health — always available, no rate limit (exempt via skip fn)
app.use('/health', healthRouter)

// Anthropic OAuth callback — registered at root path because Anthropic's OAuth
// server redirects to http://localhost:PORT/oauth/callback after authorization.
// This proxies query params to the real handler.
function anthropicCallbackProxy(req: express.Request, res: express.Response) {
    const params = new URLSearchParams(req.query as Record<string, string>).toString()
    res.redirect(307, `/api/oauth/anthropic/callback${params ? `?${params}` : ''}`)
}
app.get('/oauth/callback', anthropicCallbackProxy)
app.get('/callback', anthropicCallbackProxy)

// Build a v1 sub-router so we can mount once at both prefixes
const v1 = express.Router()

v1.use('/sse', sseRouter)
v1.use('/auth', authLimiter, authRouter)
v1.use('/oauth', oauthRouter)
v1.use('/tasks', taskCreationLimiter, workspaceRateLimit, tasksRouter)
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
v1.use('/settings/ai-providers', aiProvidersRouter)
v1.use('/channels', channelsRouter)
v1.use('/cron', cronRouter)
v1.use('/users', usersRouter)
v1.use('/workspaces/:id/members', membersRouter)
v1.use('/invites', invitesRouter)
v1.use('/plugins', workspaceRateLimit, pluginsRouter)
v1.use('/registry', registryRouter)
v1.use('/audit', auditRouter)
v1.use('/telemetry', telemetryRouter)

v1.use('/debug', debugRouter)
v1.use('/chat', chatRouter)
v1.use('/voice', voiceRouter)
v1.use('/behavior/:workspaceId', behaviorRouter)
v1.use('/system', systemRouter)

v1.get('/agent/status', (_req, res) => {
    res.json({ status: 'idle', currentTask: null, currentModel: null, sessionCount: 0, lastActivity: null })
})

// Canonical versioned prefix
app.use('/api/v1', v1)

// ── Error Handler ────────────────────────────────────────────

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logger.error({ err }, 'Unhandled error')
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
    startAgentLoop()
    initTelegramWebhook().catch((err) => logger.error({ err }, 'Telegram init failed'))

    // Background Sync
    runCronJobs()
    setInterval(() => { void runCronJobs() }, 24 * 60 * 60 * 1000)

    // OWD → SSE: when an agent requests approval, push a real-time notification
    // to all connected SSE clients in that workspace so the approval banner appears
    eventBus.subscribe(TOPICS.OWD_PENDING, (payload) => {
        const record = payload as { workspaceId: string;[key: string]: unknown }
        emitToWorkspace(record.workspaceId, { type: 'owd.pending', data: record })
    })
})

process.on('SIGTERM', () => {
    stopAgentLoop()
    terminateAll()
    server.close(() => process.exit(0))
})

process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'Uncaught exception — shutting down')
    process.exit(1)
})

process.on('unhandledRejection', (reason) => {
    logger.error({ reason }, 'Unhandled promise rejection')
})

export { app }
