import { Router, type Router as RouterType } from 'express'
import { randomBytes, createHash } from 'node:crypto'
import { z } from 'zod'
import {
    ANTHROPIC_OAUTH,
    buildAnthropicAuthUrl,
    exchangeAnthropicCode,
} from '@plexo/agent/ai/anthropic-oauth'
import { logger } from '../logger.js'

export const oauthRouter: RouterType = Router()

// In-memory PKCE verifier store — keyed by state, cleared after exchange.
// In Phase 3+, move this to Redis with a short TTL.
const pkceStore = new Map<string, { verifier: string; workspaceId: string; redirectUri: string }>()

function base64url(buf: Buffer): string {
    return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

function generatePKCE(): { verifier: string; challenge: string } {
    const verifier = base64url(randomBytes(32))
    const challenge = base64url(Buffer.from(createHash('sha256').update(verifier).digest()))
    return { verifier, challenge }
}

// GET /api/oauth/anthropic/start?workspaceId=...
// Initiates the Anthropic OAuth flow — returns redirect URL.
oauthRouter.get('/anthropic/start', async (req, res) => {
    const workspaceId = req.query.workspaceId as string
    if (!workspaceId) {
        res.status(400).json({ error: 'workspaceId required' })
        return
    }

    const { verifier, challenge } = generatePKCE()
    const state = base64url(randomBytes(16))
    const redirectUri = `${process.env.PUBLIC_URL}/api/oauth/anthropic/callback`

    pkceStore.set(state, { verifier, workspaceId, redirectUri })

    // Clean up stale entries after 10 minutes
    setTimeout(() => pkceStore.delete(state), 10 * 60 * 1000)

    const url = buildAnthropicAuthUrl({ redirectUri, state, codeChallenge: challenge })
    res.json({ url, state })
})

// GET /api/oauth/anthropic/callback?code=...&state=...
const CallbackSchema = z.object({
    code: z.string(),
    state: z.string(),
})

oauthRouter.get('/anthropic/callback', async (req, res) => {
    const parse = CallbackSchema.safeParse(req.query)
    if (!parse.success) {
        res.status(400).json({ error: 'Invalid callback parameters' })
        return
    }

    const { code, state } = parse.data
    const pending = pkceStore.get(state)
    if (!pending) {
        res.status(400).json({ error: 'Invalid or expired state' })
        return
    }
    pkceStore.delete(state)

    try {
        const tokens = await exchangeAnthropicCode({
            code,
            redirectUri: pending.redirectUri,
            codeVerifier: pending.verifier,
        })

        logger.info({ workspaceId: pending.workspaceId }, 'Anthropic OAuth token obtained')

        // TODO Phase 3: persist encrypted tokens to installed_connections table
        // For now, return tokens so the web client can store them in the session
        res.json({
            workspaceId: pending.workspaceId,
            credentialType: 'oauth_token',
            expiresIn: tokens.expires_in,
            // DO NOT log the actual tokens — only return to client
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token,
        })
    } catch (err) {
        logger.error({ err }, 'Anthropic OAuth exchange failed')
        res.status(502).json({ error: 'OAuth token exchange failed' })
    }
})

// GET /api/oauth/anthropic/info — static info about Anthropic OAuth capabilities
oauthRouter.get('/anthropic/info', (_req, res) => {
    res.json({
        available: true,
        description: 'Authenticate with your Claude.ai subscription (Pro/Max) instead of a paid API key.',
        scopes: ANTHROPIC_OAUTH.scopes,
        clientId: ANTHROPIC_OAUTH.clientId,
        authorizationUrl: ANTHROPIC_OAUTH.authorizationUrl,
    })
})
