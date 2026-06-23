// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * QA-opt ADR 0038: proves the error ring captures error/fatal records, bounds
 * its size, and — critically — only persists the scalar allowlist, never the
 * raw log object (so a secret in the merge-object cannot leak into the surface
 * exposed at /admin/recent-errors).
 */
import { describe, it, expect } from 'vitest'
import { recordErrorFromArgs, getRecentErrors, getErrorRingSize } from '../error-ring.js'

describe('error-ring', () => {
    it('captures a redaction-safe record from pino-shaped args', () => {
        recordErrorFromArgs([
            { err: { name: 'PgError', message: 'connection refused', code: 'ECONNREFUSED' }, status: 503, requestId: 'req-1', workspaceId: 'ws-1', apiKey: 'sk-SECRET-should-not-appear', password: 'hunter2' },
            'db ping failed',
        ], 50)

        const [rec] = getRecentErrors(1)
        expect(rec.level).toBe('error')
        expect(rec.msg).toBe('db ping failed')
        expect(rec.errCode).toBe('ECONNREFUSED')
        expect(rec.status).toBe(503)
        expect(rec.requestId).toBe('req-1')

        // The whole record serialized must NOT contain any secret-ish field.
        const blob = JSON.stringify(rec)
        expect(blob).not.toContain('SECRET')
        expect(blob).not.toContain('hunter2')
        expect(blob).not.toContain('apiKey')
        expect(blob).not.toContain('password')
    })

    it('marks fatal at level >= 60 and bounds the ring at 200', () => {
        recordErrorFromArgs([{ err: { message: 'boom' } }, 'fatal thing'], 60)
        expect(getRecentErrors(1)[0].level).toBe('fatal')

        for (let i = 0; i < 250; i++) recordErrorFromArgs([`spam-${i}`], 50)
        expect(getErrorRingSize()).toBeLessThanOrEqual(200)
        // newest-first ordering
        expect(getRecentErrors(1)[0].msg).toBe('spam-249')
    })
})
