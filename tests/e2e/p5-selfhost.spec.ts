// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * P5 Self-Hosted Packaging E2E — proves the Docker instance boots,
 * health endpoint responds, and install artifacts exist.
 */
import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'

const API = process.env.E2E_API_URL ?? 'http://localhost:3001'
const REPO_ROOT = path.resolve(__dirname, '../..')

test.describe('P5: Self-Hosted Packaging', () => {
    test('health endpoint returns 200 with all services ok', async ({ request }) => {
        // In local dev the API is on :3001, hit /health directly.
        // In Docker/production, Caddy routes /api/* → api:3001, so /api/v1/health
        // is the safe universal path.
        const isDirect = API.includes('localhost') || API.includes('127.0.0.1')
        const healthPath = isDirect ? `${API}/health` : `${API}/api/v1/health`
        const res = await request.get(healthPath)
        expect(res.status()).toBe(200)
        const body = await res.json()
        expect(body.status).toBe('ok')
        expect(body.services.postgres.ok).toBe(true)
        expect(body.services.redis.ok).toBe(true)
    })

    test('.env.example exists and has required vars', () => {
        const envExample = fs.readFileSync(path.join(REPO_ROOT, '.env.example'), 'utf-8')
        expect(envExample).toContain('DATABASE_URL')
        expect(envExample).toContain('ENCRYPTION_SECRET')
        expect(envExample).toContain('AUTH_SECRET')
    })

    test('docker-compose.yml exists with required services', () => {
        const compose = fs.readFileSync(path.join(REPO_ROOT, 'docker-compose.yml'), 'utf-8')
        expect(compose).toContain('postgres')
        expect(compose).toContain('redis')
        expect(compose).toContain('api')
        expect(compose).toContain('web')
        expect(compose).toContain('migrate')
        expect(compose).toContain('healthcheck')
    })

    test('install.sh exists and is executable', () => {
        const installPath = path.join(REPO_ROOT, 'scripts', 'install.sh')
        expect(fs.existsSync(installPath)).toBe(true)
        const stats = fs.statSync(installPath)
        // Check executable bit (owner)
        expect(stats.mode & 0o100).toBeTruthy()
    })

    test('self-update.sh exists and is executable', () => {
        const updatePath = path.join(REPO_ROOT, 'scripts', 'self-update.sh')
        expect(fs.existsSync(updatePath)).toBe(true)
        const stats = fs.statSync(updatePath)
        expect(stats.mode & 0o100).toBeTruthy()
    })
})
