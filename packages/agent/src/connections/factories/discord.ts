// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Discord tool factory — produces agent-callable tools from an installed Discord connection.
 *
 * Tools: discord__send_message, discord__list_channels
 *
 * Auth: Bot token stored as bot_token / token.
 */

import { tool } from 'ai'
import { z } from 'zod'
import type { ConnectionCredentials, ToolSet } from '../bridge.js'
import pino from 'pino'

const logger = pino({ name: 'discord:tools' })

const API_BASE = 'https://discord.com/api/v10'

function buildHeaders(creds: ConnectionCredentials): Record<string, string> {
    const token = (creds.bot_token as string) ?? (creds.token as string) ?? (creds.access_token as string) ?? ''
    return {
        Authorization: `Bot ${token}`,
        'Content-Type': 'application/json',
    }
}

function audit(toolName: string, detail: Record<string, unknown>, opts: { connectionId: string; workspaceId: string }) {
    logger.info({
        type: 'discord_tool_call',
        toolName,
        connectionId: opts.connectionId,
        workspaceId: opts.workspaceId,
        ...detail,
    }, `Discord tool: ${toolName}`)
}

export const DISCORD_TOOLS = (creds: ConnectionCredentials, opts: { connectionId: string; workspaceId: string }): ToolSet => {
    const headers = buildHeaders(creds)
    const defaultGuildId = (creds.guild_id as string) ?? (creds.server_id as string) ?? ''

    return {
        discord__send_message: tool({
            description: 'Send a message to a Discord channel by channel ID.',
            inputSchema: z.object({
                channelId: z.string().describe('Discord channel ID (snowflake)'),
                content: z.string().describe('Message text (max 2000 chars)'),
            }),
            execute: async ({ channelId, content }) => {
                try {
                    const res = await fetch(`${API_BASE}/channels/${channelId}/messages`, {
                        method: 'POST',
                        headers,
                        body: JSON.stringify({ content: content.slice(0, 2000) }),
                    })
                    if (!res.ok) return `Discord error ${res.status}: ${(await res.text()).slice(0, 200)}`
                    const data = await res.json() as { id: string }
                    audit('discord__send_message', { channelId, messageId: data.id }, opts)
                    return `Sent message ${data.id} to channel ${channelId}`
                } catch (err) {
                    return `Discord send_message failed: ${err instanceof Error ? err.message : String(err)}`
                }
            },
        }),

        discord__list_channels: tool({
            description: 'List text channels in a Discord guild/server.',
            inputSchema: z.object({
                guildId: z.string().optional().describe('Discord guild/server ID. Uses stored default if omitted.'),
            }),
            execute: async ({ guildId }) => {
                try {
                    const id = guildId ?? defaultGuildId
                    if (!id) return 'Discord error: no guild ID supplied and no default configured'
                    const res = await fetch(`${API_BASE}/guilds/${id}/channels`, { headers })
                    if (!res.ok) return `Discord error ${res.status}: ${(await res.text()).slice(0, 200)}`
                    const channels = await res.json() as Array<{ id: string; name: string; type: number }>
                    // type 0 = text, 5 = announcement, 15 = forum
                    const textChannels = channels.filter((c) => c.type === 0 || c.type === 5 || c.type === 15)
                    audit('discord__list_channels', { guildId: id, count: textChannels.length }, opts)
                    if (!textChannels.length) return 'No text channels found.'
                    return textChannels.map((c) => `#${c.name} — ${c.id}`).join('\n')
                } catch (err) {
                    return `Discord list_channels failed: ${err instanceof Error ? err.message : String(err)}`
                }
            },
        }),
    }
}
