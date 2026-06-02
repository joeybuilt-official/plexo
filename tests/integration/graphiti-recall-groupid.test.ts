// Regression: hyphenated-UUID group_id must not 500 the Graphiti /v1/search
// path. Pre-fix, graphiti-core's _build_falkor_fulltext_query injected the raw
// UUID into a RediSearch query → "Syntax error ... near <uuid8>" → bridge
// returns null. This asserts a real round-trip returns a result object (200),
// not null (500). Env-guarded like the other live-service integration tests:
// runs only when a sidecar + service key are present.
import { describe, it, expect } from 'vitest'
import { GraphitiClient } from '@plexo/graphiti-bridge'

const SIDECAR = process.env.GRAPHITI_SIDECAR_URL ?? process.env.PLEXO_GRAPHITI_SIDECAR_URL
const KEY = process.env.PLEXO_SERVICE_KEY

// A hyphenated UUID is the trigger — a non-hyphenated group_id never reproduced it.
const HYPHENATED_WS = '00000000-0000-4000-8000-0000000000aa'

describe.skipIf(!SIDECAR || !KEY)('Graphiti recall — hyphenated UUID group_id (regression)', () => {
    const client = new GraphitiClient({ baseUrl: SIDECAR!, serviceKey: KEY!, appId: 'recall-regression' })

    it('search() returns a result object, not null (no RediSearch syntax error)', async () => {
        const res = await client.search({ workspaceId: HYPHENATED_WS, query: 'memory', numResults: 3 })
        // Pre-fix: sidecar 500s → bridge maps to null. Post-fix: parses → object (0+ hits ok).
        expect(res).not.toBeNull()
        expect(Array.isArray(res?.results)).toBe(true)
    })
})
