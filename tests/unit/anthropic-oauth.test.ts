import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
    buildAnthropicAuthUrl,
    ANTHROPIC_OAUTH,
} from '../../packages/agent/src/ai/anthropic-oauth.js'

// Mock fetch for token exchange/refresh tests
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

describe('Anthropic OAuth', () => {
    beforeEach(() => mockFetch.mockReset())
    afterEach(() => vi.restoreAllMocks())

    describe('ANTHROPIC_OAUTH constants', () => {
        it('uses the correct public client ID', () => {
            expect(ANTHROPIC_OAUTH.clientId).toBe('9d1c250a-e61b-44d9-88ed-5944d1962f5e')
        })

        it('authorization URL points to claude.ai', () => {
            expect(ANTHROPIC_OAUTH.authorizationUrl).toBe('https://claude.ai/oauth/authorize')
        })

        it('token URL points to api.anthropic.com', () => {
            expect(ANTHROPIC_OAUTH.tokenUrl).toBe('https://api.anthropic.com/oauth/token')
        })

        it('includes required scopes', () => {
            expect(ANTHROPIC_OAUTH.scopes).toContain('user:inference')
        })
    })

    describe('buildAnthropicAuthUrl', () => {
        it('returns a valid HTTPS URL', () => {
            const url = buildAnthropicAuthUrl({
                redirectUri: 'https://app.test/callback',
                state: 'test-state',
                codeChallenge: 'test-challenge',
            })
            expect(url).toMatch(/^https:\/\/claude\.ai\/oauth\/authorize/)
        })

        it('includes required PKCE parameters', () => {
            const url = buildAnthropicAuthUrl({
                redirectUri: 'https://app.test/callback',
                state: 'abc123',
                codeChallenge: 'S256-challenge',
            })
            const parsed = new URL(url)
            expect(parsed.searchParams.get('client_id')).toBe(ANTHROPIC_OAUTH.clientId)
            expect(parsed.searchParams.get('response_type')).toBe('code')
            expect(parsed.searchParams.get('code_challenge_method')).toBe('S256')
            expect(parsed.searchParams.get('state')).toBe('abc123')
            expect(parsed.searchParams.get('code_challenge')).toBe('S256-challenge')
        })

        it('includes all required scopes', () => {
            const url = buildAnthropicAuthUrl({
                redirectUri: 'https://app.test/callback',
                state: 'x',
                codeChallenge: 'y',
            })
            const scope = new URL(url).searchParams.get('scope')
            expect(scope).toContain('user:inference')
        })
    })

    describe('resolveAnthropicHeaders — api_key path', () => {
        it('returns x-api-key header for api_key credential', async () => {
            const { resolveAnthropicHeaders } = await import('../../packages/agent/src/ai/anthropic-oauth.js')
            const headers = await resolveAnthropicHeaders({ type: 'api_key', apiKey: 'sk-ant-test' })
            expect(headers['x-api-key']).toBe('sk-ant-test')
            expect(headers['anthropic-version']).toMatch(/^\d{4}-\d{2}-\d{2}$/)
        })
    })

    describe('resolveAnthropicHeaders — oauth_token path (valid token)', () => {
        it('returns Authorization header for non-expired oauth token', async () => {
            const { resolveAnthropicHeaders } = await import('../../packages/agent/src/ai/anthropic-oauth.js')
            const headers = await resolveAnthropicHeaders({
                type: 'oauth_token',
                accessToken: 'access-token-abc',
                refreshToken: 'refresh-token-xyz',
                expiresAt: Date.now() + 120_000, // 2 min from now — not expired
            })
            expect(headers['Authorization']).toBe('Bearer access-token-abc')
            expect(headers['anthropic-beta']).toContain('oauth')
        })
    })

    describe('resolveAnthropicHeaders — oauth_token path (expired token)', () => {
        it('refreshes token when within 60s of expiry', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    access_token: 'new-access-token',
                    refresh_token: 'new-refresh-token',
                    expires_in: 3600,
                    token_type: 'bearer',
                    scope: 'org:create_api_key',
                }),
            })

            const { resolveAnthropicHeaders } = await import('../../packages/agent/src/ai/anthropic-oauth.js')
            const onRefresh = vi.fn()
            const headers = await resolveAnthropicHeaders(
                {
                    type: 'oauth_token',
                    accessToken: 'old-access-token',
                    refreshToken: 'old-refresh-token',
                    expiresAt: Date.now() + 30_000, // 30s — within the 60s refresh window
                },
                onRefresh,
            )

            expect(mockFetch).toHaveBeenCalledOnce()
            expect(headers['Authorization']).toBe('Bearer new-access-token')
            expect(onRefresh).toHaveBeenCalledWith(
                expect.objectContaining({ accessToken: 'new-access-token' }),
            )
        })
    })
})
