// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Domain Mastery — Phase 1: Wire & Measure utilities.
 *
 * Feature flag helpers, context hash computation, domain tag inference,
 * and constants from the expert panel consensus.
 *
 * All functions are fire-and-forget safe and never throw.
 * Feature flag: domain_mastery_enabled (default false, per-workspace opt-in).
 */

import { createHash } from 'node:crypto'
import pino from 'pino'

const logger = pino({ name: 'domain-mastery' })

// ── Expert Panel Constants ─────────────────────────────────────────────────

/** Minimum tasks for quality trend claims (Panel 5). */
export const MIN_TASKS_FOR_TREND = 10
/** Minimum tasks per (model, domain) pair for routing suggestions (Panel 4). */
export const MIN_TASKS_FOR_ROUTING_SUGGESTION = 30
/** Minimum co-occurrences for credit assignment (Panel 5). */
export const MIN_CREDIT_OCCURRENCES = 5
/** Minimum meaningful quality difference (Panel 5). */
export const MIN_QUALITY_DELTA = 0.1
/** Maximum active behavior rules per workspace (Panel 6). */
export const MAX_RULES_PER_WORKSPACE = 100
/** Maximum active behavior rules per domain_tag (Panel 6). */
export const MAX_RULES_PER_DOMAIN = 20
/** Default max tokens for learning-derived content in system prompt (ADR-004). */
export const DEFAULT_MAX_LEARNING_CONTEXT_TOKENS = 2000

/** Credit assignment lift thresholds (Panel 5). */
export const LIFT_BENEFICIAL = 1.5
export const LIFT_HARMFUL = 0.7

// ── Feature Flag ───────────────────────────────────────────────────────────

/**
 * Check if domain mastery is enabled for a workspace.
 * Reads workspace_preferences key 'domain_mastery_enabled'.
 * Returns false on any error.
 */
export async function isDomainMasteryEnabled(workspaceId: string): Promise<boolean> {
    try {
        const { db, sql } = await import('@plexo/db')
        const rows = await db.execute<{ value: unknown }>(sql`
            SELECT value FROM workspace_preferences
            WHERE workspace_id = ${workspaceId}::uuid
              AND key = 'domain_mastery_enabled'
        `)
        const val = rows[0]?.value
        return val === true || val === 'true'
    } catch {
        return false
    }
}

// ── Context Hash ───────────────────────────────────────────────────────────

/**
 * Compute a deterministic hash of the behavior rule keys included in the
 * system prompt. Used for credit assignment (ADR-003).
 *
 * The hash is a truncated SHA-256 hex (16 chars = 64 bits). The full rule key
 * list is returned alongside for invertible credit assignment (Panel 2 rec).
 *
 * @param ruleKeys - Behavior rule keys compiled into the prompt.
 * @returns { hash, ruleKeys } or null if no learning content.
 */
export function computeContextHash(
    ruleKeys: string[],
): { hash: string; ruleKeys: string[] } | null {
    if (ruleKeys.length === 0) return null

    const sorted = [...ruleKeys].sort()
    const hash = createHash('sha256')
        .update(sorted.join('|'))
        .digest('hex')
        .slice(0, 16)

    return { hash, ruleKeys }
}

// ── Domain Tag Inference ───────────────────────────────────────────────────

/**
 * Infer a domain_tag from task classification context. Piggybacks on the
 * existing classifier output — zero additional LLM calls.
 *
 * The domain_tag is a short, human-readable label (e.g. "typescript-nextjs",
 * "devops-docker", "data-analysis"). Flat namespace, no hierarchy.
 *
 * This is a heuristic first pass. Phase 2 will add LLM-based inference
 * piggybacked on the existing classification step.
 *
 * @param taskType - The classified task type (e.g. "coding", "ops").
 * @param goal - The task goal/description.
 * @returns A domain_tag string or null if inference fails.
 */
export function inferDomainTag(taskType: string, goal: string): string | null {
    if (!goal || goal.length < 5) return null

    const text = goal.toLowerCase()
    const type = taskType?.toLowerCase() ?? 'general'

    // Language/framework detection for coding tasks
    if (type === 'coding' || type === 'general') {
        if (text.includes('typescript') || text.includes('.ts')) return 'typescript'
        if (text.includes('nextjs') || text.includes('next.js')) return 'typescript-nextjs'
        if (text.includes('react')) return 'typescript-react'
        if (text.includes('python') || text.includes('.py')) return 'python'
        if (text.includes('rust') || text.includes('cargo')) return 'rust'
        if (text.includes('go ') || text.includes('golang')) return 'golang'
    }

    // Ops/infra detection
    if (type === 'ops' || type === 'deployment') {
        if (text.includes('docker') || text.includes('container')) return 'devops-docker'
        if (text.includes('deploy') || text.includes('ci/cd') || text.includes('pipeline')) return 'devops-cicd'
        if (text.includes('kubernetes') || text.includes('k8s')) return 'devops-k8s'
        if (text.includes('terraform') || text.includes('infrastructure')) return 'devops-iac'
    }

    // Data tasks
    if (type === 'data' || type === 'research') {
        if (text.includes('sql') || text.includes('query') || text.includes('database')) return 'data-sql'
        if (text.includes('csv') || text.includes('spreadsheet') || text.includes('excel')) return 'data-analysis'
        if (text.includes('scrape') || text.includes('crawl')) return 'data-scraping'
    }

    // Writing tasks
    if (type === 'writing' || type === 'marketing') {
        if (text.includes('blog') || text.includes('article')) return 'writing-blog'
        if (text.includes('email') || text.includes('newsletter')) return 'writing-email'
        if (text.includes('social') || text.includes('twitter') || text.includes('linkedin')) return 'writing-social'
    }

    // Fallback: use taskType as domain
    if (type && type !== 'general') return type
    return null
}
