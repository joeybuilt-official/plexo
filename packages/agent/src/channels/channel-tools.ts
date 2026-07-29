// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Channel-scoped agent tools.
 *
 * These tools require a live channel context (chat_id, message_id, bot token)
 * and are only added to the tool set when a message arrives via a channel
 * adapter (Telegram, Slack, Discord). The web UI agent path does not see them.
 *
 * Today:
 *   - react_to_message: add an emoji reaction to the user's most recent
 *     message in this conversation.
 */

import { tool } from 'ai'
import { z } from 'zod'
import type { ToolSet } from 'ai'
import pino from 'pino'
import {
    sendTelegramReactionRaw,
    sendSlackReactionRaw,
    sendDiscordReactionRaw,
} from './reaction-manager.js'

const logger = pino({ name: 'channel-tools' })

export type ChannelKind = 'telegram' | 'slack' | 'discord'

export interface ChannelToolContext {
    channel: ChannelKind
    workspaceId: string
    /** The chat/channel identifier (telegram chat_id, slack channel, discord channel_id) */
    chatId?: string | number
    /** The user's message identifier (telegram message_id number, slack ts, discord message id string) */
    messageId?: number | string
    /** Bot token for the channel */
    botToken?: string
}

/**
 * Build the channel-scoped tool set for a given channel context.
 *
 * Returns an empty object when there is no usable context (e.g. web UI calls
 * or channels where a message id is not available). Callers should spread the
 * result into the main tool set unconditionally.
 */
export function buildChannelTools(ctx: ChannelToolContext): ToolSet {
    // Without a chat + message id the tool cannot act — don't expose it.
    if (!ctx.chatId || ctx.messageId === undefined || ctx.messageId === null) {
        return {}
    }
    if (!ctx.botToken) {
        return {}
    }

    const { channel, chatId, messageId, botToken } = ctx

    return {
        react_to_message: tool({
            description:
                `React to the user's most recent message with an emoji. Use this when:
- The user explicitly asks for a reaction ("react with X", "give me a thumbs up")
- You want to acknowledge a message without sending a text reply
- The message is positive/funny/notable and a reaction is more natural than a reply
Reactions DO NOT replace your text response — you can do both in the same turn.
Available channel: ${channel}. Pass a single unicode emoji like 👍 ❤️ 🎉 ✅ 🤔.`,
            inputSchema: z.object({
                emoji: z
                    .string()
                    .min(1)
                    .describe('A single unicode emoji, e.g. 👍, ❤️, 🎉, ✅, 🤔'),
            }),
            execute: async ({ emoji }): Promise<string> => {
                try {
                    switch (channel) {
                        case 'telegram': {
                            const msgIdNum = typeof messageId === 'number' ? messageId : Number(messageId)
                            if (!Number.isFinite(msgIdNum)) {
                                return `Reaction failed: invalid telegram message id "${String(messageId)}"`
                            }
                            const res = await sendTelegramReactionRaw(botToken, chatId, msgIdNum, emoji)
                            if (!res.ok) {
                                logger.warn({ err: res.error, emoji, chatId, messageId }, 'react_to_message: telegram failed')
                                return `Reaction failed: ${res.error ?? 'unknown'}`
                            }
                            return `Reacted with ${emoji} on the user's message.`
                        }
                        case 'slack': {
                            const res = await sendSlackReactionRaw(botToken, String(chatId), String(messageId), emoji)
                            if (!res.ok) {
                                logger.warn({ err: res.error, emoji, chatId, messageId }, 'react_to_message: slack failed')
                                return `Reaction failed: ${res.error ?? 'unknown'}`
                            }
                            return `Reacted with ${emoji} on the user's message.`
                        }
                        case 'discord': {
                            const res = await sendDiscordReactionRaw(botToken, String(chatId), String(messageId), emoji)
                            if (!res.ok) {
                                logger.warn({ err: res.error, emoji, chatId, messageId }, 'react_to_message: discord failed')
                                return `Reaction failed: ${res.error ?? 'unknown'}`
                            }
                            return `Reacted with ${emoji} on the user's message.`
                        }
                        default:
                            return `Reaction failed: unsupported channel "${String(channel)}"`
                    }
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err)
                    logger.warn({ err, emoji, channel }, 'react_to_message: threw')
                    return `Reaction failed: ${msg}`
                }
            },
        }),
    }
}
