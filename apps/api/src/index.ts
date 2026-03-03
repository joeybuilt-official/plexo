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
import { owdRouter } from './routes/approvals.js'
import { traceMiddleware } from './middleware/trace.js'
import { startAgentLoop, stopAgentLoop } from './agent-loop.js'

const app: Express = express()
const port = parseInt(process.env.PORT ?? '3001', 10)

// ── Middleware ───────────────────────────────────────────────

app.use(cors({
    origin: process.env.PUBLIC_URL ?? 'http://localhost:3000',
    credentials: true,
}))
app.use(express.json({ limit: '1mb' }))
app.use(traceMiddleware)

// ── Routes ───────────────────────────────────────────────────

app.use('/health', healthRouter)
app.use('/api/sse', sseRouter)
app.use('/api/auth', authRouter)
app.use('/api/oauth', oauthRouter)
app.use('/api/tasks', tasksRouter)
app.use('/api/sprints', sprintsRouter)
app.use('/api/dashboard', dashboardRouter)
app.use('/api/approvals', owdRouter)
app.use('/api/channels/telegram', telegramRouter)
app.use('/api/channels/slack', slackRouter)

app.get('/api/agent/status', (_req, res) => {
    res.json({ status: 'idle', currentTask: null, currentModel: null, sessionCount: 0, lastActivity: null })
})

app.get('/api/connections/registry', (_req, res) => {
    res.json({ items: [], nextCursor: null, total: 0 })
})

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
