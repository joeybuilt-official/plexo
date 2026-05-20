// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Stabilization monitoring agents — proactive checkers for known failure modes.
 *
 * Each agent:
 *   - Has a stable name (used as alert event_type and as the cron job name)
 *   - Probes one specific system property
 *   - Returns an Alert when broken, null when healthy
 *
 * Wiring:
 *   The main process (apps/api/src/index.ts) imports `runMonitoringAgents()`
 *   and schedules it via cron-dispatch. Each agent is run on its own
 *   cadence; the dispatcher claims them via SELECT FOR UPDATE SKIP LOCKED
 *   so a single instance fires each agent at most once per interval even
 *   under multiple Plexo replicas.
 *
 * Adding an agent:
 *   1. Implement `Agent` and add it to `MONITORING_AGENTS`.
 *   2. (Optional) Add a self-heal path under self-heal.ts keyed by agent name.
 *
 * Output:
 *   Alerts are appended to `ops/stabilization/alerts/YYYY-MM-DD.jsonl` for
 *   the SaaS dashboard to read, and emitted to the logger at warn level.
 */

import { promises as fs } from 'fs'
import { join } from 'path'
import pino from 'pino'

const logger = pino({ name: 'stabilization-agents' })

// Resolve repo-root-relative paths for alert files.
const ALERT_DIR = process.env.PLEXO_ALERT_DIR
    ?? join(process.cwd(), 'ops', 'stabilization', 'alerts')

// ── Public types ─────────────────────────────────────────────────────────────

export interface Alert {
    /** Stable agent name (e.g. 'embedder-health'). Used as the event type. */
    agent: string
    /** ISO timestamp of detection. */
    at: string
    /** Severity. 'critical' is page-worthy; 'warn' is informational. */
    severity: 'warn' | 'error' | 'critical'
    /** Short human-readable description. */
    message: string
    /** Free-form structured detail. */
    metadata?: Record<string, unknown>
}

export interface AgentResult {
    agent: string
    healthy: boolean
    alert: Alert | null
    /** Wall-clock duration of the probe. */
    durationMs: number
}

export interface Agent {
    name: string
    /** Polling interval in seconds (informational; cron drives actual cadence). */
    intervalSec: number
    /** Probe — return null on healthy, Alert on broken. */
    check: () => Promise<Alert | null>
}

// ── Alert sink ───────────────────────────────────────────────────────────────

export async function writeAlert(alert: Alert): Promise<void> {
    try {
        await fs.mkdir(ALERT_DIR, { recursive: true })
        const day = alert.at.slice(0, 10) // YYYY-MM-DD
        const path = join(ALERT_DIR, `${day}.jsonl`)
        await fs.appendFile(path, JSON.stringify(alert) + '\n', 'utf-8')
    } catch (err) {
        // Never crash the monitor over a write failure — just log it.
        logger.warn({ err, alert }, 'Alert sink write failed')
    }
}

// ── Default agent list ───────────────────────────────────────────────────────
// Imported lazily so this module can be loaded without pulling DB clients
// during config-only usage (e.g. listing agents in the dashboard).

export async function defaultAgents(): Promise<Agent[]> {
    const all = await Promise.all([
        import('./embedder-health.js').then(m => m.embedderHealth),
        import('./bridge-auth.js').then(m => m.bridgeAuth),
        import('./cron-late.js').then(m => m.cronLate),
        import('./db-migration-drift.js').then(m => m.dbMigrationDrift),
        import('./route-error-rate.js').then(m => m.routeErrorRate),
        import('./karakeep-ingest-stalled.js').then(m => m.karakeepIngestStalled),
        import('./disk-fill.js').then(m => m.diskFill),
    ])
    return all
}

// ── Driver ───────────────────────────────────────────────────────────────────

/**
 * Run a single agent and persist any alert. Caller decides cadence —
 * the function itself does no waiting.
 */
export async function runAgent(agent: Agent): Promise<AgentResult> {
    const start = Date.now()
    try {
        const alert = await agent.check()
        const durationMs = Date.now() - start
        if (alert) {
            await writeAlert(alert)
            logger.warn({ agent: agent.name, alert, durationMs }, 'Stabilization alert raised')
        } else {
            logger.debug({ agent: agent.name, durationMs }, 'Stabilization agent healthy')
        }
        return { agent: agent.name, healthy: alert === null, alert, durationMs }
    } catch (err) {
        const durationMs = Date.now() - start
        const alert: Alert = {
            agent: agent.name,
            at: new Date().toISOString(),
            severity: 'error',
            message: `Agent crashed: ${err instanceof Error ? err.message : String(err)}`,
            metadata: { error: String(err) },
        }
        await writeAlert(alert)
        logger.error({ err, agent: agent.name, durationMs }, 'Stabilization agent itself failed')
        return { agent: agent.name, healthy: false, alert, durationMs }
    }
}

/** Run every default agent sequentially. Returns the aggregate result. */
export async function runMonitoringAgents(): Promise<AgentResult[]> {
    const agents = await defaultAgents()
    const out: AgentResult[] = []
    for (const a of agents) {
        out.push(await runAgent(a))
    }
    return out
}
