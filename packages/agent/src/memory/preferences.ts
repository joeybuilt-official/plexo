/**
 * Workspace preference learning — infers and stores agent preferences
 * from task outcomes (tool selection, code style, communication tone).
 *
 * Preferences are stored in workspace_preferences as key/value pairs
 * with a confidence score that grows as more evidence accumulates.
 *
 * Keys (examples):
 *   preferred_language       — "TypeScript" | "Python" | ...
 *   preferred_test_framework — "vitest" | "jest" | "pytest"
 *   code_style               — { quotes: "single", semicolons: false }
 *   communication_tone       — "concise" | "detailed"
 *   preferred_tools          — ["read_file", "shell", ...]  (ranked by success rate)
 */
import pino from 'pino'
import { db, sql } from '@plexo/db'

const logger = pino({ name: 'preferences' })

export interface Preference {
    workspaceId: string
    key: string
    value: unknown
    confidence: number
    evidenceCount: number
    lastUpdated: Date
}

// ── Read ──────────────────────────────────────────────────────────────────────

export async function getPreferences(workspaceId: string): Promise<Record<string, unknown>> {
    const rows = await db.execute<{
        key: string
        value: unknown
        confidence: number
    }>(sql`
    SELECT key, value, confidence
    FROM workspace_preferences
    WHERE workspace_id = ${workspaceId}::uuid
    ORDER BY confidence DESC
  `)

    return Object.fromEntries(rows.map((r) => [r.key, r.value]))
}

export async function getPreference(workspaceId: string, key: string): Promise<unknown | null> {
    const rows = await db.execute<{ value: unknown }>(sql`
    SELECT value FROM workspace_preferences
    WHERE workspace_id = ${workspaceId}::uuid AND key = ${key}
    LIMIT 1
  `)
    return rows[0]?.value ?? null
}

// ── Write (upsert with confidence accumulation) ───────────────────────────────

export async function learnPreference(params: {
    workspaceId: string
    key: string
    value: unknown
    /**
     * How confident is this observation? 0-1.
     * Repeated observations increase stored confidence up to 0.95.
     */
    observationConfidence?: number
}): Promise<void> {
    const { workspaceId, key, value, observationConfidence = 0.6 } = params

    await db.execute(sql`
    INSERT INTO workspace_preferences (workspace_id, key, value, confidence, evidence_count, last_updated)
    VALUES (
      ${workspaceId}::uuid,
      ${key},
      ${JSON.stringify(value)}::jsonb,
      ${observationConfidence},
      1,
      now()
    )
    ON CONFLICT (workspace_id, key)
    DO UPDATE SET
      value = EXCLUDED.value,
      confidence = LEAST(0.95, workspace_preferences.confidence + (EXCLUDED.confidence * 0.1)),
      evidence_count = workspace_preferences.evidence_count + 1,
      last_updated = now()
  `)

    logger.debug({ workspaceId, key, value }, 'Preference learned')
}

// ── Infer preferences from task outcome ──────────────────────────────────────

export async function inferFromTaskOutcome(params: {
    workspaceId: string
    toolsUsed: string[]
    filesWritten: string[]
    qualityScore?: number
    outcome: 'success' | 'failure' | 'partial'
}): Promise<void> {
    const { workspaceId, toolsUsed, filesWritten, qualityScore, outcome } = params

    const confidence = outcome === 'success' ? 0.7 : outcome === 'partial' ? 0.4 : 0.2

    // Infer language preference from files written
    const langPref = inferLanguage(filesWritten)
    if (langPref) {
        await learnPreference({ workspaceId, key: 'preferred_language', value: langPref, observationConfidence: confidence })
    }

    // Track tool success rates
    if (toolsUsed.length > 0 && outcome === 'success') {
        for (const tool of toolsUsed) {
            await learnPreference({
                workspaceId,
                key: `tool_success_${tool}`,
                value: true,
                observationConfidence: 0.65,
            })
        }
    }

    // Test framework preference
    const testPref = inferTestFramework(filesWritten)
    if (testPref) {
        await learnPreference({ workspaceId, key: 'preferred_test_framework', value: testPref, observationConfidence: confidence })
    }
}

function inferLanguage(files: string[]): string | null {
    const exts: Record<string, string> = {
        '.ts': 'TypeScript', '.tsx': 'TypeScript',
        '.py': 'Python', '.go': 'Go', '.rs': 'Rust',
        '.js': 'JavaScript', '.jsx': 'JavaScript',
        '.rb': 'Ruby', '.java': 'Java',
    }
    const counts: Record<string, number> = {}
    for (const f of files) {
        const ext = '.' + f.split('.').pop()
        const lang = exts[ext]
        if (lang) counts[lang] = (counts[lang] ?? 0) + 1
    }
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]
    return top ? top[0] : null
}

function inferTestFramework(files: string[]): string | null {
    const lower = files.map((f) => f.toLowerCase())
    if (lower.some((f) => f.includes('vitest'))) return 'vitest'
    if (lower.some((f) => f.includes('jest'))) return 'jest'
    if (lower.some((f) => f.includes('pytest'))) return 'pytest'
    if (lower.some((f) => f.includes('playwright'))) return 'playwright'
    return null
}
