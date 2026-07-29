// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Distillation retro agent — reads outcome_records for a routine, synthesizes
 * a proposed prompt improvement, and writes a PENDING versioned row to
 * prompt_revisions.
 *
 * REQUIRES migration 0123_prompt_revisions before activating.
 * All logic is behind DISTILL_ENABLED=false — flip only after real data accrues.
 *
 * Signal weighting:
 *   human_reject   → highest weight (explicit negative feedback)
 *   disagreement   → high weight (human_verdict contradicts automated_outcome)
 *   auto_failed    → medium weight
 *   auto_complete  → context only
 *
 * Approval path:
 *   1. runDistillRetro() writes PENDING row + sends Telegram notification
 *   2. Operator replies "approve <id>" or "reject <id>" in Telegram
 *   3. telegram.ts calls applyRevision() or rejectRevision()
 *   4. applyRevision() does stomp-check (base_prompt_hash) then updates cron_jobs.prompt
 *   5. Rollback: look up previous version's proposedDiff (= the prompt text at that point)
 *
 * Never auto-applies. Approval is always human-in-the-loop.
 */

import { createHash } from 'node:crypto'
import { logger } from '../logger.js'

// Migration 0123 applied 2026-06-01. Keep false until real outcome data accrues.
const DISTILL_ENABLED = false

const DEFAULT_MIN_ROWS = 10
const TELEGRAM_API = 'https://api.telegram.org/bot'

export interface DistillRetroOpts {
    routineId: string
    /** Override minimum outcome row requirement (for tests). */
    minRows?: number
}

export interface DistillRetroResult {
    routineId: string
    skipped: boolean
    skipReason?: string
    revisionId?: string
    version?: number
}

/**
 * Run the distillation retro agent for one routine.
 * Non-fatal: errors are logged and surfaced as skipped=true.
 */
export async function runDistillRetro(opts: DistillRetroOpts): Promise<DistillRetroResult> {
    if (!DISTILL_ENABLED) {
        logger.debug({ routineId: opts.routineId }, 'distill-retro: disabled (DISTILL_ENABLED=false)')
        return { routineId: opts.routineId, skipped: true, skipReason: 'DISTILL_ENABLED=false' }
    }

    const { db, promptRevisions, cronJobs } = await import('@plexo/db')
    const { eq, sql, and } = await import('drizzle-orm')
    const minRows = opts.minRows ?? DEFAULT_MIN_ROWS

    // 1. Fetch the routine
    const [routine] = await db.select({
        id:            cronJobs.id,
        workspaceId:   cronJobs.workspaceId,
        name:          cronJobs.name,
        prompt:        cronJobs.prompt,
        notifyChannel: cronJobs.notifyChannel,
    }).from(cronJobs).where(eq(cronJobs.id, opts.routineId)).limit(1)

    if (!routine) return skip(opts.routineId, 'routine_not_found')
    if (!routine.prompt) return skip(opts.routineId, 'no_prompt')

    // 2. Block if a non-expired PENDING revision already exists
    const [existingPending] = await db.select({ id: promptRevisions.id })
        .from(promptRevisions)
        .where(and(
            eq(promptRevisions.routineId, opts.routineId),
            eq(promptRevisions.status, 'pending'),
            sql`${promptRevisions.expiresAt} > NOW()`,
        ))
        .limit(1)

    if (existingPending) return skip(opts.routineId, 'pending_revision_exists')

    // 3. Expire any stale pending rows (TTL elapsed)
    await db.update(promptRevisions)
        .set({ status: 'expired' })
        .where(and(
            eq(promptRevisions.routineId, opts.routineId),
            eq(promptRevisions.status, 'pending'),
            sql`${promptRevisions.expiresAt} <= NOW()`,
        ))

    // 4. Fetch outcome rows — weighted: human_reject, disagreement, auto_failed, rest
    const rows = await db.execute<{
        id: string
        automated_outcome: string | null
        human_verdict: string | null
        summary: string | null
        ts: string
    }>(sql`
        SELECT id, automated_outcome, human_verdict, summary, ts
        FROM outcome_records
        WHERE routine_id = ${opts.routineId}::uuid
        ORDER BY
            CASE
                WHEN human_verdict = 'reject' THEN 0
                WHEN (human_verdict = 'reject' AND automated_outcome = 'complete')
                  OR (human_verdict = 'accept' AND automated_outcome = 'failed') THEN 1
                WHEN automated_outcome = 'failed' THEN 2
                ELSE 3
            END ASC,
            ts DESC
        LIMIT 50
    `)

    const outcomeRows = Array.from(rows)

    if (outcomeRows.length < minRows) {
        return skip(opts.routineId, `insufficient_data (${outcomeRows.length}/${minRows})`)
    }

    // 5. Next version number (monotonic per routine)
    const [latestRevision] = await db.select({ version: promptRevisions.version })
        .from(promptRevisions)
        .where(eq(promptRevisions.routineId, opts.routineId))
        .orderBy(sql`${promptRevisions.version} DESC`)
        .limit(1)
    const nextVersion = (latestRevision?.version ?? 0) + 1

    // 6. Hash current prompt for stomp-guard on apply
    const basePromptHash = sha256(routine.prompt)

    // 7. LLM synthesis — route through workspace's configured provider
    const analysisPrompt = buildAnalysisPrompt(routine.name, routine.prompt, outcomeRows)

    const { chatWithAI } = await import('../channel-ai.js')
    const llmResult = await chatWithAI(
        routine.workspaceId,
        [{ role: 'user', content: analysisPrompt }],
        'You are a prompt engineering expert. Output valid JSON only — no markdown fences, no extra text.',
    )

    if (!llmResult.text) {
        logger.warn({ routineId: opts.routineId, error: llmResult.error }, 'distill-retro: LLM call failed')
        return skip(opts.routineId, `llm_error: ${llmResult.error ?? 'no text'}`)
    }

    // 8. Parse LLM response
    const proposed = parseLlmResponse(llmResult.text)
    if (!proposed) {
        logger.warn({ routineId: opts.routineId, raw: llmResult.text.slice(0, 200) }, 'distill-retro: LLM parse failed')
        return skip(opts.routineId, 'llm_parse_error')
    }

    // 9. Write PENDING revision
    const sourceIds = outcomeRows.map(r => r.id)
    const [revision] = await db.insert(promptRevisions).values({
        routineId:        opts.routineId,
        version:          nextVersion,
        basePromptHash,
        proposedDiff:     proposed.proposedPrompt,
        rationale:        proposed.rationale,
        sourceOutcomeIds: sourceIds,
        status:           'pending',
    }).returning({ id: promptRevisions.id })

    if (!revision) {
        logger.warn({ routineId: opts.routineId }, 'distill-retro: revision insert returned nothing')
        return skip(opts.routineId, 'insert_failed')
    }

    logger.info({ routineId: opts.routineId, revisionId: revision.id, version: nextVersion }, 'distill-retro: pending revision written')

    // 10. Telegram notification
    if (routine.notifyChannel?.startsWith('telegram:')) {
        const chatId = routine.notifyChannel.slice('telegram:'.length)
        await notifyTelegram(routine.workspaceId, chatId, {
            routineName:    routine.name,
            revisionId:     revision.id,
            version:        nextVersion,
            rationale:      proposed.rationale,
            proposedPrompt: proposed.proposedPrompt,
            currentPrompt:  routine.prompt,
            sourceCount:    outcomeRows.length,
        })
    }

    return { routineId: opts.routineId, skipped: false, revisionId: revision.id, version: nextVersion }
}

/**
 * Apply an approved revision — stomp-check then update cron_jobs.prompt.
 * Call from telegram.ts approval handler.
 */
export async function applyRevision(revisionId: string, reviewedBy: string): Promise<{ ok: boolean; error?: string }> {
    const { db, promptRevisions, cronJobs } = await import('@plexo/db')
    const { eq, and } = await import('drizzle-orm')

    const [revision] = await db.select().from(promptRevisions).where(eq(promptRevisions.id, revisionId)).limit(1)
    if (!revision) return { ok: false, error: 'revision_not_found' }
    if (revision.status !== 'pending') return { ok: false, error: `revision_not_pending (${revision.status})` }

    // Stomp check — abort if prompt changed since diff was generated
    const [routine] = await db.select({ prompt: cronJobs.prompt, workspaceId: cronJobs.workspaceId })
        .from(cronJobs).where(eq(cronJobs.id, revision.routineId)).limit(1)
    if (!routine) return { ok: false, error: 'routine_not_found' }

    const currentHash = sha256(routine.prompt ?? '')
    if (currentHash !== revision.basePromptHash) {
        await db.update(promptRevisions).set({ status: 'stale' }).where(eq(promptRevisions.id, revisionId))
        logger.warn({ revisionId, routineId: revision.routineId }, 'distill-retro: apply aborted — prompt changed since diff (stale)')
        return { ok: false, error: 'prompt_changed_stale' }
    }

    const now = new Date()
    await db.update(cronJobs).set({ prompt: revision.proposedDiff }).where(eq(cronJobs.id, revision.routineId))
    await db.update(promptRevisions).set({
        status:     'applied',
        reviewedBy,
        reviewedAt: now,
        appliedAt:  now,
    }).where(eq(promptRevisions.id, revisionId))

    logger.info({ revisionId, routineId: revision.routineId, version: revision.version }, 'distill-retro: revision applied')

    return { ok: true }
}

/**
 * Reject a revision — marks it as rejected, no DB changes to cron_jobs.
 */
export async function rejectRevision(revisionId: string, reviewedBy: string): Promise<{ ok: boolean; error?: string }> {
    const { db, promptRevisions, cronJobs } = await import('@plexo/db')
    const { eq } = await import('drizzle-orm')

    const [revision] = await db.select({ status: promptRevisions.status })
        .from(promptRevisions).where(eq(promptRevisions.id, revisionId)).limit(1)
    if (!revision) return { ok: false, error: 'revision_not_found' }
    if (revision.status !== 'pending') return { ok: false, error: `revision_not_pending (${revision.status})` }

    await db.update(promptRevisions).set({
        status:     'rejected',
        reviewedBy,
        reviewedAt: new Date(),
    }).where(eq(promptRevisions.id, revisionId))

    logger.info({ revisionId }, 'distill-retro: revision rejected')

    return { ok: true }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function skip(routineId: string, reason: string): DistillRetroResult {
    return { routineId, skipped: true, skipReason: reason }
}

function sha256(text: string): string {
    return createHash('sha256').update(text).digest('hex')
}

type OutcomeRow = { automated_outcome: string | null; human_verdict: string | null; summary: string | null; ts: string }

function buildAnalysisPrompt(routineName: string, currentPrompt: string, rows: OutcomeRow[]): string {
    const outcomeData = rows.map(r => ({
        automated: r.automated_outcome ?? undefined,
        human: r.human_verdict ?? undefined,
        summary: r.summary?.slice(0, 300) ?? undefined,
        ts: r.ts,
    }))
    return `You are analyzing the execution history of an automated AI agent routine named "${routineName}".

Current prompt:
<current_prompt>
${currentPrompt}
</current_prompt>

Recent execution outcomes (${rows.length} rows, most important first — human rejections and disagreements are weighted highest):
<outcomes>
${JSON.stringify(outcomeData, null, 2)}
</outcomes>

Identify what the agent is doing wrong or what the prompt is missing. Propose an improved prompt that addresses the observed failure patterns.

Respond with valid JSON only:
{"proposed_prompt":"<full new prompt text>","rationale":"<1-3 sentences citing specific failure patterns and what changed>"}`
}

function parseLlmResponse(text: string): { proposedPrompt: string; rationale: string } | null {
    try {
        const cleaned = text.trim().replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
        const parsed = JSON.parse(cleaned) as { proposed_prompt?: string; rationale?: string }
        if (!parsed.proposed_prompt || !parsed.rationale) return null
        return { proposedPrompt: parsed.proposed_prompt, rationale: parsed.rationale }
    } catch {
        return null
    }
}

interface RevisionNotification {
    routineName: string
    revisionId: string
    version: number
    rationale: string
    proposedPrompt: string
    currentPrompt: string
    sourceCount: number
}

async function notifyTelegram(workspaceId: string, chatId: string, n: RevisionNotification): Promise<void> {
    const { getChannelToken } = await import('../channel-delivery.js')
    let token = getChannelToken(workspaceId)

    if (!token) {
        try {
            const { db, channels } = await import('@plexo/db')
            const { eq } = await import('drizzle-orm')
            const [row] = await db.select({ config: channels.config })
                .from(channels)
                .where(eq(channels.workspaceId, workspaceId))
                .limit(1)
            const cfg = row?.config as { token?: string; bot_token?: string } | null
            token = cfg?.token ?? cfg?.bot_token
        } catch { /* non-fatal */ }
    }

    if (!token) {
        logger.warn({ workspaceId, routineName: n.routineName }, 'distill-retro: no Telegram token — notification skipped')
        return
    }

    const MAX_PROMPT = 600
    const promptSnippet = n.proposedPrompt.length > MAX_PROMPT
        ? n.proposedPrompt.slice(0, MAX_PROMPT) + '…'
        : n.proposedPrompt

    const text = [
        `🔬 *Prompt revision v${n.version}* for *${n.routineName}*`,
        `Based on ${n.sourceCount} outcome rows.`,
        '',
        `*Rationale:* ${n.rationale}`,
        '',
        `*Proposed prompt:*\n\`\`\`\n${promptSnippet}\n\`\`\``,
        '',
        `Reply \`approve ${n.revisionId}\` to apply, or \`reject ${n.revisionId}\` to dismiss.`,
    ].join('\n')

    try {
        await fetch(`${TELEGRAM_API}${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
            signal: AbortSignal.timeout(10_000),
        })
    } catch (err) {
        logger.warn({ err, routineName: n.routineName }, 'distill-retro: Telegram notification failed — non-fatal')
    }
}
