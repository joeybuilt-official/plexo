// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Routing chain backfill — Phase 2b of the intelligence overhaul.
 *
 * Walks every workspace at API container startup and inserts smart-default
 * `routing_chains` rows for any (workspace, task_type) pair that does not
 * already have one. Idempotent both via the unique index on
 * `(workspace_id, task_type, position)` and via the explicit
 * `ON CONFLICT DO NOTHING` clause on the bulk insert.
 *
 * The same helper backs `POST /chains/:taskType/reset` (called per-task
 * with `tasksToSeed` narrowed) so the seeding logic and the reset logic
 * never drift apart.
 *
 * Pure-ish: takes (db, workspaceId?) and runs the catalog/provider
 * fetches itself, but the chain computation lives in `routing-defaults.ts`
 * so the unit tests don't need a DB.
 */

import { db, sql } from '@plexo/db'
import { pgRows } from './pg-rows.js'
import {
    computeDefaultChainsForWorkspace,
    reconcileChain,
    chainsEqual,
    ROUTING_TASK_TYPES,
    type CatalogModel,
    type EnabledProvider,
    type RoutingTaskType,
    type DefaultChain,
    type StoredChainEntry,
} from './routing-defaults.js'

const log = (msg: string, ctx?: Record<string, unknown>) => {
    // Tiny logger so this module doesn't pull pino at startup; the API
    // index logger handles structured output for callers that care.
    if (ctx) console.log(`[seed-routing-chains] ${msg}`, ctx)
    else console.log(`[seed-routing-chains] ${msg}`)
}

// ── DB shapes ─────────────────────────────────────────────────────────────

interface WorkspaceRow { id: string }
interface ProviderRow {
    id: string
    workspace_id: string
    provider_type: string
    enabled: boolean
    selected_model: string | null
    capabilities: {
        chatModels?: string[] | null
        supportsChat?: boolean
    } | null
}

// ── Loaders ───────────────────────────────────────────────────────────────

async function loadAllWorkspaces(): Promise<WorkspaceRow[]> {
    const result = await db.execute(sql`SELECT id FROM workspaces ORDER BY created_at`)
    const rows = pgRows(result)
    return (rows ?? []).map((r: any) => ({ id: String(r.id) }))
}

async function loadProvidersForWorkspace(workspaceId: string): Promise<EnabledProvider[]> {
    const result = await db.execute(sql`
        SELECT id, workspace_id, provider_type, enabled, selected_model, capabilities
        FROM provider_instances
        WHERE workspace_id = ${workspaceId}::uuid AND enabled = true
    `)
    const rows = pgRows<ProviderRow>(result)
    return rows.map((r) => ({
        id: r.id,
        providerType: r.provider_type,
        enabled: r.enabled,
        chatModels: Array.isArray(r.capabilities?.chatModels) ? (r.capabilities!.chatModels as string[]) : [],
        selectedModel: r.selected_model,
    }))
}

async function loadCatalog(): Promise<CatalogModel[]> {
    // A6 cutover: prefer the numeric columns; fall back to the legacy real
    // columns when a row predates the expand backfill. Routing-tier
    // classification is float-fine, so Number() at the edge is acceptable.
    const result = await db.execute(sql`
        SELECT id, provider, model_id, context_window,
               cost_per_m_in, cost_per_m_out,
               cost_per_m_in_numeric, cost_per_m_out_numeric,
               strengths, reliability_score
        FROM models_knowledge
    `)
    const rows = pgRows(result)
    return (rows ?? []).map((r: any): CatalogModel => ({
        id: String(r.id),
        provider: String(r.provider),
        modelId: String(r.model_id),
        contextWindow: Number(r.context_window ?? 128_000),
        costPerMIn: Number(r.cost_per_m_in_numeric ?? r.cost_per_m_in ?? 0),
        costPerMOut: Number(r.cost_per_m_out_numeric ?? r.cost_per_m_out ?? 0),
        strengths: Array.isArray(r.strengths) ? (r.strengths as string[]) : [],
        reliabilityScore: Number(r.reliability_score ?? 1),
    }))
}

async function workspaceHasAnyChain(workspaceId: string): Promise<boolean> {
    const result = await db.execute(sql`
        SELECT 1 FROM routing_chains WHERE workspace_id = ${workspaceId}::uuid LIMIT 1
    `)
    const rows = pgRows(result)
    return (rows?.length ?? 0) > 0
}

// ── Insert ────────────────────────────────────────────────────────────────

interface InsertRow {
    workspaceId: string
    taskType: string
    providerId: string
    modelId: string
    position: number
}

async function insertChainRows(rows: InsertRow[]): Promise<number> {
    if (rows.length === 0) return 0
    // Drizzle's `sql` template tag doesn't have a clean variadic insert
    // helper that survives `pg.execute`, so we batch one row at a time
    // with ON CONFLICT DO NOTHING. This is a startup-time path so the
    // per-row round trip is fine.
    let inserted = 0
    for (const row of rows) {
        const result = await db.execute(sql`
            INSERT INTO routing_chains (workspace_id, task_type, provider_id, model_id, position)
            VALUES (
                ${row.workspaceId}::uuid,
                ${row.taskType},
                ${row.providerId}::uuid,
                ${row.modelId},
                ${row.position}
            )
            ON CONFLICT (workspace_id, task_type, position) DO NOTHING
        `)
        // Some drivers report rowCount, others don't — assume 1 on
        // success, fall back to 0 on conflict.
        const rowCount = (result as any)?.rowCount
        if (typeof rowCount === 'number') inserted += rowCount
        else inserted += 1
    }
    return inserted
}

// ── Public API ────────────────────────────────────────────────────────────

export interface SeedSummary {
    workspacesScanned: number
    workspacesSeeded: number
    rowsInserted: number
}

/**
 * Seed default chains for any workspace that has zero `routing_chains`
 * rows. Called once at API container boot. Safe to invoke repeatedly —
 * existing rows are never touched.
 *
 * The optional `taskTypes` filter narrows the seed to specific task
 * tiers (used by the reset endpoint when a user wants to reset just
 * one tier). When omitted, all `ROUTING_TASK_TYPES` are seeded.
 */
export async function seedRoutingChainDefaults(opts?: {
    workspaceId?: string
    taskTypes?: RoutingTaskType[]
    /** Force seeding even if the workspace already has chains. */
    force?: boolean
}): Promise<SeedSummary> {
    const summary: SeedSummary = { workspacesScanned: 0, workspacesSeeded: 0, rowsInserted: 0 }
    const taskFilter = new Set<RoutingTaskType>(opts?.taskTypes ?? ROUTING_TASK_TYPES)

    let workspaces: WorkspaceRow[]
    if (opts?.workspaceId) {
        workspaces = [{ id: opts.workspaceId }]
    } else {
        workspaces = await loadAllWorkspaces()
    }
    summary.workspacesScanned = workspaces.length
    if (workspaces.length === 0) return summary

    // Catalog is workspace-independent — load once.
    let catalog: CatalogModel[] = []
    try {
        catalog = await loadCatalog()
    } catch (err) {
        log('catalog load failed; falling back to synthesized rows', { err: String(err) })
    }

    for (const ws of workspaces) {
        try {
            if (!opts?.force && !opts?.workspaceId) {
                const hasAny = await workspaceHasAnyChain(ws.id)
                if (hasAny) continue
            }

            const providers = await loadProvidersForWorkspace(ws.id)
            if (providers.length === 0) continue

            const chains = computeDefaultChainsForWorkspace(providers, catalog)
            const insertRows: InsertRow[] = []
            for (const taskType of ROUTING_TASK_TYPES) {
                if (!taskFilter.has(taskType)) continue
                const chain: DefaultChain = chains[taskType]
                chain.forEach((entry, idx) => {
                    insertRows.push({
                        workspaceId: ws.id,
                        taskType,
                        providerId: entry.providerId,
                        modelId: entry.modelId,
                        position: idx,
                    })
                })
            }

            if (insertRows.length === 0) continue
            const rowsInserted = await insertChainRows(insertRows)
            summary.rowsInserted += rowsInserted
            summary.workspacesSeeded += 1
            log(`seeded ${rowsInserted} rows for workspace ${ws.id}`)
        } catch (err) {
            log(`workspace ${ws.id} failed`, { err: String(err) })
        }
    }
    return summary
}

// ── Reconcile (self-heal stale chains) ───────────────────────────────────────

interface ChainRowDb {
    task_type: string
    provider_id: string
    model_id: string
    position: number
}

async function loadChainsForWorkspace(workspaceId: string): Promise<Map<string, StoredChainEntry[]>> {
    const result = await db.execute(sql`
        SELECT task_type, provider_id, model_id, position
        FROM routing_chains
        WHERE workspace_id = ${workspaceId}::uuid
        ORDER BY task_type, position
    `)
    const rows = pgRows<ChainRowDb>(result)
    const map = new Map<string, StoredChainEntry[]>()
    for (const r of rows) {
        const list = map.get(r.task_type) ?? []
        list.push({ providerId: r.provider_id, modelId: r.model_id })
        map.set(r.task_type, list)
    }
    return map
}

async function rewriteChain(workspaceId: string, taskType: string, entries: StoredChainEntry[]): Promise<void> {
    await db.execute(sql`
        DELETE FROM routing_chains WHERE workspace_id = ${workspaceId}::uuid AND task_type = ${taskType}
    `)
    let position = 0
    for (const e of entries) {
        await db.execute(sql`
            INSERT INTO routing_chains (workspace_id, task_type, provider_id, model_id, position)
            VALUES (${workspaceId}::uuid, ${taskType}, ${e.providerId}::uuid, ${e.modelId}, ${position})
            ON CONFLICT (workspace_id, task_type, position) DO NOTHING
        `)
        position++
    }
}

export interface ReconcileSummary {
    workspacesScanned: number
    chainsRewritten: number
}

/**
 * Reconcile every workspace's existing chains against the currently-enabled
 * providers so chains stop going stale when providers are added/removed.
 * Append-only (per `reconcileChain`): operator ordering is preserved, newly
 * available providers are appended as fallbacks, gone/disabled providers are
 * pruned. Workspaces with NO chains are left to `seedRoutingChainDefaults`
 * (first-boot path). Safe to run at every API boot.
 */
export async function reconcileRoutingChains(opts?: { workspaceId?: string }): Promise<ReconcileSummary> {
    const summary: ReconcileSummary = { workspacesScanned: 0, chainsRewritten: 0 }
    const workspaces = opts?.workspaceId ? [{ id: opts.workspaceId }] : await loadAllWorkspaces()
    summary.workspacesScanned = workspaces.length
    if (workspaces.length === 0) return summary

    let catalog: CatalogModel[] = []
    try {
        catalog = await loadCatalog()
    } catch (err) {
        log('reconcile: catalog load failed; using synthesized rows', { err: String(err) })
    }

    for (const ws of workspaces) {
        try {
            const providers = await loadProvidersForWorkspace(ws.id)
            if (providers.length === 0) continue
            const existing = await loadChainsForWorkspace(ws.id)
            if (existing.size === 0) continue // first-boot path owned by the seeder
            const defaults = computeDefaultChainsForWorkspace(providers, catalog)
            for (const taskType of ROUTING_TASK_TYPES) {
                const cur = existing.get(taskType) ?? []
                const defaultChain = defaults[taskType].map((e) => ({ providerId: e.providerId, modelId: e.modelId }))
                if (cur.length === 0) {
                    if (defaultChain.length > 0) {
                        await rewriteChain(ws.id, taskType, defaultChain)
                        summary.chainsRewritten += 1
                    }
                    continue
                }
                const reconciled = reconcileChain(cur, providers, defaults[taskType])
                if (!chainsEqual(cur, reconciled)) {
                    await rewriteChain(ws.id, taskType, reconciled)
                    summary.chainsRewritten += 1
                }
            }
        } catch (err) {
            log(`reconcile workspace ${ws.id} failed`, { err: String(err) })
        }
    }
    return summary
}

/**
 * Wipe and re-seed every chain row for one (workspace, taskType). Used
 * by the reset endpoint. Always runs in a single transaction so a
 * partial failure leaves the existing chain intact.
 */
export async function resetWorkspaceTaskChain(
    workspaceId: string,
    taskType: RoutingTaskType,
): Promise<{ rowsInserted: number }> {
    // Delete first, then re-seed via the standard helper. This is
    // intentionally not in a single SQL transaction — the unique index
    // protects against double-inserts and the seeder is idempotent.
    await db.execute(sql`
        DELETE FROM routing_chains
        WHERE workspace_id = ${workspaceId}::uuid AND task_type = ${taskType}
    `)
    const summary = await seedRoutingChainDefaults({
        workspaceId,
        taskTypes: [taskType],
        force: true,
    })
    return { rowsInserted: summary.rowsInserted }
}
