/**
 * Claude Max subscription transport for the `anthropic_subscription` provider.
 *
 * A subscription OAuth token (`sk-ant-oat01-…`, from `claude setup-token`) is
 * accepted by the normal Anthropic Messages API via `Authorization: Bearer`
 * — NOT `x-api-key` (that 401s) — provided the first `system` block is the
 * Claude Code identity string. This module is a `fetch` wrapper that rewrites
 * an outgoing `@ai-sdk/anthropic` request to satisfy that contract, so the
 * provider is a native Vercel AI SDK `LanguageModelV2` with no extra SDK.
 *
 * The token is treated as a secret: it is only ever placed in the outbound
 * Authorization header and is never included in any thrown error message.
 */

// The following three constants are an undocumented Anthropic contract for the
// OAuth/subscription path. If Anthropic rotates them every subscription call
// will 429/401 with the API-key path unaffected (masking it). Re-verify here.
// VERIFIED 2026-06-02 against api.anthropic.com/v1/messages (live oat01 token).
export const CLAUDE_CODE_SYSTEM_IDENTITY =
    "You are Claude Code, Anthropic's official CLI for Claude."
export const CLAUDE_CODE_OAUTH_BETA = 'claude-code-20250219,oauth-2025-04-20'
export const CLAUDE_CODE_USER_AGENT = 'claude-cli/2.1.75 (external, cli)'

const REWRITE_FAILED = 'oauth_subscription_request_rewrite_failed'

export function isOAuthToken(token: string): boolean {
    return token.startsWith('sk-ant-oat')
}

/**
 * Resolve the subscription token from explicit config or the environment.
 * Never hardcoded; the env var is populated from a secrets manager / the
 * operator's `claude setup-token` output. Throws (without echoing the token)
 * when absent.
 */
export function resolveSubscriptionToken(configToken?: string): string {
    const tok = (configToken?.trim() || process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim()) ?? ''
    if (!tok) {
        throw new Error(
            'anthropic_subscription: no OAuth token. Set CLAUDE_CODE_OAUTH_TOKEN ' +
            '(run `claude setup-token`) or store it in the workspace provider config.',
        )
    }
    return tok
}

type SystemBlock = { type: 'text'; text: string; [k: string]: unknown }

/**
 * Ensure the Claude Code identity is the FIRST system block while preserving
 * the caller's own system prompt verbatim (Anthropic accepts a multi-block
 * `system`). Returns the new value for the body's `system` field.
 */
function withIdentitySystem(system: unknown): SystemBlock[] {
    const identity: SystemBlock = { type: 'text', text: CLAUDE_CODE_SYSTEM_IDENTITY }
    if (system == null) return [identity]
    if (typeof system === 'string') {
        return system.trim() === CLAUDE_CODE_SYSTEM_IDENTITY
            ? [identity]
            : [identity, { type: 'text', text: system }]
    }
    if (Array.isArray(system)) {
        const blocks = system as SystemBlock[]
        const first = blocks[0]
        if (first && typeof first.text === 'string' && first.text === CLAUDE_CODE_SYSTEM_IDENTITY) {
            return blocks
        }
        return [identity, ...blocks]
    }
    // Unknown shape — wrap it defensively rather than drop it.
    return [identity, { type: 'text', text: String(system) }]
}

function rewriteHeaders(input: HeadersInit | undefined, token: string): Headers {
    const h = new Headers(input)
    h.delete('x-api-key')
    h.set('authorization', `Bearer ${token}`)
    const existingBeta = h.get('anthropic-beta')
    if (!existingBeta) {
        h.set('anthropic-beta', CLAUDE_CODE_OAUTH_BETA)
    } else if (!existingBeta.includes('oauth-2025-04-20')) {
        h.set('anthropic-beta', `${existingBeta},${CLAUDE_CODE_OAUTH_BETA}`)
    }
    h.set('user-agent', CLAUDE_CODE_USER_AGENT)
    h.set('x-app', 'cli')
    return h
}

function rewriteBody(body: BodyInit | null | undefined): BodyInit | null | undefined {
    if (typeof body !== 'string') return body
    // Fast path: identity already present → no parse/serialize tax on the hot path.
    if (body.includes(CLAUDE_CODE_SYSTEM_IDENTITY)) return body
    const parsed = JSON.parse(body) as Record<string, unknown>
    parsed.system = withIdentitySystem(parsed.system)
    return JSON.stringify(parsed)
}

/**
 * Build a `fetch` that turns an `@ai-sdk/anthropic` request into a valid
 * subscription-OAuth request. On any rewrite failure it throws a fixed-string
 * error that never contains the token or the request body.
 */
export function buildSubscriptionFetch(
    token: string,
    baseFetch: typeof globalThis.fetch = globalThis.fetch,
): typeof globalThis.fetch {
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
        let nextInit: RequestInit
        try {
            nextInit = {
                ...(init ?? {}),
                headers: rewriteHeaders(init?.headers, token),
                body: rewriteBody(init?.body),
            }
        } catch {
            // Never surface the token or body in the error.
            throw new Error(REWRITE_FAILED)
        }
        return baseFetch(input, nextInit)
    }) as typeof globalThis.fetch
}
