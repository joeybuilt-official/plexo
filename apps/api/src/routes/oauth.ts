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

oauthRouter.get('/anthropic/start', async (req, res) => {
    const workspaceId = req.query.workspaceId as string
    if (!workspaceId) {
        res.status(400).json({ error: 'workspaceId required' })
        return
    }

    const { verifier, challenge } = generatePKCE()
    const state = base64url(randomBytes(16))
    const redirectUri = `${process.env.PUBLIC_URL}/api/oauth/anthropic/callback`

    try {
        await storePkce(state, {
            codeVerifier: verifier,
            workspaceId,
            redirectUri,
            createdAt: Date.now(),
        })
    } catch (err) {
        logger.error({ err }, 'PKCE store failed — Redis may be down')
        res.status(503).json({ error: 'OAuth service temporarily unavailable' })
        return
    }

    const url = buildAnthropicAuthUrl({ redirectUri, state, codeChallenge: challenge })
    res.json({ url, state })
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

        // Don't return raw tokens — they're persisted in DB now
        res.json({
            success: true,
            workspaceId: pending.workspaceId,
            credentialType: 'oauth_token',
            expiresIn: tokens.expires_in,
        })
    } catch (err) {
        logger.error({ err }, 'Anthropic OAuth exchange failed')
        res.status(502).json({ error: 'OAuth token exchange failed' })
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
