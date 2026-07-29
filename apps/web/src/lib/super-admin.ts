// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Server-side super-admin check, mirroring the API's `isSuperAdminEmail`
 * (apps/api/src/middleware/better-auth.ts). Super-admin is derived purely
 * from the `SUPER_ADMIN_EMAILS` env list — no DB lookup. Used to gate
 * operator-only UI (e.g. the in-app updater) so normal users don't render
 * components that call super-admin-gated endpoints.
 *
 * Reads a non-public env var, so this must only run server-side.
 */
export function isSuperAdminEmail(email: string | null | undefined): boolean {
    if (!email) return false
    const raw = process.env.SUPER_ADMIN_EMAILS
    if (!raw) return false
    return raw.split(',').map((e) => e.trim().toLowerCase()).includes(email.toLowerCase())
}
