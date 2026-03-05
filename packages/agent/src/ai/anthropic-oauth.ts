/**
 * AI Provider credential types.
 *
 * Plexo supports two Anthropic credential modes:
 *
 * 1. api_key     — Standard Anthropic API key (paid per-token usage)
 * 2. oauth_token — Anthropic OAuth via claude.ai subscription
 *                  Same flow as Claude Code. Uses the user's Pro/Max subscription
 *                  credits instead of paying API rates. Much cheaper for high-volume
 *                  operators. Access tokens are short-lived (1hr); refresh tokens
 *                  are used automatically.
 *
 * The agent always resolves credentials at call time via resolveAnthropicCredential()
 * and never caches them in memory between requests.
 */

import type { AnthropicCredential } from '../types.js'
import { PlexoError } from '../errors.js'

// ── Anthropic OAuth constants (matches Claude Code implementation) ────────────

export const ANTHROPIC_OAUTH = {
    /** Public OAuth client ID — same as Claude Code */
    clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
    authorizationUrl: 'https://claude.ai/oauth/authorize',
    tokenUrl: 'https://api.anthropic.com/oauth/token',
    /** Scopes required for API access via subscription — matches claude setup-token */
    scopes: ['user:inference'],
    /** Access tokens expire after 1 hour */
    accessTokenTtlMs: 60 * 60 * 1000,
} as const

// ── Authorization URL builder ─────────────────────────────────────────────────

export interface OAuthStatePayload {
    workspaceId: string
    redirectUri: string
    nonce: string
}

export function buildAnthropicAuthUrl(params: {
    redirectUri: string
    state: string
    codeChallenge: string
}): string {
    const url = new URL(ANTHROPIC_OAUTH.authorizationUrl)
    url.searchParams.set('code', 'true')
    url.searchParams.set('client_id', ANTHROPIC_OAUTH.clientId)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('redirect_uri', params.redirectUri)
    url.searchParams.set('scope', ANTHROPIC_OAUTH.scopes.join(' '))
    url.searchParams.set('state', params.state)
    url.searchParams.set('code_challenge', params.codeChallenge)
    url.searchParams.set('code_challenge_method', 'S256')
    return url.toString()
}

// ── Token exchange ────────────────────────────────────────────────────────────

export interface OAuthTokenResponse {
    access_token: string
    refresh_token: string
    token_type: string
    expires_in: number
    scope: string
}

export async function exchangeAnthropicCode(params: {
    code: string
    redirectUri: string
    codeVerifier: string
}): Promise<OAuthTokenResponse> {
    const res = await fetch(ANTHROPIC_OAUTH.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            grant_type: 'authorization_code',
            client_id: ANTHROPIC_OAUTH.clientId,
            code: params.code,
            redirect_uri: params.redirectUri,
            code_verifier: params.codeVerifier,
        }),
    })

    if (!res.ok) {
        const body = await res.text()
        throw new PlexoError(
            `Anthropic OAuth token exchange failed: ${body}`,
            'OAUTH_TOKEN_EXCHANGE_FAILED',
            'upstream',
            502,
        )
    }

    return res.json() as Promise<OAuthTokenResponse>
}

export async function refreshAnthropicToken(refreshToken: string): Promise<OAuthTokenResponse> {
    const res = await fetch(ANTHROPIC_OAUTH.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            grant_type: 'refresh_token',
            client_id: ANTHROPIC_OAUTH.clientId,
            refresh_token: refreshToken,
        }),
    })

    if (!res.ok) {
        const body = await res.text()
        throw new PlexoError(
            `Anthropic OAuth token refresh failed: ${body}`,
            'OAUTH_TOKEN_REFRESH_FAILED',
            'upstream',
            502,
        )
    }

    return res.json() as Promise<OAuthTokenResponse>
}

// ── Credential resolver ───────────────────────────────────────────────────────
// Credentials are fetched fresh from DB at call time — never cached in memory.

export async function resolveAnthropicHeaders(
    credential: AnthropicCredential,
    onRefresh?: (updated: AnthropicCredential) => Promise<void>,
): Promise<Record<string, string>> {
    if (credential.type === 'api_key') {
        // Claude.ai subscription tokens (sk-ant-oat*) use Authorization: Bearer, not x-api-key
        if (credential.apiKey.startsWith('sk-ant-oat')) {
            return {
                'Authorization': `Bearer ${credential.apiKey}`,
                'anthropic-version': '2023-06-01',
                'anthropic-beta': 'oauth-2025-04-20',
            }
        }
        return {
            'x-api-key': credential.apiKey,
            'anthropic-version': '2023-06-01',
        }
    }

    // OAuth path — check if access token needs refresh
    const now = Date.now()
    const expiresAt = credential.expiresAt ?? 0

    if (now >= expiresAt - 60_000) {
        // Refresh proactively 60s before expiry
        const refreshed = await refreshAnthropicToken(credential.refreshToken)
        const updated: AnthropicCredential = {
            ...credential,
            accessToken: refreshed.access_token,
            refreshToken: refreshed.refresh_token,
            expiresAt: now + refreshed.expires_in * 1000,
        }
        await onRefresh?.(updated)
        return {
            Authorization: `Bearer ${updated.accessToken}`,
            'anthropic-version': '2023-06-01',
            'anthropic-beta': 'oauth-2025-04-20',
        }
    }

    return {
        Authorization: `Bearer ${credential.accessToken}`,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'oauth-2025-04-20',
    }
}
