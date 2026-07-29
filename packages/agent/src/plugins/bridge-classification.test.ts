// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Unit tests for the PEX bridge's isSkillOnly classification logic.
 *
 * Mirrors the production predicate in plugins/bridge.ts so regressions are
 * caught without requiring DB or worker-thread access.
 */

import { describe, it, expect } from 'vitest'

// ── Inline mirror of production logic ─────────────────────────────────────────

function classifyExtension(ext: {
    source?: string | null
    entry?: string | null
}): { isSkillOnly: boolean; hasRealEntry: boolean } {
    const hasRealEntry = Boolean(ext.entry)
        && ext.entry !== 'skill://'
        && ext.entry !== 'index.js'

    const isSkillOnly = ext.source === 'skillmd' || !hasRealEntry
    return { isSkillOnly, hasRealEntry }
}

// ── Fixtures ───────────────────────────────────────────────────────────────────

describe('bridge isSkillOnly classification', () => {
    // Skill-only cases — should be skipped (no worker spawned)
    it('source=skillmd → isSkillOnly regardless of entry', () => {
        expect(classifyExtension({ source: 'skillmd', entry: '/real/path/index.js' }).isSkillOnly).toBe(true)
    })

    it('no entry → isSkillOnly', () => {
        expect(classifyExtension({ source: null, entry: null }).isSkillOnly).toBe(true)
    })

    it('empty entry → isSkillOnly', () => {
        expect(classifyExtension({ source: null, entry: '' }).isSkillOnly).toBe(true)
    })

    it('entry=skill:// → isSkillOnly (explicit no-code marker)', () => {
        expect(classifyExtension({ source: null, entry: 'skill://' }).isSkillOnly).toBe(true)
    })

    it('entry=index.js → isSkillOnly (Hub catalog placeholder)', () => {
        // Hub catalog normalizer writes 'index.js' for manifests without a real entry
        expect(classifyExtension({ source: null, entry: 'index.js' }).isSkillOnly).toBe(true)
    })

    // Executable cases — should proceed to worker spawn
    it('synthesizer extension: type=skill with full absolute path → NOT isSkillOnly', () => {
        // Synthesizer stores: type='skill', entry='/var/plexo/generated-skills/docker-ops/index.js'
        // The type='skill' alone must NOT filter these out — the real entry presence is the gate.
        const result = classifyExtension({
            source: null,
            entry: '/var/plexo/generated-skills/docker-ops/index.js',
        })
        expect(result.hasRealEntry).toBe(true)
        expect(result.isSkillOnly).toBe(false)
    })

    it('synthesizer extension: deploy-engine absolute path → NOT isSkillOnly', () => {
        const result = classifyExtension({
            source: null,
            entry: '/var/plexo/generated-skills/deploy-engine/index.js',
        })
        expect(result.isSkillOnly).toBe(false)
    })

    it('npm-package entry → NOT isSkillOnly', () => {
        const result = classifyExtension({ source: null, entry: '@acme/stripe-monitor' })
        expect(result.hasRealEntry).toBe(true)
        expect(result.isSkillOnly).toBe(false)
    })

    it('relative non-placeholder path → NOT isSkillOnly', () => {
        // e.g. dist/index.js is NOT the bare 'index.js' placeholder
        const result = classifyExtension({ source: null, entry: 'dist/index.js' })
        expect(result.isSkillOnly).toBe(false)
    })

    it('source=skillmd with real entry still → isSkillOnly (source wins)', () => {
        // skillmd source always means prompt-injection regardless of stored entry
        expect(classifyExtension({ source: 'skillmd', entry: '/real/path.js' }).isSkillOnly).toBe(true)
    })
})
