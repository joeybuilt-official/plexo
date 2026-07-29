// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { encrypt, decrypt } from '../crypto.js'

const WS = '00000000-0000-0000-0000-000000000001'
const SECRET_A = 'root-secret-aaaaaaaaaaaaaaaaaaaaaaaa'
const SECRET_B = 'root-secret-bbbbbbbbbbbbbbbbbbbbbbbb'

describe('crypto key-versioning (Round-5 Phase 8 / ADR 0003)', () => {
    const saved = { ...process.env }
    beforeEach(() => {
        delete process.env.ENCRYPTION_SECRET_PREVIOUS
        delete process.env.PLEXO_ENC_WRITE_V2
        process.env.ENCRYPTION_SECRET = SECRET_A
    })
    afterEach(() => { process.env = { ...saved } })

    it('v1 (default) round-trips and keeps the legacy enc:iv.ct.tag format', () => {
        const tok = encrypt('sk-secret-value', WS)
        expect(tok.startsWith('enc:')).toBe(true)
        expect(tok.startsWith('enc:v2:')).toBe(false)
        expect(tok.slice(4).split('.')).toHaveLength(3)
        expect(decrypt(tok, WS)).toBe('sk-secret-value')
    })

    it('v2 (PLEXO_ENC_WRITE_V2=1) writes enc:v2:<keyId>. and round-trips', () => {
        process.env.PLEXO_ENC_WRITE_V2 = '1'
        const tok = encrypt('sk-v2', WS)
        expect(tok.startsWith('enc:v2:')).toBe(true)
        // enc:v2:<keyId>.iv.ct.tag → after stripping enc:v2: there are 3 dot-parts + keyId
        const afterPrefix = tok.slice('enc:v2:'.length)
        const [keyId, ...rest] = afterPrefix.split('.')
        expect(keyId).toMatch(/^[0-9a-f]{8}$/)
        expect(rest).toHaveLength(3)
        expect(decrypt(tok, WS)).toBe('sk-v2')
    })

    it('reads both v1 and v2 tokens (read-compat — the Deploy-1 guarantee)', () => {
        const v1 = encrypt('val-1', WS)
        process.env.PLEXO_ENC_WRITE_V2 = '1'
        const v2 = encrypt('val-2', WS)
        delete process.env.PLEXO_ENC_WRITE_V2 // back to v1-writing
        expect(decrypt(v1, WS)).toBe('val-1')
        expect(decrypt(v2, WS)).toBe('val-2')
    })

    it('rotation: a legacy v1 row written under the OLD secret still decrypts when it becomes PREVIOUS', () => {
        const tok = encrypt('pre-rotation', WS)           // written under SECRET_A
        // Rotate: A → previous, B → current
        process.env.ENCRYPTION_SECRET = SECRET_B
        process.env.ENCRYPTION_SECRET_PREVIOUS = SECRET_A
        expect(decrypt(tok, WS)).toBe('pre-rotation')      // legacy multi-key read finds A
    })

    it('rotation: a v2 row keyed to the PREVIOUS secret decrypts via the keyring', () => {
        process.env.PLEXO_ENC_WRITE_V2 = '1'
        const tok = encrypt('v2-pre-rotation', WS)         // keyId = keyId(A)
        // Rotate
        process.env.ENCRYPTION_SECRET = SECRET_B
        process.env.ENCRYPTION_SECRET_PREVIOUS = SECRET_A
        expect(decrypt(tok, WS)).toBe('v2-pre-rotation')   // keyId(A) found in keyring
    })

    it('v2 token whose keyId is absent from the keyring throws (never silently wrong)', () => {
        process.env.PLEXO_ENC_WRITE_V2 = '1'
        const tok = encrypt('orphan', WS)                  // keyId(A)
        process.env.ENCRYPTION_SECRET = SECRET_B           // A dropped entirely
        delete process.env.ENCRYPTION_SECRET_PREVIOUS
        expect(() => decrypt(tok, WS)).toThrow(/keyId/)
    })

    it('wrong workspaceId fails the GCM auth tag (does not return garbage)', () => {
        const tok = encrypt('scoped', WS)
        expect(() => decrypt(tok, 'aaaaaaaa-0000-0000-0000-000000000000')).toThrow()
    })

    it('a v1 token that decrypts under no keyring key throws after trying all', () => {
        const tok = encrypt('x', WS)
        process.env.ENCRYPTION_SECRET = SECRET_B
        delete process.env.ENCRYPTION_SECRET_PREVIOUS
        expect(() => decrypt(tok, WS)).toThrow()
    })
})
