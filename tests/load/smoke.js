/**
 * k6 smoke test — Plexo API
 *
 * Run: k6 run tests/load/smoke.js
 *      K6_API_URL=http://your-server:3001 k6 run tests/load/smoke.js
 *
 * Thresholds:
 * - /health: p95 < 100ms
 * - /api/v1/tasks: p95 < 500ms
 * - Error rate: < 1%
 */
import http from 'k6/http'
import { check, sleep } from 'k6'
import { Rate, Trend } from 'k6/metrics'

const errorRate = new Rate('errors')
const healthLatency = new Trend('health_latency', true)
const tasksLatency = new Trend('tasks_latency', true)

const BASE_URL = __ENV.K6_API_URL || 'http://localhost:3001'

// Test workspace — use a real UUID if you have one
const WORKSPACE_ID = __ENV.K6_WORKSPACE_ID || '00000000-0000-0000-0000-000000000001'

export const options = {
    stages: [
        { duration: '10s', target: 5 },   // ramp up
        { duration: '30s', target: 10 },  // steady load
        { duration: '10s', target: 0 },   // ramp down
    ],
    thresholds: {
        'http_req_duration{name:health}': ['p(95)<100'],
        'http_req_duration{name:tasks_list}': ['p(95)<500'],
        'http_req_duration{name:registry}': ['p(95)<300'],
        'errors': ['rate<0.01'],
    },
}

export default function () {
    // ── Health check ──────────────────────────────────────────
    const healthRes = http.get(`${BASE_URL}/health`, {
        tags: { name: 'health' },
    })
    const healthOk = check(healthRes, {
        'health status 200': (r) => r.status === 200,
        'health body ok': (r) => r.json('status') === 'ok',
    })
    errorRate.add(!healthOk)
    healthLatency.add(healthRes.timings.duration)

    // ── Task list ─────────────────────────────────────────────
    const tasksRes = http.get(
        `${BASE_URL}/api/v1/tasks?workspaceId=${WORKSPACE_ID}&limit=10`,
        { tags: { name: 'tasks_list' } }
    )
    check(tasksRes, {
        'tasks list 200 or 400': (r) => r.status === 200 || r.status === 400,
    })
    tasksLatency.add(tasksRes.timings.duration)

    // ── Registry list ─────────────────────────────────────────
    const regRes = http.get(`${BASE_URL}/api/v1/connections/registry`, {
        tags: { name: 'registry' },
    })
    const regOk = check(regRes, {
        'registry 200': (r) => r.status === 200,
        'registry has items': (r) => r.json('total') > 0,
    })
    errorRate.add(!regOk)

    // ── Rate limit test (expect 429 at high volume) ───────────
    // This is informational — not an error if it fires at high VU counts

    sleep(0.5)
}
