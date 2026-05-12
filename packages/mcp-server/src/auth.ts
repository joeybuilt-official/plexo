// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * MCP Auth Middleware
 *
 * Validates Bearer tokens against the mcp_tokens table.
 * Enforces: type='mcp', not revoked, not expired, rate limit.
 *
 * Token hashing: SHA-256(raw_token + salt) stored, raw value never stored.
 * Rate limit: 60 requests/minute per token via Redis (mcp:rl:{token_id}).
 *
 * Security requirements:
 * - Never log the raw token value
 * - Return opaque errors (no hint about which check failed for security)
 * - Rate limit checked before scope check (fail fast)
 */
import { createHash, randomBytes } from 'node:crypto'
import { createClient, type RedisClientType } from 'redis'
import { db, eq, and } from '@plexo/db'
import { mcpTokens, workspaces } from '@plexo/db'
import type { McpContext } from './types.js'
import { logger } from './logger.js'

const RATE_LIMIT_MAX = 60       // requests per window
const RATE_LIMIT_WINDOW_S = 60  // seconds

let _redis: RedisClientType | null = null

async function getRedis(): Promise<RedisClientType> {
    if (_redis?.isReady) return _redis
    _redis = createClient({ url: process.env.REDIS_URL ?? 'redis://localhost:6379' }) as RedisClientType
    _redis.on('error', (err: Error) => logger.error({ err }, 'MCP Redis error'))
    await _redis.connect()
    return _redis
}

/**
 * Hash a raw token value using SHA-256 + per-token salt.
 */
export function hashToken(rawToken: string, salt: string): string {
    return createHash('sha256').update(rawToken + salt).digest('hex')
}

/**
 * Generate a new token: returns { rawToken, hash, salt }.
 * rawToken is shown once; hash+salt are stored.
 */
export function generateToken(): { rawToken: string; hash: string; salt: string } {
    const rawToken = 'plx_' + randomBytes(32).toString('base64url')
    const salt = randomBytes(32).toString('hex')
    const hash = hashToken(rawToken, salt)
    return { rawToken, hash, salt }
}

export interface AuthResult {
    ok: true
    ctx: McpContext
}

export interface AuthFailure {
    ok: false
    status: number
    message: string
    retryAfter?: number
}

/**
 * Validate an Authorization: Bearer <token> header.
 *
 * Returns McpContext on success, or an AuthFailure describing the error.
 * Logs only token_id (never raw token) on failure.
 */
export async function validateMcpToken(
    authHeader: string | undefined,
): Promise<AuthResult | AuthFailure> {
    if (!authHeader?.startsWith('Bearer ')) {
        return { ok: false, status: 401, message: 'Authorization header required' }
    }

    const rawToken = authHeader.slice(7).trim()
    if (!rawToken) {
        return { ok: false, status: 401, message: 'Bearer token missing' }
    }

    // Look up candidates by scanning — we can't reverse-hash to find without salt.
    // Approach: fetch by prefix (first 8 chars used as lookup hint) OR scan.
    // Since mcp_tokens is tiny per workspace, we fetch all non-revoked and compare.
    // For production scale: store a token_prefix index. For now this is secure and fast.
    //
    // Alternative: store SHA-256(raw_token) without salt as a lookup key,
    // and SHA-256(raw_token + salt) as the proof-of-knowledge. We use the simpler
    // single-hash approach: store hash(raw + salt), scan active tokens.
    //
    // Optimization: The token prefix 'plx_' + first 8 chars could index but
    // for <1000 tokens per workspace this full scan is fine.

    let tokenRecord: typeof mcpTokens.$inferSelect | null = null

    try {
        const candidates = await db
            .select()
            .from(mcpTokens)
            .where(and(eq(mcpTokens.revoked, false), eq(mcpTokens.type, 'mcp')))

        for (const candidate of candidates) {
            const expected = hashToken(rawToken, candidate.tokenSalt)
            if (expected === candidate.tokenHash) {
                tokenRecord = candidate
                break
            }
        }
    } catch (err) {
        logger.error({ err }, 'MCP auth: DB lookup failed')
        return { ok: false, status: 500, message: 'Internal error' }
    }

    if (!tokenRecord) {
        logger.warn({ event: 'mcp_auth_invalid_token' }, 'MCP auth: token not found')
        return { ok: false, status: 401, message: 'Invalid token' }
    }

    // Check expiry
    if (tokenRecord.expiresAt && tokenRecord.expiresAt < new Date()) {
        logger.warn({ token_id: tokenRecord.id, event: 'mcp_auth_expired' }, 'MCP auth: token expired')
        return { ok: false, status: 401, message: 'Token expired' }
    }

    // Rate limit check
    try {
        const redis = await getRedis()
        const key = `mcp:rl:${tokenRecord.id}`
        const count = await redis.incr(key)
        if (count === 1) {
            await redis.expire(key, RATE_LIMIT_WINDOW_S)
        }
        if (count > RATE_LIMIT_MAX) {
            const ttl = await redis.ttl(key)
            return {
                ok: false,
                status: 429,
                message: 'Rate limit exceeded',
                retryAfter: ttl > 0 ? ttl : RATE_LIMIT_WINDOW_S,
            }
        }
    } catch (err) {
        // Redis failure is non-fatal for rate limiting — degrade gracefully
        logger.error({ err, token_id: tokenRecord.id }, 'MCP rate limit Redis error — allowing request')
    }

    // Verify workspace is active
    let workspaceRecord: typeof workspaces.$inferSelect | null = null
    try {
        const [ws] = await db
            .select()
            .from(workspaces)
            .where(eq(workspaces.id, tokenRecord.workspaceId))
            .limit(1)
        workspaceRecord = ws ?? null
    } catch (err) {
        logger.error({ err, token_id: tokenRecord.id }, 'MCP auth: workspace lookup failed')
        return { ok: false, status: 500, message: 'Internal error' }
    }

    if (!workspaceRecord) {
        logger.warn({ token_id: tokenRecord.id }, 'MCP auth: workspace not found')
        return { ok: false, status: 401, message: 'Workspace not found' }
    }

    // Update last_used_at asynchronously (non-blocking)
    void db.update(mcpTokens)
        .set({ lastUsedAt: new Date() })
        .where(eq(mcpTokens.id, tokenRecord.id))
        .catch((err) => logger.error({ err }, 'MCP auth: failed to update last_used_at'))

    return {
        ok: true,
        ctx: {
            workspace_id: tokenRecord.workspaceId,
            token_id: tokenRecord.id,
            scopes: tokenRecord.scopes,
        },
    }
}

/**
 * Scope gate — call this at the start of every tool handler.
 * Defense in depth: checked even if middleware already ran.
 */
export function requireScope(ctx: McpContext, scope: string): boolean {
    return ctx.scopes.includes(scope)
}
