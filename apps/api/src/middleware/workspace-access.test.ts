// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Request, Response, NextFunction } from 'express'

// Mock DB — tests drive the membership lookup table directly.
const selectMock = vi.fn()
vi.mock('@plexo/db', () => ({
    db: {
        select: () => ({
            from: () => ({
                where: () => ({
                    limit: selectMock,
                }),
            }),
        }),
    },
    workspaceMembers: { workspaceId: 'workspace_id', userId: 'user_id', role: 'role' },
    and: vi.fn(() => 'AND'),
    eq: vi.fn(() => 'EQ'),
}))

vi.mock('../logger.js', () => ({
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import {
    requireWorkspaceMember,
    ensureWorkspaceAccess,
    resolveWorkspaceId,
    clearWorkspaceMembershipCache,
} from './workspace-access.js'

function buildRes() {
    const res: Partial<Response> = {}
    res.status = vi.fn().mockReturnValue(res)
    res.json = vi.fn().mockReturnValue(res)
    return res as Response
}

function buildReq(overrides: Partial<Request> = {}): Request {
    return {
        params: {},
        query: {},
        body: {},
        headers: {},
        ...overrides,
    } as unknown as Request
}

const VALID_WS = '11111111-1111-1111-1111-111111111111'
const VALID_USER = '22222222-2222-2222-2222-222222222222'

describe('resolveWorkspaceId', () => {
    it('prefers the route param', () => {
        const req = buildReq({
            params: { workspaceId: VALID_WS } as any,
            query: { workspaceId: 'other' } as any,
            body: { workspaceId: 'body' },
        })
        expect(resolveWorkspaceId(req)).toBe(VALID_WS)
    })

    it('falls back to query', () => {
        const req = buildReq({ query: { workspaceId: VALID_WS } as any })
        expect(resolveWorkspaceId(req)).toBe(VALID_WS)
    })

    it('falls back to body', () => {
        const req = buildReq({ body: { workspaceId: VALID_WS } })
        expect(resolveWorkspaceId(req)).toBe(VALID_WS)
    })

    it('returns null when nothing matches', () => {
        expect(resolveWorkspaceId(buildReq())).toBeNull()
    })
})

describe('requireWorkspaceMember', () => {
    beforeEach(() => {
        clearWorkspaceMembershipCache()
        selectMock.mockReset()
    })

    it('returns 401 when no user is attached', async () => {
        const req = buildReq({ query: { workspaceId: VALID_WS } as any })
        const res = buildRes()
        const next = vi.fn() as NextFunction
        await requireWorkspaceMember()(req, res, next)
        expect(res.status).toHaveBeenCalledWith(401)
        expect(next).not.toHaveBeenCalled()
    })

    it('returns 400 when no workspace id can be resolved', async () => {
        const req = buildReq()
        req.user = { id: VALID_USER, email: 'a@b.c', role: 'member', isSuperAdmin: false }
        const res = buildRes()
        const next = vi.fn() as NextFunction
        await requireWorkspaceMember()(req, res, next)
        expect(res.status).toHaveBeenCalledWith(400)
        expect(next).not.toHaveBeenCalled()
    })

    it('returns 400 when workspace id is not a UUID', async () => {
        const req = buildReq({ query: { workspaceId: 'not-a-uuid' } as any })
        req.user = { id: VALID_USER, email: 'a@b.c', role: 'member', isSuperAdmin: false }
        const res = buildRes()
        const next = vi.fn() as NextFunction
        await requireWorkspaceMember()(req, res, next)
        expect(res.status).toHaveBeenCalledWith(400)
    })

    it('returns 403 when user is not a member', async () => {
        selectMock.mockResolvedValue([])
        const req = buildReq({ query: { workspaceId: VALID_WS } as any })
        req.user = { id: VALID_USER, email: 'a@b.c', role: 'member', isSuperAdmin: false }
        const res = buildRes()
        const next = vi.fn() as NextFunction
        await requireWorkspaceMember()(req, res, next)
        expect(res.status).toHaveBeenCalledWith(403)
        expect(next).not.toHaveBeenCalled()
    })

    it('calls next() when user is a member', async () => {
        selectMock.mockResolvedValue([{ role: 'member' }])
        const req = buildReq({ query: { workspaceId: VALID_WS } as any })
        req.user = { id: VALID_USER, email: 'a@b.c', role: 'member', isSuperAdmin: false }
        const res = buildRes()
        const next = vi.fn() as NextFunction
        await requireWorkspaceMember()(req, res, next)
        expect(next).toHaveBeenCalled()
        expect(req.workspaceId).toBe(VALID_WS)
        expect(req.workspaceRole).toBe('member')
    })

    it('super admin bypasses membership check', async () => {
        const req = buildReq({ query: { workspaceId: VALID_WS } as any })
        req.user = { id: VALID_USER, email: 'a@b.c', role: 'admin', isSuperAdmin: true }
        const res = buildRes()
        const next = vi.fn() as NextFunction
        await requireWorkspaceMember()(req, res, next)
        expect(next).toHaveBeenCalled()
        expect(selectMock).not.toHaveBeenCalled()
        expect(req.workspaceRole).toBe('admin')
    })

    it('caches membership lookups across requests', async () => {
        selectMock.mockResolvedValue([{ role: 'member' }])
        const req1 = buildReq({ query: { workspaceId: VALID_WS } as any })
        const req2 = buildReq({ query: { workspaceId: VALID_WS } as any })
        req1.user = req2.user = { id: VALID_USER, email: 'a@b.c', role: 'member', isSuperAdmin: false }
        const next = vi.fn() as NextFunction

        await requireWorkspaceMember()(req1, buildRes(), next)
        await requireWorkspaceMember()(req2, buildRes(), next)

        expect(selectMock).toHaveBeenCalledTimes(1)
    })
})

describe('ensureWorkspaceAccess', () => {
    beforeEach(() => {
        clearWorkspaceMembershipCache()
        selectMock.mockReset()
    })

    it('returns true + sets role when member', async () => {
        selectMock.mockResolvedValue([{ role: 'owner' }])
        const req = buildReq()
        req.user = { id: VALID_USER, email: 'a@b.c', role: 'member', isSuperAdmin: false }
        const res = buildRes()
        const ok = await ensureWorkspaceAccess(req, res, VALID_WS)
        expect(ok).toBe(true)
        expect(req.workspaceRole).toBe('owner')
    })

    it('returns false + 403 when not a member', async () => {
        selectMock.mockResolvedValue([])
        const req = buildReq()
        req.user = { id: VALID_USER, email: 'a@b.c', role: 'member', isSuperAdmin: false }
        const res = buildRes()
        const ok = await ensureWorkspaceAccess(req, res, VALID_WS)
        expect(ok).toBe(false)
        expect(res.status).toHaveBeenCalledWith(403)
    })

    it('returns false + 401 without a user', async () => {
        const req = buildReq()
        const res = buildRes()
        const ok = await ensureWorkspaceAccess(req, res, VALID_WS)
        expect(ok).toBe(false)
        expect(res.status).toHaveBeenCalledWith(401)
    })
})
