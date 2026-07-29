// SPDX-License-Identifier: MIT
// k6 soak test — sustained load for 2 hours, detect memory leaks and connection pool exhaustion.
// Run: k6 run tests/load/soak.js

import http from 'k6/http'
import { check, sleep } from 'k6'
import { Rate, Trend } from 'k6/metrics'

const BASE_URL = __ENV.K6_API_URL || 'http://localhost:3001'
const WS_ID = __ENV.K6_WORKSPACE_ID || 'test-workspace'

const errorRate = new Rate('errors')
const latencyTrend = new Trend('soak_latency', true)

export const options = {
    stages: [
        { duration: '2m', target: 20 },     // ramp up
        { duration: '116m', target: 20 },    // sustain for ~2 hours
        { duration: '2m', target: 0 },       // ramp down
    ],
    thresholds: {
        errors: ['rate<0.01'],               // <1% error rate over 2 hours
        soak_latency: ['p(95)<1000'],        // p95 stays under 1s
        http_req_duration: ['p(99)<3000'],   // no creep over time
    },
}

export default function () {
    const healthRes = http.get(`${BASE_URL}/health`, { timeout: '10s' })
    check(healthRes, { 'health ok': (r) => r.status === 200 })
    latencyTrend.add(healthRes.timings.duration)

    const tasksRes = http.get(`${BASE_URL}/api/v1/tasks?workspaceId=${WS_ID}&limit=5`, {
        timeout: '10s',
    })
    const ok = check(tasksRes, { 'tasks ok': (r) => r.status < 500 })
    errorRate.add(!ok)
    latencyTrend.add(tasksRes.timings.duration)

    // Introspection snapshot — exercises Redis cache + 12+ DB queries
    const introRes = http.get(`${BASE_URL}/api/v1/workspaces/${WS_ID}/introspect`, {
        timeout: '10s',
    })
    check(introRes, { 'introspect ok': (r) => r.status < 500 })
    latencyTrend.add(introRes.timings.duration)

    sleep(2) // low rate — we're testing duration, not throughput
}
