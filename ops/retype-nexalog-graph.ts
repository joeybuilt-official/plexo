#!/usr/bin/env npx tsx
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// P9c retro re-typing backfill for the Nexalog knowledge graph.
//
// Graphiti extracted ~3.8k entities as the bare generic `Entity` label (no
// custom entity_types were passed at ingest time). This script classifies each
// existing Entity node into Nexalog's PKMS taxonomy via a cheap LLM pass and
// writes the type back as a second node label + an `entity_type` property — so
// the graph explorer can colour/group/inspect by type. It is NON-destructive
// (no re-ingest, no node deletion) and idempotent (re-running re-SETs the same
// labels).
//
// Reads + writes go through the graphiti sidecar's /v1/graph/cypher (the write
// path takes the per-workspace lock). Classification goes through plexo-api's
// /api/v1/ai/complete. Run inside the plexo-api container, which has
// PLEXO_SERVICE_KEY + PLEXO_GRAPHITI_SIDECAR_URL in env.
//
// Usage:
//   npx tsx ops/retype-nexalog-graph.ts \
//     --graph-workspace <nexalog graph ws uuid> \
//     --inference-workspace <plexo ws uuid for the LLM> \
//     [--batch 40] [--limit 0] [--dry-run]

import { createHmac } from 'node:crypto'
import { parseArgs } from 'node:util'

const SIDECAR_URL = (process.env.PLEXO_GRAPHITI_SIDECAR_URL ?? 'http://localhost:8080').replace(/\/$/, '')
const PLEXO_API_URL = (process.env.PLEXO_API_INTERNAL_URL ?? 'http://localhost:3001').replace(/\/$/, '')
const SERVICE_KEY = process.env.PLEXO_SERVICE_KEY ?? ''

// Must match NEXALOG_ENTITY_TYPES in nexalog lib/plexo.ts (the forward-fix
// taxonomy). "Other" is the catch-all for entities that fit none — those get
// no type label so they stay the generic Entity.
const TAXONOMY: ReadonlyArray<{ name: string; description: string }> = [
    { name: 'Technology', description: 'A software technology, AI model, framework, protocol, API, library, or programming language.' },
    { name: 'Product', description: 'A consumer-facing app, tool, service, device, or hardware product.' },
    { name: 'Organization', description: 'A company, startup, team, institution, or named project/repository.' },
    { name: 'Person', description: 'An individual human, real or fictional.' },
    { name: 'Place', description: 'A physical or geographic location: city, country, venue, region, or address.' },
    { name: 'Concept', description: 'An abstract idea, method, technique, topic, or field of study.' },
    { name: 'CreativeWork', description: 'A discrete authored work: article, blog post, book, video, paper, podcast, or course.' },
    { name: 'Event', description: 'A time-bounded happening: a release, conference, launch, announcement, or incident.' },
]
const TYPE_NAMES = new Set(TAXONOMY.map((t) => t.name))
const LABEL_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function sign(body: string): { sig: string; ts: string } {
    return {
        sig: 'sha256=' + createHmac('sha256', SERVICE_KEY).update(body).digest('hex'),
        ts: new Date().toISOString(),
    }
}

async function cypher(workspaceId: string, query: string, params: Record<string, unknown> = {}): Promise<{ header: string[]; rows: unknown[][] }> {
    const body = JSON.stringify({ workspace_id: workspaceId, cypher: query, params })
    const { sig, ts } = sign(body)
    const res = await fetch(`${SIDECAR_URL}/v1/graph/cypher`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-App-Id': 'plexo-ops-retype',
            'X-Plexo-Timestamp': ts,
            'X-Plexo-Signature': sig,
        },
        body,
    })
    if (!res.ok) throw new Error(`sidecar cypher ${res.status}: ${await res.text()}`)
    return (await res.json()) as { header: string[]; rows: unknown[][] }
}

async function classify(
    inferenceWs: string,
    batch: Array<{ name: string; summary: string }>,
): Promise<string[]> {
    const list = batch
        .map((e, i) => `${i + 1}. ${e.name}${e.summary ? ` — ${e.summary.slice(0, 160)}` : ''}`)
        .join('\n')
    const taxonomyDoc = TAXONOMY.map((t) => `- ${t.name}: ${t.description}`).join('\n')
    const prompt =
        `Classify each item below into EXACTLY ONE of these knowledge-graph entity types:\n${taxonomyDoc}\n- Other: fits none of the above.\n\n` +
        `Items:\n${list}\n\n` +
        `Respond with ONLY a JSON array of ${batch.length} strings, one type per item in order, each being one of: ${[...TYPE_NAMES, 'Other'].join(', ')}. No prose, no markdown.`
    const reqBody = JSON.stringify({
        workspaceId: inferenceWs,
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 1024,
        taskType: 'classification',
    })
    const res = await fetch(`${PLEXO_API_URL}/api/v1/ai/complete`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${SERVICE_KEY}`,
            'X-App-Id': 'plexo-ops-retype',
        },
        body: reqBody,
    })
    if (!res.ok) throw new Error(`ai/complete ${res.status}: ${await res.text()}`)
    const text = ((await res.json()) as { text?: string }).text ?? ''
    const match = text.match(/\[[\s\S]*\]/)
    if (!match) throw new Error(`no JSON array in completion: ${text.slice(0, 200)}`)
    const parsed = JSON.parse(match[0]) as unknown[]
    return batch.map((_, i) => {
        const t = parsed[i]
        return typeof t === 'string' && TYPE_NAMES.has(t) && LABEL_RE.test(t) ? t : 'Other'
    })
}

async function main() {
    const { values } = parseArgs({
        options: {
            'graph-workspace': { type: 'string' },
            'inference-workspace': { type: 'string' },
            batch: { type: 'string', default: '40' },
            limit: { type: 'string', default: '0' },
            'dry-run': { type: 'boolean', default: false },
        },
        strict: true,
    })
    const graphWs = values['graph-workspace']?.trim()
    const inferenceWs = values['inference-workspace']?.trim()
    const batchSize = Math.max(1, Math.min(parseInt(values.batch ?? '40', 10) || 40, 100))
    const limit = parseInt(values.limit ?? '0', 10) || 0
    const dryRun = values['dry-run'] === true

    if (!SERVICE_KEY) throw new Error('PLEXO_SERVICE_KEY not set')
    if (!graphWs || !UUID_RE.test(graphWs)) throw new Error('--graph-workspace must be a UUID')
    if (!inferenceWs || !UUID_RE.test(inferenceWs)) throw new Error('--inference-workspace must be a UUID')

    // Pull untyped Entity nodes (no entity_type prop yet) so re-runs only touch
    // what's left. uuid + name + summary feed classification.
    const cap = limit > 0 ? `LIMIT ${limit}` : ''
    const read = await cypher(
        graphWs,
        `MATCH (n:Entity) WHERE n.entity_type IS NULL AND n.name IS NOT NULL ` +
            `RETURN n.uuid AS uuid, n.name AS name, n.summary AS summary ${cap}`,
    )
    const ui = read.header.indexOf('uuid')
    const ni = read.header.indexOf('name')
    const si = read.header.indexOf('summary')
    const nodes = read.rows
        .map((r) => ({ uuid: String(r[ui] ?? ''), name: String(r[ni] ?? ''), summary: r[si] != null ? String(r[si]) : '' }))
        .filter((n) => UUID_RE.test(n.uuid) && n.name)
    console.log(`untyped entities to classify: ${nodes.length} (batch ${batchSize}${dryRun ? ', DRY-RUN' : ''})`)
    if (nodes.length === 0) return

    // On a failed batch, leave those entities UNTYPED (entity_type stays NULL) so
    // a later rerun retries them — never bake a transient AI outage in as 'Other',
    // which the IS NULL guard would then skip forever. Light retry + an inter-batch
    // pause keep a 100-batch run from rate-limiting the inference workspace.
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
    const byType = new Map<string, string[]>()
    let done = 0
    let failed = 0
    for (let i = 0; i < nodes.length; i += batchSize) {
        const slice = nodes.slice(i, i + batchSize)
        let types: string[] | null = null
        for (let attempt = 0; attempt < 3 && types === null; attempt++) {
            try {
                types = await classify(inferenceWs, slice)
            } catch (e) {
                if (attempt === 2) {
                    console.warn(`batch @${i} classify failed after 3 tries (${(e as Error).message}); leaving untyped for a later rerun`)
                    failed += slice.length
                } else {
                    await sleep(2000 * (attempt + 1))
                }
            }
        }
        if (types !== null) {
            slice.forEach((n, j) => {
                const t = types![j] ?? 'Other'
                if (!byType.has(t)) byType.set(t, [])
                byType.get(t)!.push(n.uuid)
            })
        }
        done += slice.length
        if (done % 200 < batchSize) console.log(`  classified ${done}/${nodes.length}`)
        await sleep(400)
    }

    const summary = [...byType.entries()].map(([t, ids]) => `${t}:${ids.length}`).sort().join('  ')
    console.log(`classification: ${summary}`)
    if (dryRun) {
        console.log('dry-run — no writes')
        return
    }

    // Write one query per type (FalkorDB can't parameterize a label). Label is
    // whitelist-validated against the taxonomy before interpolation. "Other"
    // still gets the entity_type prop set (so re-runs skip it) but no label.
    let written = 0
    for (const [type, ids] of byType) {
        if (type === 'Other') {
            await cypher(graphWs, `MATCH (n:Entity) WHERE n.uuid IN $ids SET n.entity_type = 'Other'`, { ids })
            written += ids.length
            continue
        }
        if (!TYPE_NAMES.has(type) || !LABEL_RE.test(type)) continue
        await cypher(
            graphWs,
            `MATCH (n:Entity) WHERE n.uuid IN $ids SET n:${type}, n.entity_type = $t`,
            { ids, t: type },
        )
        written += ids.length
        console.log(`  SET ${type} on ${ids.length}`)
    }
    console.log(`done — typed ${written} entities${failed ? `; ${failed} left untyped (transient failures — rerun to retry)` : ''}`)
}

main().catch((err) => {
    console.error(err)
    process.exit(1)
})
