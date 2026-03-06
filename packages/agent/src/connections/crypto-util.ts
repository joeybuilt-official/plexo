/**
 * Thin re-export of AES-256-GCM crypto for use within packages/agent.
 * Same algorithm as apps/api/src/crypto.ts — must stay in sync.
 */
import { createHmac, createDecipheriv } from 'node:crypto'

const ALGORITHM = 'aes-256-gcm'

function deriveKey(workspaceId: string): Buffer {
    const rootKey = process.env.ENCRYPTION_SECRET
    if (!rootKey) throw new Error('ENCRYPTION_SECRET not set — add to .env (see .env.example)')
    return createHmac('sha256', rootKey).update(workspaceId).digest()
}

function fromB64url(s: string): Buffer {
    const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '=='.slice(0, (4 - (s.length % 4)) % 4)
    return Buffer.from(padded, 'base64')
}

export function decrypt(token: string, workspaceId: string): string {
    const parts = token.split('.')
    if (parts.length !== 3) throw new Error('Invalid encrypted token format')
    const [ivStr, ciphertextStr, authTagStr] = parts
    const key = deriveKey(workspaceId)
    const decipher = createDecipheriv(ALGORITHM, key, fromB64url(ivStr!))
    decipher.setAuthTag(fromB64url(authTagStr!))
    return Buffer.concat([decipher.update(fromB64url(ciphertextStr!)), decipher.final()]).toString('utf8')
}
