// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Thin re-export of AES-256-GCM crypto for use within packages/agent.
 * Same algorithm as apps/api/src/crypto.ts — must stay in sync.
 */
import { createHmac, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const ALGORITHM = 'aes-256-gcm'

function deriveKey(workspaceId: string): Buffer {
    const rootKey = process.env.ENCRYPTION_SECRET
    if (!rootKey) throw new Error('ENCRYPTION_SECRET not set — add to .env (see .env.example)')
    return createHmac('sha256', rootKey).update(workspaceId).digest()
}

function b64url(buf: Buffer): string {
    return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

function fromB64url(s: string): Buffer {
    const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '=='.slice(0, (4 - (s.length % 4)) % 4)
    return Buffer.from(padded, 'base64')
}

export function encrypt(plaintext: string, workspaceId: string): string {
    const key = deriveKey(workspaceId)
    const iv = randomBytes(12)
    const cipher = createCipheriv(ALGORITHM, key, iv)
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
    const authTag = cipher.getAuthTag()
    return `enc:${b64url(iv)}.${b64url(ciphertext)}.${b64url(authTag)}`
}

export function decrypt(token: string, workspaceId: string): string {
    // Strip the enc: prefix added by apps/api/src/crypto.ts; also accept tokens without it.
    const raw = token.startsWith('enc:') ? token.slice(4) : token
    const parts = raw.split('.')
    if (parts.length !== 3) throw new Error('Invalid encrypted token format')
    const [ivStr, ciphertextStr, authTagStr] = parts
    const key = deriveKey(workspaceId)
    const decipher = createDecipheriv(ALGORITHM, key, fromB64url(ivStr!))
    decipher.setAuthTag(fromB64url(authTagStr!))
    return Buffer.concat([decipher.update(fromB64url(ciphertextStr!)), decipher.final()]).toString('utf8')
}
