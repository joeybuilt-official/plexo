// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Synthesis Phase 5 — cross-app suggestion promotion.
 *
 * Suggestions live in `synthesis_suggestions` (kind, payload, score). The
 * earlier phases just surfaced them in the dashboard inbox. Phase 5 closes
 * the loop: take a ripe suggestion, decide which sibling app it belongs
 * to, and emit a domain event that the relevant bridge subscribes to.
 *
 * Routing rules (kept tiny on purpose — extension via `promotionRoutes`):
 *
 *   note          → levio.tasks.create     when imperative ("should", "todo"…)
 *   asset_cluster → fonto.projects.create  when ≥3 assets share a cluster
 *   spend_pattern → fylo.budget.signal     when recurring merchant + band
 *
 * The actual cross-app HTTP call is the bridge's job (Levio/Fonto/Fylo).
 * This module emits an `ext.synthesis-promote.<targetTopic>` event via
 * the existing PEX event-bus; the bridge (subscribed at activation time)
 * handles the side-effect.
 *
 * Manual promotion: `promoteSuggestion(workspaceId, suggestionId)` is the
 * entry point that the HTTP handler at
 * `POST /api/v1/synthesis/promote/:suggestionId` calls. Idempotent — a
 * second promotion of the same suggestion is a no-op (status check) and
 * returns the prior route decision.
 */
import pino from 'pino'
import { db, sql } from '@plexo/db'
import { eventBus } from '../plugins/event-bus.js'

const logger = pino({ name: 'memory:promote' })

/* ── Public types ─────────────────────────────────────────────────────── */

export type PromotionTarget = 'levio.tasks.create' | 'fonto.projects.create' | 'fylo.budget.signal'

export interface PromotionDecision {
    suggestionId: string
    workspaceId: string
    /** Null when no rule matched — caller decides whether that's an error. */
    target: PromotionTarget | null
    /** Per-target payload mapped from the suggestion. */
    payload: Record<string, unknown>
    /** Why this target won (for audit trail). */
    rationale: string
    /** True when the underlying suggestion was already promoted. */
    alreadyPromoted: boolean
}

export interface PromoteOptions {
    /** Mark suggestion as accepted in the DB after promotion. Default true. */
    markAccepted?: boolean
    /**
     * When true, only return the decision and don't publish the event. Useful
     * for the manual UI flow that wants to confirm with the user first.
     */
    dryRun?: boolean
}

/* ── Routing rules ────────────────────────────────────────────────────── */

const IMPERATIVE_PATTERNS = [
    /\bshould\b/i,
    /\bneed(s)? to\b/i,
    /\bmust\b/i,
    /\bto[- ]?do\b/i,
    /\btodo\b/i,
    /\bremember to\b/i,
    /\bplan to\b/i,
    /\bgotta\b/i,
    /\baction[- ]?item\b/i,
]

const ASSET_CLUSTER_MIN_SIZE = 3

/** A small, swap-in registry. Tests and downstream extensions may augment
 *  this without touching `decideRoute`. */
export const promotionRoutes: Array<(s: SuggestionRow) => PromotionDecision | null> = [
    routeNoteToLevioTask,
    routeAssetClusterToFontoProject,
    routeSpendPatternToFyloBudget,
]

/* ── DB row shape ─────────────────────────────────────────────────────── */

interface SuggestionRow {
    id: string
    workspaceId: string
    kind: string
    payload: Record<string, unknown>
    score: number
    status: string
}

/* ── Public API ───────────────────────────────────────────────────────── */

/**
 * Promote a single suggestion by id. Returns the routing decision; if a
 * route matched and `dryRun` is false, the corresponding domain event has
 * been published to the bus before this function returns.
 */
export async function promoteSuggestion(
    workspaceId: string,
    suggestionId: string,
    opts: PromoteOptions = {},
): Promise<PromotionDecision> {
    const markAccepted = opts.markAccepted ?? true

    const rows = Array.from(await db.execute<{
        id: string
        workspace_id: string
        kind: string
        payload: Record<string, unknown>
        score: number
        status: string
    }>(sql`
        SELECT id, workspace_id, kind, payload, score, status
        FROM synthesis_suggestions
        WHERE id = ${suggestionId}::uuid
          AND workspace_id = ${workspaceId}::uuid
        LIMIT 1
    `))
    const row = rows[0]
    if (!row) {
        const err = new Error(`Suggestion ${suggestionId} not found in workspace ${workspaceId}`)
        ;(err as Error & { code?: string }).code = 'SUGGESTION_NOT_FOUND'
        throw err
    }

    const suggestion: SuggestionRow = {
        id: row.id,
        workspaceId: row.workspace_id,
        kind: row.kind,
        payload: row.payload ?? {},
        score: row.score,
        status: row.status,
    }

    if (suggestion.status === 'promoted' || suggestion.status === 'accepted') {
        const decision = decideRoute(suggestion) ?? noopDecision(suggestion)
        decision.alreadyPromoted = true
        decision.rationale = `already ${suggestion.status}`
        return decision
    }

    const decision = decideRoute(suggestion) ?? noopDecision(suggestion)

    if (opts.dryRun) return decision
    if (decision.target === null) {
        logger.info({ workspaceId, suggestionId, kind: suggestion.kind }, 'promote: no route matched')
        return decision
    }

    // Publish the event — bridge listeners pick it up and call the sibling app.
    const topic = `ext.synthesis-promote.${decision.target}`
    try {
        eventBus.publish(topic, {
            workspaceId,
            suggestionId,
            kind: suggestion.kind,
            target: decision.target,
            payload: decision.payload,
            rationale: decision.rationale,
        })
    } catch (err) {
        logger.warn({ err, topic, suggestionId }, 'promote: event publish failed')
    }

    if (markAccepted) {
        try {
            await db.execute(sql`
                UPDATE synthesis_suggestions
                SET status = 'promoted', accepted_at = NOW()
                WHERE id = ${suggestionId}::uuid
                  AND workspace_id = ${workspaceId}::uuid
            `)
        } catch (err) {
            logger.warn({ err, suggestionId }, 'promote: status update failed')
        }
    }

    return decision
}

/**
 * Pure routing — no DB, no events. Used by tests and by the dry-run path.
 * Walks `promotionRoutes` in order; first non-null wins.
 */
export function decideRoute(suggestion: SuggestionRow): PromotionDecision | null {
    for (const rule of promotionRoutes) {
        const d = rule(suggestion)
        if (d) return d
    }
    return null
}

/* ── Routes ───────────────────────────────────────────────────────────── */

function routeNoteToLevioTask(s: SuggestionRow): PromotionDecision | null {
    if (s.kind !== 'note' && s.kind !== 'theme.page_draft' && s.kind !== 'link.note_to_note') return null

    // Pick a candidate text from the payload — different kinds use different keys.
    const candidates: string[] = []
    const p = s.payload
    if (typeof p.text === 'string') candidates.push(p.text)
    if (typeof p.content === 'string') candidates.push(p.content)
    if (typeof p.label === 'string') candidates.push(p.label)
    if (Array.isArray(p.sampleContents)) {
        for (const c of p.sampleContents as Array<{ content?: unknown }>) {
            if (c && typeof c.content === 'string') candidates.push(c.content)
        }
    }
    const text = candidates.join('\n').slice(0, 4000)
    if (!text) return null

    const matched = IMPERATIVE_PATTERNS.find(re => re.test(text))
    if (!matched) return null

    const titleLine = text.split(/\n+/).map(l => l.trim()).filter(Boolean)[0] ?? 'Untitled'
    const title = titleLine.replace(/\s+/g, ' ').slice(0, 120)

    return {
        suggestionId: s.id,
        workspaceId: s.workspaceId,
        target: 'levio.tasks.create',
        payload: { title, source: 'plexo.synthesis', suggestionId: s.id, score: s.score },
        rationale: `imperative phrase "${matched.source}" detected in note text`,
        alreadyPromoted: false,
    }
}

function routeAssetClusterToFontoProject(s: SuggestionRow): PromotionDecision | null {
    if (s.kind !== 'asset_cluster' && s.kind !== 'cross_app.asset_project') return null

    const p = s.payload
    const memberIds = Array.isArray(p.memberIds) ? (p.memberIds as unknown[]) : []
    if (memberIds.length < ASSET_CLUSTER_MIN_SIZE) return null

    const label = typeof p.label === 'string' ? p.label : 'Untitled cluster'
    return {
        suggestionId: s.id,
        workspaceId: s.workspaceId,
        target: 'fonto.projects.create',
        payload: {
            name: label,
            assetIds: memberIds,
            source: 'plexo.synthesis',
            suggestionId: s.id,
            score: s.score,
        },
        rationale: `asset cluster of size ${memberIds.length} ≥ ${ASSET_CLUSTER_MIN_SIZE}`,
        alreadyPromoted: false,
    }
}

function routeSpendPatternToFyloBudget(s: SuggestionRow): PromotionDecision | null {
    if (s.kind !== 'spend_pattern' && s.kind !== 'cross_app.financial_pattern') return null

    const p = s.payload
    const merchant = typeof p.merchant === 'string' ? p.merchant : null
    const amountBand = typeof p.amountBand === 'string' || typeof p.amountBand === 'number' ? p.amountBand : null
    const occurrences = typeof p.occurrences === 'number' ? p.occurrences : 0

    if (!merchant || amountBand === null || occurrences < 2) return null

    return {
        suggestionId: s.id,
        workspaceId: s.workspaceId,
        target: 'fylo.budget.signal',
        payload: {
            merchant,
            amountBand,
            occurrences,
            source: 'plexo.synthesis',
            suggestionId: s.id,
            score: s.score,
        },
        rationale: `recurring merchant "${merchant}" × ${occurrences} in band ${amountBand}`,
        alreadyPromoted: false,
    }
}

function noopDecision(s: SuggestionRow): PromotionDecision {
    return {
        suggestionId: s.id,
        workspaceId: s.workspaceId,
        target: null,
        payload: {},
        rationale: 'no route matched',
        alreadyPromoted: false,
    }
}

/* ── Bulk helper for the nightly cron ─────────────────────────────────── */

export interface AutoPromoteOptions {
    /** Promote any pending suggestion with score ≥ threshold. Default 1.5. */
    confidenceThreshold?: number
    /** Cap promotions per workspace per run. Default 25. */
    perWorkspaceCap?: number
    /** Workspace id — required. */
    workspaceId: string
}

export interface AutoPromoteResult {
    workspaceId: string
    inspected: number
    promoted: number
    noRoute: number
    skipped: number
}

/**
 * Walk pending suggestions above the confidence threshold and promote them.
 * Used by the nightly cron — see apps/api/src/cron/synthesis-nightly.ts.
 */
export async function autoPromoteAboveThreshold(opts: AutoPromoteOptions): Promise<AutoPromoteResult> {
    const threshold = opts.confidenceThreshold ?? 1.5
    const cap = opts.perWorkspaceCap ?? 25

    const rows = Array.from(await db.execute<{ id: string }>(sql`
        SELECT id FROM synthesis_suggestions
        WHERE workspace_id = ${opts.workspaceId}::uuid
          AND status = 'pending'
          AND score >= ${threshold}
        ORDER BY score DESC
        LIMIT ${cap}
    `))

    let promoted = 0, noRoute = 0, skipped = 0
    for (const r of rows) {
        try {
            const d = await promoteSuggestion(opts.workspaceId, r.id, { markAccepted: true })
            if (d.target === null) noRoute++
            else if (d.alreadyPromoted) skipped++
            else promoted++
        } catch (err) {
            logger.warn({ err, suggestionId: r.id, workspaceId: opts.workspaceId }, 'auto-promote: skipping')
            skipped++
        }
    }

    return {
        workspaceId: opts.workspaceId,
        inspected: rows.length,
        promoted,
        noRoute,
        skipped,
    }
}
