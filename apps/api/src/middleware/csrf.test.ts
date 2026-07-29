// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

import { describe, it, expect, vi } from 'vitest'
import type { Request, Response, NextFunction } from 'express'
import { createOriginCsrfMiddleware } from './csrf.js'

function makeReq(partial: Partial<Request>): Request {
    return {
        method: 'POST',
        headers: {},
        path: '/test',
        ...partial,
    } as unknown as Request
}

function makeRes(): { res: Response; status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> } {
    const json = vi.fn()
    const status = vi.fn(() => ({ json }))
    const res = { status, json } as unknown as Response
    return { res, status, json }
}

describe('createOriginCsrfMiddleware', () => {
    const allowed = new Set<string>(['https://getplexo.com', 'http://localhost:3000'])
    const csrf = createOriginCsrfMiddleware(allowed)

    it('passes GET without checks', () => {
        const req = makeReq({ method: 'GET' })
        const { res } = makeRes()
        const next: NextFunction = vi.fn()
        csrf(req, res, next)
        expect(next).toHaveBeenCalled()
    })

    it('passes HEAD/OPTIONS without checks', () => {
        const next: NextFunction = vi.fn()
        const { res } = makeRes()
        csrf(makeReq({ method: 'HEAD' }), res, next)
        csrf(makeReq({ method: 'OPTIONS' }), res, next)
        expect(next).toHaveBeenCalledTimes(2)
    })

    it('rejects POST with missing Origin and Referer', () => {
        const req = makeReq({ method: 'POST', headers: {} })
        const { res, status } = makeRes()
        const next: NextFunction = vi.fn()
        csrf(req, res, next)
        expect(next).not.toHaveBeenCalled()
        expect(status).toHaveBeenCalledWith(403)
    })

    it('rejects POST with disallowed Origin', () => {
        const req = makeReq({ method: 'POST', headers: { origin: 'https://evil.com' } })
        const { res, status } = makeRes()
        const next: NextFunction = vi.fn()
        csrf(req, res, next)
        expect(next).not.toHaveBeenCalled()
        expect(status).toHaveBeenCalledWith(403)
    })

    it('allows POST with allowed Origin', () => {
        const req = makeReq({ method: 'POST', headers: { origin: 'https://getplexo.com' } })
        const { res } = makeRes()
        const next: NextFunction = vi.fn()
        csrf(req, res, next)
        expect(next).toHaveBeenCalled()
    })

    it('falls back to Referer when Origin missing', () => {
        const req = makeReq({
            method: 'PATCH',
            headers: { referer: 'https://getplexo.com/app/tasks/123' },
        })
        const { res } = makeRes()
        const next: NextFunction = vi.fn()
        csrf(req, res, next)
        expect(next).toHaveBeenCalled()
    })

    it('rejects Referer from disallowed host', () => {
        const req = makeReq({
            method: 'DELETE',
            headers: { referer: 'https://evil.com/attack' },
        })
        const { res, status } = makeRes()
        const next: NextFunction = vi.fn()
        csrf(req, res, next)
        expect(next).not.toHaveBeenCalled()
        expect(status).toHaveBeenCalledWith(403)
    })

    it('bypasses CSRF for Bearer token auth', () => {
        const req = makeReq({
            method: 'POST',
            headers: { authorization: 'Bearer sk-api-xxx' },
        })
        const { res } = makeRes()
        const next: NextFunction = vi.fn()
        csrf(req, res, next)
        expect(next).toHaveBeenCalled()
    })

    it('bypasses CSRF for valid internal service-key auth', () => {
        process.env.PLEXO_SERVICE_KEY = 'internal-ssr-secret'
        const req = makeReq({
            method: 'POST',
            headers: { 'x-plexo-service-key': 'internal-ssr-secret' },
        })
        const { res } = makeRes()
        const next: NextFunction = vi.fn()
        csrf(req, res, next)
        expect(next).toHaveBeenCalled()
        delete process.env.PLEXO_SERVICE_KEY
    })

    it('rejects CSRF bypass with wrong service-key', () => {
        process.env.PLEXO_SERVICE_KEY = 'real-secret-value-here'
        const req = makeReq({
            method: 'POST',
            headers: { 'x-plexo-service-key': 'attacker-fake-value' },
        })
        const { res, status } = makeRes()
        const next: NextFunction = vi.fn()
        csrf(req, res, next)
        expect(next).not.toHaveBeenCalled()
        expect(status).toHaveBeenCalledWith(403)
        delete process.env.PLEXO_SERVICE_KEY
    })

    it('handles malformed Referer without throwing', () => {
        const req = makeReq({
            method: 'POST',
            headers: { referer: 'not a url' },
        })
        const { res, status } = makeRes()
        const next: NextFunction = vi.fn()
        expect(() => csrf(req, res, next)).not.toThrow()
        expect(status).toHaveBeenCalledWith(403)
    })

    it('rejects when Referer is blank string and no Origin', () => {
        const req = makeReq({
            method: 'PUT',
            headers: { referer: '' },
        })
        const { res, status } = makeRes()
        const next: NextFunction = vi.fn()
        csrf(req, res, next)
        expect(status).toHaveBeenCalledWith(403)
    })
})
