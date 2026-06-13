// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Phase M regression guard: the quality judge must stay OFF the executor's
 * user-facing return path. `executeTask` returns `qualityScore: null` and runs
 * the judge + its score-dependent consumers (memory / reflect / credit /
 * variant / score-patch) inside a detached `trackJudge()` block, so async and
 * queued task replies are never delayed by the 1–5-round judge ensemble
 * (~15–35s typical, up to ~60s).
 *
 * We do NOT boot `executeTask` here: it needs a full workspace fixture and
 * mocks of half the agent package (executor-timeout.test.ts makes the same
 * call and validates the building block instead). The judge block is inline in
 * `executeTask`, so there is no narrower functional seam — the structural
 * invariant is the building block. If a future edit re-inlines
 * `await judgeQuality` ahead of `return executionResult` (re-blocking the hot
 * path), these assertions break loudly.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const EXECUTOR_SRC = readFileSync(
    fileURLToPath(new URL('../executor/index.ts', import.meta.url)),
    'utf8',
)

// Scope every positional check to the executeTask body so the private
// `trackJudge()` *definition* earlier in the file cannot satisfy an ordering
// assertion by accident.
const executeTaskBody = EXECUTOR_SRC.slice(
    EXECUTOR_SRC.indexOf('export async function executeTask('),
)

describe('Phase M — quality judge stays off the executor return path', () => {
    it('locates the executeTask body', () => {
        expect(executeTaskBody.length).toBeGreaterThan(0)
    })

    it('invokes the judge inside a detached trackJudge() block', () => {
        expect(executeTaskBody).toContain('trackJudge((async () =>')
    })

    it('runs judgeQuality exactly once, and only after the detach is set up', () => {
        const judgeCalls = executeTaskBody.match(/await judgeQuality\(/g) ?? []
        expect(judgeCalls).toHaveLength(1)

        const trackIdx = executeTaskBody.indexOf('trackJudge((async () =>')
        const judgeIdx = executeTaskBody.indexOf('await judgeQuality(')
        expect(trackIdx).toBeGreaterThan(-1)
        expect(judgeIdx).toBeGreaterThan(trackIdx)
    })

    it('returns executionResult only after the judge block — the judge never blocks the return', () => {
        const judgeIdx = executeTaskBody.indexOf('await judgeQuality(')
        const returnIdx = executeTaskBody.lastIndexOf('return executionResult')
        expect(returnIdx).toBeGreaterThan(judgeIdx)
    })

    it('exposes the drain + dropped-counter API the detach relies on for graceful shutdown', () => {
        expect(EXECUTOR_SRC).toContain('export async function drainPendingJudges(')
        expect(EXECUTOR_SRC).toContain('export function getJudgeDroppedCount(')
    })
})
