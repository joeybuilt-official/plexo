// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * clamd INSTREAM TCP client (ADR 0012 §D6/§D7).
 *
 * Pure-Node `net` socket — no SDK. Speaks the `z`-prefixed null-terminated
 * command framing because it's more robust than newline framing when
 * payloads themselves can contain newlines.
 *
 * INSTREAM wire format:
 *   client → "zINSTREAM\0"
 *   client → [4-byte BE length][chunk bytes] (repeat)
 *   client → [4-byte BE length=0]   ← terminator
 *   server → "stream: OK\0"
 *           or "stream: <SIG> FOUND\0"
 *           or "stream: <reason> ERROR\0"
 */

import * as net from 'node:net'

export interface ClamdConfig {
    host: string
    port: number
    timeoutMs?: number
}

export interface ClamdScanResult {
    status: 'clean' | 'infected' | 'error'
    /** populated when status === 'infected' */
    signature?: string
    error?: string
    durationMs: number
}

const DEFAULT_TIMEOUT_MS = 30_000
const CHUNK_SIZE = 64 * 1024
// clamd default StreamMaxLength is 25 MB. Refuse anything bigger client-side
// so we don't waste a socket round-trip just to be cut off.
const STREAM_MAX_LENGTH = 25 * 1024 * 1024

export type SocketFactory = (cfg: ClamdConfig) => net.Socket

const defaultSocketFactory: SocketFactory = (cfg) => net.connect({ host: cfg.host, port: cfg.port })

export async function pingClamd(
    cfg: ClamdConfig,
    socketFactory: SocketFactory = defaultSocketFactory,
): Promise<boolean> {
    const timeout = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS
    return new Promise<boolean>((resolve) => {
        let settled = false
        const finish = (v: boolean): void => {
            if (settled) return
            settled = true
            try { socket.destroy() } catch { /* ignore */ }
            resolve(v)
        }

        const socket = socketFactory(cfg)
        socket.setTimeout(timeout)

        const chunks: Buffer[] = []
        socket.on('connect', () => {
            socket.write(Buffer.from('zPING\0', 'utf8'))
        })
        socket.on('data', (chunk: Buffer) => {
            chunks.push(chunk)
            const joined = Buffer.concat(chunks).toString('utf8')
            if (joined.includes('\0')) {
                const reply = joined.replace(/\0$/, '').trim()
                finish(reply === 'PONG')
            }
        })
        socket.on('timeout', () => finish(false))
        socket.on('error', () => finish(false))
        socket.on('close', () => finish(false))
    })
}

export async function instreamScan(
    cfg: ClamdConfig,
    bytes: Buffer,
    socketFactory: SocketFactory = defaultSocketFactory,
): Promise<ClamdScanResult> {
    const startedAt = Date.now()
    const timeout = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS

    if (bytes.byteLength > STREAM_MAX_LENGTH) {
        return {
            status: 'error',
            error: `payload exceeds StreamMaxLength (${bytes.byteLength} > ${STREAM_MAX_LENGTH})`,
            durationMs: Date.now() - startedAt,
        }
    }

    return new Promise<ClamdScanResult>((resolve) => {
        let settled = false
        const finish = (r: ClamdScanResult): void => {
            if (settled) return
            settled = true
            try { socket.destroy() } catch { /* ignore */ }
            resolve(r)
        }

        const socket = socketFactory(cfg)
        socket.setTimeout(timeout)

        const chunks: Buffer[] = []

        socket.on('connect', () => {
            try {
                socket.write(Buffer.from('zINSTREAM\0', 'utf8'))
                for (let off = 0; off < bytes.byteLength; off += CHUNK_SIZE) {
                    const slice = bytes.subarray(off, Math.min(off + CHUNK_SIZE, bytes.byteLength))
                    const len = Buffer.alloc(4)
                    len.writeUInt32BE(slice.byteLength, 0)
                    socket.write(len)
                    socket.write(slice)
                }
                const term = Buffer.alloc(4)
                term.writeUInt32BE(0, 0)
                socket.write(term)
            } catch (err) {
                finish({
                    status: 'error',
                    error: err instanceof Error ? err.message : String(err),
                    durationMs: Date.now() - startedAt,
                })
            }
        })

        socket.on('data', (chunk: Buffer) => {
            chunks.push(chunk)
            const joined = Buffer.concat(chunks).toString('utf8')
            if (joined.includes('\0')) {
                const reply = joined.replace(/\0$/, '').trim()
                finish(parseInstreamReply(reply, Date.now() - startedAt))
            }
        })

        socket.on('timeout', () => finish({
            status: 'error',
            error: `clamd timeout after ${timeout}ms`,
            durationMs: Date.now() - startedAt,
        }))

        socket.on('error', (err: Error) => finish({
            status: 'error',
            error: err.message,
            durationMs: Date.now() - startedAt,
        }))

        socket.on('close', () => {
            // close before settled means we never got a complete \0-terminated reply
            finish({
                status: 'error',
                error: 'clamd connection closed before reply',
                durationMs: Date.now() - startedAt,
            })
        })
    })
}

function parseInstreamReply(reply: string, durationMs: number): ClamdScanResult {
    // Forms:
    //   "stream: OK"
    //   "stream: <SIG> FOUND"
    //   "stream: <reason> ERROR"
    const m = reply.match(/^stream:\s*(.*)$/)
    const tail = m?.[1]?.trim() ?? reply.trim()

    if (tail === 'OK') {
        return { status: 'clean', durationMs }
    }
    if (/\bFOUND$/.test(tail)) {
        const sig = tail.replace(/\s+FOUND$/, '').trim()
        return { status: 'infected', signature: sig, durationMs }
    }
    if (/\bERROR$/.test(tail)) {
        const reason = tail.replace(/\s+ERROR$/, '').trim()
        return { status: 'error', error: reason, durationMs }
    }
    return { status: 'error', error: `unparseable clamd reply: ${reply}`, durationMs }
}
