// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Reminder channel registry — maps channel.type → "is this channel ready to
 * receive a reminder?" probe + a default sender identity extractor.
 *
 * Recipient (chatId / phone / email-to / webhook target) comes from the
 * operator at reminder-creation time via `taskContext.chatId`. The resolver's
 * job is to validate that the channel itself is dispatch-ready (has the
 * minimal config a sender needs) and to return a non-empty identifier so
 * cron-dispatch can short-circuit a malformed channel before calling
 * `deliverToOriginChannel`.
 *
 * L4 v1 shipped Gmail-only. L4.5 extends to telegram, twilio, slack, discord.
 */

export type RecipientResolver = (channel: { type: string; config: Record<string, unknown> }) => string | null

export const REMINDER_CHANNEL_RESOLVERS: Record<string, RecipientResolver> = {
    gmail: (ch) => {
        const email = (ch.config as { emailAddress?: string }).emailAddress
        return typeof email === 'string' && email.length > 0 ? email : null
    },
    twilio: (ch) => {
        const cfg = ch.config as { fromNumber?: string; accountSid?: string }
        // Twilio needs a verified `fromNumber` AND an accountSid to send.
        if (typeof cfg.fromNumber !== 'string' || cfg.fromNumber.length === 0) return null
        if (typeof cfg.accountSid !== 'string' || cfg.accountSid.length === 0) return null
        return cfg.fromNumber
    },
    telegram: (ch) => {
        const cfg = ch.config as { token?: string; bot_token?: string }
        const token = cfg.token ?? cfg.bot_token
        return typeof token === 'string' && token.length > 0 ? 'telegram-bot' : null
    },
    slack: (ch) => {
        const cfg = ch.config as { webhook?: string; webhookUrl?: string; webhook_url?: string }
        const url = cfg.webhook ?? cfg.webhookUrl ?? cfg.webhook_url
        return typeof url === 'string' && url.length > 0 ? url : null
    },
    discord: (ch) => {
        const cfg = ch.config as { webhook?: string; webhookUrl?: string; webhook_url?: string }
        const url = cfg.webhook ?? cfg.webhookUrl ?? cfg.webhook_url
        return typeof url === 'string' && url.length > 0 ? url : null
    },
}

export function resolveRecipient(channel: { type: string; config: Record<string, unknown> }): string | null {
    const resolver = REMINDER_CHANNEL_RESOLVERS[channel.type]
    return resolver ? resolver(channel) : null
}

export function isReminderSupportedChannelType(type: string): boolean {
    return type in REMINDER_CHANNEL_RESOLVERS
}
