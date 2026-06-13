// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { Router, type Router as RouterType } from 'express'
import { randomBytes } from 'node:crypto'
import { logger } from '../logger.js'
import * as oauthRepo from '../repositories/oauth.repository.js'
import { encrypt } from '../crypto.js'

export const oauthRouter: RouterType = Router()

function base64url(buf: Buffer): string {
    return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}


// Redis-backed PKCE state store (inline — no longer a separate file)
import { createClient, type RedisClientType } from 'redis'
import { UUID_RE } from '../validation.js'

const PKCE_TTL = 600
let _redis: RedisClientType | null = null
async function getRedis(): Promise<RedisClientType> {
    if (!_redis) {
        _redis = createClient({ url: process.env.REDIS_URL ?? 'redis://localhost:6379' }) as RedisClientType
        _redis.on('error', (err: Error) => logger.warn({ err }, '[pkce] Redis error'))
        await _redis.connect()
    }
    return _redis
}

// registryId stored so a single /google/callback handles all Google service types
// popupOrigin: when the OAuth popup is opened from a sibling app (e.g. Levio), the opener's
// origin is stored here so postMessage uses the correct targetOrigin instead of PUBLIC_URL.
interface PkceRecord { workspaceId: string; redirectUri: string; createdAt: number; registryId?: string; popupOrigin?: string }
const pkceKey = (s: string) => `pkce:${s}`

async function storePkce(state: string, record: PkceRecord): Promise<void> {
    const r = await getRedis()
    await r.setEx(pkceKey(state), PKCE_TTL, JSON.stringify(record))
}

async function consumePkce(state: string): Promise<PkceRecord | null> {
    const r = await getRedis()
    const result = await r.eval(
        `local v = redis.call('GET', KEYS[1]) if v then redis.call('DEL', KEYS[1]) end return v`,
        { keys: [pkceKey(state)], arguments: [] },
    ) as string | null
    if (!result) return null
    try { return JSON.parse(result) as PkceRecord } catch { return null }
}

// ── Generic provider OAuth2 (GitHub, Slack, Google) ─────────────────────────
// Pattern: open popup → /api/oauth/:provider/start → redirect to provider →
//          callback → store encrypted token → postMessage to opener → close popup
//
// Google providers (google-drive, gmail, google-calendar, google-workspace) all
// share a single callback URL (/api/oauth/google/callback) via callbackKey.
// The PKCE state record carries registryId so the callback knows which
// installed_connection row to create.

interface ProviderConfig {
    authUrl: string
    tokenUrl: string
    clientIdEnv: string
    clientSecretEnv: string
    defaultScopes: string
    registryId: string
    /** When set, overrides the :provider segment in the redirect_uri.
     *  All Google service providers set this to 'google' so only one
     *  redirect URI needs to be registered in Google Cloud Console. */
    callbackKey?: string
}

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'

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

    // ── Google providers — all route through /api/oauth/google/callback ────────
    // Only one redirect URI needs to be registered in Google Cloud Console:
    //   https://getplexo.com/api/oauth/google/callback
    'google-drive': {
        authUrl: GOOGLE_AUTH_URL,
        tokenUrl: GOOGLE_TOKEN_URL,
        clientIdEnv: 'GOOGLE_CLIENT_ID',
        clientSecretEnv: 'GOOGLE_CLIENT_SECRET',
        defaultScopes: [
            'https://www.googleapis.com/auth/drive.file',
            'https://www.googleapis.com/auth/drive.readonly',
            'https://www.googleapis.com/auth/userinfo.email',
            'https://www.googleapis.com/auth/userinfo.profile',
        ].join(' '),
        registryId: 'google-drive',
        callbackKey: 'google',
    },
    gmail: {
        authUrl: GOOGLE_AUTH_URL,
        tokenUrl: GOOGLE_TOKEN_URL,
        clientIdEnv: 'GOOGLE_CLIENT_ID',
        clientSecretEnv: 'GOOGLE_CLIENT_SECRET',
        defaultScopes: [
            'https://www.googleapis.com/auth/gmail.readonly',
            'https://www.googleapis.com/auth/gmail.modify',
            'https://www.googleapis.com/auth/gmail.send',
            'https://www.googleapis.com/auth/userinfo.email',
            'https://www.googleapis.com/auth/userinfo.profile',
        ].join(' '),
        registryId: 'gmail',
        callbackKey: 'google',
    },
    'google-calendar': {
        authUrl: GOOGLE_AUTH_URL,
        tokenUrl: GOOGLE_TOKEN_URL,
        clientIdEnv: 'GOOGLE_CLIENT_ID',
        clientSecretEnv: 'GOOGLE_CLIENT_SECRET',
        defaultScopes: [
            'https://www.googleapis.com/auth/calendar',
            'https://www.googleapis.com/auth/userinfo.email',
            'https://www.googleapis.com/auth/userinfo.profile',
        ].join(' '),
        registryId: 'google-calendar',
        callbackKey: 'google',
    },
    'google-workspace': {
        authUrl: GOOGLE_AUTH_URL,
        tokenUrl: GOOGLE_TOKEN_URL,
        clientIdEnv: 'GOOGLE_CLIENT_ID',
        clientSecretEnv: 'GOOGLE_CLIENT_SECRET',
        defaultScopes: [
            'https://www.googleapis.com/auth/gmail.readonly',
            'https://www.googleapis.com/auth/gmail.modify',
            'https://www.googleapis.com/auth/gmail.send',
            'https://www.googleapis.com/auth/calendar',
            'https://www.googleapis.com/auth/drive.file',
            'https://www.googleapis.com/auth/drive.readonly',
            'https://www.googleapis.com/auth/userinfo.email',
            'https://www.googleapis.com/auth/userinfo.profile',
        ].join(' '),
        registryId: 'google-workspace',
        callbackKey: 'google',
    },
    // Backward-compat alias — 'google' was the original Drive-only provider key
    google: {
        authUrl: GOOGLE_AUTH_URL,
        tokenUrl: GOOGLE_TOKEN_URL,
        clientIdEnv: 'GOOGLE_CLIENT_ID',
        clientSecretEnv: 'GOOGLE_CLIENT_SECRET',
        defaultScopes: [
            'https://www.googleapis.com/auth/drive.file',
            'https://www.googleapis.com/auth/drive.readonly',
            'https://www.googleapis.com/auth/userinfo.email',
            'https://www.googleapis.com/auth/userinfo.profile',
        ].join(' '),
        registryId: 'google-drive',
    },
}

// GET /api/oauth/:provider/start?workspaceId=&popupOrigin=
// popupOrigin is optional — sibling apps (Levio, Fylo) pass their own origin so the
// callback postMessage reaches the correct opener window instead of PUBLIC_URL.
oauthRouter.get('/:provider/start', async (req, res) => {
    const { provider } = req.params
    const { workspaceId, popupOrigin } = req.query as Record<string, string>

    const config = PROVIDERS[provider]
    if (!config) {
        res.status(404).json({ error: `Unknown provider: ${provider}` })
        return
    }
    if (!workspaceId || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: 'Valid workspaceId required' })
        return
    }

    // Validate popupOrigin against known-safe origins before storing.
    let resolvedPopupOrigin: string | undefined
    if (popupOrigin) {
        const allowed = [
            process.env.PUBLIC_URL,
            process.env.LEVIO_PUBLIC_URL,
            ...(process.env.CORS_ORIGINS?.split(',').map((s) => s.trim()) ?? []),
        ].filter(Boolean) as string[]
        const normalized = popupOrigin.replace(/\/$/, '')
        if (allowed.some((a) => a.replace(/\/$/, '') === normalized)) {
            resolvedPopupOrigin = normalized
        } else {
            res.status(400).json({ error: 'Invalid popupOrigin' })
            return
        }
    }

    const clientId = process.env[config.clientIdEnv]
    if (!clientId) {
        res.send(popupCloseScript({
            ok: false,
            provider,
            error: 'setup_required',
            envVar: config.clientIdEnv,
            message: `Set ${config.clientIdEnv} and ${config.clientSecretEnv} in the API environment to enable ${provider} OAuth.`,
        }, resolvedPopupOrigin))
        return
    }

    const state = base64url(randomBytes(16))
    // All Google providers share /api/oauth/google/callback — one redirect URI in Google Console
    const callbackProvider = config.callbackKey ?? provider
    const redirectUri = `${process.env.PUBLIC_URL ?? 'http://localhost:3001'}/api/oauth/${callbackProvider}/callback`

    try {
        await storePkce(state, { workspaceId, redirectUri, createdAt: Date.now(), registryId: config.registryId, popupOrigin: resolvedPopupOrigin })
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
    if (config.authUrl === GOOGLE_AUTH_URL) {
        params.set('access_type', 'offline')
        params.set('prompt', 'consent')
    }
    res.redirect(`${config.authUrl}?${params.toString()}`)
})

// GET /api/oauth/:provider/callback?code=&state=
oauthRouter.get('/:provider/callback', async (req, res) => {
    // Helmet sets COOP: same-origin globally. After the cross-origin Google redirect, that
    // nullifies window.opener so postMessage back to the parent never arrives. Override here.
    res.setHeader('Cross-Origin-Opener-Policy', 'unsafe-none')

    const { provider } = req.params
    const { code, state, error: oauthError } = req.query as Record<string, string>

    const config = PROVIDERS[provider]
    if (!config) {
        res.status(404).send('Unknown provider')
        return
    }

    if (oauthError) {
        res.send(popupCloseScript({ ok: false, error: oauthError, provider }))
        return
    }

    if (!code || !state) {
        res.status(400).send(popupCloseScript({ ok: false, error: 'missing_params', provider }))
        return
    }

    let pending: PkceRecord | null
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

    // Use registryId from PKCE state (set at start time) to support the unified
    // /google/callback that handles google-drive, gmail, google-calendar, google-workspace
    const effectiveRegistryId = pending.registryId ?? config.registryId

    try {
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
        if (!accessToken) {
            logger.error({ provider, tokenDataKeys: Object.keys(tokenData), hasAuthedUser: !!authedUser }, 'Token exchange returned no access_token')
            res.send(popupCloseScript({ ok: false, error: 'token_exchange_failed', provider }, pending.popupOrigin))
            return
        }

        // Fetch connected account email for Google providers
        let connectedEmail: string | null = null
        if (config.authUrl === GOOGLE_AUTH_URL) {
            try {
                const userInfoRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
                    headers: { Authorization: `Bearer ${accessToken}` },
                })
                if (userInfoRes.ok) {
                    const userInfo = await userInfoRes.json() as Record<string, unknown>
                    connectedEmail = (userInfo.email as string | undefined) ?? null
                }
            } catch { /* non-fatal */ }
        }

        const credentials = {
            access_token: accessToken,
            refresh_token: (tokenData.refresh_token as string | undefined) ?? null,
            expires_at: tokenData.expires_in
                ? new Date(Date.now() + Number(tokenData.expires_in) * 1000).toISOString()
                : null,
            bot_token: tokenData.access_token as string | undefined,
            scope: (tokenData.scope as string | undefined) ?? config.defaultScopes,
            ...(connectedEmail ? { email: connectedEmail } : {}),
        }

        const { workspaceId } = pending
        // Multi-account support: for Google providers, scope the uniqueness
        // by the connected account email so a workspace can connect multiple
        // Google accounts (e.g. personal + work). The `label` column backs
        // the unique index (workspace_id, registry_id, label).
        // CONTRACT: For Google providers, label === connectedEmail. The
        // frontend channels UI relies on `label.includes('@')` to extract the
        // email for the Gmail-connection dropdown — see
        // apps/web/src/app/app/settings/channels/page.tsx (gmailEmailFromConnection).
        // Do NOT change this without updating the frontend.
        const connectionLabel = connectedEmail ?? 'default'
        const existingId = await oauthRepo.findConnectionId(workspaceId, effectiveRegistryId, connectionLabel)

        const encrypted = { encrypted: encrypt(JSON.stringify(credentials), workspaceId) }
        const scopesGranted = typeof credentials.scope === 'string'
            ? credentials.scope.split(/[,\s]+/).filter(Boolean)
            : []

        const connectionName = connectedEmail
            ? `${connectedEmail}`
            : `${provider} (connected ${new Date().toLocaleDateString()})`

        if (existingId) {
            await oauthRepo.updateConnection(existingId, { credentials: encrypted, scopesGranted, name: connectionName, label: connectionLabel, status: 'active', lastVerifiedAt: new Date() })
        } else {
            await oauthRepo.insertConnection({
                workspaceId,
                registryId: effectiveRegistryId,
                name: connectionName,
                label: connectionLabel,
                status: 'active',
                credentials: encrypted,
                scopesGranted,
                lastVerifiedAt: new Date(),
            })
        }

        logger.info({ workspaceId, provider, effectiveRegistryId, connectedEmail }, 'OAuth token stored')
        res.send(popupCloseScript({ ok: true, provider, workspaceId, email: connectedEmail }, pending.popupOrigin))
    } catch (err) {
        logger.error({ err, provider }, 'OAuth token exchange failed')
        res.send(popupCloseScript({ ok: false, error: 'exchange_error', provider }, pending.popupOrigin))
    }
})

function escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

function popupCloseScript(payload: Record<string, unknown>, postMessageOrigin?: string): string {
    // SEC: JSON-in-script — escape <, >, & so injected strings can't close the <script> tag.
    const safeJson = JSON.stringify({ type: 'oauth_callback', ...payload })
        .replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
    // Use caller-supplied origin (validated against allowlist) or fall back to PUBLIC_URL.
    // JSON.stringify produces a safely escaped JS string literal ("\"https://...\"").
    const origin = postMessageOrigin ?? process.env.PUBLIC_URL ?? 'http://localhost:3000'
    const safeOrigin = JSON.stringify(origin)
    // SEC: HTML body — escape error string to prevent reflected XSS.
    const bodyText = payload.ok ? 'Connected! Closing…' : 'Error: ' + escapeHtml(String(payload.error ?? ''))
    return `<!DOCTYPE html><html><body><script>
        try { window.opener.postMessage(${safeJson}, ${safeOrigin}) } catch(e){}
        setTimeout(() => window.close(), 300)
    </script><p style="font-family:sans-serif;color:#aaa;text-align:center;margin-top:40vh">${bodyText}</p></body></html>`
}
