import 'dotenv/config'
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
import { aiProvidersRouter } from './routes/ai-providers.js'
import { channelsRouter } from './routes/channels.js'
import { cronRouter } from './routes/cron.js'
import { usersRouter } from './routes/users.js'
import { traceMiddleware } from './middleware/trace.js'
import { generalLimiter, authLimiter, taskCreationLimiter } from './middleware/rate-limit.js'
import { startAgentLoop, stopAgentLoop } from './agent-loop.js'

const app: Express = express()
const port = parseInt(process.env.PORT ?? '3001', 10)

// ── Middleware ───────────────────────────────────────────────

app.set('trust proxy', 1) // required for rate limiter behind Caddy/nginx
app.use(cors({
    origin: process.env.PUBLIC_URL ?? 'http://localhost:3000',
    credentials: true,
}))
app.use(express.json({ limit: '1mb' }))
app.use(traceMiddleware)
app.use(generalLimiter) // default: 300/15min

// ── Routes (/api/v1/ canonical + /api/ aliases) ──────────────

// Health — always available, no rate limit (exempt via skip fn)
app.use('/health', healthRouter)

// Build a v1 sub-router so we can mount once at both prefixes
const v1 = express.Router()

v1.use('/sse', sseRouter)
v1.use('/auth', authLimiter, authRouter)
v1.use('/oauth', oauthRouter)
v1.use('/tasks', taskCreationLimiter, tasksRouter)
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
v1.use('/settings/ai-providers', aiProvidersRouter)
v1.use('/channels', channelsRouter)
v1.use('/cron', cronRouter)
v1.use('/users', usersRouter)

v1.get('/agent/status', (_req, res) => {
    res.json({ status: 'idle', currentTask: null, currentModel: null, sessionCount: 0, lastActivity: null })
})

// Canonical versioned prefix
app.use('/api/v1', v1)

// Legacy aliases — preserve backward compat while clients migrate
// TODO: Remove /api/* aliases at v2
app.use('/api', v1)

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
    startAgentLoop()
    initTelegramWebhook().catch((err) => logger.error({ err }, 'Telegram init failed'))
})

process.on('SIGTERM', () => {
    stopAgentLoop()
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
