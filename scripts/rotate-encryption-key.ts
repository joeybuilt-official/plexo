#!/usr/bin/env tsx
// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * SEC-029 — Encryption key rotation script.
 *
 * Re-encrypts all workspace credentials from ENCRYPTION_SECRET_OLD to
 * ENCRYPTION_SECRET_NEW. Each workspace is updated in its own transaction
 * so a partial failure doesn't corrupt unrelated workspaces.
 *
 * Encrypted locations:
 *   1. workspaces.settings.vault  → per-provider apiKey fields
 *   2. workspaces.settings.voice  → deepgramApiKey
 *   3. workspaces.settings.search → braveApiKey
 *   4. installed_connections.credentials → { encrypted: "enc:..." }
 *
 * MANUAL OPERATION — requires downtime or read-only mode while running.
 *
 * Usage:
 *   ENCRYPTION_SECRET_OLD=xxx ENCRYPTION_SECRET_NEW=yyy \
 *     npx tsx scripts/rotate-encryption-key.ts [--dry-run]
 */

import { createHmac, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { db, sql } from '@plexo/db'

// ── Args ─────────────────────────────────────────────────────────────────────

const OLD_SECRET = process.env.ENCRYPTION_SECRET_OLD
const NEW_SECRET = process.env.ENCRYPTION_SECRET_NEW
const DRY_RUN = process.argv.includes('--dry-run')

if (!OLD_SECRET || !NEW_SECRET) {
    console.error('ERROR: ENCRYPTION_SECRET_OLD and ENCRYPTION_SECRET_NEW must both be set')
    process.exit(1)
}
if (OLD_SECRET === NEW_SECRET) {
    console.error('ERROR: Old and new secrets are identical — nothing to do')
    process.exit(1)
}

// ── Crypto helpers (self-contained — no env dependency) ──────────────────────

const ALGORITHM = 'aes-256-gcm'

function b64url(buf: Buffer): string {
    return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

function fromB64url(s: string): Buffer {
    const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '=='.slice(0, (4 - (s.length % 4)) % 4)
    return Buffer.from(padded, 'base64')
}

function deriveKey(secret: string, workspaceId: string): Buffer {
    return createHmac('sha256', secret).update(workspaceId).digest()
}

function decryptWith(token: string, secret: string, workspaceId: string): string {
    const raw = token.startsWith('enc:') ? token.slice(4) : token
    const parts = raw.split('.')
    if (parts.length !== 3) throw new Error('Invalid encrypted token format')
    const [ivStr, ciphertextStr, authTagStr] = parts
    const key = deriveKey(secret, workspaceId)
    const iv = fromB64url(ivStr!)
    const ciphertext = fromB64url(ciphertextStr!)
    const authTag = fromB64url(authTagStr!)
    const decipher = createDecipheriv(ALGORITHM, key, iv)
    decipher.setAuthTag(authTag)
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}

function encryptWith(plaintext: string, secret: string, workspaceId: string): string {
    const key = deriveKey(secret, workspaceId)
    const iv = randomBytes(12)
    const cipher = createCipheriv(ALGORITHM, key, iv)
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    const authTag = cipher.getAuthTag()
    return `enc:${b64url(iv)}.${b64url(ciphertext)}.${b64url(authTag)}`
}

/** Detect encrypted values — both enc:-prefixed and legacy (iv.ct.tag without prefix). */
function looksEncrypted(v: string): boolean {
    if (v.startsWith('enc:')) return true
    // Legacy: three base64url segments separated by dots
    const parts = v.split('.')
    return parts.length === 3 && parts.every(p => /^[A-Za-z0-9_-]+$/.test(p))
}

function reEncrypt(token: string, workspaceId: string): string {
    const plaintext = decryptWith(token, OLD_SECRET!, workspaceId)
    return encryptWith(plaintext, NEW_SECRET!, workspaceId)
}

// ── Stats ────────────────────────────────────────────────────────────────────

let totalWorkspaces = 0
let rotatedVault = 0
let rotatedVoice = 0
let rotatedSearch = 0
let rotatedConnections = 0
const failures: { workspaceId: string; location: string; error: string }[] = []

// ── Rotate workspace settings ────────────────────────────────────────────────

type VaultBlob = Record<string, { apiKey?: string; [k: string]: unknown }>

async function rotateWorkspaceSettings(wsId: string, settings: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    let changed = false
    const updated = { ...settings }

    // 1. Vault — providers' apiKey fields
    const vault = (settings.vault ?? {}) as VaultBlob
    const newVault: VaultBlob = {}
    for (const [providerKey, entry] of Object.entries(vault)) {
        const out = { ...entry }
        if (out.apiKey && typeof out.apiKey === 'string' && looksEncrypted(out.apiKey)) {
            try {
                out.apiKey = reEncrypt(out.apiKey, wsId)
                rotatedVault++
                changed = true
            } catch (err) {
                failures.push({ workspaceId: wsId, location: `vault.${providerKey}.apiKey`, error: String(err) })
            }
        }
        newVault[providerKey] = out
    }
    updated.vault = newVault

    // 2. Voice — deepgramApiKey
    const voice = (settings.voice ?? {}) as Record<string, unknown>
    if (voice.deepgramApiKey && typeof voice.deepgramApiKey === 'string' && looksEncrypted(voice.deepgramApiKey)) {
        try {
            const newVoice = { ...voice, deepgramApiKey: reEncrypt(voice.deepgramApiKey as string, wsId) }
            updated.voice = newVoice
            rotatedVoice++
            changed = true
        } catch (err) {
            failures.push({ workspaceId: wsId, location: 'voice.deepgramApiKey', error: String(err) })
        }
    }

    // 3. Search — braveApiKey
    const search = (settings.search ?? {}) as Record<string, unknown>
    if (search.braveApiKey && typeof search.braveApiKey === 'string' && looksEncrypted(search.braveApiKey)) {
        try {
            const newSearch = { ...search, braveApiKey: reEncrypt(search.braveApiKey as string, wsId) }
            updated.search = newSearch
            rotatedSearch++
            changed = true
        } catch (err) {
            failures.push({ workspaceId: wsId, location: 'search.braveApiKey', error: String(err) })
        }
    }

    // 4. Legacy aiProviders blob (pre-vault migration)
    const legacy = (settings.aiProviders ?? {}) as { providers?: Record<string, { apiKey?: string; [k: string]: unknown }> }
    if (legacy.providers) {
        let legacyChanged = false
        const newProviders: Record<string, unknown> = {}
        for (const [pk, pe] of Object.entries(legacy.providers)) {
            const out = { ...pe }
            if (out.apiKey && typeof out.apiKey === 'string' && looksEncrypted(out.apiKey)) {
                try {
                    out.apiKey = reEncrypt(out.apiKey, wsId)
                    rotatedVault++
                    legacyChanged = true
                } catch (err) {
                    failures.push({ workspaceId: wsId, location: `aiProviders.${pk}.apiKey`, error: String(err) })
                }
            }
            newProviders[pk] = out
        }
        if (legacyChanged) {
            updated.aiProviders = { ...legacy, providers: newProviders }
            changed = true
        }
    }

    return changed ? updated : null
}

// ── Rotate installed_connections ─────────────────────────────────────────────

async function rotateConnections(wsId: string): Promise<void> {
    const result = await db.execute(sql`
        SELECT id, credentials
        FROM installed_connections
        WHERE workspace_id = ${wsId}::uuid
    `)
    const rows = (result as unknown as { rows: any[] }).rows
        ?? (Array.isArray(result) ? result as any[] : [])

    for (const row of rows) {
        const creds = row.credentials as Record<string, unknown> | null
        if (!creds || typeof creds !== 'object') continue

        const encryptedValue = creds.encrypted
        if (!encryptedValue || typeof encryptedValue !== 'string') continue
        if (!looksEncrypted(encryptedValue)) continue

        try {
            const newEncrypted = reEncrypt(encryptedValue, wsId)
            if (!DRY_RUN) {
                await db.execute(sql`
                    UPDATE installed_connections
                    SET credentials = jsonb_set(credentials, '{encrypted}', to_jsonb(${newEncrypted}::text))
                    WHERE id = ${row.id}::uuid
                `)
            }
            rotatedConnections++
        } catch (err) {
            failures.push({ workspaceId: wsId, location: `connection:${row.id}`, error: String(err) })
        }
    }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
    console.log(`\n=== Encryption Key Rotation ${DRY_RUN ? '(DRY RUN)' : ''} ===\n`)

    // Load all workspaces
    const wsResult = await db.execute(sql`SELECT id, settings FROM workspaces ORDER BY id`)
    const wsRows = (wsResult as unknown as { rows: any[] }).rows
        ?? (Array.isArray(wsResult) ? wsResult as any[] : [])

    totalWorkspaces = wsRows.length
    console.log(`Found ${totalWorkspaces} workspace(s) to process\n`)

    for (const ws of wsRows) {
        const wsId = ws.id as string
        const settings = (ws.settings ?? {}) as Record<string, unknown>
        console.log(`[${wsId}] Processing...`)

        try {
            // Rotate settings fields
            const updatedSettings = await rotateWorkspaceSettings(wsId, settings)
            if (updatedSettings && !DRY_RUN) {
                await db.execute(sql`
                    UPDATE workspaces
                    SET settings = ${JSON.stringify(updatedSettings)}::jsonb
                    WHERE id = ${wsId}::uuid
                `)
            }

            // Rotate installed_connections for this workspace
            await rotateConnections(wsId)

            console.log(`[${wsId}] Done`)
        } catch (err) {
            console.error(`[${wsId}] FAILED:`, err)
            failures.push({ workspaceId: wsId, location: 'workspace-level', error: String(err) })
        }
    }

    // ── Report ───────────────────────────────────────────────────────────────

    console.log('\n=== Rotation Summary ===')
    console.log(`Workspaces processed: ${totalWorkspaces}`)
    console.log(`Vault apiKeys rotated: ${rotatedVault}`)
    console.log(`Voice keys rotated: ${rotatedVoice}`)
    console.log(`Search keys rotated: ${rotatedSearch}`)
    console.log(`Connection credentials rotated: ${rotatedConnections}`)

    if (failures.length > 0) {
        console.error(`\nFAILURES (${failures.length}):`)
        for (const f of failures) {
            console.error(`  [${f.workspaceId}] ${f.location}: ${f.error}`)
        }
        process.exit(1)
    }

    if (DRY_RUN) {
        console.log('\nDry run complete — no changes written.')
    } else {
        console.log('\nAll credentials rotated successfully.')
        console.log('Next step: update ENCRYPTION_SECRET env var to the new value and restart all services.')
    }
}

main().catch((err) => {
    console.error('Fatal error:', err)
    process.exit(1)
}).finally(() => {
    // Give postgres-js time to close connections
    setTimeout(() => process.exit(0), 500)
})
