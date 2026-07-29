// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Verifies the home-page gate matches the contract documented in
 * `lib/feature-flags.ts`:
 *
 *   anon  + flag off → redirect /login
 *   authed + flag off → redirect /app
 *   authed + flag on  → redirect /app
 *   anon  + flag on   → render landing (no redirect)
 *
 * `redirect()` from `next/navigation` throws a sentinel error to
 * unwind the request, so we treat each redirect as a thrown call.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

class RedirectError extends Error {
    target: string
    constructor(target: string) {
        super(`NEXT_REDIRECT:${target}`)
        this.target = target
    }
}

const redirectMock = vi.fn((target: string) => {
    throw new RedirectError(target)
})

const getSessionMock = vi.fn<() => Promise<{ user?: { id: string } } | null>>()

vi.mock('next/navigation', () => ({
    redirect: (target: string) => redirectMock(target),
}))

vi.mock('next/headers', () => ({
    headers: async () => new Headers(),
}))

vi.mock('@web/lib/auth', () => ({
    getAuth: () => ({
        api: {
            getSession: (..._args: unknown[]) => getSessionMock(),
        },
    }),
}))

// The landing page imports a bag of marketing-only React components.
// Stub them out so the module loads in a node test environment.
vi.mock('@web/components/plexo-logo', () => ({ PlexoMark: () => null }))
vi.mock('@web/components/landing-client', () => ({
    ScrollReveal: () => null,
    CopyButton: () => null,
}))
vi.mock('@web/components/landing-theme-toggle', () => ({
    LandingThemeToggle: () => null,
}))
vi.mock('next/link', () => ({ default: () => null }))

const ENV_KEYS = ['PLEXO_MARKETING_ENABLED', 'SKIP_LANDING'] as const

describe('home page gate', () => {
    let envSnapshot: Record<string, string | undefined>

    beforeEach(() => {
        redirectMock.mockClear()
        getSessionMock.mockReset()
        envSnapshot = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
        for (const k of ENV_KEYS) delete process.env[k]
        vi.resetModules()
    })

    afterEach(() => {
        for (const k of ENV_KEYS) {
            const v = envSnapshot[k]
            if (v === undefined) delete process.env[k]
            else process.env[k] = v
        }
    })

    async function loadPage() {
        const mod = await import('../page')
        return mod.default as () => Promise<unknown>
    }

    it('anon visitor + marketing OFF → redirects to /login (self-host default)', async () => {
        getSessionMock.mockResolvedValue(null)
        const Page = await loadPage()
        await expect(Page()).rejects.toMatchObject({ target: '/login' })
        expect(redirectMock).toHaveBeenCalledWith('/login')
    })

    it('authed visitor + marketing OFF → redirects to /app', async () => {
        getSessionMock.mockResolvedValue({ user: { id: 'u1' } })
        const Page = await loadPage()
        await expect(Page()).rejects.toMatchObject({ target: '/app' })
        expect(redirectMock).toHaveBeenCalledWith('/app')
    })

    it('authed visitor + marketing ON → still redirects to /app', async () => {
        process.env.PLEXO_MARKETING_ENABLED = 'true'
        getSessionMock.mockResolvedValue({ user: { id: 'u1' } })
        const Page = await loadPage()
        await expect(Page()).rejects.toMatchObject({ target: '/app' })
    })

    it('anon visitor + marketing ON → renders landing (no redirect)', async () => {
        process.env.PLEXO_MARKETING_ENABLED = 'true'
        getSessionMock.mockResolvedValue(null)
        const Page = await loadPage()
        await expect(Page()).resolves.toBeDefined()
        expect(redirectMock).not.toHaveBeenCalled()
    })

    it('legacy SKIP_LANDING=true overrides marketing ON → redirects to /login', async () => {
        process.env.PLEXO_MARKETING_ENABLED = 'true'
        process.env.SKIP_LANDING = 'true'
        getSessionMock.mockResolvedValue(null)
        const Page = await loadPage()
        await expect(Page()).rejects.toMatchObject({ target: '/login' })
    })
})
