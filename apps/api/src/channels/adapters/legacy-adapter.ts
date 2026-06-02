// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { deliverToOriginChannel } from '../../channel-delivery.js'
import type { CanonicalAction, ChannelAddress, ChannelAdapter } from '../types.js'

/**
 * Legacy outbound delegate — maps a canonical action onto the existing
 * channel-delivery.ts if/else (deliverToOriginChannel). Used to wrap the
 * channels not yet natively migrated (slack/discord/twilio/gmail, and Telegram
 * outbound). Behaviour is identical to today's delivery; the 770-line dispatcher
 * is NOT rewritten here. Inbound parse() is a no-op for legacy channels.
 */
export async function legacySend(channel: string, addr: ChannelAddress, action: CanonicalAction): Promise<void> {
    // Only notify/deliver are outbound sends; decision/steer are inbound or no-op here.
    if (action.kind !== 'notify' && action.kind !== 'deliver') return
    await deliverToOriginChannel({
        taskId: action.taskId,
        workspaceId: action.workspaceId,
        context: { channel, chatId: addr.address },
        summary: action.text,
        assets: action.kind === 'deliver' ? action.assets : undefined,
        outcome: 'complete',
    })
}

export function makeLegacyAdapter(channel: string): ChannelAdapter {
    return {
        channel,
        parse: () => null,
        send: (addr, action) => legacySend(channel, addr, action),
    }
}
