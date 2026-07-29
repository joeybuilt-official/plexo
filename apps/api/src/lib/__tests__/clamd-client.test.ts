// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * ADR 0012 §D6/§D7 — clamd INSTREAM client tests.
 *
 * Mocks the TCP socket via `socketFactory` injection. Each test drives the
 * mock socket lifecycle (connect → data → close) on `process.nextTick` to
 * mirror real I/O ordering.
 */

import { EventEmitter } from 'node:events'
import type * as net from 'node:net'
import { describe, it, expect } from 'vitest'
import {
    pingClamd,
    instreamScan,
    type ClamdConfig,
    type SocketFactory,
} from '../clamd-client.js'

class MockSocket extends EventEmitter {
    public destroyed = false
    public timeout = 0
    public writes: Buffer[] = []

    setTimeout(ms: number): this {
        this.timeout = ms
        return this
    }

    write(data: Buffer | string): boolean {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)
        this.writes.push(buf)
        return true
    }

    destroy(): void {
        this.destroyed = true
    }

    /** Test helper — fire `connect` on next tick. */
    fireConnect(): void {
        process.nextTick(() => this.emit('connect'))
    }

    /** Test helper — emit data after a short delay so `connect` writes land first. */
    sendDataAfterConnect(payload: Buffer | string): void {
        const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8')
        process.nextTick(() => {
            this.emit('connect')
            // give the client a tick to write its INSTREAM frames
            setImmediate(() => this.emit('data', buf))
        })
    }
}

const cfg: ClamdConfig = { host: '127.0.0.1', port: 3310, timeoutMs: 100 }

function factory(socket: MockSocket): SocketFactory {
    return () => socket as unknown as net.Socket
}

describe('pingClamd', () => {
    it('happy path: socket emits PONG\\0 → returns true', async () => {
        const sock = new MockSocket()
        sock.sendDataAfterConnect('PONG\0')
        const ok = await pingClamd(cfg, factory(sock))
        expect(ok).toBe(true)
        expect(sock.destroyed).toBe(true)
        // sent the zPING\0 frame
        const all = Buffer.concat(sock.writes).toString('utf8')
        expect(all).toContain('zPING\0')
    })

    it('connect error → returns false', async () => {
        const sock = new MockSocket()
        process.nextTick(() => sock.emit('error', new Error('ECONNREFUSED')))
        const ok = await pingClamd(cfg, factory(sock))
        expect(ok).toBe(false)
    })

    it('timeout → returns false', async () => {
        const sock = new MockSocket()
        process.nextTick(() => sock.emit('timeout'))
        const ok = await pingClamd(cfg, factory(sock))
        expect(ok).toBe(false)
    })
})

describe('instreamScan', () => {
    it('happy path: server replies stream: OK\\0 → status=clean, durationMs >= 0', async () => {
        const sock = new MockSocket()
        sock.sendDataAfterConnect('stream: OK\0')
        const result = await instreamScan(cfg, Buffer.from('hello'), factory(sock))
        expect(result.status).toBe('clean')
        expect(result.durationMs).toBeGreaterThanOrEqual(0)
        expect(result.signature).toBeUndefined()
        expect(sock.destroyed).toBe(true)
    })

    it('infected: server replies stream: Eicar-Test-Signature FOUND\\0 → signature populated', async () => {
        const sock = new MockSocket()
        sock.sendDataAfterConnect('stream: Eicar-Test-Signature FOUND\0')
        const result = await instreamScan(cfg, Buffer.from('eicar-bytes'), factory(sock))
        expect(result.status).toBe('infected')
        expect(result.signature).toBe('Eicar-Test-Signature')
    })

    it('clamd error: server replies stream: SizeLimitExceeded ERROR\\0 → status=error, error reason', async () => {
        const sock = new MockSocket()
        sock.sendDataAfterConnect('stream: SizeLimitExceeded ERROR\0')
        const result = await instreamScan(cfg, Buffer.from('x'), factory(sock))
        expect(result.status).toBe('error')
        expect(result.error).toBe('SizeLimitExceeded')
    })

    it('chunked write: payload > 64 KB emits multiple length-prefixed chunks + 0-length terminator', async () => {
        const sock = new MockSocket()
        sock.sendDataAfterConnect('stream: OK\0')
        // 200 KB → expect 4 chunks (64 + 64 + 64 + 8) + terminator
        const payload = Buffer.alloc(200 * 1024, 0x41)
        const result = await instreamScan(cfg, payload, factory(sock))
        expect(result.status).toBe('clean')

        // Reconstruct: first frame is `zINSTREAM\0`, then alternating 4-byte BE length + chunk, ending in 4-byte 0.
        const all = Buffer.concat(sock.writes)
        expect(all.subarray(0, 'zINSTREAM\0'.length).toString('utf8')).toBe('zINSTREAM\0')

        let off = 'zINSTREAM\0'.length
        const lens: number[] = []
        while (off < all.byteLength) {
            const len = all.readUInt32BE(off)
            lens.push(len)
            off += 4 + len
        }
        // Last length must be 0 (terminator).
        expect(lens[lens.length - 1]).toBe(0)
        // Body chunks (excluding terminator) sum to payload size.
        const bodySum = lens.slice(0, -1).reduce((a, b) => a + b, 0)
        expect(bodySum).toBe(payload.byteLength)
        // Multiple chunks were written, not one.
        expect(lens.length - 1).toBeGreaterThan(1)
    })

    it('timeout: socket never replies → status=error, error matches /timeout/i', async () => {
        const sock = new MockSocket()
        process.nextTick(() => {
            sock.emit('connect')
            // simulate the runtime firing `timeout` after no data arrives
            setImmediate(() => sock.emit('timeout'))
        })
        const result = await instreamScan(cfg, Buffer.from('x'), factory(sock))
        expect(result.status).toBe('error')
        expect(result.error).toMatch(/timeout/i)
    })
})
