#!/usr/bin/env npx ts-node
// SPDX-License-Identifier: AGPL-3.0-only
// Single-workspace FalkorDB cypher runner. Read-only — rejects mutation keywords.
// Usage:
//   npx ts-node ops/cypher-cli.ts --workspace <workspaceId> --cypher "MATCH (n) RETURN count(n)"

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

async function postCypher(workspaceId: string, cypher: string): Promise<unknown> {
    const body = JSON.stringify({ workspace_id: workspaceId, cypher, params: {} })
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

async function main() {
    const { values } = parseArgs({
        options: {
            workspace: { type: 'string' },
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

    const workspaceId = values.workspace?.trim()
    if (!workspaceId) {
        console.error('Error: --workspace <workspaceId> is required')
        process.exit(1)
    }

    console.log(`\n── ${workspaceId} ──`)
    const result = await postCypher(workspaceId, cypher)
    console.log(JSON.stringify(result, null, 2))
}

main().catch((err) => {
    console.error(err)
    process.exit(1)
})
