// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Architecture boundary guards — Connection & Profile Standard (ADR 0001, Phase 4a).
 *
 * Two invariants the Standard depends on, enforced in CI:
 *
 * Guard A — SDK purity: `@joeybuilt/plexo-sdk` (packages/sdk) is the thin Pex
 *   client that external apps depend on. It MUST NOT import Plexo Core internals
 *   (`@plexo/agent`, `@plexo/db`, …) or it stops being a standalone shim and
 *   drags the whole core into every consumer.
 *
 * Guard B — no domain drift in core intelligence: the domain-agnostic core
 *   (executor/planner/prompts/memory/providers) MUST NOT reference an app by
 *   name. App-specific integration legitimately lives in the connector surface
 *   (connections/, tool name translations) — NOT in the intelligence loop.
 *   A small KNOWN_DEBT allowlist holds the 2 pre-existing drift spots Phase 4b
 *   extracts; the test fails if a NEW core file references an app, AND fails if
 *   an allowlisted file no longer drifts (forcing the allowlist to shrink).
 */

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { resolve, relative, join } from 'path'

const repoRoot = resolve(__dirname, '../..')

function walk(dir: string, acc: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
        const p = join(dir, entry)
        const st = statSync(p)
        if (st.isDirectory()) {
            if (entry === 'node_modules' || entry === 'dist' || entry === '__tests__') continue
            walk(p, acc)
        } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts') && !entry.endsWith('.d.ts')) {
            acc.push(p)
        }
    }
    return acc
}

const rel = (p: string) => relative(repoRoot, p).replace(/\\/g, '/')

describe('Guard A — SDK purity (packages/sdk imports no Plexo Core internals)', () => {
    const CORE_IMPORT_RE = /from\s+['"]@plexo\/(agent|db|queue|storage)(\/[^'"]*)?['"]/

    it('no packages/sdk source file imports @plexo/* core internals', () => {
        const files = walk(resolve(repoRoot, 'packages/sdk/src'))
        const offenders: string[] = []
        for (const f of files) {
            if (CORE_IMPORT_RE.test(readFileSync(f, 'utf8'))) offenders.push(rel(f))
        }
        expect(offenders, `SDK (Pex client) must stay a standalone shim. Offending files:\n${offenders.join('\n')}`).toEqual([])
    })
})

describe('Guard B — no app-specific domain drift in core intelligence', () => {
    // Apps that consume Plexo. Their names must not appear in the core
    // intelligence dirs (they belong in the connector/integration surface).
    const APP_TOKENS = ['fylo', 'fonto', 'frameforge', 'frame-forge', 'koforje', 'levio']
    const APP_RE = new RegExp(`(${APP_TOKENS.join('|')})`, 'i')

    // Domain-agnostic core intelligence surfaces. App names forbidden here.
    const CORE_DIRS = ['executor', 'planner', 'prompts', 'memory', 'providers'].map((d) =>
        resolve(repoRoot, 'packages/agent/src', d),
    )

    // Pre-existing drift the allowlist tolerates until extracted. Each entry
    // MUST currently drift (the minimality check below forces removal once a
    // file is cleaned). Phase 4b extracted the original 2 (Levio timezone +
    // calendar rule) → empty. Keep it empty: new drift must be fixed, not added.
    const KNOWN_DEBT = new Set<string>([])

    const scan = () => {
        const drifting: string[] = []
        for (const dir of CORE_DIRS) {
            for (const f of walk(dir)) {
                if (APP_RE.test(readFileSync(f, 'utf8'))) drifting.push(rel(f))
            }
        }
        return drifting
    }

    it('no NEW core-intelligence file references an app by name', () => {
        const newDrift = scan().filter((f) => !KNOWN_DEBT.has(f))
        expect(newDrift, `App-specific domain logic must not live in core intelligence (ADR 0001). New offenders:\n${newDrift.join('\n')}`).toEqual([])
    })

    it('KNOWN_DEBT allowlist stays minimal (no stale entries)', () => {
        const drifting = new Set(scan())
        const stale = [...KNOWN_DEBT].filter((f) => !drifting.has(f))
        expect(stale, `These files no longer drift — remove them from KNOWN_DEBT:\n${stale.join('\n')}`).toEqual([])
    })
})
