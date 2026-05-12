// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Workspace Membership Middleware
 *
 * Enforces that the authenticated user is a member of the workspace
 * referenced by the request. Supports workspace id sourced from:
 *   1. req.params[paramName]   (default: 'workspaceId')
 *   2. req.query.workspaceId   (query string)
 *   3. req.body.workspaceId    (JSON body)
 *
 * Must be mounted AFTER `requireAuth` — it relies on `req.user.id`.
 *
 * Returns:
 *   - 401 if no authenticated user is attached
 *   - 400 if no workspace id can be resolved / is not a UUID
 *   - 403 if the user is not a member of the workspace
 *
 * On success, attaches:
 *   - req.workspaceId  — resolved UUID
 *   - req.workspaceRole — 'admin' | 'member' | ... (from workspace_members.role)
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express'
import { db, and, eq } from '@plexo/db'
import { workspaceMembers } from '@plexo/db'
import { UUID_RE } from '../validation.js'
import { logger } from '../logger.js'

declare global {
    namespace Express {
        interface Request {
            workspaceId?: string
            workspaceRole?: string
        }
    }
}

// Small in-memory membership cache — invalidated by TTL.
// Per-pair lookups are hot on every workspace-scoped request; DB hit on every
// call would be wasteful. Cache the positive result for 30s and negative
// for 5s (to limit blast radius if a user is revoked).
interface CacheEntry { role: string | null; expiry: number }
const membershipCache = new Map<string, CacheEntry>()
const POSITIVE_TTL_MS = 30_000
const NEGATIVE_TTL_MS = 5_000
const MAX_CACHE_SIZE = 2_000

// Sweep expired entries every 5 minutes to prevent unbounded growth
setInterval(() => {
    const now = Date.now()
    for (const [key, entry] of membershipCache) {
        if (entry.expiry < now) membershipCache.delete(key)
    }
}, 5 * 60 * 1000).unref()

function cacheKey(userId: string, workspaceId: string): string {
    return `${userId}:${workspaceId}`
}

async function lookupMembership(userId: string, workspaceId: string): Promise<string | null> {
    const key = cacheKey(userId, workspaceId)
    const hit = membershipCache.get(key)
    if (hit && hit.expiry > Date.now()) return hit.role

    try {
        const [row] = await db
            .select({ role: workspaceMembers.role })
            .from(workspaceMembers)
            .where(and(
                eq(workspaceMembers.workspaceId, workspaceId),
                eq(workspaceMembers.userId, userId),
            ))
            .limit(1)

        const role = row?.role ?? null
        // Evict oldest entry if cache is at capacity
        if (membershipCache.size >= MAX_CACHE_SIZE) {
            const oldest = membershipCache.keys().next().value
            if (oldest !== undefined) membershipCache.delete(oldest)
        }
        membershipCache.set(key, {
            role,
            expiry: Date.now() + (role ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS),
        })
        return role
    } catch (err) {
        logger.error({ err, userId, workspaceId }, 'workspace membership lookup failed')
        return null
    }
}

/**
 * Resolve the target workspace id from the request, checking the route
 * param first, then the query string, then the body. Returns null if
 * nothing looks like a workspace id.
 */
export function resolveWorkspaceId(req: Request, paramName = 'workspaceId'): string | null {
    const fromParam = (req.params as Record<string, string | undefined>)[paramName]
    if (typeof fromParam === 'string' && fromParam.length > 0) return fromParam

    const fromQuery = (req.query as Record<string, unknown>)['workspaceId']
    if (typeof fromQuery === 'string' && fromQuery.length > 0) return fromQuery

    const body = req.body as Record<string, unknown> | undefined
    const fromBody = body?.['workspaceId']
    if (typeof fromBody === 'string' && fromBody.length > 0) return fromBody

    return null
}

/**
 * Middleware: require an authenticated user who is a member of the
 * workspace resolved from the request.
 */
export function requireWorkspaceMember(paramName = 'workspaceId'): RequestHandler {
    return async function requireWorkspaceMemberHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
        // Service key callers (app-to-Plexo) are trusted for any workspace
        if (req.serviceContext?.appId) {
            const wsId = resolveWorkspaceId(req, paramName)
            if (wsId && UUID_RE.test(wsId)) {
                req.workspaceId = wsId
                req.workspaceRole = 'admin'
            }
            next()
            return
        }

        if (!req.user?.id) {
            res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } })
            return
        }

        // Super admins can read/write any workspace — they already have
        // elevated privileges through the Command Center admin routes.
        if (req.user.isSuperAdmin) {
            const wsId = resolveWorkspaceId(req, paramName)
            if (wsId && UUID_RE.test(wsId)) {
                req.workspaceId = wsId
                req.workspaceRole = 'admin'
            }
            next()
            return
        }

        const wsId = resolveWorkspaceId(req, paramName)
        if (!wsId) {
            res.status(400).json({ error: { code: 'MISSING_WORKSPACE', message: 'workspaceId is required' } })
            return
        }
        if (!UUID_RE.test(wsId)) {
            res.status(400).json({ error: { code: 'INVALID_WORKSPACE', message: 'workspaceId must be a valid UUID' } })
            return
        }

        const role = await lookupMembership(req.user.id, wsId)
        if (!role) {
            res.status(403).json({ error: { code: 'FORBIDDEN', message: 'You are not a member of this workspace' } })
            return
        }

        req.workspaceId = wsId
        req.workspaceRole = role
        next()
    }
}

/**
 * Middleware: attach membership info if present, but never block the
 * request. Used by routes where workspace membership is optional
 * (e.g. registry discovery, A2A agent listings).
 */
export function optionalWorkspaceMember(paramName = 'workspaceId'): RequestHandler {
    return async function optionalWorkspaceMemberHandler(req: Request, _res: Response, next: NextFunction): Promise<void> {
        if (!req.user?.id) {
            next()
            return
        }

        const wsId = resolveWorkspaceId(req, paramName)
        if (!wsId || !UUID_RE.test(wsId)) {
            next()
            return
        }

        if (req.user.isSuperAdmin) {
            req.workspaceId = wsId
            req.workspaceRole = 'admin'
            next()
            return
        }

        const role = await lookupMembership(req.user.id, wsId)
        if (role) {
            req.workspaceId = wsId
            req.workspaceRole = role
        }
        next()
    }
}

/**
 * Inline helper for handlers that need to verify access to a workspace
 * discovered after the route has started executing (e.g. looking up the
 * task first, then its workspaceId). Returns true if access is allowed;
 * returns false and writes the response otherwise.
 */
export async function ensureWorkspaceAccess(
    req: Request,
    res: Response,
    workspaceId: string,
): Promise<boolean> {
    // Service key callers (app-to-Plexo) are trusted for any workspace
    if (req.serviceContext?.appId) {
        req.workspaceId = workspaceId
        req.workspaceRole = 'admin'
        return true
    }
    if (!req.user?.id) {
        res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } })
        return false
    }
    if (req.user.isSuperAdmin) {
        req.workspaceId = workspaceId
        req.workspaceRole = 'admin'
        return true
    }
    if (!UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE', message: 'workspaceId must be a valid UUID' } })
        return false
    }
    const role = await lookupMembership(req.user.id, workspaceId)
    if (!role) {
        res.status(403).json({ error: { code: 'FORBIDDEN', message: 'You are not a member of this workspace' } })
        return false
    }
    req.workspaceId = workspaceId
    req.workspaceRole = role
    return true
}

/**
 * Test helper — clears the in-memory membership cache.
 */
export function clearWorkspaceMembershipCache(): void {
    membershipCache.clear()
}
