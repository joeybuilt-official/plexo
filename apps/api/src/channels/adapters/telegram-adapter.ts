// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

import { legacySend } from './legacy-adapter.js'
import type { ChannelAdapter, InboundIntent } from '../types.js'

/** Minimal shape telegram.ts hands to parse(): the message text + sender id. */
interface TelegramRaw {
    text?: unknown
    fromId?: string | number
}

const REVISION_RE = /^(approve|reject)\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i

/**
 * Telegram adapter. parse() is the migrated inbound seam: a "approve|reject
 * <uuid>" message becomes a canonical decision intent that telegram.ts routes
 * through applyDecision (same handler the generic endpoint uses — de-dup).
 * Outbound send() delegates to the existing channel-delivery path for now.
 */
export const telegramAdapter: ChannelAdapter = {
    channel: 'telegram',

    parse(raw): InboundIntent | null {
        const o = (raw ?? {}) as TelegramRaw
        if (typeof o.text !== 'string') return null
        const m = REVISION_RE.exec(o.text.trim())
        if (m) {
            return {
                kind: 'decision',
                targetType: 'revision',
                targetId: m[2]!.toLowerCase(),
                choice: m[1]!.toLowerCase() as 'approve' | 'reject',
                actor: `telegram:${o.fromId ?? 'unknown'}`,
            }
        }
        return null
    },

    async send(addr, action) {
        await legacySend('telegram', addr, action)
    },
}
