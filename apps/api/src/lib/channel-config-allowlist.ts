// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * PATCH config-key allow-list for channels (L3.5).
 *
 * Two layers of defense:
 *   1. Per-channel-type ALLOW-LIST of operator-mutable config keys.
 *   2. Global DENY-LIST of server-managed keys (lastHistoryId, errorCount, ...).
 *
 * For Gmail (and other dead-UI types), the allow-list is empty: any PATCH config
 * is rejected. Identity-binding fields (installedConnectionId, emailAddress) are
 * fixed at create-time; rebinding requires DELETE + POST. Server-managed keys
 * (lastHistoryId etc.) are explicitly rejected (NOT silently dropped) so an
 * operator does not believe they cleared a value when in fact server state
 * persists.
 */

const SERVER_MANAGED_CONFIG_KEYS = new Set([
    'lastHistoryId', 'last_history_id',
    'errorCount', 'error_count',
    'lastError', 'last_error',
    'lastErrorAt', 'last_error_at',
])

const PATCH_ALLOWED_CONFIG_KEYS: Record<string, ReadonlySet<string>> = {
    twilio: new Set(['accountSid', 'authToken', 'fromNumber']),
    telegram: new Set(['token', 'bot_token']),
    slack: new Set(['webhook', 'webhookUrl', 'webhook_url', 'token', 'signingSecret']),
    discord: new Set(['webhook', 'webhookUrl', 'webhook_url']),
    gmail: new Set([]),
    whatsapp: new Set([]),
    signal: new Set([]),
    matrix: new Set([]),
}

export type ConfigPatchError =
    | { code: 'CONFIG_KEY_NOT_ALLOWED'; key: string }
    | { code: 'CONFIG_KEY_SERVER_MANAGED'; key: string }

export function filterChannelConfigForPatch(
    channelType: string,
    incoming: Record<string, unknown>,
): { ok: true; filtered: Record<string, unknown> } | { ok: false; error: ConfigPatchError } {
    const allowed = PATCH_ALLOWED_CONFIG_KEYS[channelType] ?? new Set()
    const filtered: Record<string, unknown> = {}
    for (const key of Object.keys(incoming)) {
        if (SERVER_MANAGED_CONFIG_KEYS.has(key)) {
            return { ok: false, error: { code: 'CONFIG_KEY_SERVER_MANAGED', key } }
        }
        if (!allowed.has(key)) {
            return { ok: false, error: { code: 'CONFIG_KEY_NOT_ALLOWED', key } }
        }
        filtered[key] = incoming[key]
    }
    return { ok: true, filtered }
}
