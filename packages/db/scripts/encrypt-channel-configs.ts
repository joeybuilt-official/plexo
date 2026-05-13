// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Phase O / ADR 0010 — encrypt-existing channel.config sensitive keys.
 *
 * Idempotent + reentrant: rows already encrypted (`enc:` prefix on each
 * sensitive value) are no-ops. Crash-safe — re-running picks up where it
 * left off.
 *
 * Invoked from migrate.sh after drizzle:
 *   pnpm --filter @plexo/db tsx scripts/encrypt-channel-configs.ts
 *
 * Reuses the same crypto helpers used by the API (apps/api/src/crypto.ts).
 * Requires ENCRYPTION_SECRET env var.
 */

import { db, eq } from '../src/index.js'
import { channels } from '../src/index.js'
import { createHmac, createCipheriv, randomBytes } from 'node:crypto'

// Same per-channel-type sensitive-key map as apps/api/src/lib/channel-config-crypto.ts.
// Duplicated here to keep the migration script standalone (no cross-package import
// from the api package which would couple the db package to api at build time).
const SENSITIVE: Record<string, ReadonlySet<string>> = {
    twilio: new Set(['authToken', 'accountSid']),
    telegram: new Set(['token', 'bot_token']),
    slack: new Set(['signingSecret', 'token', 'webhook', 'webhookUrl', 'webhook_url']),
    discord: new Set(['webhook', 'webhookUrl', 'webhook_url']),
    gmail: new Set(),
    whatsapp: new Set(),
    signal: new Set(),
    matrix: new Set(),
}

function deriveKey(workspaceId: string): Buffer {
    const root = process.env.ENCRYPTION_SECRET
    if (!root) throw new Error('ENCRYPTION_SECRET not set — cannot encrypt')
    return createHmac('sha256', root).update(workspaceId).digest()
}

function b64url(buf: Buffer): string {
    return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

function encrypt(plaintext: string, workspaceId: string): string {
    const key = deriveKey(workspaceId)
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    return `enc:${b64url(iv)}.${b64url(ct)}.${b64url(tag)}`
}

function isEncrypted(v: unknown): boolean {
    return typeof v === 'string' && v.startsWith('enc:')
}

async function main(): Promise<void> {
    // Sentinel encrypt to verify ENCRYPTION_SECRET is set BEFORE iterating rows.
    encrypt('sentinel', '00000000-0000-0000-0000-000000000000')

    const rows = await db.select({
        id: channels.id,
        workspaceId: channels.workspaceId,
        type: channels.type,
        config: channels.config,
    }).from(channels)

    let scanned = 0
    let updated = 0
    let alreadyEncrypted = 0
    let noSensitive = 0

    for (const row of rows) {
        scanned++
        const sensitive = SENSITIVE[row.type] ?? new Set()
        if (sensitive.size === 0) { noSensitive++; continue }
        const cfg = (row.config ?? {}) as Record<string, unknown>
        const next: Record<string, unknown> = { ...cfg }
        let touched = false
        for (const k of Object.keys(cfg)) {
            if (!sensitive.has(k)) continue
            const v = cfg[k]
            if (typeof v !== 'string' || v.length === 0) continue
            if (isEncrypted(v)) continue
            next[k] = encrypt(v, row.workspaceId)
            touched = true
        }
        if (!touched) { alreadyEncrypted++; continue }
        await db.update(channels).set({ config: next }).where(eq(channels.id, row.id))
        updated++
        console.log(`encrypted: channel=${row.id} type=${row.type} keys=[${Object.keys(cfg).filter(k => sensitive.has(k)).join(',')}]`)
    }

    console.log(JSON.stringify({
        scanned, updated, alreadyEncrypted, noSensitive,
        msg: 'encrypt-channel-configs.ts complete',
    }))
}

main().catch((err) => {
    console.error('encrypt-channel-configs.ts FAILED:', err)
    process.exit(1)
})
