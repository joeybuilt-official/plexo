// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { describe, it, expect } from 'vitest'
import { validateManifest } from './manifest.js'
import { verifySignature, type SignatureMetadata } from './signature.js'
import type { ExtensionManifest } from '../types/manifest.js'

const baseManifest: Record<string, unknown> = {
    plexo: '0.4.0',
    name: '@acme/example',
    version: '1.0.0',
    type: 'tool',
    entry: 'dist/index.js',
    capabilities: ['storage:read', 'storage:write'],
    displayName: 'Example',
    description: 'Example tool',
    author: 'Acme',
    license: 'MIT',
}

describe('validateManifest — capabilitiesRationale (Q4)', () => {
    it('accepts a verified-tier manifest with rationale for every non-trivial capability', () => {
        const m = {
            ...baseManifest,
            trust: 'verified',
            capabilities: ['storage:read', 'memory:read:thread', 'memory:write:note'],
            capabilitiesRationale: {
                'memory:read:thread': 'Read the conversation thread.',
                'memory:write:note': 'Save the research summary.',
            },
        }
        const result = validateManifest(m)
        expect(result.valid).toBe(true)
    })

    it('rejects a verified-tier manifest missing rationale on a non-trivial capability', () => {
        const m = {
            ...baseManifest,
            trust: 'verified',
            capabilities: ['storage:read', 'memory:read:thread'],
            // no rationale at all
        }
        const result = validateManifest(m)
        expect(result.valid).toBe(false)
        expect(result.errors.some((e) => e.field === 'capabilitiesRationale')).toBe(true)
    })

    it('warns but does not fail when a community-tier manifest omits rationale', () => {
        const m = {
            ...baseManifest,
            trust: 'community',
            capabilities: ['storage:read', 'memory:read:thread'],
        }
        const result = validateManifest(m)
        expect(result.valid).toBe(true)
        expect(result.errors.some((e) => e.severity === 'warning' && e.field === 'capabilitiesRationale')).toBe(true)
    })

    it('rejects a rationale entry for a capability that is not declared', () => {
        const m = {
            ...baseManifest,
            trust: 'community',
            capabilities: ['storage:read'],
            capabilitiesRationale: {
                'memory:read:thread': 'orphan',
            },
        }
        const result = validateManifest(m)
        expect(result.valid).toBe(false)
        expect(result.errors.some((e) => e.field === 'capabilitiesRationale.memory:read:thread')).toBe(true)
    })

    it('rejects rationale strings longer than 200 characters', () => {
        const longText = 'x'.repeat(201)
        const m = {
            ...baseManifest,
            trust: 'verified',
            capabilities: ['memory:read:thread'],
            capabilitiesRationale: { 'memory:read:thread': longText },
        }
        const result = validateManifest(m)
        expect(result.valid).toBe(false)
    })
})

describe('validateManifest — sideload ceiling (Q3)', () => {
    it('rejects owner-only capabilities when source is sideload', () => {
        const m = {
            ...baseManifest,
            capabilities: ['storage:read', 'audit:read'],
        }
        const result = validateManifest(m, { source: 'sideload' })
        expect(result.valid).toBe(false)
        expect(result.errors.some((e) => e.message.includes('audit:read'))).toBe(true)
    })

    it('rejects wildcard memory capabilities when source is sideload', () => {
        const m = {
            ...baseManifest,
            capabilities: ['memory:read:*'],
        }
        const result = validateManifest(m, { source: 'sideload' })
        expect(result.valid).toBe(false)
    })

    it('allows non-owner capabilities when source is sideload', () => {
        const m = {
            ...baseManifest,
            capabilities: ['storage:read', 'storage:write', 'memory:read:thread'],
        }
        const result = validateManifest(m, { source: 'sideload' })
        expect(result.valid).toBe(true)
    })
})

describe('validateManifest — channelTransport', () => {
    it('accepts channelTransport "worker" for channel type', () => {
        const m = { ...baseManifest, type: 'channel', channelTransport: 'worker' }
        const result = validateManifest(m)
        expect(result.valid).toBe(true)
        expect(result.errors.filter(e => e.field === 'channelTransport')).toHaveLength(0)
    })

    it('accepts channelTransport "api" for channel type', () => {
        const m = { ...baseManifest, type: 'channel', channelTransport: 'api' }
        const result = validateManifest(m)
        expect(result.valid).toBe(true)
        expect(result.errors.filter(e => e.field === 'channelTransport')).toHaveLength(0)
    })

    it('rejects channelTransport on non-channel type', () => {
        const m = { ...baseManifest, type: 'tool', channelTransport: 'api' }
        const result = validateManifest(m)
        expect(result.valid).toBe(false)
        expect(result.errors.some(e => e.field === 'channelTransport')).toBe(true)
    })

    it('rejects invalid channelTransport value', () => {
        const m = { ...baseManifest, type: 'channel', channelTransport: 'websocket' }
        const result = validateManifest(m)
        expect(result.valid).toBe(false)
        expect(result.errors.some(e => e.field === 'channelTransport' && e.message.includes('"worker" or "api"'))).toBe(true)
    })

    it('allows channel type without channelTransport (defaults to worker)', () => {
        const m = { ...baseManifest, type: 'channel' }
        const result = validateManifest(m)
        expect(result.valid).toBe(true)
    })
})

describe('verifySignature — stub v1 (Q1)', () => {
    const manifest = { trust: 'verified' } as ExtensionManifest

    it('downgrades unsigned verified manifests to community', () => {
        const result = verifySignature(manifest, null)
        expect(result.ok).toBe(false)
        expect(result.effectiveTrust).toBe('community')
    })

    it('accepts a Sigstore signature with a joeybuilt-official signer as owner', () => {
        const meta: SignatureMetadata = {
            signature: 'fake-bundle',
            signatureType: 'sigstore',
            signerIdentity: 'plexo-bot@joeybuilt-official',
            signedAt: new Date().toISOString(),
        }
        const result = verifySignature({ trust: 'owner' } as ExtensionManifest, meta)
        expect(result.ok).toBe(true)
        expect(result.effectiveTrust).toBe('owner')
    })

    it('caps a Sigstore signature from an unknown identity at verified', () => {
        const meta: SignatureMetadata = {
            signature: 'fake-bundle',
            signatureType: 'sigstore',
            signerIdentity: 'someone@some-other-org.com',
            signedAt: new Date().toISOString(),
        }
        const result = verifySignature({ trust: 'owner' } as ExtensionManifest, meta)
        expect(result.ok).toBe(true)
        // owner claim downgraded to verified because signer is not joeybuilt
        expect(result.effectiveTrust).toBe('verified')
    })

    it('never upgrades the declared tier', () => {
        const meta: SignatureMetadata = {
            signature: 'fake',
            signatureType: 'sigstore',
            signerIdentity: 'plexo-bot@joeybuilt-official',
            signedAt: new Date().toISOString(),
        }
        const result = verifySignature({ trust: 'community' } as ExtensionManifest, meta)
        expect(result.effectiveTrust).toBe('community')
    })
})
