// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Sends a no-op probe to every registered app-bridge extension using the
 * service key, alerting when any return 401/403. PEX bridges that drift
 * out of auth (key rotation, env mismatch) silently break tool calls
 * from Plexo to apps; this agent surfaces that drift early.
 */

import type { Agent, Alert } from './index.js'

interface BridgeRecord {
    name: string
    baseUrl: string
}

const PROBE_PATH = process.env.BRIDGE_PROBE_PATH ?? '/api/v1/_probe'
const SERVICE_KEY = process.env.PLEXO_SERVICE_KEY ?? ''

/**
 * Discover known bridges. We avoid pulling the DB client into this file
 * directly; instead we read `BRIDGE_TARGETS` (comma-separated
 * name=url pairs) from env, with a fallback to the @plexo/db extensions
 * table when `PLEXO_BRIDGE_DISCOVERY=db`.
 */
async function discoverBridges(): Promise<BridgeRecord[]> {
    const env = process.env.BRIDGE_TARGETS
    if (env) {
        return env.split(',').flatMap((entry) => {
            const [name, url] = entry.split('=')
            if (!name || !url) return []
            return [{ name: name.trim(), baseUrl: url.trim() }]
        })
    }

    if (process.env.PLEXO_BRIDGE_DISCOVERY === 'db') {
        try {
            const { db } = await import('@plexo/db')
            const { eq } = await import('drizzle-orm')
            const { extensions } = await import('@plexo/db')
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- runtime row shape
            const rows = await db.select().from(extensions).where(eq(extensions.type as any, 'bridge'))
            return rows
                .map((r) => {
                    const m = r.manifest as { baseUrl?: string } | null
                    if (!m?.baseUrl) return null
                    return { name: r.name, baseUrl: m.baseUrl }
                })
                .filter((b): b is BridgeRecord => b !== null)
        } catch {
            return []
        }
    }
    return []
}

export const bridgeAuth: Agent = {
    name: 'bridge-auth',
    intervalSec: 10 * 60,
    async check(): Promise<Alert | null> {
        const at = new Date().toISOString()
        const bridges = await discoverBridges()
        if (bridges.length === 0) {
            // No bridges configured — that's fine, nothing to probe.
            return null
        }
        if (!SERVICE_KEY) {
            return {
                agent: 'bridge-auth',
                at,
                severity: 'warn',
                message: 'PLEXO_SERVICE_KEY not set — cannot probe bridges',
            }
        }

        const failures: { name: string; status: number; baseUrl: string }[] = []
        for (const b of bridges) {
            try {
                const r = await fetch(`${b.baseUrl}${PROBE_PATH}`, {
                    headers: { 'X-Plexo-Service-Key': SERVICE_KEY },
                    signal: AbortSignal.timeout(5000),
                })
                if (r.status === 401 || r.status === 403) {
                    failures.push({ name: b.name, status: r.status, baseUrl: b.baseUrl })
                }
            } catch {
                // Network failures are covered by other agents; we only flag auth drift here.
            }
        }
        if (failures.length === 0) return null
        return {
            agent: 'bridge-auth',
            at,
            severity: 'critical',
            message: `${failures.length} bridge(s) rejected service key`,
            metadata: { failures },
        }
    },
}
