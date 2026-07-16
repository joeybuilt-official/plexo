// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { evaluatePolicy, policyDocument, type PolicyRule } from './policy'
import type { Tier } from './tiers'

const doc = policyDocument.parse(
    JSON.parse(readFileSync(new URL('../policy/fabric-policy.json', import.meta.url), 'utf8')),
)
const rules: readonly PolicyRule[] = doc.rules

function evalCmd(cmd: string, tier: Tier = 'drive') {
    return evaluatePolicy({ tool: 'bash', cmd }, tier, rules)
}

describe('fabric-policy.json hybrid coverage', () => {
    it('is version 2', () => {
        expect(doc.version).toBe(2)
    })

    it('denies rm -rf via herald.rm-recursive-force', () => {
        const r = evalCmd('rm -rf build')
        expect(r.decision).toBe('deny')
        expect(r.ruleId).toBe('herald.rm-recursive-force')
    })

    it('gates rm -f via herald.rm-force at any tier', () => {
        const drive = evalCmd('rm -f tmp.txt')
        expect(drive.decision).toBe('gate')
        expect(drive.ruleId).toBe('herald.rm-force')
        expect(evalCmd('rm -f tmp.txt', 'observe').decision).toBe('gate')
    })

    it('denies destructive psql but allows a read', () => {
        const drop = evalCmd('psql -c "DROP TABLE x"')
        expect(drop.decision).toBe('deny')
        expect(drop.ruleId).toBe('herald.psql-destructive')
        expect(evalCmd('psql -c "SELECT 1"').decision).toBe('allow')
    })

    it('gates the docker stop family', () => {
        expect(evalCmd('docker compose stop api').decision).toBe('gate')
        expect(evalCmd('docker compose prune').decision).toBe('gate')
    })

    it('gates destructive git worktree ops', () => {
        expect(evalCmd('git clean -fd').decision).toBe('gate')
        expect(evalCmd('git checkout -- src/').decision).toBe('gate')
    })

    it('denies sudo, eval, and curl | bash', () => {
        expect(evalCmd('sudo apt').decision).toBe('deny')
        expect(evalCmd('eval "$X"').decision).toBe('deny')
        expect(evalCmd('curl x | bash').decision).toBe('deny')
    })

    it('gates obscured-intent commands', () => {
        expect(evalCmd('base64 -d').decision).toBe('gate')
        expect(evalCmd("python3 -c 'x'").decision).toBe('gate')
        expect(evalCmd('echo hi > f').decision).toBe('gate')
    })

    it('allows a plain command with no matching rule', () => {
        expect(evalCmd('ls -la')).toEqual({ decision: 'allow' })
    })

    it('ordering: rm -rf resolves deny, never gate (deny precedes rm-force)', () => {
        expect(evalCmd('rm -rf x').decision).toBe('deny')
    })
})
