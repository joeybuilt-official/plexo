// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Phase 3c smoke test for the plexo-graphiti sidecar.
 *
 * Prereqs (operator runs once, NOT done in this session):
 *   1. `docker compose --profile graphiti build graphiti-sidecar`
 *   2. `docker compose --profile graphiti up -d graphiti-sidecar`
 *   3. apps/api running w/ PLEXO_SERVICE_KEY set so the inference shim is reachable
 *      from the sidecar at PLEXO_INFERENCE_BASE (default http://plexo-api:8080/api/inference)
 *
 * Run:
 *   PLEXO_SERVICE_KEY=<...> \
 *   GRAPHITI_SIDECAR_URL=http://127.0.0.1:8090 \
 *   pnpm -C packages/graphiti-bridge exec tsx scripts/smoke.ts
 *
 * Exits 0 on success; non-zero on any failure. Prints each step's outcome so
 * a CI run produces a useful log.
 */

import { GraphitiClient } from '../src/index.js'

const SERVICE_KEY = process.env.PLEXO_SERVICE_KEY
if (!SERVICE_KEY) {
    console.error('FAIL: PLEXO_SERVICE_KEY env var is required')
    process.exit(2)
}

const BASE_URL = process.env.GRAPHITI_SIDECAR_URL ?? 'http://127.0.0.1:8090'
const WORKSPACE_ID = process.env.SMOKE_WORKSPACE_ID ?? '00000000-0000-0000-0000-00000000beef'

const client = new GraphitiClient({
    baseUrl: BASE_URL,
    serviceKey: SERVICE_KEY,
    appId: 'graphiti-sidecar-smoke',
})

console.log(`smoke: sidecar=${BASE_URL} workspace=${WORKSPACE_ID}`)

console.log('\n[1/3] /v1/health …')
const health = await client.health()
if (!health?.ok) {
    console.error('FAIL: /v1/health returned non-ok:', health)
    process.exit(1)
}
console.log('  →', health)

// Canonical probe text per phase-11-design.md §"Probe text". Five
// unambiguous subject-verb-object triples that any reasonable LLM should
// extract; gives the smoke (and the future Phase-11 schema-compat probe)
// a meaningful regression signal beyond just "did the boundary respond".
const factText = [
    `Phase 3c smoke marker — ${new Date().toISOString()}.`,
    'Alice manages Bob.',
    'Bob reports to Alice.',
    'Alice works at Acme.',
    'Acme is headquartered in Austin.',
    'Bob lives in Austin.',
].join(' ')

console.log('\n[2/3] addEpisode …')
const added = await client.addEpisode({
    workspaceId: WORKSPACE_ID,
    name: 'phase-3c-smoke',
    content: factText,
    sourceDescription: 'phase-3c-smoke',
    episodeType: 'message',
    // A3 S1 — every plexo-side call site allocates a plexo_memory_id.
    sourceMetadata: { plexo_memory_id: globalThis.crypto.randomUUID() },
})
if (!added) {
    console.error('FAIL: addEpisode returned null (network or HMAC error). Check sidecar logs + service key.')
    process.exit(1)
}
console.log('  →', added)
if (!added.episodeId) {
    console.error('FAIL: addEpisode succeeded but episode_id is null — Graphiti returned no episode')
    process.exit(1)
}

// Brief pause — Graphiti's extraction is async-ish (LLM round-trips) and the
// sidecar single-worker loop may still be wrapping up dedup before search
// indexes are visible. 1s is conservative for a local smoke run.
await new Promise((r) => setTimeout(r, 1000))

console.log('\n[3/3] search("Austin") …')
const found = await client.search({ workspaceId: WORKSPACE_ID, query: 'Austin', numResults: 5 })
if (!found) {
    console.error('FAIL: search returned null')
    process.exit(1)
}
console.log(`  → ${found.results.length} result(s)`)
for (const r of found.results.slice(0, 3)) {
    console.log(`    - ${r.uuid}  fact="${r.fact}"  valid_at=${r.valid_at}`)
}
if (found.results.length === 0) {
    console.error('FAIL: search returned 0 results — Graphiti extracted no facts from the smoke episode, OR search index is empty')
    process.exit(1)
}

console.log('\nOK — Phase 3c smoke passed')
