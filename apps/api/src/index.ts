// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Deploy marker: db3b95b (Phase 4e-3) — redeploy attempt 2 after
// .github/workflows/deploy.yml hardening (verbose rsync, BatchMode SSH,
// pre-deploy reachability probe). Safe to remove once a subsequent
// code-bearing commit lands on main.

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
import { trackError } from './event-tracker.js'
import { handoffRouter } from './routes/handoff.js'
import { ssoRouter } from './routes/sso.js'
import { channelsSubscriptionRouter } from './routes/channels-subscription.js'
import { channelsGmessagesRouter } from './routes/channels-gmessages.js'
import { connectionsGmessagesRouter } from './routes/connections-gmessages.js'
import { createInngestExpressHandler } from '@plexo/queue/inngest-express'
import { extractTurnFn } from '@plexo/agent/memory/inngest/extract-turn-fn'
import { lessonsWriteFn } from '@plexo/agent/memory/inngest/lessons-write-fn'
import { lessonsInvalidateFn } from '@plexo/agent/memory/inngest/lessons-invalidate-fn'
import { inferenceRouter } from './routes/inference.js'
import { graphRouter } from './routes/graph.js'
import { themesRouter } from './routes/themes.js'
import { synthesisRouter } from './routes/synthesis.js'
import { installGlobalHandlers as installCCHandlers } from './cc-ingest.js'
installCCHandlers()
import express, { type Express } from 'express'
import cors from 'cors'
import helmet from 'helmet'
import { logger } from './logger.js'
import { claimLocalInstance, releaseLocalInstance } from './services/instance-descriptor.js'
import { healthRouter } from './routes/health.js'
import { metricsRouter } from './routes/metrics.js'
import { metricsMiddleware, setBuildInfo } from './lib/metrics.js'
import { sseRouter } from './routes/sse.js'
import { authRouter } from './routes/auth.js'
import { billingRouter, stripeWebhookHandler } from './routes/billing.js'
import { oauthRouter } from './routes/oauth.js'
import { tasksRouter } from './routes/tasks.js'
import { sprintsRouter } from './routes/sprints.js'
import { dashboardRouter } from './routes/dashboard.js'
import { telegramRouter, initTelegramWebhook } from './routes/telegram.js'
import { slackRouter } from './routes/slack.js'
import { twilioRouter } from './routes/twilio.js'
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
import { extensionsRouter } from './routes/extensions.js'
import { publicSkillsRouter } from './routes/public-skills.js'
import { auditRouter } from './routes/audit.js'
import { extensionAuditRouter } from './routes/extension-audit.js'
import { escalationRouter } from './routes/escalation.js'
import { foundryRouter } from './routes/foundry.js'
import { trainingDataRouter } from './routes/training-data.js'
import { standingApprovalsRouter } from './routes/standing-approvals.js'
import { userSelfRouter } from './routes/user-self.js'
import { registryRouter } from './routes/registry.js'
import { hubRouter } from './routes/hub.js'
import { analyticsRouter } from './analytics/router.js'
import { channelDispatchRouter } from './routes/channel-dispatch.js'
import { configureAnalytics, syncAnalyticsFromDB } from './analytics/config.js'
import { clarificationRouter } from './routes/clarification.js'
// External error webhooks removed — analytics uses native relay
import { a2aRouter, wellKnownAgentHandler } from './routes/a2a.js'
import { webhooksRouter } from './routes/webhooks.js'
import { githubWebhooksRouter } from './routes/webhooks-github.js'
import { taskStreamRouter } from './routes/task-stream.js'
import { agentsActiveStreamRouter } from './routes/agents-active-stream.js'
import { revisionDecisionRouter } from './routes/revision-decision.js'
import { outcomesRouter } from './routes/outcomes.js'
import { registerChannelAdapters } from './channels/register.js'
import { taskInjectRouter } from './routes/task-inject.js'
import { sharesRouter, publicShareRouter } from './routes/shares.js'
import { terminateAll } from '@plexo/agent/persistent-pool'
import { drainPendingJudges } from '@plexo/agent/executor'
import { eventBus, TOPICS } from '@plexo/agent/event-bus'
import { emitToWorkspace } from './sse-emitter.js'
import { initSprintLogger } from '@plexo/agent/sprint/logger'
import { setOutboundAttachmentsHandler } from '@plexo/agent/channels/outbound-attachments-port'
import { setUserTimezoneResolver } from '@plexo/agent/user-timezone-port'
import { getLevioUserTimezone } from '@plexo/agent/connections/factories/levio'
import { resolveOutboundAttachments } from './lib/outbound-attachment-resolver.js'
import { emitAttachmentSent, emitAttachmentOutboundBlocked } from './lib/attachment-audit.js'

setOutboundAttachmentsHandler({
    resolve: (inputs, ctx) =>
        resolveOutboundAttachments(inputs, {
            workspaceId: ctx.workspaceId,
            operatorUserId: ctx.operatorUserId,
            auditEmit: async (_event, payload) => {
                await emitAttachmentOutboundBlocked(
                    { workspaceId: ctx.workspaceId },
                    {
                        contentHash: payload.contentHash as string | undefined,
                        reason: String(payload.reason ?? 'unknown'),
                        filename: payload.filename as string | undefined,
                        sizeBytes: payload.sizeBytes as number | undefined,
                    },
                )
            },
        }),
    emitSent: (p) =>
        emitAttachmentSent(
            { workspaceId: p.workspaceId },
            {
                conversationIds: p.conversationIds,
                recipientEmail: p.recipientEmail,
                channelType: p.channelType,
                count: p.count,
                totalBytes: p.totalBytes,
                contentHashes: p.contentHashes,
            },
        ),
})

// ADR 0001: keep the core executor domain-agnostic — the user-timezone source
// (currently the Levio connector) is wired here at the composition root, not
// imported by core. Other connectors can override by setting the resolver.
setUserTimezoneResolver((workspaceId) => getLevioUserTimezone(workspaceId))


import { debugRouter } from './routes/debug.js'
import { aiCompleteRouter } from './routes/ai-complete.js'
import { externalTasksRouter } from './routes/external-tasks.js'
import { aiMediaRouter } from './routes/ai-media.js'
import { chatRouter } from './routes/chat.js'
import { chatAppTransportRouter } from './routes/chat-app-transport.js'
import { conversationsRouter } from './routes/conversations.js'
import { draftAttachmentsRouter } from './routes/draft-attachments.js'
import { messageDeliveriesRouter } from './routes/message-deliveries.js'
import { behaviorRouter } from './routes/behavior.js'
import { promptsRouter } from './routes/prompts.js'
import { contextRouter } from './routes/context.js'
import { systemRouter } from './routes/system.js'
import { voiceRouter } from './routes/voice.js'
import { searchRouter } from './routes/search.js'
import { visionRouter } from './routes/vision.js'
import { introspectRouter } from './routes/introspect.js'
import { codeRouter } from './routes/code.js'
import { rsiRouter } from './routes/rsi.js'
import { stabilizationRouter } from './routes/stabilization.js'
import { parallelRouter } from './routes/parallel.js'
import { paxRouter } from './routes/pax.js'
import { profilesRouter } from './routes/profiles.js'
import { appGrantsRouter } from './routes/app-grants.js'
import { appServiceKeysRouter } from './routes/app-service-keys.js'
import { agentsRunRouter } from './routes/agents-run.js'
import { agentsRunCustomRouter } from './routes/agents-run-custom.js'
import { nodesRouter } from './routes/nodes.js'
import { federationRouter } from './routes/federation.js'
import { nodeEventsRouter } from './routes/node-events.js'
import { workspaceAppsRouter } from './routes/workspace-apps.js'
import { workbenchRouter } from './routes/workbench.js'
import { worksRouter } from './routes/works.js'
import { toolsRouter } from './routes/tools.js'
import { toolsGmessagesRouter } from './routes/tools-gmessages.js'
import { requireAuth } from './middleware/auth.js'
import { requireWorkspaceMember } from './middleware/workspace-access.js'
import { requireSuperAdmin } from './middleware/super-admin.js'
import { requireServiceKey } from './middleware/service-key-auth.js'
import { adminRouter } from './routes/admin.js'
import { adminTasksRouter } from './routes/admin/tasks.js'
import ollamaAdminRouter from './routes/ollama-admin.js'
import { providerInstancesRouter } from './routes/provider-instances.js'
import { providerAlertsRouter } from './routes/provider-alerts.js'
import { embeddingsRouter } from './routes/embeddings.js'
import { embeddingsServiceRouter } from './routes/embeddings-service.js'
import { intelligenceRouter } from './routes/intelligence.js'
import { intelligenceDashboardRouter } from './routes/intelligence-dashboard.js'
import { modelsRouter } from './routes/models.js'
import { traceMiddleware } from './middleware/trace.js'
import { generalLimiter, authLimiter, taskCreationLimiter, webhookLimiter, serviceLimiter } from './middleware/rate-limit.js'
import { createOriginCsrfMiddleware } from './middleware/csrf.js'
import { workspaceRateLimit } from './middleware/workspace-rate-limit.js'
import { sessionLogMiddleware } from './middleware/session-log.middleware.js'
import { startAgentLoop, stopAgentLoop } from './agent-loop.js'
import { startEventProcessor, stopEventProcessor } from './federation/event-processor.js'
import { db, eq, sql } from '@plexo/db'
import { sprints, nodes } from '@plexo/db'
import { runCronJobs, scheduleMemoryConsolidation, runRSIMonitor } from './cron.js'
import { setProviderFailureSink } from '@plexo/agent/providers/router-v2'
import { emitProviderFailureEvent } from './analytics/events.js'
import { recordProviderFailureForAlert } from './ops-alerts.js'
import { onboardingCanaryEnabled, runOnboardingCanary } from './onboarding-canary.js'
import { startCronDispatch } from './cron-dispatch.js'
import { emitHeartbeat } from './analytics/events.js'

const app: Express = express()
const port = parseInt(process.env.PORT ?? '3001', 10)

// ── Middleware ───────────────────────────────────────────────

// CORS origins: localhost in dev, PUBLIC_URL + sibling app URLs + any CORS_ORIGINS in production
const allowedOrigins = new Set<string>([
    'http://localhost:3000',
    'http://localhost:3001',
    'http://127.0.0.1:3000',
    'http://127.0.0.1:3001',
    ...(process.env.PUBLIC_URL ? [process.env.PUBLIC_URL] : []),
    ...(process.env.CC_PUBLIC_URL ? [process.env.CC_PUBLIC_URL] : []),
    ...(process.env.FYLO_PUBLIC_URL ? [process.env.FYLO_PUBLIC_URL] : []),
    ...(process.env.LEVIO_PUBLIC_URL ? [process.env.LEVIO_PUBLIC_URL] : []),
    ...(process.env.CORS_ORIGINS?.split(',').map(s => s.trim()).filter(Boolean) ?? []),
])

// trust proxy: explicit hop count, driven by env. Self-host behind Caddy = 1.
// Managed behind Caddy+Cloudflare = 2. Required for express-rate-limit to
// identify the real client IP rather than the loopback proxy hop.
const trustProxyHops = parseInt(process.env.TRUST_PROXY_HOPS ?? '1', 10)
app.set('trust proxy', trustProxyHops)

// ── Security headers (helmet) ────────────────────────────────
// Registered BEFORE cors/routes so every response carries defense-in-depth
// headers even when a route short-circuits early. CSP is tuned for the
// Next.js app that fronts this API.
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            // Next.js needs inline scripts. Tighten post-launch with nonce-based CSP.
            scriptSrc: ["'self'", "'unsafe-inline'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", 'data:', 'https:'],
            connectSrc: ["'self'", 'https:', 'wss:'],
            fontSrc: ["'self'", 'data:'],
            objectSrc: ["'none'"],
            frameAncestors: ["'self'"],
        },
    },
    // Needed for Next.js image optimization & cross-origin asset loads
    crossOriginEmbedderPolicy: false,
    hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
    frameguard: { action: 'deny' },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}))

app.use(cors({
    origin: (origin, cb) => {
        // Allow non-browser requests (curl, health checks) and listed origins
        if (!origin || allowedOrigins.has(origin)) return cb(null, true)
        cb(new Error(`CORS: origin "${origin}" not allowed`))
    },
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    maxAge: 600, // cache CORS preflight 10 minutes to cut request volume
}))

// Body parsers: per-route limits enforced at the mount sites further below.
// The default 1 MB parser is applied here as a baseline; routes that need a
// larger budget (extensions uploads → 10 MB, Telegram webhooks → 2 MB) pass
// their own json() instance before hitting this one so the request body is
// already populated by the time the default parser runs.
const jsonDefault = express.json({ limit: '1mb' })
const urlencodedDefault = express.urlencoded({ limit: '1mb', extended: true })
const jsonLarge = express.json({ limit: '10mb' })
const jsonMedium = express.json({ limit: '2mb' })
const jsonSmall = express.json({ limit: '256kb' })

app.use(urlencodedDefault)
app.use(traceMiddleware)
app.use(sessionLogMiddleware)
app.use(metricsMiddleware) // Phase 7: per-request timing + status counter
app.use(generalLimiter) // default: 2000/15min

// CSRF — Origin/Referer validation for cookie-authed state-changing requests.
// Bearer-token and service-key auth are exempt (see middleware for details).
const originCsrf = createOriginCsrfMiddleware(allowedOrigins)

// ── Routes (/api/v1/ canonical + /api/ aliases) ──────────────

// Health — always available, no rate limit (exempt via skip fn)
app.use('/health', healthRouter)

// Metrics (Phase 7) — Prometheus text exposition. Auth enforced inside
// metricsRouter (bearer token via METRICS_TOKEN or super-admin session).
app.use('/metrics', metricsRouter)



// Register channel adapters (web, telegram, legacy slack/discord/twilio/gmail).
registerChannelAdapters()

// Build a v1 sub-router so we can mount once at both prefixes
const v1 = express.Router()

// ── Public routes (no auth) ──────────────────────────────────
// These MUST be mounted BEFORE the blanket requireAuth below.
// Each of these routes either has its own auth mechanism (webhook
// signature verification, OAuth state nonces, etc.) or is genuinely
// public (health check, login flow, registry discovery).
v1.use('/health', healthRouter)
v1.use('/metrics', metricsRouter) // Phase 7 — bearer token or super-admin (checked inside)
v1.use('/sse', sseRouter) // performs its own auth + workspace check
v1.use('/auth', authLimiter, jsonDefault, authRouter)
v1.use('/auth/handoff', jsonDefault, handoffRouter) // `/generate` has its own requireAuth
v1.use('/oauth', jsonDefault, oauthRouter)
v1.use('/webhooks/github', webhookLimiter, githubWebhooksRouter) // GitHub App webhook — raw body, X-Hub-Signature-256
v1.use('/webhooks', webhookLimiter, jsonSmall, webhooksRouter) // per-workspace HMAC + 256 KB cap
v1.use('/channels/telegram', webhookLimiter, jsonMedium, telegramRouter) // X-Telegram-Bot-Api-Secret-Token, 2 MB
v1.use('/channels/slack', webhookLimiter, jsonDefault, slackRouter) // X-Slack-Signature
v1.use('/channels/discord', webhookLimiter, jsonDefault, discordRouter) // ed25519 signature
v1.use('/channels/twilio', webhookLimiter, twilioRouter) // X-Twilio-Signature; body parsed by app-wide urlencoded middleware
v1.use('/a2a', jsonDefault, a2aRouter) // A2A spec — GET discovery is public, POST tasks has per-handler Bearer auth
v1.use('/registry', jsonDefault, registryRouter) // public tool discovery (POST/DELETE check inside)
v1.use('/skills', jsonDefault, publicSkillsRouter) // public skill validation (no auth, no DB)
v1.use('/stabilization', jsonDefault, stabilizationRouter) // service-key auth (self-contained)
v1.use('/profiles', jsonDefault, profilesRouter) // service-key auth (self-contained — app registration)
v1.use('/s', jsonDefault, publicShareRouter) // public share links — no auth
v1.use('/analytics', jsonDefault, analyticsRouter) // public: ingest, config read — no session required
v1.use('/channel', jsonDefault, channelDispatchRouter) // service-key auth (Bearer + X-App-Id, self-contained)

// ── Authenticated routes ─────────────────────────────────────
// Everything mounted after this line requires a valid session.
// Workspace-scoped routes ALSO get requireWorkspaceMember so the
// caller must belong to the workspace they're acting on.
v1.use(requireAuth)
// CSRF: mutating methods from cookie-authed sessions must carry an Origin
// that matches our allowlist. Bearer tokens and service-key SSR bypass.
v1.use(originCsrf)

// Route-specific body limits — mount BEFORE the default 1 MB parser so
// these parsers populate req.body first. express.json() is a no-op once
// the body is already parsed, so the default parser won't fire again.
v1.use('/extensions', jsonLarge)

// Default body parser for every authenticated v1 route: 1 MB.
v1.use(jsonDefault)

// External app agent dispatch (service-key auth via requireAuth above)
v1.use('/agents', agentsRunRouter)
v1.use('/agents', agentsRunCustomRouter)
v1.use('/agents', agentsActiveStreamRouter) // SSE workspace active-agents feed: GET /agents/active/stream

// Workspace-scoped (CRUD over workspace-owned data)
v1.use('/tasks', (req, res, next) => req.method === 'POST' ? taskCreationLimiter(req, res, next) : next(), workspaceRateLimit, tasksRouter)
v1.use('/tasks', taskStreamRouter) // SSE step-tail: GET /tasks/:id/steps/stream
v1.use('/revisions', jsonDefault, revisionDecisionRouter) // canonical decision seam: POST /revisions/:id/decision
v1.use('/outcomes', outcomesRouter) // outcomes/learning read view: GET /outcomes?workspaceId=
v1.use('/tasks', taskInjectRouter) // mid-run inject: POST /tasks/:id/inject
v1.use('/tasks/:taskId/clarification', clarificationRouter)
v1.use('/parallel', parallelRouter)
v1.use('/sprints', sprintsRouter)
v1.use('/sprints', sprintRunnerRouter)
v1.use('/dashboard', requireWorkspaceMember('workspaceId'), dashboardRouter)
v1.use('/approvals', owdRouter)
v1.use('/memory', requireWorkspaceMember('workspaceId'), memoryRouter)
v1.use('/connections', connectionsRouter) // some endpoints have no workspaceId (registry); per-handler checks
v1.use('/app-grants', appGrantsRouter) // ADR 0001 §3 — operator per-(app×workspace) capability grants
v1.use('/connections/gmessages', connectionsGmessagesRouter) // ADR-0005: pairing lifecycle, NOT subscription
// ADR 0013 §D9 — draft attachments. Mounted BEFORE conversationsRouter so
// the more specific /:conversationId/draft-attachments path matches first.
// express.raw() is registered inside the router so the default jsonDefault
// parser (1 MB limit) doesn't consume the multipart body.
v1.use('/conversations/:conversationId/draft-attachments', draftAttachmentsRouter)
v1.use('/conversations', conversationsRouter) // per-handler workspace check
v1.use('/workspaces', workspacesRouter) // list + /:id checked per-handler
v1.use('/workspaces/:workspaceId/api-keys', requireWorkspaceMember('workspaceId'), apiKeysRouter)
v1.use('/workspaces/:id/ai-providers', requireWorkspaceMember('id'), aiProviderCredsRouter)
v1.use('/workspaces/:id/key-shares', requireWorkspaceMember('id'), keySharesRouter)
v1.use('/settings/ai-providers', aiProvidersRouter)
v1.use('/channels', channelsRouter) // per-handler workspace check
v1.use('/cron', workspaceRateLimit, cronRouter) // per-handler workspace check
v1.use('/users', usersRouter)
v1.use('/workspaces/:id/members', requireWorkspaceMember('id'), membersRouter)
v1.use('/invites', invitesRouter)
v1.use('/extensions', workspaceRateLimit, extensionsRouter) // per-handler workspace check
v1.use('/hub', hubRouter) // in-app Hub catalog — per-handler workspace check
v1.use('/audit', requireWorkspaceMember('workspaceId'), auditRouter)
v1.use('/extension-audit', requireWorkspaceMember('workspaceId'), extensionAuditRouter)
v1.use('/escalations', requireWorkspaceMember('workspaceId'), escalationRouter)
v1.use('/foundry', requireSuperAdmin, foundryRouter)
v1.use('/admin/training-data', requireSuperAdmin, trainingDataRouter)
v1.use('/standing-approvals', standingApprovalsRouter)
v1.use('/user-self', userSelfRouter)
v1.use('/billing', billingRouter)
// Admin task triage — service-key auth (mounted before /admin so Express
// matches the more specific prefix first; auth model differs from the
// super-admin Command Center router below).
v1.use('/admin/tasks', requireServiceKey, adminTasksRouter)
// A3 Phase 7 — per-app service keys (replaces shared PLEXO_SERVICE_KEY)
v1.use('/admin/app-service-keys', requireSuperAdmin, appServiceKeysRouter)
// Admin routes — super-admin only (Command Center)
v1.use('/admin', requireSuperAdmin, adminRouter)
v1.use('/admin/ollama', requireSuperAdmin, ollamaAdminRouter)

v1.use('/debug', requireSuperAdmin, debugRouter)
v1.use('/ai', aiCompleteRouter)
v1.use('/ai', aiMediaRouter)
// External app AI task dispatch (Fylo etc.); service-key auth + workspace creds.
// Co-located under /ai/ to avoid clash with internal /tasks router above.
v1.use('/ai/tasks', jsonDefault, externalTasksRouter)
v1.use('/chat', chatRouter) // per-handler workspace check
v1.use('/chat', jsonDefault, chatAppTransportRouter) // Levio-Pex app transport (service key auth)
v1.use('/message-deliveries', messageDeliveriesRouter)
v1.use('/voice', voiceRouter)
v1.use('/search', searchRouter)
v1.use('/vision', visionRouter)
v1.use('/behavior/:workspaceId', requireWorkspaceMember('workspaceId'), behaviorRouter)
v1.use('/prompts/:workspaceId', requireWorkspaceMember('workspaceId'), promptsRouter)
v1.use('/context/:workspaceId', requireWorkspaceMember('workspaceId'), contextRouter)
v1.use('/system', requireSuperAdmin, systemRouter)
v1.use('/pax', paxRouter)
v1.use('/nodes', nodesRouter)
v1.use('/federation', federationRouter)
v1.use('/events', serviceLimiter, nodeEventsRouter)
v1.use('/workspaces/:id/apps', requireWorkspaceMember('id'), workspaceAppsRouter)
v1.use('/workspaces/:id/providers', requireWorkspaceMember('id'), providerInstancesRouter)
v1.use('/workspaces/:id/provider-alerts', requireWorkspaceMember('id'), providerAlertsRouter)
// Service-key /embed (single segment) must mount BEFORE the workspace-scoped
// settings router (two-segment /:workspaceId/...) so /embed resolves cleanly.
v1.use('/embeddings', embeddingsServiceRouter)
v1.use('/embeddings', embeddingsRouter)
v1.use('/intelligence', intelligenceRouter)
v1.use('/intel-dashboard', intelligenceDashboardRouter)
v1.use('/models', modelsRouter)
v1.use('/workspaces/:id/introspect', requireWorkspaceMember('id'), introspectRouter)
v1.use('/workspaces/:id/rsi', requireWorkspaceMember('id'), rsiRouter)
v1.use('/code', codeRouter)
v1.use('/works', worksRouter) // works listing — workspace-scoped
v1.use('/workbench', workbenchRouter) // works phase 7 — per-user pins
v1.use('/tools', toolsRouter) // works phase 5 — UI-initiated tool invoke
v1.use('/tools/gmessages', toolsGmessagesRouter) // app-integration surface (Levio SMS card, etc.)
v1.use('/shares', sharesRouter) // artifact share links — auth required

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

v1.get('/agent/health', async (_req, res) => {
    try {
        const { getAgentHealth } = await import('./agent-loop.js')
        const health = await getAgentHealth()
        res.json(health)
    } catch (err) {
        res.status(500).json({ error: 'Failed to retrieve agent health' })
    }
})

// Stripe webhook — mounted BEFORE /api/v1 so the raw body parser runs
// instead of express.json(). Stripe signature verification requires the
// exact request bytes. The billingRouter inside v1 provides the rest of
// the billing endpoints (GET /subscription, POST /checkout).
app.post(
    '/api/v1/billing/stripe-webhook',
    express.raw({ type: 'application/json', limit: '1mb' }),
    stripeWebhookHandler
)

// Canonical versioned prefix
app.use('/api/v1', v1)

// OAuth callbacks are constructed as /api/oauth/:provider/callback (no v1 prefix)
// by the redirect_uri builder in oauth.ts. Mount directly so Google/Slack/etc.
// can complete the OAuth flow regardless of API versioning.
app.use('/api/oauth', authLimiter, jsonDefault, oauthRouter)

// Universal Plexo SSO — Phase 1 (gated by PLEXO_SSO_ENABLED).
// Mounted unversioned because sibling apps construct stable URLs of the
// form /api/sso/handoff?app=…&return=… and /api/sso/verify.
app.use('/api/sso', authLimiter, jsonDefault, ssoRouter)

// Channel subscription contract for sibling apps (ADR-0002).
// HMAC-authenticated; mounted unversioned so app SDKs target a stable URL.
// The gmessages connector (Go sidecar) posts inbound events to the
// /gmessages subpath using the same HMAC envelope.
app.use('/api/plexo/channels/gmessages', jsonMedium, channelsGmessagesRouter)
app.use('/api/plexo/channels', jsonDefault, channelsSubscriptionRouter)

// Inngest function discovery + invocation. The dev server (compose service
// `inngest`) GETs this endpoint at boot to list registered functions and
// POSTs back to invoke them when crons fire. ADR-0006: Plexo and Levio
// share the Inngest substrate.
// Inngest payloads carry event data + step state per fn invocation.
app.use('/api/inngest', jsonLarge, createInngestExpressHandler([extractTurnFn, lessonsWriteFn, lessonsInvalidateFn]))

// Inference shim — exposes Plexo's per-workspace LLM provider router as an
// OpenAI-compatible endpoint for the Graphiti Python sidecar (ADR 0011).
// Phase 3a ships /v1/embeddings; Phase 3b adds /v1/chat/completions.
app.use('/api/inference', serviceLimiter, jsonDefault, inferenceRouter)

// Phase 8 graph routes — public surface for @joeybuilt/plexo-sdk 1.1.0.
// Proxies addEpisode + searchFacts through the bridge to the Graphiti sidecar.
app.use('/api/v1/graph', jsonDefault, graphRouter)

// Phase 8 themes-forest — Nexalog /app/graph clustered thematic view.
// On-demand label-propagation clustering of the workspace Entity graph.
app.use('/api/v1/themes', jsonDefault, themesRouter)

// Phase 8 synthesis inbox — Nexalog /app/synthesis. Suggestions derived
// from the same cached forest (stateless v1, no persistence table yet).
app.use('/api/v1/synthesis', jsonDefault, synthesisRouter)

// A2A spec — agent discovery at /.well-known/agent.json (no API prefix)
app.use('/.well-known', wellKnownAgentHandler())

// ── Self-heal middleware (Backlog A — stabilization) ─────────
// Catches transient/recoverable errors on idempotent routes and surfaces
// a 503 with Retry-After. Mounted before the global error handler so
// non-recoverable errors fall through to the existing INTERNAL_ERROR path.

import { selfHealMiddleware } from './stabilization/self-heal.js'
app.use(selfHealMiddleware())

// ── Error Handler ────────────────────────────────────────────

app.use((err: Error, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logger.error({ err, userId: req.user?.id, path: req.path, workspaceId: req.workspaceId, method: req.method }, 'Unhandled error')
    trackError(err, { context: 'express_error_handler' })
    // Include error type and sanitized message — never stack traces or file paths
    const errType = err.constructor?.name ?? 'Error'
    const safeMessage = err.message ? err.message.slice(0, 120) : 'Unknown error'
    res.status(500).json({
        error: {
            code: 'INTERNAL_ERROR',
            message: `${errType}: ${safeMessage}`,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- express locals
            requestId: (res as any).locals?.requestId ?? 'unknown',
        },
    })
})

// ── Start ────────────────────────────────────────────────────

const server = app.listen(port, '0.0.0.0', async () => {
    logger.info({ port }, 'Plexo API server started')
    // Phase 7: seed static build-info metric so scrapers can label alerts by version/commit
    setBuildInfo(
        process.env.APP_VERSION ?? '0.0.0',
        process.env.SOURCE_COMMIT ?? 'unknown',
    )
    // Start health monitor (if enabled)
    void import('./health-monitor.js').then(m => m.startHealthMonitor()).catch(err => logger.error({ err }, 'Health monitor failed to start'))
    // Single-writer local-instance descriptor claim (ADR 0001 §1, default-OFF
    // behind PLEXO_CLAIM_LOCAL_INSTANCE=1). Guarded so a claim failure never
    // crashes boot.
    try {
        await claimLocalInstance({ url: `http://127.0.0.1:${port}` })
    } catch (err) {
        logger.warn({ err }, 'claimLocalInstance threw during boot (ignored)')
    }
    // Init analytics — defaults off, then sync actual consent from DB
    configureAnalytics({
        instanceId: process.env.PLEXO_INSTANCE_ID ?? crypto.randomUUID(),
        plexoVersion: process.env.npm_package_version ?? '0.1.0',
        redisUrl: process.env.REDIS_URL,
    })
    // Sync consent state from DB — fixes the init race where events were dropped
    // between server start and first browser request
    void syncAnalyticsFromDB().then(async () => {
        // Analytics: session started — emit after consent state is synced
        try {
            const { emitSessionStarted } = await import('./analytics/events.js')
            emitSessionStarted()
        } catch { /* analytics must never crash the app */ }

        // Analytics: first boot detection — emit plexo_installed once
        try {
            const rows = await db.execute<{ count: number }>(sql`
                SELECT count(*) as count FROM plexo_ops_analytics WHERE event_name = 'plexo_installed'
            `)
            if (Number(rows[0]?.count ?? 0) === 0) {
                await db.execute(sql`
                    INSERT INTO plexo_ops_analytics (app, event_name, properties, instance_uuid)
                    VALUES ('plexo', 'plexo_installed', '{"source":"boot"}'::jsonb,
                            ${process.env.PLEXO_INSTANCE_ID ?? 'unknown'})
                `)
                logger.info('Analytics: plexo_installed event emitted (first boot)')
            }
        } catch { /* analytics must never crash the app */ }
    }).catch(() => { /* non-fatal — defaults remain */ })
    // On startup: reset any sprints left in 'running' state by a previous process.
    // Fire-and-forget async runners die with the process, leaving DB rows orphaned.
    void db.update(sprints)
        .set({ status: 'failed', completedAt: new Date() })
        .where(eq(sprints.status, 'running'))
        .then(async () => {
            logger.info('Startup: orphaned running sprints reset to failed')
            // FUN-019: also reset orphaned sprint_tasks still in running/queued
            await db.execute(sql`
                UPDATE sprint_tasks SET status = 'failed'
                WHERE status IN ('running', 'queued')
                  AND sprint_id IN (SELECT id FROM sprints WHERE status = 'failed')
            `)
            logger.info('Startup: orphaned sprint_tasks reset to failed')
        })
        .catch((err: unknown) => logger.error({ err }, 'Startup: failed to reset orphaned sprints'))

    // Reconcile self-node DID with PLEXO_INSTANCE_ID.
    // The migration inserts a placeholder self-record; this corrects it on every boot.
    void (async () => {
        try {
            const instanceId = process.env.PLEXO_INSTANCE_ID ?? crypto.randomUUID()
            const selfDid = `did:plexo:${instanceId}`
            // Upsert the authoritative self-record
            await db
                .insert(nodes)
                .values({ did: selfDid, displayName: 'Self', isSelf: true })
                .onConflictDoUpdate({
                    target: nodes.did,
                    set: { isSelf: true, displayName: 'Self' },
                })
            // Clear is_self on any stale placeholder rows (different DID)
            await db
                .update(nodes)
                .set({ isSelf: false })
                .where(eq(nodes.isSelf, true))
            // Re-mark the correct one (two-step avoids unique constraint issues)
            await db
                .update(nodes)
                .set({ isSelf: true })
                .where(eq(nodes.did, selfDid))
            logger.info({ selfDid }, 'Self-node DID reconciled')
        } catch (err) {
            logger.warn({ err }, 'Self-node DID reconciliation failed — non-fatal')
        }
    })()

    // Stabilization: wire LLM call latency metrics into the agent's callModel hook
    void (async () => {
        try {
            const { setLlmCallMetricsHook } = await import('@plexo/agent/providers/call-model')
            const { recordLlmLatency } = await import('./lib/metrics.js')
            setLlmCallMetricsHook((m: { provider: string; model: string; taskType: string; status: string; latencySec: number }) => {
                recordLlmLatency(m.provider, m.model, m.taskType, m.status, m.latencySec)
            })
            logger.info('LLM call metrics hook wired')
        } catch (err) {
            logger.warn({ err }, 'Failed to wire LLM metrics hook — non-fatal')
        }
    })()

    // QA-opt ADR 0037: wire router-v2 decision outcomes into Prometheus counters.
    void (async () => {
        try {
            const { setRoutedEventMetricsHook } = await import('@plexo/agent/providers/router-v2')
            const { recordModelRouted } = await import('./lib/metrics.js')
            setRoutedEventMetricsHook((evt) => {
                recordModelRouted({
                    taskType: evt.taskType,
                    fallback: evt.fallbackEngaged,
                    degraded: evt.degradation_reason !== undefined,
                    operatorAction: evt.requireOperatorAction,
                })
            })
            logger.info('Router metrics hook wired')
        } catch (err) {
            logger.warn({ err }, 'Failed to wire router metrics hook — non-fatal')
        }
    })()

    // QA-opt ADR 0044: wire memory-write outcomes (extracted|empty|failed) into a
    // Prometheus counter — graphiti is the canonical recall store, so a write that
    // extracts 0 facts is the real silent memory-loss signal.
    void (async () => {
        try {
            const { setMemoryWriteMetricsHook } = await import('@plexo/agent/analytics/memory-events')
            const { recordMemoryWrite } = await import('./lib/metrics.js')
            setMemoryWriteMetricsHook((m) => recordMemoryWrite(m))
            logger.info('Memory-write metrics hook wired')
        } catch (err) {
            logger.warn({ err }, 'Failed to wire memory-write metrics hook — non-fatal')
        }
    })()

    // Subscribe TASK_FAILED listeners BEFORE startAgentLoop so that any task
    // failing in the first ms after agent-loop boot still gets channel delivery.
    // In-process EventEmitter has zero buffer — a publish with no subscribers
    // is silently dropped.
    await import('./channel-delivery.js')
        .then(({ initTaskFailedListener }) => initTaskFailedListener())
        .catch((err) => logger.warn({ err }, 'TASK_FAILED listener init failed — non-fatal'))
    await import('@plexo/agent/tasks/reflect')
        .then(({ initReflectListener }) => initReflectListener())
        .catch((err) => logger.warn({ err }, 'Reflect listener init failed — non-fatal'))

    startAgentLoop()
    startCronDispatch()
    startEventProcessor()
    await initTelegramWebhook().catch((err) => logger.error({ err }, 'Telegram init failed'))

    // Phase 2b: smart-default seed for routing_chains. Idempotent —
    // workspaces that already have any chain rows are skipped, and
    // the seed is gated by ON CONFLICT DO NOTHING on the unique index.
    void (async () => {
        try {
            const { seedRoutingChainDefaults, reconcileRoutingChains } = await import('./lib/seed-routing-chains.js')
            const summary = await seedRoutingChainDefaults()
            if (summary.workspacesSeeded > 0) {
                logger.info(summary, 'Routing chain defaults seeded')
            } else {
                logger.info(summary, 'Routing chain defaults — nothing to seed')
            }
            // Self-heal: chains seeded earlier (when fewer providers existed) go
            // stale — newly-added providers never enter them. Reconcile appends
            // available providers as fallbacks + prunes disabled ones, preserving
            // operator ordering. Runs every boot.
            const recon = await reconcileRoutingChains()
            logger.info(recon, 'Routing chains reconciled')
        } catch (err) {
            logger.warn({ err }, 'Routing chain default seeding/reconcile failed — non-fatal')
        }
    })()

    // Background Sync
    if (process.env.PLEXO_DISABLE_CRONS !== '1') {
        void runCronJobs()
        setInterval(() => { void runCronJobs() }, 24 * 60 * 60 * 1000).unref()
    } else {
        logger.warn('Background runCronJobs disabled via PLEXO_DISABLE_CRONS=1')
    }

    // Provider-failure ops sink (Phase 4): the agent router fires cascade-exhaust
    // and auth/quota-streak events into this; we record a privacy-safe analytics
    // event and accumulate for the batched Telegram alert (flushed by cron).
    setProviderFailureSink((evt) => {
        emitProviderFailureEvent({
            kind: evt.kind,
            providerFamily: evt.provider,
            taskType: evt.taskType,
            statusCode: evt.statusCode,
            skippedCount: evt.skipped?.length,
        })
        recordProviderFailureForAlert({
            kind: evt.kind,
            provider: evt.provider,
            taskType: evt.taskType,
            statusCode: evt.statusCode,
        })
    })

    // Schedule automatic memory consolidation (every 6h, first run after 5m)
    scheduleMemoryConsolidation()

    // Event-driven consolidation: also consolidate when task count exceeds threshold
    if (process.env.PLEXO_DISABLE_CRONS !== '1') {
        void import('@plexo/agent/memory/consolidation')
            .then(({ initConsolidationListener }) => initConsolidationListener())
            .catch(() => { /* non-fatal — event bus may not be ready */ })
    }

    // Schedule RSI monitor every 6h (first run after 7m so it doesn't contend with memory consolidation)
    if (process.env.PLEXO_DISABLE_CRONS !== '1') {
        setTimeout(() => {
            void runRSIMonitor()
            setInterval(() => { void runRSIMonitor() }, 6 * 60 * 60 * 1000).unref()
        }, 7 * 60 * 1000)
    }

    // Onboarding canary — every 30m (first run after 4m). OFF unless both
    // PLEXO_ONBOARDING_CANARY=1 and PLEXO_ONBOARDING_CANARY_USER_ID are set.
    if (onboardingCanaryEnabled()) {
        logger.info('Onboarding canary enabled — scheduling synthetic first-workspace check every 30m')
        setTimeout(() => {
            void runOnboardingCanary()
            setInterval(() => { void runOnboardingCanary() }, 30 * 60 * 1000).unref()
        }, 4 * 60 * 1000)
    }

    // Seed default cron rows per workspace in one batch INSERT (avoids N+1 at startup)
    void db.execute(sql`
        INSERT INTO cron_jobs (id, workspace_id, name, schedule, enabled, created_at)
        SELECT gen_random_uuid(), w.id, n.name, '0 */6 * * *', true, now()
        FROM (SELECT id FROM workspaces LIMIT 50) w
        CROSS JOIN (VALUES ('Memory consolidation'), ('RSI Monitor')) AS n(name)
        WHERE NOT EXISTS (
            SELECT 1 FROM cron_jobs cj
            WHERE cj.workspace_id = w.id AND cj.name = n.name
        )
    `).catch((err: unknown) => logger.warn({ err }, 'Startup: failed to seed default cron rows — non-fatal'))

    // Wire sprint activity logger → SSE emitter so runner events stream to Control Room
    initSprintLogger((workspaceId: string, event: Record<string, unknown>) => emitToWorkspace(workspaceId, event as import('./sse-emitter.js').AgentEvent))

    // OWD → SSE: when an agent requests approval, push a real-time notification
    // to all connected SSE clients in that workspace so the approval banner appears
    eventBus.subscribe(TOPICS.OWD_PENDING, (payload) => {
        const record = payload as { workspaceId: string;[key: string]: unknown }
        emitToWorkspace(record.workspaceId, { type: 'owd.pending', data: record })
    })

    // Daily heartbeat — 10 min after startup then every 24h
    // Queries the DB; will be a no-op if analytics is disabled
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
                    memory: memEntryCount > 0,
                    sprints: !!sprintRow,
                    rsi: !!rsiRow,
                },
            })
            logger.debug('Analytics heartbeat sent')
        } catch (err) {
            logger.debug({ err }, 'Analytics heartbeat failed — suppressed')
        }
    }
    setTimeout(() => {
        void sendHeartbeat()
        setInterval(() => void sendHeartbeat(), HEARTBEAT_INTERVAL_MS).unref()
    }, 10 * 60 * 1000) // first ping 10m after startup
})

process.on('SIGTERM', async () => {
    logger.info('SIGTERM received — starting graceful shutdown')
    // Release the local-instance descriptor claim first so a restarting peer can
    // re-claim promptly. Best-effort, never throws.
    try {
        await releaseLocalInstance()
    } catch { /* release is best-effort */ }
    stopAgentLoop()
    stopEventProcessor()

    // Drain in-flight detached quality judges (Phase M) so their score/_judge
    // patch lands before teardown. Bounded well inside the 10s force-exit below.
    try {
        await Promise.race([
            drainPendingJudges(),
            new Promise<void>(r => setTimeout(r, 5_000).unref()),
        ])
        logger.info('Pending judges drained')
    } catch { /* drain is best-effort */ }

    terminateAll()

    // Drain DB connection pool
    try {
        const pg = db.$client as { end?: () => Promise<void> }
        if (typeof pg.end === 'function') await pg.end()
        logger.info('DB connection pool drained')
    } catch { /* pool may not be initialized */ }

    // Close Redis connection pool
    try {
        const { getRedis } = await import('./redis-client.js')
        const redis = await getRedis()
        await redis.quit()
        logger.info('Redis connection closed')
    } catch { /* may not be connected */ }

    server.close(() => process.exit(0))

    // Force exit after 10s if graceful shutdown stalls
    setTimeout(() => process.exit(1), 10_000).unref()
})

process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'Uncaught exception — shutting down')
    trackError(err, { context: 'uncaughtException' })
    process.exit(1)
})

process.on('unhandledRejection', (reason) => {
    // Normalize non-Error rejections so the log carries a message + stack
    // instead of an empty `reason:{}` (Round-5 Phase 1; mirrors cc-ingest.ts).
    const err = reason instanceof Error ? reason : new Error(String(reason))
    logger.error({ err }, 'Unhandled promise rejection')
    trackError(err, { context: 'unhandledRejection' })
})

export { app }
