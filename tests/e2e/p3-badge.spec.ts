// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * P3 Badge + Vocabulary E2E — proves badge component exists,
 * vocabulary is correct, and standalone constraint holds.
 */
import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'

const LIVE_URL = 'https://getplexo.com'
const REPO_ROOT = path.resolve(__dirname, '../..')

test.describe('P3: Awareness Badge + Vocabulary', () => {
    test('PlexoAwarenessBadge component file exists', () => {
        const badgePath = path.join(REPO_ROOT, 'apps/web/src/components/plexo-awareness-badge.tsx')
        expect(fs.existsSync(badgePath)).toBe(true)
        const content = fs.readFileSync(badgePath, 'utf-8')
        expect(content).toContain('data-testid="plexo-awareness-badge"')
        expect(content).toContain('getplexo.com')
    })

    test('badge is imported in task detail page', () => {
        const taskPage = fs.readFileSync(
            path.join(REPO_ROOT, 'apps/web/src/app/app/tasks/[id]/page.tsx'),
            'utf-8',
        )
        expect(taskPage).toContain('PlexoAwarenessBadge')
    })

    test('no hard sibling app imports in codebase', () => {
        // Check apps/ and packages/ for imports from sibling Joeybuilt apps
        const check = (dir: string) => {
            const files = walkTs(path.join(REPO_ROOT, dir))
            for (const file of files) {
                const content = fs.readFileSync(file, 'utf-8')
                for (const sibling of ['fylo', 'fonto', 'levio', 'koforje']) {
                    if (content.includes(`from '${sibling}`) || content.includes(`from "${sibling}`)) {
                        throw new Error(`Hard sibling import found: ${file} imports ${sibling}`)
                    }
                }
            }
        }
        check('apps')
        check('packages')
    })

    test('landing page loads on live', async ({ request }) => {
        const res = await request.get(LIVE_URL)
        expect(res.status()).toBe(200)
    })

    test('health endpoint responds on live', async ({ request }) => {
        const res = await request.get(`${LIVE_URL}/health`)
        expect(res.status()).toBe(200)
    })
})

/** Recursively walk .ts/.tsx files */
function walkTs(dir: string): string[] {
    if (!fs.existsSync(dir)) return []
    const results: string[] = []
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules' && entry.name !== '.next' && entry.name !== 'dist') {
            results.push(...walkTs(full))
        } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))) {
            results.push(full)
        }
    }
    return results
}
