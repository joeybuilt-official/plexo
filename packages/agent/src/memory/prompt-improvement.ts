/**
 * Recursive self-improvement — prompt iteration engine
 *
 * The agent reviews its own system prompt against a sample of task outcomes,
 * identifies weaknesses, and proposes a revised prompt section.
 *
 * Proposal flow:
 * 1. Load current prompt version from workspace_preferences
 * 2. Sample N recent work_ledger entries (failed/low-quality biased)
 * 3. Ask the registry model to identify what the prompt causes it to do poorly
 * 4. Generate a proposed patch (diff-style: section + replacement)
 * 5. Store in agent_improvement_log with applied=false
 * 6. Operator reviews via GET /api/memory/improvements
 * 7. On approval, PATCH /api/memory/improvements/:id/apply sets applied=true
 *    and writes the new prompt section to workspace_preferences
 *
 * The agent reads workspace_preferences['prompt_overrides'] at task start
 * to pick up approved prompt changes without a code deploy.
 */
import { generateObject } from 'ai'
import { z } from 'zod'
import pino from 'pino'
import { db, sql, desc, eq } from '@plexo/db'
import { workLedger } from '@plexo/db'
import { resolveModelFromEnv } from '../providers/registry.js'
import { getPreference, learnPreference } from './preferences.js'

const logger = pino({ name: 'prompt-improvement' })

// ── Schema ───────────────────────────────────────────────────────────────────

export interface PromptPatch {
    section: string         // e.g. "tool_selection" | "error_handling" | "code_quality"
    original: string        // Current prompt text for this section (may be empty if new)
    proposed: string        // Replacement text
    rationale: string       // Why the change is proposed
    supportingTaskIds: string[]
}

const PromptPatchSchema = z.object({
    section: z.enum(['tool_selection', 'error_handling', 'code_quality', 'planning', 'output_format']),
    original: z.string(),
    proposed: z.string(),
    rationale: z.string(),
    supportingTaskIds: z.array(z.string()),
})

const PatchesSchema = z.object({
    patches: z.array(PromptPatchSchema).max(3),
})

// ── Analyse and propose ───────────────────────────────────────────────────────

export async function proposePromptImprovements(params: {
    workspaceId: string
    lookbackDays?: number
    minSamples?: number
}): Promise<PromptPatch[]> {
    const { workspaceId, lookbackDays = 14, minSamples = 5 } = params

    const apiKey = process.env.ANTHROPIC_API_KEY ?? process.env.OPENAI_API_KEY
    if (!apiKey) {
        logger.warn('No AI provider API key — cannot run prompt improvement analysis')
        return []
    }

    // Get current prompt overrides (may be empty first run)
    const currentOverrides = (await getPreference(workspaceId, 'prompt_overrides')) as Record<string, string> | null ?? {}

    // Sample low-quality outcomes — weighted toward failures
    const since = new Date()
    since.setDate(since.getDate() - lookbackDays)

    const rawSamples = await db.select({
        taskId: workLedger.taskId,
        type: workLedger.type,
        qualityScore: workLedger.qualityScore,
        calibration: workLedger.calibration,
        tokensIn: workLedger.tokensIn,
        deliverables: workLedger.deliverables,
        wallClockMs: workLedger.wallClockMs,
    }).from(workLedger)
        .where(eq(workLedger.workspaceId, workspaceId))
        .orderBy(desc(workLedger.completedAt))
        .limit(200)

    if (rawSamples.length < minSamples) {
        logger.info({ workspaceId, samples: rawSamples.length, minSamples }, 'Not enough samples for prompt analysis')
        return []
    }

    // Stratify by task type (up to 10 per type to ensure diversity)
    const byType = new Map<string, typeof rawSamples>()
    for (const s of rawSamples) {
        const t = s.type ?? 'unknown'
        const list = byType.get(t) ?? []
        if (list.length < 10) {
            list.push(s)
            byType.set(t, list)
        }
    }
    const samples = Array.from(byType.values()).flat()

    // Within the stratified sample, segregate
    const lowQuality = samples.filter((s) => (s.qualityScore ?? 1) < 0.7 || s.calibration === 'over')
    const highQuality = samples.filter((s) => (s.qualityScore ?? 0) >= 0.8)

    const model = resolveModelFromEnv('claude-haiku-4-5')

    let patches: PromptPatch[] = []
    try {
        const result = await generateObject({
            model,
            schema: PatchesSchema,
            system: `You are an AI meta-evaluator. You review AI agent task performance data and the agent's current system prompt overrides, then propose targeted improvements to the prompt.

Rules:
- Only propose changes supported by concrete evidence in the data
- Changes must be specific and actionable, not vague
- Maximum 3 proposals per run`,
            prompt: `Current prompt overrides: ${JSON.stringify(currentOverrides)}

Low-quality outcomes (${lowQuality.length}): ${JSON.stringify(lowQuality.slice(0, 10).map((s) => ({
                id: s.taskId?.slice(0, 8),
                type: s.type,
                q: s.qualityScore,
                cal: s.calibration,
                ms: s.wallClockMs,
            })))}

High-quality outcomes (${highQuality.length}): ${JSON.stringify(highQuality.slice(0, 5).map((s) => ({
                id: s.taskId?.slice(0, 8),
                type: s.type,
                q: s.qualityScore,
            })))}

Propose up to 3 prompt improvements.`,
            maxOutputTokens: 2048,
        })
        patches = result.object.patches as PromptPatch[]
    } catch (err) {
        logger.error({ err }, 'Prompt improvement LLM call failed')
    }

    // Store proposals as improvement log entries
    for (const patch of patches.slice(0, 3)) {
        await db.execute(sql`
      INSERT INTO agent_improvement_log
        (workspace_id, pattern_type, description, evidence, proposed_change, created_at)
      VALUES (
        ${workspaceId}::uuid,
        'prompt_patch',
        ${`[${patch.section}] ${patch.rationale}`},
        ${JSON.stringify(patch.supportingTaskIds ?? [])}::jsonb,
        ${JSON.stringify({ section: patch.section, original: patch.original, proposed: patch.proposed })}::text,
        now()
      )
    `)
    }

    logger.info({ workspaceId, patches: patches.length }, 'Prompt improvement proposals stored')
    return patches
}

// ── Apply an approved patch ───────────────────────────────────────────────────

export async function applyPromptPatch(params: {
    workspaceId: string
    improvementLogId: string
}): Promise<void> {
    const { workspaceId, improvementLogId } = params

    const rows = await db.execute<{ proposed_change: string; applied: boolean }>(sql`
    SELECT proposed_change, applied FROM agent_improvement_log
    WHERE id = ${improvementLogId}::uuid AND workspace_id = ${workspaceId}::uuid
    LIMIT 1
  `)

    const row = rows[0]
    if (!row) throw new Error(`Improvement log entry ${improvementLogId} not found`)
    if (row.applied) throw new Error('Patch already applied')

    const patch = JSON.parse(row.proposed_change) as { section: string; proposed: string }

    // Read current overrides and merge
    const current = (await getPreference(workspaceId, 'prompt_overrides')) as Record<string, string> | null ?? {}
    const updated = { ...current, [patch.section]: patch.proposed }

    await learnPreference({
        workspaceId,
        key: 'prompt_overrides',
        value: updated,
        observationConfidence: 0.9, // Operator-approved — high confidence
    })

    // Mark applied
    await db.execute(sql`
    UPDATE agent_improvement_log SET applied = true
    WHERE id = ${improvementLogId}::uuid
  `)

    logger.info({ workspaceId, improvementLogId, section: patch.section }, 'Prompt patch applied')
}

// ── Read overrides (called by executor at task start) ─────────────────────────

export async function getPromptOverrides(workspaceId: string): Promise<Record<string, string>> {
    return (await getPreference(workspaceId, 'prompt_overrides')) as Record<string, string> | null ?? {}
}
