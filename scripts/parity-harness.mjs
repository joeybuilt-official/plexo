#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// parity-harness.mjs — dogfood-gate parity harness (docs/plexo-plan.md "Dogfood gate").
// Measures the checklist rows that are measurable TODAY against a LIVE fabric API,
// and honestly reports the rest as BLOCKED (no execution yet) or MANUAL (operator
// judgment). Never fakes a row.
//
// Rows:
//   A file-edit-reliability  BLOCKED — needs D2 container jail (RefuseToolExecutor live)
//   B one-way-door-gates     measured — POST /sessions/:id/policy/evaluate deny/gate/allow
//   C mcp-tools-in-session   BLOCKED — needs D2 execution
//   D kill-and-resume        measured — lease + append N + simulated kill + cross-device replay
//   E context-handoff        MANUAL — operator judgment vs progress.md workflow
//   F cost-usage-visible     measured — usage events vs GET /sessions/:id/usage exact sums
//   G latency                measured — p50/p95 of create/append/replay/SSE-first-event
//
// Usage:
//   node scripts/parity-harness.mjs [--json]
//
// Against the local e2e stack (scripts/e2e-up.sh):
//   PLEXO_SERVICE_KEY=... PLEXO_USER_ID=<uuid> PLEXO_WORKSPACE_ID=<uuid> \
//     node scripts/parity-harness.mjs
//
// Env vars:
//   PLEXO_API_URL              default http://127.0.0.1:3001 (e2e stack)
//   PLEXO_SERVICE_KEY          REQUIRED — internal service key (X-Plexo-Service-Key path).
//                              PLEXO_TOKEN accepted as an alias.
//   PLEXO_USER_ID              REQUIRED — user UUID forwarded as X-Plexo-User-Id.
//                              For full coverage this user's email must be in the API's
//                              SUPER_ADMIN_EMAILS (device-token mint + drive grants are
//                              super-admin endpoints). Otherwise rows B/D/F/G SKIP.
//   PLEXO_WORKSPACE_ID         REQUIRED — workspace UUID for created sessions.
//   PLEXO_DEVICE_TOKEN         optional pre-minted drive-tier device token (identity A).
//   PLEXO_DEVICE_TOKEN_B       optional second device token (identity B). When absent the
//                              harness mints both via POST /fabric/tokens (super-admin).
//   PARITY_EVENT_COUNT         default 20, clamped 2..1000 — N events for row D (server
//                              replay caps at 1000 rows: session-fabric.repository.ts
//                              listEvents .limit(1000))
//   PARITY_LATENCY_ITERS       default 8  — K iterations per latency op
//   PARITY_LATENCY_BUDGET_MS   default 1500 — p95 budget per non-SSE op
//   PARITY_SSE_BUDGET_MS       default 4000 — p95 budget for SSE first-event (server polls @2s)
//   PARITY_INCLUDE_LLM         default off — set 1 to also measure POST /sessions/:id/drive
//                              (plan/verify; costs real tokens + latency)
//
// Auth model (per apps/api/src/routes/sessions.ts + fabric-security.ts):
//   - every /api/v1 fabric route sits behind requireAuth → we use the trusted
//     internal path: X-Plexo-Service-Key + X-Plexo-User-Id (sets req.user).
//   - mutating fabric routes (events append, lease claim/renew, drive) ALSO need
//     x-fabric-device-token; drive-tier ops need a per-session grant keyed by the
//     token's participantId (POST /sessions/:id/grant, super-admin).
//   - lease identity = runnerId in the BODY (not bound to the token), but we use two
//     distinct tokens + runnerIds for a faithful two-device simulation.
//
// Cleanup: there is no DELETE /sessions route. Sessions created here are titled
// "parity-harness <iso-ts> <row>" and left behind; ids are listed in the summary.
// Leases are released on exit.
//
// Exit code: 0 unless a MEASURED row FAILED. SKIP/BLOCKED/MANUAL are not failures.

const API = (process.env.PLEXO_API_URL ?? 'http://127.0.0.1:3001').replace(/\/+$/, '')
const V1 = `${API}/api/v1`
const SERVICE_KEY = process.env.PLEXO_SERVICE_KEY ?? process.env.PLEXO_TOKEN ?? ''
const USER_ID = process.env.PLEXO_USER_ID ?? ''
const WORKSPACE_ID = process.env.PLEXO_WORKSPACE_ID ?? ''
const EVENT_COUNT = Math.min(1000, Math.max(2, parseInt(process.env.PARITY_EVENT_COUNT ?? '20', 10) || 20))
const LAT_ITERS = Math.max(2, parseInt(process.env.PARITY_LATENCY_ITERS ?? '8', 10) || 8)
const LAT_BUDGET = parseInt(process.env.PARITY_LATENCY_BUDGET_MS ?? '1500', 10) || 1500
const SSE_BUDGET = parseInt(process.env.PARITY_SSE_BUDGET_MS ?? '4000', 10) || 4000
const INCLUDE_LLM = process.env.PARITY_INCLUDE_LLM === '1'
const JSON_OUT = process.argv.includes('--json')

const RUN_TS = new Date().toISOString()
const RUN_TAG = RUN_TS.replace(/[:.]/g, '-')

const rows = []
const createdSessionIds = []
const openLeases = [] // {sessionId, runnerId, token}

function addRow(id, title, status, detail, metrics) {
    rows.push({ id, title, status, detail, ...(metrics ? { metrics } : {}) })
}

const userHeaders = {
    'content-type': 'application/json',
    'x-plexo-service-key': SERVICE_KEY,
    'x-plexo-user-id': USER_ID,
}

async function api(method, path, { body, deviceToken, base = V1 } = {}) {
    const headers = { ...userHeaders }
    if (deviceToken) headers['x-fabric-device-token'] = deviceToken
    const started = performance.now()
    const res = await fetch(`${base}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    const ms = performance.now() - started
    let json = null
    try { json = text ? JSON.parse(text) : null } catch { /* non-JSON body */ }
    return { status: res.status, json, ms }
}

function fail(msg) { const e = new Error(msg); e.parity = true; return e }
function skip(msg) { const e = fail(msg); e.skip = true; return e }
function expect(cond, msg) { if (!cond) throw fail(msg) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function percentile(samples, p) {
    const s = [...samples].sort((a, b) => a - b)
    return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]
}

function decodeJwtPayload(token) {
    try {
        const b64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
        return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'))
    } catch { return null }
}

// ── Provisioning ────────────────────────────────────────────────

async function createSession(rowLabel) {
    const r = await api('POST', '/sessions', {
        body: { workspaceId: WORKSPACE_ID, title: `parity-harness ${RUN_TS} ${rowLabel}` },
    })
    expect(r.status === 201, `POST /sessions → ${r.status} ${JSON.stringify(r.json)}`)
    createdSessionIds.push(r.json.id)
    return r.json
}

async function mintDeviceToken(suffix) {
    const r = await api('POST', '/fabric/tokens', {
        body: {
            deviceId: `parity-dev-${suffix}`,
            participantId: `parity-part-${suffix}-${RUN_TAG}`,
            workspaceId: WORKSPACE_ID,
            tier: 'drive',
            ttlSec: 3600,
        },
    })
    if (r.status === 403) return { forbidden: true }
    if (r.status !== 201) {
        const e = fail(`POST /fabric/tokens → ${r.status} ${JSON.stringify(r.json)}`)
        e.status = r.status
        throw e
    }
    return { token: r.json.token }
}

async function grantDrive(sessionId, participantId) {
    const r = await api('POST', `/sessions/${sessionId}/grant`, { body: { participantId, ttlSec: 3600 } })
    if (r.status === 403) return false
    expect(r.status === 200, `POST /sessions/:id/grant → ${r.status} ${JSON.stringify(r.json)}`)
    return true
}

async function registerRunner(id) {
    const r = await api('POST', '/runners', { body: { id, workspaceId: WORKSPACE_ID, backend: 'generic' } })
    expect(r.status === 200, `POST /runners → ${r.status} ${JSON.stringify(r.json)}`)
}

async function claimLease(sessionId, runnerId, token, ttlMs) {
    return api('POST', `/sessions/${sessionId}/lease`, { deviceToken: token, body: { runnerId, ttlMs } })
}

async function appendEvent(sessionId, runnerId, token, fields) {
    return api('POST', `/sessions/${sessionId}/events`, {
        deviceToken: token,
        body: { runnerId, kind: 'message', actorType: 'agent', payload: {}, ...fields },
    })
}

async function releaseLease(sessionId, runnerId) {
    try { await api('DELETE', `/sessions/${sessionId}/lease`, { body: { runnerId } }) } catch { /* best effort */ }
}

// ── Row B: one-way-door gates ───────────────────────────────────

async function rowB(dev) {
    const s = await createSession('row-B')
    const cases = [
        { cmd: 'sudo apt-get install x', want: 'deny' },
        { cmd: 'rm -rf /srv/data', want: 'deny' },
        { cmd: 'git push origin main', want: 'gate' },
        { cmd: 'echo hello', want: 'allow' },
    ]
    const results = []
    for (const c of cases) {
        const r = await api('POST', `/sessions/${s.id}/policy/evaluate`, {
            deviceToken: dev.a.token,
            body: { action: { tool: 'bash', cmd: c.cmd }, tier: 'drive' },
        })
        expect(r.status === 200, `policy/evaluate → ${r.status} ${JSON.stringify(r.json)}`)
        results.push({ cmd: c.cmd, want: c.want, got: r.json.decision, ruleId: r.json.ruleId ?? null })
    }
    const bad = results.filter((r) => r.got !== r.want)
    expect(bad.length === 0, `policy decisions mismatched: ${JSON.stringify(bad)}`)
    addRow('B', 'one-way-door gates fire', 'PASS',
        `${results.length}/${results.length} policy decisions matched (deny/deny/gate/allow)`, { cases: results })
}

// ── Row D: kill-and-resume across devices ───────────────────────

async function rowD(dev) {
    const s = await createSession('row-D')
    const okA = await grantDrive(s.id, dev.a.participantId)
    const okB = await grantDrive(s.id, dev.b.participantId)
    if (!okA || !okB) throw skip('drive grant denied (PLEXO_USER_ID not super-admin) — lease ops unavailable')

    const runnerA = `parity-runner-a-${RUN_TAG}`
    const runnerB = `parity-runner-b-${RUN_TAG}`
    await registerRunner(runnerA) // leases.runner_id FKs runners.id — register first
    await registerRunner(runnerB)

    // Device A claims with a comfortable TTL, appends N events.
    let r = await claimLease(s.id, runnerA, dev.a.token, 60_000)
    expect(r.status === 201, `A lease claim → ${r.status} ${JSON.stringify(r.json)}`)
    openLeases.push({ sessionId: s.id, runnerId: runnerA })

    for (let i = 1; i <= EVENT_COUNT; i += 1) {
        r = await appendEvent(s.id, runnerA, dev.a.token, { payload: { parity: true, n: i } })
        expect(r.status === 201, `A append #${i} → ${r.status} ${JSON.stringify(r.json)}`)
        expect(r.json.seq === i, `A append #${i} got seq ${r.json.seq}`)
    }

    // Simulated kill: A renews down to a short TTL, then goes silent. No release —
    // the lease must expire on its own, exactly like a crashed device.
    r = await api('POST', `/sessions/${s.id}/lease/renew`, {
        deviceToken: dev.a.token, body: { runnerId: runnerA, ttlMs: 1500 },
    })
    expect(r.status === 200, `A lease renew(short) → ${r.status} ${JSON.stringify(r.json)}`)
    const killedAt = performance.now()

    // Single-writer invariant: B must be REJECTED while A's lease is live.
    r = await claimLease(s.id, runnerB, dev.b.token, 30_000)
    const singleWriterHeld = r.status === 409 && r.json?.error?.code === 'LEASE_HELD'
    // (If >1.5s elapsed before this call landed, the lease may already be expired —
    // treat a 201 here as inconclusive-but-not-fatal and record it.)
    let takeoverMs = null
    if (r.status !== 201) {
        expect(singleWriterHeld, `B claim while A live → ${r.status} ${JSON.stringify(r.json)} (expected 409 LEASE_HELD)`)
        // Poll until the dead device's lease expires and B wins.
        const deadline = performance.now() + 15_000
        for (;;) {
            await sleep(300)
            r = await claimLease(s.id, runnerB, dev.b.token, 30_000)
            if (r.status === 201) break
            expect(r.status === 409, `B claim poll → ${r.status} ${JSON.stringify(r.json)}`)
            expect(performance.now() < deadline, 'B never acquired the lease within 15s of simulated kill')
        }
    }
    takeoverMs = Math.round(performance.now() - killedAt)
    openLeases.push({ sessionId: s.id, runnerId: runnerB })

    // Zero context loss: full replay from seq 0 on the "new device".
    r = await api('GET', `/sessions/${s.id}/events?sinceSeq=0`)
    expect(r.status === 200, `replay → ${r.status}`)
    const items = r.json.items
    expect(items.length === EVENT_COUNT, `replay returned ${items.length} events, expected ${EVENT_COUNT}`)
    for (let i = 0; i < EVENT_COUNT; i += 1) {
        expect(items[i].seq === i + 1, `seq gap: index ${i} has seq ${items[i].seq}`)
        expect(items[i].payload?.n === i + 1, `payload mismatch at seq ${i + 1}`)
    }

    // Resumability: B appends the next event with a contiguous seq.
    r = await appendEvent(s.id, runnerB, dev.b.token, { payload: { parity: true, n: EVENT_COUNT + 1, resumedBy: 'B' } })
    expect(r.status === 201 && r.json.seq === EVENT_COUNT + 1,
        `B resume append → ${r.status} seq=${r.json?.seq} (expected seq ${EVENT_COUNT + 1})`)

    const distinctTokens = dev.a.token !== dev.b.token
    const distinctParticipants = dev.a.participantId !== dev.b.participantId
    addRow('D', 'kill-and-resume across devices, zero context loss', 'PASS',
        `${EVENT_COUNT} events appended by device A, simulated kill (no release), device B ` +
        `${singleWriterHeld ? 'correctly rejected while lease live, then ' : ''}took over in ${takeoverMs}ms, ` +
        `replayed all ${EVENT_COUNT} events seq-contiguous 1..${EVENT_COUNT}, resumed at seq ${EVENT_COUNT + 1}` +
        (distinctTokens ? '' : ' (single shared device token — runnerId-level separation only)'),
        { eventCount: EVENT_COUNT, singleWriterRejection: singleWriterHeld, takeoverMs, distinctTokens, distinctParticipants })
}

// ── Row F: cost/usage visible ───────────────────────────────────

async function rowF(dev) {
    const s = await createSession('row-F')
    if (!(await grantDrive(s.id, dev.a.participantId))) throw skip('drive grant denied (PLEXO_USER_ID not super-admin) — lease ops unavailable')
    const runnerId = `parity-runner-f-${RUN_TAG}`
    await registerRunner(runnerId)
    let r = await claimLease(s.id, runnerId, dev.a.token, 60_000)
    expect(r.status === 201, `lease claim → ${r.status} ${JSON.stringify(r.json)}`)
    openLeases.push({ sessionId: s.id, runnerId })

    const usageEvents = [
        { model: 'parity-model-a', provider: 'parity', tokensIn: 100, tokensOut: 20, costUsd: 0.01 },
        { model: 'parity-model-a', provider: 'parity', tokensIn: 50, tokensOut: 5, costUsd: 0.0025 },
        { model: 'parity-model-b', provider: 'parity', tokensIn: 1000, tokensOut: 300, costUsd: 0.15 },
        {}, // no usage fields — must NOT count toward eventCount
        { tokensIn: 7 }, // usage without model — counts in totals, not in byModel
    ]
    for (const u of usageEvents) {
        r = await appendEvent(s.id, runnerId, dev.a.token, u)
        expect(r.status === 201, `usage append → ${r.status} ${JSON.stringify(r.json)}`)
    }

    r = await api('GET', `/sessions/${s.id}/usage`)
    expect(r.status === 200, `GET usage → ${r.status}`)
    const u = r.json
    const bearing = usageEvents.filter((e) => e.model || e.tokensIn || e.tokensOut || e.costUsd)
    const sum = (k) => bearing.reduce((acc, e) => acc + (e[k] ?? 0), 0)
    const close = (a, b) => Math.abs(a - b) < 1e-9

    expect(u.tokensIn === sum('tokensIn'), `usage.tokensIn=${u.tokensIn}, expected ${sum('tokensIn')}`)
    expect(u.tokensOut === sum('tokensOut'), `usage.tokensOut=${u.tokensOut}, expected ${sum('tokensOut')}`)
    expect(close(u.costUsd, sum('costUsd')), `usage.costUsd=${u.costUsd}, expected ${sum('costUsd')}`)
    expect(u.eventCount === bearing.length, `usage.eventCount=${u.eventCount}, expected ${bearing.length}`)

    const byModel = Object.fromEntries(u.byModel.map((m) => [m.model, m]))
    expect(u.byModel.length === 2, `byModel has ${u.byModel.length} groups, expected 2`)
    expect(byModel['parity-model-a']?.tokensIn === 150 && byModel['parity-model-a']?.tokensOut === 25
        && close(byModel['parity-model-a']?.costUsd, 0.0125) && byModel['parity-model-a']?.eventCount === 2,
        `byModel[parity-model-a] wrong: ${JSON.stringify(byModel['parity-model-a'])}`)
    expect(byModel['parity-model-b']?.tokensIn === 1000 && close(byModel['parity-model-b']?.costUsd, 0.15),
        `byModel[parity-model-b] wrong: ${JSON.stringify(byModel['parity-model-b'])}`)
    expect(u.byModel[0].model === 'parity-model-b', 'byModel not sorted by costUsd desc')

    addRow('F', 'cost/usage visible', 'PASS',
        `totals exact (tokensIn ${u.tokensIn}, tokensOut ${u.tokensOut}, costUsd ${u.costUsd}, ` +
        `eventCount ${u.eventCount}) + byModel breakdown matches, cost-desc ordering verified`,
        { usage: u })
}

// ── Row G: latency ──────────────────────────────────────────────

async function sseFirstEventMs(sessionId, sinceSeq, fireAppend) {
    const ctrl = new AbortController()
    const res = await fetch(`${V1}/sessions/${sessionId}/events/stream?sinceSeq=${sinceSeq}`, {
        headers: userHeaders, signal: ctrl.signal,
    })
    expect(res.status === 200, `SSE connect → ${res.status}`)
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    const started = performance.now()
    await fireAppend()
    let buf = ''
    const readLoop = async () => {
        for (;;) {
            const { done, value } = await reader.read()
            if (done) throw fail('SSE stream closed before event arrived')
            buf += dec.decode(value, { stream: true })
            for (const line of buf.split('\n')) {
                if (line.startsWith('data: ')) return performance.now() - started
            }
        }
    }
    let timer
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
            ctrl.abort()
            reject(fail('SSE first event not received within 20s'))
        }, 20_000)
    })
    const loop = readLoop()
    loop.catch(() => { /* losing branch after abort — already surfaced via race */ })
    try {
        return await Promise.race([loop, timeout])
    } finally {
        clearTimeout(timer)
        ctrl.abort()
    }
}

async function rowG(dev) {
    const s = await createSession('row-G')
    if (!(await grantDrive(s.id, dev.a.participantId))) throw skip('drive grant denied (PLEXO_USER_ID not super-admin) — lease ops unavailable')
    const runnerId = `parity-runner-g-${RUN_TAG}`
    await registerRunner(runnerId)
    let r = await claimLease(s.id, runnerId, dev.a.token, 300_000)
    expect(r.status === 201, `lease claim → ${r.status} ${JSON.stringify(r.json)}`)
    openLeases.push({ sessionId: s.id, runnerId })

    const samples = { sessionCreate: [], eventAppend: [], replay: [], sseFirstEvent: [] }

    for (let i = 0; i < LAT_ITERS; i += 1) {
        const c = await api('POST', '/sessions', {
            body: { workspaceId: WORKSPACE_ID, title: `parity-harness ${RUN_TS} latency-${i}` },
        })
        expect(c.status === 201, `latency session create → ${c.status}`)
        createdSessionIds.push(c.json.id)
        samples.sessionCreate.push(c.ms)
    }

    let seq = 0
    for (let i = 0; i < LAT_ITERS; i += 1) {
        const a = await appendEvent(s.id, runnerId, dev.a.token, { payload: { latency: i } })
        expect(a.status === 201, `latency append → ${a.status}`)
        seq = a.json.seq
        samples.eventAppend.push(a.ms)
    }

    for (let i = 0; i < LAT_ITERS; i += 1) {
        const g = await api('GET', `/sessions/${s.id}/events?sinceSeq=0`)
        expect(g.status === 200, `latency replay → ${g.status}`)
        samples.replay.push(g.ms)
    }

    // SSE: server polls the log every 2s, so budget these separately.
    const sseIters = Math.min(3, LAT_ITERS)
    for (let i = 0; i < sseIters; i += 1) {
        const ms = await sseFirstEventMs(s.id, seq + 1, async () => {
            const a = await appendEvent(s.id, runnerId, dev.a.token, { payload: { sse: i } })
            expect(a.status === 201, `sse append → ${a.status}`)
            seq = a.json.seq
        })
        samples.sseFirstEvent.push(ms)
    }

    const metrics = {}
    const failures = []
    for (const [op, arr] of Object.entries(samples)) {
        const budget = op === 'sseFirstEvent' ? SSE_BUDGET : LAT_BUDGET
        const p50 = Math.round(percentile(arr, 50))
        const p95 = Math.round(percentile(arr, 95))
        metrics[op] = { iters: arr.length, p50Ms: p50, p95Ms: p95, budgetP95Ms: budget, pass: p95 <= budget }
        if (p95 > budget) failures.push(`${op} p95 ${p95}ms > ${budget}ms`)
    }

    if (INCLUDE_LLM) {
        const d = await api('POST', `/sessions/${s.id}/drive`, {
            deviceToken: dev.a.token,
            body: { goal: 'Parity harness: produce a one-step plan that echoes "parity-ok".', runnerId },
        })
        metrics.llmDrive = { status: d.status, ms: Math.round(d.ms), note: 'informational — not budget-gated' }
    }

    const detail = Object.entries(metrics)
        .map(([op, m]) => `${op} p50=${m.p50Ms ?? m.ms}ms p95=${m.p95Ms ?? '-'}ms`).join(', ')
        + '. NOTE: the 1.5x-vs-Claude-Code comparison needs an operator-supplied Claude Code baseline; '
        + 'PASS here means p95 under the configured budget only.'
    expect(failures.length === 0, `latency over budget: ${failures.join('; ')} (${detail})`)
    addRow('G', 'latency within 1.5x (budget proxy)', 'PASS', detail, metrics)
}

// ── Main ────────────────────────────────────────────────────────

async function main() {
    // Static rows — honest non-measurements.
    addRow('A', 'file-edit reliability >= Claude Code (20-task sample)', 'BLOCKED',
        'Not measurable: fabric runner is execution-free (RefuseToolExecutor); file edits require the D2 container jail (ADR 0050).')
    addRow('C', 'MCP tools callable in-session', 'BLOCKED',
        'Not measurable: tool execution is refused by design until D2 lands.')
    addRow('E', 'context/handoff >= progress.md workflow', 'MANUAL',
        'Subjective — operator judgment. Suggested drill: run a real task via the fabric, kill mid-task, resume on another device, compare against the progress.md workflow.')

    const missing = []
    if (!SERVICE_KEY) missing.push('PLEXO_SERVICE_KEY (or PLEXO_TOKEN)')
    if (!USER_ID) missing.push('PLEXO_USER_ID')
    if (!WORKSPACE_ID) missing.push('PLEXO_WORKSPACE_ID')
    if (missing.length > 0) {
        for (const [id, title] of [['B', 'one-way-door gates fire'], ['D', 'kill-and-resume across devices, zero context loss'], ['F', 'cost/usage visible'], ['G', 'latency within 1.5x (budget proxy)']]) {
            addRow(id, title, 'SKIP', `missing env: ${missing.join(', ')}`)
        }
        return finish()
    }

    // Reachability.
    try {
        const h = await fetch(`${API}/health`)
        expect(h.ok, `GET /health → ${h.status}`)
    } catch (e) {
        for (const [id, title] of [['B', 'one-way-door gates fire'], ['D', 'kill-and-resume across devices, zero context loss'], ['F', 'cost/usage visible'], ['G', 'latency within 1.5x (budget proxy)']]) {
            addRow(id, title, 'FAIL', `API unreachable at ${API}: ${e.message}`)
        }
        return finish()
    }

    // Device identities: two tokens (distinct participantId) = two devices.
    const dev = { a: {}, b: {} }
    const envA = process.env.PLEXO_DEVICE_TOKEN
    const envB = process.env.PLEXO_DEVICE_TOKEN_B
    let mintForbidden = false
    try {
        if (envA) {
            dev.a.token = envA
            dev.b.token = envB ?? envA // same token still works: lease identity is runnerId
        } else {
            const a = await mintDeviceToken('a')
            const b = a.forbidden ? a : await mintDeviceToken('b')
            if (a.forbidden || b.forbidden) mintForbidden = true
            else { dev.a.token = a.token; dev.b.token = b.token }
        }
        if (!mintForbidden) {
            dev.a.participantId = decodeJwtPayload(dev.a.token)?.participantId
            dev.b.participantId = decodeJwtPayload(dev.b.token)?.participantId
        }
    } catch (e) {
        const authShaped = e.status === 401 || e.status === 403 || /CF_ACCESS|cloudflare access/i.test(e.message ?? '')
        const status = authShaped ? 'SKIP' : 'FAIL'
        const detail = `device-token provisioning failed: ${e.parity ? e.message : (e.stack ?? e.message)}`
        for (const [id, title] of [['B', 'one-way-door gates fire'], ['D', 'kill-and-resume across devices, zero context loss'], ['F', 'cost/usage visible'], ['G', 'latency within 1.5x (budget proxy)']]) {
            addRow(id, title, status, detail)
        }
        return finish()
    }

    if (mintForbidden) {
        const why = 'PLEXO_USER_ID is not a super-admin (SUPER_ADMIN_EMAILS): cannot mint device tokens '
            + 'or issue per-session drive grants. Supply PLEXO_DEVICE_TOKEN(+_B) AND run as super-admin, '
            + 'or add the user email to SUPER_ADMIN_EMAILS on the API.'
        addRow('B', 'one-way-door gates fire', 'SKIP', why)
        addRow('D', 'kill-and-resume across devices, zero context loss', 'SKIP', why)
        addRow('F', 'cost/usage visible', 'SKIP', why)
        addRow('G', 'latency within 1.5x (budget proxy)', 'SKIP', why)
        return finish()
    }

    for (const [id, title, run] of [
        ['B', 'one-way-door gates fire', () => rowB(dev)],
        ['D', 'kill-and-resume across devices, zero context loss', () => rowD(dev)],
        ['F', 'cost/usage visible', () => rowF(dev)],
        ['G', 'latency within 1.5x (budget proxy)', () => rowG(dev)],
    ]) {
        try {
            await run()
        } catch (e) {
            if (e.skip) addRow(id, title, 'SKIP', e.message)
            else addRow(id, title, 'FAIL', e.parity ? e.message : `unexpected error: ${e.stack ?? e.message}`)
        }
    }

    for (const l of openLeases) await releaseLease(l.sessionId, l.runnerId)
    return finish()
}

function finish() {
    const order = { A: 0, B: 1, C: 2, D: 3, E: 4, F: 5, G: 6 }
    rows.sort((a, b) => order[a.id] - order[b.id])
    const counts = { PASS: 0, FAIL: 0, BLOCKED: 0, MANUAL: 0, SKIP: 0 }
    for (const r of rows) counts[r.status] += 1
    const summary = {
        apiUrl: API,
        timestamp: RUN_TS,
        counts,
        createdSessionIds,
        cleanup: createdSessionIds.length > 0
            ? `no DELETE /sessions route exists; ${createdSessionIds.length} session(s) titled "parity-harness ${RUN_TS} *" were left behind`
            : 'nothing created',
        exitCode: counts.FAIL > 0 ? 1 : 0,
    }

    if (JSON_OUT) {
        console.log(JSON.stringify({ rows, summary }, null, 2))
    } else {
        const pad = (s, n) => String(s).padEnd(n)
        console.log(`parity-harness ${RUN_TS} → ${API}`)
        console.log('─'.repeat(100))
        for (const r of rows) {
            console.log(`${pad(r.status, 8)} ${pad(r.id, 3)} ${pad(r.title, 55)}`)
            console.log(`         ${' '.repeat(3)} ${r.detail}`)
        }
        console.log('─'.repeat(100))
        console.log(`PASS ${counts.PASS} · FAIL ${counts.FAIL} · BLOCKED ${counts.BLOCKED} · MANUAL ${counts.MANUAL} · SKIP ${counts.SKIP}`)
        console.log(summary.cleanup)
    }
    process.exitCode = summary.exitCode
}

main().catch((e) => {
    console.error(`parity-harness fatal: ${e.stack ?? e.message}`)
    process.exitCode = 1
})
