// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Reminder channel registry — maps channel.type → recipient extractor.
 *
 * L4 v1 ships Gmail-only. To add a channel type later, add a single entry
 * here returning the recipient identifier for that channel's config; no
 * other code paths need to change. Multi-channel reminder support beyond
 * this registry is tracked in the L4.5 backlog.
 */

export type RecipientResolver = (channel: { type: string; config: Record<string, unknown> }) => string | null

export const REMINDER_CHANNEL_RESOLVERS: Record<string, RecipientResolver> = {
    gmail: (ch) => {
        const email = (ch.config as { emailAddress?: string }).emailAddress
        return typeof email === 'string' && email.length > 0 ? email : null
    },
    // L4.5: telegram, twilio, slack, discord, etc.
}

export function resolveRecipient(channel: { type: string; config: Record<string, unknown> }): string | null {
    const resolver = REMINDER_CHANNEL_RESOLVERS[channel.type]
    return resolver ? resolver(channel) : null
}

export function isReminderSupportedChannelType(type: string): boolean {
    return type in REMINDER_CHANNEL_RESOLVERS
}
