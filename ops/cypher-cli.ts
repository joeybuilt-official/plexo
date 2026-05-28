#!/usr/bin/env npx ts-node
// SPDX-License-Identifier: AGPL-3.0-only
// Multi-graph FalkorDB cypher runner. Read-only — rejects mutation keywords.
// Usage:
//   npx ts-node ops/cypher-cli.ts --graph plexo:test --cypher "MATCH (n) RETURN count(n)"
//   npx ts-node ops/cypher-cli.ts --all-graphs  --cypher "MATCH (n) RETURN count(n)"

import { createHmac } from 'node:crypto'
import { parseArgs } from 'node:util'

const SIDECAR_URL = (process.env.PLEXO_GRAPHITI_SIDECAR_URL ?? 'http://localhost:8000').replace(/\/$/, '')
const SERVICE_KEY = process.env.PLEXO_SERVICE_KEY ?? ''

const MUTATION_RE = /\b(CREATE|DELETE|MERGE|SET|REMOVE)\b/i

function sign(body: string): { sig: string; ts: string } {
    const sig = 'sha256=' + createHmac('sha256', SERVICE_KEY).update(body).digest('hex')
    const ts = new Date().toISOString()
    return { sig, ts }
}

async function postCypher(graph: string, cypher: string): Promise<unknown> {
    const body = JSON.stringify({ graph_name: graph, query: cypher })
    const { sig, ts } = sign(body)
    const res = await fetch(`${SIDECAR_URL}/v1/graph/cypher`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-App-Id': 'plexo-ops',
            'X-Plexo-Timestamp': ts,
            'X-Plexo-Signature': sig,
        },
        body,
    })
    if (!res.ok) throw new Error(`Sidecar returned ${res.status}: ${await res.text()}`)
    return res.json()
}

async function getGraphNames(): Promise<string[]> {
    const body = ''
    const { sig, ts } = sign(body)
    const res = await fetch(`${SIDECAR_URL}/v1/schema/registry`, {
        headers: {
            'X-App-Id': 'plexo-ops',
            'X-Plexo-Timestamp': ts,
            'X-Plexo-Signature': sig,
        },
    })
    if (!res.ok) throw new Error(`Registry returned ${res.status}: ${await res.text()}`)
    const data = await res.json() as { graphs?: string[] }
    return data.graphs ?? []
}

async function main() {
    const { values } = parseArgs({
        options: {
            graph: { type: 'string' },
            'all-graphs': { type: 'boolean', default: false },
            cypher: { type: 'string' },
        },
        strict: true,
    })

    const cypher = values.cypher?.trim()
    if (!cypher) {
        console.error('Error: --cypher <query> is required')
        process.exit(1)
    }

    if (MUTATION_RE.test(cypher)) {
        console.error('Error: query contains a mutation keyword (CREATE, DELETE, MERGE, SET, REMOVE). Only read-only queries are allowed.')
        process.exit(1)
    }

    if (!SERVICE_KEY) {
        console.error('Error: PLEXO_SERVICE_KEY env var is not set')
        process.exit(1)
    }

    const allGraphs = values['all-graphs']
    const graphs: string[] = allGraphs
        ? await getGraphNames()
        : values.graph
            ? [values.graph]
            : []

    if (graphs.length === 0) {
        console.error('Error: provide --graph <name> or --all-graphs')
        process.exit(1)
    }

    for (const graph of graphs) {
        console.log(`\n── ${graph} ──`)
        try {
            const result = await postCypher(graph, cypher)
            console.log(JSON.stringify(result, null, 2))
        } catch (err) {
            console.error(`  Error: ${err instanceof Error ? err.message : String(err)}`)
        }
    }
}

main().catch((err) => {
    console.error(err)
    process.exit(1)
})
