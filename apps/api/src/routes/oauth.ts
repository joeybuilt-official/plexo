import { Router, type Router as RouterType } from 'express'
import { randomBytes, createHash } from 'node:crypto'
import { z } from 'zod'
import {
    ANTHROPIC_OAUTH,
    buildAnthropicAuthUrl,
    exchangeAnthropicCode,
} from '@plexo/agent/ai/anthropic-oauth'
import { logger } from '../logger.js'
import { storePkce, consumePkce } from '../pkce-store.js'
import { storeAnthropicTokens } from '../anthropic-tokens.js'
import { db, eq, and } from '@plexo/db'
import { installedConnections } from '@plexo/db'
import { encrypt } from '../crypto.js'

export const oauthRouter: RouterType = Router()

function base64url(buf: Buffer): string {
    return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

function generatePKCE(): { verifier: string; challenge: string } {
    const verifier = base64url(randomBytes(32))
    const challenge = base64url(Buffer.from(createHash('sha256').update(verifier).digest()))
    return { verifier, challenge }
}

// ── GET /api/oauth/anthropic/start?workspaceId= ──────────────────────────────

// Anthropic's OAuth server requires http://localhost:{port}/callback
// (matches Claude Code's actual implementation).
const ANTHROPIC_REDIRECT_URI = `http://localhost:${process.env.PORT ?? 3001}/callback`

oauthRouter.get('/anthropic/start', async (req, res) => {
    const workspaceId = req.query.workspaceId as string
    if (!workspaceId) {
        res.status(400).json({ error: 'workspaceId required' })
        return
    }

    const { verifier, challenge } = generatePKCE()
    const state = base64url(randomBytes(16))

    try {
        await storePkce(state, {
            codeVerifier: verifier,
            workspaceId,
            redirectUri: ANTHROPIC_REDIRECT_URI,
            createdAt: Date.now(),
        })
    } catch (err) {
        logger.error({ err }, 'PKCE store failed — Redis may be down')
        res.status(503).json({ error: 'OAuth service temporarily unavailable' })
        return
    }

    const url = buildAnthropicAuthUrl({ redirectUri: ANTHROPIC_REDIRECT_URI, state, codeChallenge: challenge })
    res.redirect(url)
})

// ── GET /api/oauth/anthropic/callback?code=...&state=... ─────────────────────

const CallbackSchema = z.object({ code: z.string(), state: z.string() })

oauthRouter.get('/anthropic/callback', async (req, res) => {
    const parse = CallbackSchema.safeParse(req.query)
    if (!parse.success) {
        res.status(400).json({ error: 'Invalid callback parameters' })
        return
    }

    const { code, state } = parse.data

    let pending: Awaited<ReturnType<typeof consumePkce>>
    try {
        pending = await consumePkce(state)
    } catch (err) {
        logger.error({ err }, 'PKCE consume failed')
        res.status(503).json({ error: 'OAuth service temporarily unavailable' })
        return
    }

    if (!pending) {
        res.status(400).json({ error: 'Invalid or expired state — please restart the OAuth flow' })
        return
    }

    try {
        const tokens = await exchangeAnthropicCode({
            code,
            redirectUri: pending.redirectUri,
            codeVerifier: pending.codeVerifier,
        })

        // Persist encrypted to installed_connections (Phase 4)
        await storeAnthropicTokens(pending.workspaceId, tokens)

        logger.info({ workspaceId: pending.workspaceId }, 'Anthropic OAuth tokens stored (encrypted)')

        res.send(popupCloseScript({
            ok: true,
            provider: 'anthropic',
            workspaceId: pending.workspaceId,
            credentialType: 'oauth_token',
        }))
    } catch (err) {
        logger.error({ err }, 'Anthropic OAuth exchange failed')
        res.send(popupCloseScript({ ok: false, provider: 'anthropic', error: 'exchange_failed' }))
    }
})

// ── Generic provider OAuth2 (GitHub, Slack, Google) ─────────────────────────
// Pattern: open popup → /api/oauth/:provider/start → redirect to provider →
//          callback → store encrypted token → postMessage to opener → close popup

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface ProviderConfig {
    authUrl: string
    tokenUrl: string
    clientIdEnv: string
    clientSecretEnv: string
    defaultScopes: string
    registryId: string
}

const PROVIDERS: Record<string, ProviderConfig> = {
    github: {
        authUrl: 'https://github.com/login/oauth/authorize',
        tokenUrl: 'https://github.com/login/oauth/access_token',
        clientIdEnv: 'GITHUB_CLIENT_ID',
        clientSecretEnv: 'GITHUB_CLIENT_SECRET',
        defaultScopes: 'repo read:org workflow',
        registryId: 'github',
    },
    slack: {
        authUrl: 'https://slack.com/oauth/v2/authorize',
        tokenUrl: 'https://slack.com/api/oauth.v2.access',
        clientIdEnv: 'SLACK_CLIENT_ID',
        clientSecretEnv: 'SLACK_CLIENT_SECRET',
        defaultScopes: 'chat:write,commands,im:history',
        registryId: 'slack',
    },
    google: {
        authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
        tokenUrl: 'https://oauth2.googleapis.com/token',
        clientIdEnv: 'GOOGLE_CLIENT_ID',
        clientSecretEnv: 'GOOGLE_CLIENT_SECRET',
        defaultScopes: 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.readonly',
        registryId: 'google-drive',
    },
}

// GET /api/oauth/:provider/start?workspaceId=
oauthRouter.get('/:provider/start', async (req, res) => {
    const { provider } = req.params
    const { workspaceId } = req.query as Record<string, string>

    const config = PROVIDERS[provider]
    if (!config) {
        res.status(404).json({ error: `Unknown provider: ${provider}` })
        return
    }
    if (!workspaceId || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: 'Valid workspaceId required' })
        return
    }

    const clientId = process.env[config.clientIdEnv]
    if (!clientId) {
        // Return an HTML popup-close page so the UI message handler can surface the error cleanly
        res.send(popupCloseScript({
            ok: false,
            provider,
            error: 'setup_required',
            envVar: config.clientIdEnv,
            message: `Set ${config.clientIdEnv} and ${config.clientSecretEnv} in the API environment to enable ${provider} OAuth.`,
        }))
        return
    }

    const state = base64url(randomBytes(16))
    const redirectUri = `${process.env.API_PUBLIC_URL ?? 'http://localhost:3001'}/api/oauth/${provider}/callback`

    try {
        await storePkce(state, {
            codeVerifier: '',  // not used for GitHub/Slack (no PKCE)
            workspaceId,
            redirectUri,
            createdAt: Date.now(),
        })
    } catch (err) {
        logger.error({ err }, `${provider} OAuth: PKCE store failed`)
        res.status(503).json({ error: 'OAuth service temporarily unavailable' })
        return
    }

    const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        scope: config.defaultScopes,
        state,
        response_type: 'code',
    })
    // Google requires access_type=offline for refresh tokens
    if (provider === 'google') params.set('access_type', 'offline')

    res.redirect(`${config.authUrl}?${params.toString()}`)
})

// GET /api/oauth/:provider/callback?code=&state=
oauthRouter.get('/:provider/callback', async (req, res) => {
    const { provider } = req.params
    const { code, state, error: oauthError } = req.query as Record<string, string>

    const config = PROVIDERS[provider]
    if (!config) {
        res.status(404).send('Unknown provider')
        return
    }

    // Surface provider denials gracefully (popup close)
    if (oauthError) {
        res.send(popupCloseScript({ ok: false, error: oauthError, provider }))
        return
    }

    if (!code || !state) {
        res.status(400).send(popupCloseScript({ ok: false, error: 'missing_params', provider }))
        return
    }

    let pending: Awaited<ReturnType<typeof consumePkce>>
    try {
        pending = await consumePkce(state)
    } catch (err) {
        logger.error({ err }, `${provider} OAuth: PKCE consume failed`)
        res.status(503).send(popupCloseScript({ ok: false, error: 'state_error', provider }))
        return
    }

    if (!pending) {
        res.status(400).send(popupCloseScript({ ok: false, error: 'invalid_state', provider }))
        return
    }

    const clientId = process.env[config.clientIdEnv] ?? ''
    const clientSecret = process.env[config.clientSecretEnv] ?? ''

    try {
        // Exchange code for tokens
        const tokenRes = await fetch(config.tokenUrl, {
            method: 'POST',
            headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
            body: JSON.stringify({
                client_id: clientId,
                client_secret: clientSecret,
                code,
                redirect_uri: pending.redirectUri,
                grant_type: 'authorization_code',
            }),
        })
        const tokenData = await tokenRes.json() as Record<string, unknown>

        const authedUser = tokenData.authed_user as Record<string, unknown> | undefined
        const accessToken = (tokenData.access_token ?? authedUser?.access_token) as string | undefined
        if (!tokenData || !accessToken) {
            logger.error({ tokenData, provider }, 'Token exchange returned no access_token')
            res.send(popupCloseScript({ ok: false, error: 'token_exchange_failed', provider }))
            return
        }

        const credentials = {
            access_token: accessToken,
            refresh_token: (tokenData.refresh_token as string | undefined) ?? null,
            expires_at: tokenData.expires_in
                ? new Date(Date.now() + Number(tokenData.expires_in) * 1000).toISOString()
                : null,
            bot_token: (tokenData.access_token) as string | undefined,  // Slack workspace token
            scope: (tokenData.scope as string | undefined) ?? config.defaultScopes,
        }

        // Upsert into installed_connections
        const { workspaceId } = pending
        const existing = await db.select({ id: installedConnections.id })
            .from(installedConnections)
            .where(and(
                eq(installedConnections.workspaceId, workspaceId),
                eq(installedConnections.registryId, config.registryId)
            ))
            .limit(1)

        const encrypted = { encrypted: encrypt(JSON.stringify(credentials), workspaceId) }
        const scopesGranted = typeof credentials.scope === 'string'
            ? credentials.scope.split(/[,\s]+/).filter(Boolean)
            : []

        if (existing[0]) {
            await db.update(installedConnections)
                .set({ credentials: encrypted, scopesGranted, status: 'active', lastVerifiedAt: new Date() })
                .where(eq(installedConnections.id, existing[0].id))
        } else {
            const { ulid } = await import('ulid')
            await db.insert(installedConnections).values({
                id: ulid(),
                workspaceId,
                registryId: config.registryId,
                name: `${provider} (connected ${new Date().toLocaleDateString()})`,
                status: 'active',
                credentials: encrypted,
                scopesGranted,
                lastVerifiedAt: new Date(),
            })
        }

        logger.info({ workspaceId, provider }, 'OAuth token stored')
        res.send(popupCloseScript({ ok: true, provider, workspaceId }))
    } catch (err) {
        logger.error({ err, provider }, 'OAuth token exchange failed')
        res.send(popupCloseScript({ ok: false, error: 'exchange_error', provider }))
    }
})

/** Sends an HTML page that posts a message to the opener and closes itself */
function popupCloseScript(payload: Record<string, unknown>): string {
    return `<!DOCTYPE html><html><body><script>
        try { window.opener.postMessage(${JSON.stringify({ type: 'oauth_callback', ...payload })}, '*') } catch(e){}
        setTimeout(() => window.close(), 300)
    </script><p style="font-family:sans-serif;color:#aaa;text-align:center;margin-top:40vh">${payload.ok ? 'Connected! Closing…' : 'Error: ' + String(payload.error)}</p></body></html>`
}

// ── POST /api/oauth/anthropic/import-cli ────────────────────────────────────
// Dev-only: reads ~/.claude/.credentials.json (written by Claude Code CLI)
// and loads the stored OAuth tokens directly into Plexo's credential store.
// Only works when the file exists on the server's local filesystem.

oauthRouter.post('/anthropic/import-cli', async (req, res) => {
    const { workspaceId } = req.body as { workspaceId?: string }
    if (!workspaceId) {
        res.status(400).json({ error: 'workspaceId required' })
        return
    }
    try {
        const { readFileSync } = await import('node:fs')
        const home = process.env.HOME ?? '/root'
        const raw = JSON.parse(readFileSync(`${home}/.claude/.credentials.json`, 'utf8'))
        const oauth = raw?.claudeAiOauth
        if (!oauth?.accessToken) {
            res.status(404).json({ error: 'No claudeAiOauth.accessToken found in ~/.claude/.credentials.json' })
            return
        }
        const expiresIn = Math.max(0, Math.floor((oauth.expiresAt - Date.now()) / 1000))
        await storeAnthropicTokens(workspaceId, {
            access_token: oauth.accessToken,
            refresh_token: oauth.refreshToken,
            expires_in: expiresIn,
        })
        logger.info({ workspaceId, expiresIn }, 'Anthropic OAuth token imported from Claude Code CLI')
        res.json({ ok: true, expiresIn, tokenPrefix: String(oauth.accessToken).slice(0, 20) + '…' })
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.error({ err }, 'CLI token import failed')
        res.status(500).json({ error: msg })
    }
})

// ── GET /api/oauth/anthropic/info ────────────────────────────────────────────

oauthRouter.get('/anthropic/info', (_req, res) => {
    res.json({
        available: true,
        description: 'Authenticate with your Claude.ai subscription (Pro/Max) instead of a paid API key.',
        scopes: ANTHROPIC_OAUTH.scopes,
        clientId: ANTHROPIC_OAUTH.clientId,
        authorizationUrl: ANTHROPIC_OAUTH.authorizationUrl,
    })
})
