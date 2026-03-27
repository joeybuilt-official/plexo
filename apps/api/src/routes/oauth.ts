// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { Router, type Router as RouterType } from 'express'
import { randomBytes } from 'node:crypto'
import { logger } from '../logger.js'
import { db, eq, and } from '@plexo/db'
import { installedConnections } from '@plexo/db'
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

interface PkceRecord { workspaceId: string; redirectUri: string; createdAt: number }
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
    'google-workspace': {
        authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
        tokenUrl: 'https://oauth2.googleapis.com/token',
        clientIdEnv: 'GOOGLE_CLIENT_ID',
        clientSecretEnv: 'GOOGLE_CLIENT_SECRET',
        defaultScopes: [
            'https://www.googleapis.com/auth/gmail.readonly',
            'https://www.googleapis.com/auth/gmail.send',
            'https://www.googleapis.com/auth/calendar',
            'https://www.googleapis.com/auth/tasks.readonly',
            'https://www.googleapis.com/auth/userinfo.email',
            'https://www.googleapis.com/auth/userinfo.profile',
        ].join(' '),
        registryId: 'google-workspace',
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
    const redirectUri = `${process.env.PUBLIC_URL ?? 'http://localhost:3001'}/api/oauth/${provider}/callback`

    try {
        await storePkce(state, { workspaceId, redirectUri, createdAt: Date.now() })
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
    if (provider === 'google' || provider === 'google-workspace') params.set('access_type', 'offline')
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
            res.send(popupCloseScript({ ok: false, error: 'token_exchange_failed', provider }))
            return
        }

        // Fetch connected account email for Google providers
        let connectedEmail: string | null = null
        if (provider === 'google' || provider === 'google-workspace') {
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
        const existing = await db.select({ id: installedConnections.id })
            .from(installedConnections)
            .where(and(
                eq(installedConnections.workspaceId, workspaceId),
                eq(installedConnections.registryId, config.registryId),
            ))
            .limit(1)

        const encrypted = { encrypted: encrypt(JSON.stringify(credentials), workspaceId) }
        const scopesGranted = typeof credentials.scope === 'string'
            ? credentials.scope.split(/[,\s]+/).filter(Boolean)
            : []

        const connectionName = connectedEmail
            ? `${connectedEmail}`
            : `${provider} (connected ${new Date().toLocaleDateString()})`

        if (existing[0]) {
            await db.update(installedConnections)
                .set({ credentials: encrypted, scopesGranted, name: connectionName, status: 'active', lastVerifiedAt: new Date() })
                .where(eq(installedConnections.id, existing[0].id))
        } else {
            await db.insert(installedConnections).values({
                workspaceId,
                registryId: config.registryId,
                name: connectionName,
                status: 'active',
                credentials: encrypted,
                scopesGranted,
                lastVerifiedAt: new Date(),
            })
        }

        logger.info({ workspaceId, provider, connectedEmail }, 'OAuth token stored')
        res.send(popupCloseScript({ ok: true, provider, workspaceId, email: connectedEmail }))
    } catch (err) {
        logger.error({ err, provider }, 'OAuth token exchange failed')
        res.send(popupCloseScript({ ok: false, error: 'exchange_error', provider }))
    }
})

function popupCloseScript(payload: Record<string, unknown>): string {
    return `<!DOCTYPE html><html><body><script>
        try { window.opener.postMessage(${JSON.stringify({ type: 'oauth_callback', ...payload })}, '*') } catch(e){}
        setTimeout(() => window.close(), 300)
    </script><p style="font-family:sans-serif;color:#aaa;text-align:center;margin-top:40vh">${payload.ok ? 'Connected! Closing…' : 'Error: ' + String(payload.error)}</p></body></html>`
}
