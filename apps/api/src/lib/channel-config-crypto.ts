// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Channel-config encryption-at-rest helpers (Phase O / ADR 0010).
 *
 * Wraps the existing apps/api/src/crypto.ts helpers with a per-channel-type
 * sensitive-key map so callers don't have to know which keys are secrets.
 *
 * Backward-compat: `tryDecrypt` returns plaintext as-is for legacy values
 * that weren't `enc:`-prefixed at write time. This lets the migration roll
 * forward while old reads still work.
 */

import { encrypt as rawEncrypt, decrypt as rawDecrypt } from '../crypto.js'
import { incrementCounter } from './metrics.js'

/** Per-channel-type sensitive-key set. Keys NOT in the set are stored
 *  plaintext (e.g. `fromNumber`, `lastHistoryId`). Updating this map is
 *  the only legitimate way to change encryption coverage. */
export const SENSITIVE_CONFIG_KEYS: Record<string, ReadonlySet<string>> = {
    twilio:   new Set(['authToken', 'accountSid']),
    telegram: new Set(['token', 'bot_token']),
    slack:    new Set(['signingSecret', 'token', 'webhook', 'webhookUrl', 'webhook_url']),
    discord:  new Set(['webhook', 'webhookUrl', 'webhook_url']),
    gmail:    new Set(),
    whatsapp: new Set(),
    signal:   new Set(),
    matrix:   new Set(),
}

/** Returns true if the value is already in `enc:` ciphertext form. */
export function isEncrypted(value: unknown): boolean {
    return typeof value === 'string' && value.startsWith('enc:')
}

/** Encrypt a value if it's a non-empty string AND not already encrypted.
 *  Other values (numbers, booleans, null, undefined, empty string) pass through. */
export function tryEncrypt(value: unknown, workspaceId: string): unknown {
    if (typeof value !== 'string') return value
    if (value.length === 0) return value
    if (isEncrypted(value)) return value
    return rawEncrypt(value, workspaceId)
}

/** Decrypt a value if it's `enc:`-prefixed; otherwise return plaintext as-is.
 *  Emits `plexo_channel_config_legacy_read_total` so the operator can watch
 *  how many legacy reads remain post-migration (target: 0 within 7 days). */
export function tryDecrypt(value: unknown, workspaceId: string, channelType: string): unknown {
    if (typeof value !== 'string') return value
    if (value.length === 0) return value
    if (isEncrypted(value)) {
        try {
            return rawDecrypt(value, workspaceId, 'channel-config')
        } catch (err) {
            incrementCounter('plexo_channel_config_decrypt_failed_total', { channel_type: channelType })
            throw err
        }
    }
    incrementCounter('plexo_channel_config_legacy_read_total', { channel_type: channelType })
    return value
}

/** Encrypt sensitive keys in a config object, returning a new object.
 *  Non-sensitive keys + non-string values pass through unchanged. */
export function encryptSensitiveConfigKeys(
    channelType: string,
    config: Record<string, unknown>,
    workspaceId: string,
): Record<string, unknown> {
    const sensitive = SENSITIVE_CONFIG_KEYS[channelType] ?? new Set()
    if (sensitive.size === 0) return { ...config }
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(config)) {
        out[k] = sensitive.has(k) ? tryEncrypt(v, workspaceId) : v
    }
    return out
}

/** Decrypt sensitive keys in a config object, returning a new object.
 *  Non-sensitive keys + non-string values pass through unchanged. */
export function decryptSensitiveConfigKeys(
    channelType: string,
    config: Record<string, unknown>,
    workspaceId: string,
): Record<string, unknown> {
    const sensitive = SENSITIVE_CONFIG_KEYS[channelType] ?? new Set()
    if (sensitive.size === 0) return { ...config }
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(config)) {
        out[k] = sensitive.has(k) ? tryDecrypt(v, workspaceId, channelType) : v
    }
    return out
}
