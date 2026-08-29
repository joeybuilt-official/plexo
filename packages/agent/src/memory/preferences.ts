// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

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
import { DrizzlePreferenceStore } from '../memory.repository.js'
import type { PreferenceStore } from '../memory.ports.js'
import { getCachedPreferences, setCachedPreferences, invalidatePrefsCache } from './store.js'

const logger = pino({ name: 'preferences' })

// ── Composition root + test seam ────────────────────────────────────────────
let preferenceStore: PreferenceStore = new DrizzlePreferenceStore()

/** Swap the preference store (e.g. an in-memory fake in unit tests). */
export function setPreferenceStore(next: PreferenceStore): void {
    preferenceStore = next
}

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
    // Redis hot path
    const cached = await getCachedPreferences(workspaceId)
    if (cached) return cached

    const rows = await preferenceStore.listByWorkspace(workspaceId)

    const prefs = Object.fromEntries(rows.map((r) => [r.key, r.value]))
    await setCachedPreferences(workspaceId, prefs)
    return prefs
}

export async function getPreference(workspaceId: string, key: string): Promise<unknown | null> {
    return preferenceStore.getValue(workspaceId, key)
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

    await preferenceStore.upsert({ workspaceId, key, value, confidence: observationConfidence })

    // Invalidate Redis cache so next read reflects the update
    await invalidatePrefsCache(workspaceId)
    logger.debug({ workspaceId, key, value }, 'Preference learned')
}

/**
 * Directly set a preference from an explicit user instruction (high confidence).
 * Sends immediately to DB + invalidates cache. Used by chat "remember" intent.
 */
export async function setPreference(params: {
    workspaceId: string
    key: string
    value: unknown
    source?: string
}): Promise<void> {
    const { workspaceId, key, value, source = 'user' } = params
    await learnPreference({ workspaceId, key, value, observationConfidence: 0.9 })
    logger.info({ workspaceId, key, source }, 'Preference set directly by user')
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
