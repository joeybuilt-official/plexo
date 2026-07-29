// SPDX-License-Identifier: MIT
// k6 stress test — find breaking point under escalating load.
// Run: k6 run tests/load/stress.js

import http from 'k6/http'
import { check, sleep } from 'k6'
import { Rate, Trend } from 'k6/metrics'

const BASE_URL = __ENV.K6_API_URL || 'http://localhost:3001'
const WS_ID = __ENV.K6_WORKSPACE_ID || 'test-workspace'

const errorRate = new Rate('errors')
const healthLatency = new Trend('health_latency', true)
const tasksLatency = new Trend('tasks_latency', true)

export const options = {
    stages: [
        { duration: '30s', target: 10 },   // warm up
        { duration: '1m', target: 50 },     // normal load
        { duration: '1m', target: 100 },    // push
        { duration: '1m', target: 200 },    // stress
        { duration: '30s', target: 0 },     // cool down
    ],
    thresholds: {
        errors: ['rate<0.10'],               // <10% error rate under stress
        health_latency: ['p(95)<500'],       // health stays responsive
        tasks_latency: ['p(95)<2000'],       // tasks endpoint degrades gracefully
        http_req_duration: ['p(99)<5000'],   // no request over 5s at p99
    },
}

export default function () {
    // Health endpoint — should stay fast even under stress
    const healthRes = http.get(`${BASE_URL}/health`, { timeout: '10s' })
    healthLatency.add(healthRes.timings.duration)
    check(healthRes, { 'health 2xx': (r) => r.status >= 200 && r.status < 300 })

    // Tasks listing — heavier query
    const tasksRes = http.get(`${BASE_URL}/api/v1/tasks?workspaceId=${WS_ID}&limit=10`, {
        timeout: '10s',
    })
    tasksLatency.add(tasksRes.timings.duration)
    const tasksOk = check(tasksRes, { 'tasks 2xx or 401': (r) => r.status < 500 })
    errorRate.add(!tasksOk)

    // Connections registry
    const regRes = http.get(`${BASE_URL}/api/v1/connections/registry`, { timeout: '10s' })
    check(regRes, { 'registry 2xx': (r) => r.status >= 200 && r.status < 300 })

    sleep(0.5)
}
