// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * LLM Fault Proxy — thin HTTP proxy for injecting provider-level faults.
 *
 * Sits between Plexo's IntelligentRouter and real LLM APIs during chaos tests.
 * No OSS chaos tool operates at HTTP-semantic level for LLM providers.
 *
 * Usage:
 *   1. Start: `npx tsx tests/chaos/llm-fault-proxy.ts`
 *   2. Point provider endpoints to http://localhost:9999
 *   3. Control faults via POST http://localhost:9998/faults
 *
 * Control API (port 9998):
 *   POST /faults — set active faults
 *     { "enabled": true, "mode": "status", "statusCode": 429, "probability": 1.0,
 *       "headers": { "retry-after": "30" }, "delayMs": 0 }
 *   POST /faults — slow streaming
 *     { "enabled": true, "mode": "slow-stream", "chunkDelayMs": 2000, "probability": 0.5 }
 *   POST /faults — partial stream then disconnect
 *     { "enabled": true, "mode": "partial-stream", "chunksBeforeDisconnect": 3, "probability": 1.0 }
 *   POST /faults — disable
 *     { "enabled": false }
 *   GET /faults — get current config
 *   GET /stats — get request count, fault count
 */

import http from 'node:http'
import https from 'node:https'
import { URL } from 'node:url'

interface FaultConfig {
    enabled: boolean
    mode: 'status' | 'slow-stream' | 'partial-stream' | 'passthrough'
    statusCode: number
    probability: number
    headers: Record<string, string>
    delayMs: number
    chunkDelayMs: number
    chunksBeforeDisconnect: number
    errorBody: string
}

const DEFAULT_FAULT: FaultConfig = {
    enabled: false,
    mode: 'passthrough',
    statusCode: 429,
    probability: 1.0,
    headers: {},
    delayMs: 0,
    chunkDelayMs: 2000,
    chunksBeforeDisconnect: 3,
    errorBody: '{"error":{"type":"overloaded_error","message":"Injected fault from stabilization proxy"}}',
}

let fault: FaultConfig = { ...DEFAULT_FAULT }
let stats = { requests: 0, faults: 0, proxied: 0 }

function shouldInjectFault(): boolean {
    if (!fault.enabled) return false
    return Math.random() < fault.probability
}

// Control server (port 9998)
const controlServer = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json')

    if (req.url === '/faults' && req.method === 'GET') {
        res.end(JSON.stringify(fault))
        return
    }

    if (req.url === '/faults' && req.method === 'POST') {
        let body = ''
        req.on('data', (chunk) => { body += chunk })
        req.on('end', () => {
            try {
                const update = JSON.parse(body)
                fault = { ...DEFAULT_FAULT, ...update }
                res.end(JSON.stringify({ ok: true, fault }))
            } catch {
                res.statusCode = 400
                res.end(JSON.stringify({ error: 'Invalid JSON' }))
            }
        })
        return
    }

    if (req.url === '/stats' && req.method === 'GET') {
        res.end(JSON.stringify(stats))
        return
    }

    if (req.url === '/reset' && req.method === 'POST') {
        fault = { ...DEFAULT_FAULT }
        stats = { requests: 0, faults: 0, proxied: 0 }
        res.end(JSON.stringify({ ok: true }))
        return
    }

    res.statusCode = 404
    res.end(JSON.stringify({ error: 'Not found' }))
})

// Proxy server (port 9999)
const proxyServer = http.createServer((req, res) => {
    stats.requests++

    if (shouldInjectFault()) {
        stats.faults++

        if (fault.mode === 'status') {
            setTimeout(() => {
                res.writeHead(fault.statusCode, {
                    'Content-Type': 'application/json',
                    ...fault.headers,
                })
                res.end(fault.errorBody)
            }, fault.delayMs)
            return
        }

        if (fault.mode === 'slow-stream') {
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
            })
            let i = 0
            const interval = setInterval(() => {
                res.write(`data: {"type":"content_block_delta","delta":{"text":"tok${i}"}}\n\n`)
                i++
                if (i >= 10) {
                    clearInterval(interval)
                    res.write('data: {"type":"message_stop"}\n\n')
                    res.end()
                }
            }, fault.chunkDelayMs)
            req.on('close', () => clearInterval(interval))
            return
        }

        if (fault.mode === 'partial-stream') {
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
            })
            let i = 0
            const interval = setInterval(() => {
                res.write(`data: {"type":"content_block_delta","delta":{"text":"tok${i}"}}\n\n`)
                i++
                if (i >= fault.chunksBeforeDisconnect) {
                    clearInterval(interval)
                    res.destroy() // abrupt disconnect
                }
            }, 100)
            req.on('close', () => clearInterval(interval))
            return
        }
    }

    // Passthrough: proxy to real endpoint
    stats.proxied++
    const targetUrl = req.headers['x-target-url'] as string
    if (!targetUrl) {
        res.writeHead(502, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Missing x-target-url header for proxy passthrough' }))
        return
    }

    const parsed = new URL(targetUrl)
    const transport = parsed.protocol === 'https:' ? https : http

    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
        const proxyReq = transport.request(parsed, {
            method: req.method,
            headers: { ...req.headers, host: parsed.host },
        }, (proxyRes) => {
            res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers)
            proxyRes.pipe(res)
        })
        proxyReq.on('error', (err) => {
            res.writeHead(502, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: err.message }))
        })
        if (body) proxyReq.write(body)
        proxyReq.end()
    })
})

const CONTROL_PORT = Number(process.env.FAULT_CONTROL_PORT) || 9998
const PROXY_PORT = Number(process.env.FAULT_PROXY_PORT) || 9999

controlServer.listen(CONTROL_PORT, () => {
    console.log(`[llm-fault-proxy] Control API on :${CONTROL_PORT}`)
})
proxyServer.listen(PROXY_PORT, () => {
    console.log(`[llm-fault-proxy] Proxy on :${PROXY_PORT}`)
    console.log(`[llm-fault-proxy] POST :${CONTROL_PORT}/faults to inject faults`)
})
