// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Token encryption — AES-256-GCM with a random IV per encryption.
 *
 * Key derivation: HMAC-SHA256(<root secret>, workspaceId) so each workspace
 * gets a unique derived key from one root secret.
 *
 * Round-5 Phase 8 (ADR 0003) — key-versioning + read-side rotation support:
 *
 *   Ciphertext formats (all components base64url):
 *     v1 (legacy):  `enc:iv.ct.tag`
 *     v2:           `enc:v2:<keyId>.iv.ct.tag`   (keyId identifies the root secret)
 *
 *   Keyring: ENCRYPTION_SECRET (current) + optional ENCRYPTION_SECRET_PREVIOUS
 *   (retiring). Reads:
 *     - v2 tokens select the root secret by keyId from the keyring.
 *     - v1/legacy tokens (no keyId) try EVERY keyring secret in turn — GCM's
 *       auth tag means only the correct key decrypts — so a secret can be
 *       rotated (new=current, old=previous) without orphaning legacy rows.
 *   Writes default to v1 (byte-identical to pre-Phase-8). Set
 *   `PLEXO_ENC_WRITE_V2=1` to write v2 (the Deploy-2 flip, after read-compat is
 *   verified in prod — pre-mortem #2). ⚠ One-way door: once v2 rows exist, the
 *   keyring MUST retain the secret whose keyId wrote them.
 */
import { createHmac, createHash, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const ALGORITHM = 'aes-256-gcm'

interface KeyringEntry { keyId: string; secret: string }

/** Stable, non-secret-leaking identifier for a root secret (8 hex chars). */
function keyIdFor(secret: string): string {
    return createHash('sha256').update('plexo-enc-keyid:' + secret).digest('hex').slice(0, 8)
}

/** Current + previous root secrets, for read-side rotation support. */
function keyring(): KeyringEntry[] {
    const out: KeyringEntry[] = []
    const cur = process.env.ENCRYPTION_SECRET
    if (cur) out.push({ keyId: keyIdFor(cur), secret: cur })
    const prev = process.env.ENCRYPTION_SECRET_PREVIOUS
    if (prev && prev !== cur) out.push({ keyId: keyIdFor(prev), secret: prev })
    return out
}

function currentSecret(): string {
    const rootKey = process.env.ENCRYPTION_SECRET
    if (!rootKey) throw new Error('ENCRYPTION_SECRET not set — add to .env (see .env.example) — cannot encrypt credentials')
    return rootKey
}

function deriveKeyFrom(secret: string, workspaceId: string): Buffer {
    return createHmac('sha256', secret).update(workspaceId).digest()
}

function b64url(buf: Buffer): string {
    return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

function fromB64url(s: string): Buffer {
    const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '=='.slice(0, (4 - (s.length % 4)) % 4)
    return Buffer.from(padded, 'base64')
}

// SEC-029: Rotation script → scripts/rotate-encryption-key.ts

function encryptWith(key: Buffer, plaintext: string): { iv: Buffer; ct: Buffer; tag: Buffer } {
    const iv = randomBytes(12) // 96-bit IV for GCM
    const cipher = createCipheriv(ALGORITHM, key, iv)
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    return { iv, ct, tag }
}

export function encrypt(plaintext: string, workspaceId: string): string {
    const secret = currentSecret()
    // Deploy-2 flip (env): write versioned v2 tagged with the current keyId.
    if (process.env.PLEXO_ENC_WRITE_V2 === '1') {
        const { iv, ct, tag } = encryptWith(deriveKeyFrom(secret, workspaceId), plaintext)
        return `enc:v2:${keyIdFor(secret)}.${b64url(iv)}.${b64url(ct)}.${b64url(tag)}`
    }
    // Default: legacy v1 format (unchanged).
    const { iv, ct, tag } = encryptWith(deriveKeyFrom(secret, workspaceId), plaintext)
    return `enc:${b64url(iv)}.${b64url(ct)}.${b64url(tag)}`
}

function decryptWith(key: Buffer, ivStr: string, ctStr: string, tagStr: string): string {
    const decipher = createDecipheriv(ALGORITHM, key, fromB64url(ivStr))
    decipher.setAuthTag(fromB64url(tagStr))
    return Buffer.concat([decipher.update(fromB64url(ctStr)), decipher.final()]).toString('utf8')
}

export function decrypt(token: string, workspaceId: string, _caller?: string): string {
    // Stabilization: emit credential access event (best-effort, non-blocking)
    try {
        const { recordCredentialAccess } = require('./lib/metrics')
        recordCredentialAccess(workspaceId)
    } catch { /* metrics not loaded — non-fatal */ }

    // Strip the enc: prefix; also accept legacy tokens without it
    const raw = token.startsWith('enc:') ? token.slice(4) : token

    // v2: `v2:<keyId>.iv.ct.tag` — select the root secret by keyId.
    if (raw.startsWith('v2:')) {
        const rest = raw.slice(3)
        const firstDot = rest.indexOf('.')
        if (firstDot < 1) throw new Error('Invalid encrypted token format (v2 keyId)')
        const kid = rest.slice(0, firstDot)
        const parts = rest.slice(firstDot + 1).split('.')
        if (parts.length !== 3) throw new Error('Invalid encrypted token format (v2 payload)')
        const entry = keyring().find((k) => k.keyId === kid)
        if (!entry) throw new Error(`No encryption key in keyring for keyId ${kid}`)
        return decryptWith(deriveKeyFrom(entry.secret, workspaceId), parts[0]!, parts[1]!, parts[2]!)
    }

    // Legacy v1: `iv.ct.tag` (no keyId). Try every keyring secret — only the
    // correct key passes GCM auth — so a rotated secret still reads old rows.
    const parts = raw.split('.')
    if (parts.length !== 3) throw new Error('Invalid encrypted token format')
    const ring = keyring()
    if (ring.length === 0) throw new Error('ENCRYPTION_SECRET not set — cannot decrypt credentials')
    let lastErr: unknown
    for (const entry of ring) {
        try {
            return decryptWith(deriveKeyFrom(entry.secret, workspaceId), parts[0]!, parts[1]!, parts[2]!)
        } catch (err) {
            lastErr = err
        }
    }
    throw lastErr instanceof Error ? lastErr : new Error('Decryption failed for all keyring keys')
}
