// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Telegram tool factory — produces agent-callable tools from an installed Telegram connection.
 *
 * Tools: telegram__send_message
 *
 * Auth: Bot token stored as bot_token / token.
 *
 * Note: Plexo also uses Telegram as a channel adapter (see apps/api/src/routes/telegram.ts).
 * This factory lets agents send to arbitrary chat IDs during task execution (e.g. proactive
 * notifications or cross-channel fanout), separate from the channel reply flow.
 */

import { tool } from 'ai'
import { z } from 'zod'
import type { ConnectionCredentials, ToolSet } from '../bridge.js'
import pino from 'pino'

const logger = pino({ name: 'telegram:tools' })

function audit(toolName: string, detail: Record<string, unknown>, opts: { connectionId: string; workspaceId: string }) {
    logger.info({
        type: 'telegram_tool_call',
        toolName,
        connectionId: opts.connectionId,
        workspaceId: opts.workspaceId,
        ...detail,
    }, `Telegram tool: ${toolName}`)
}

export const TELEGRAM_TOOLS = (creds: ConnectionCredentials, opts: { connectionId: string; workspaceId: string }): ToolSet => {
    const token = (creds.bot_token as string) ?? (creds.token as string) ?? (creds.access_token as string) ?? ''
    const baseUrl = `https://api.telegram.org/bot${token}`
    const defaultChatId = (creds.chat_id as string) ?? (creds.default_chat_id as string) ?? ''

    return {
        telegram__send_message: tool({
            description: 'Send a text message to a Telegram chat by chat ID. Use this for proactive notifications or to send messages to specific chats outside the current conversation.',
            inputSchema: z.object({
                chatId: z.string().optional().describe('Telegram chat ID (numeric string). Uses stored default if omitted.'),
                text: z.string().describe('Message text (max 4096 chars). Plain text only — markdown not parsed.'),
            }),
            execute: async ({ chatId, text }) => {
                try {
                    if (!token) return 'Telegram error: no bot token configured'
                    const target = chatId ?? defaultChatId
                    if (!target) return 'Telegram error: no chat ID supplied and no default configured'
                    const res = await fetch(`${baseUrl}/sendMessage`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            chat_id: target,
                            text: text.slice(0, 4096),
                        }),
                    })
                    const data = await res.json() as { ok: boolean; description?: string; result?: { message_id: number } }
                    if (!data.ok) return `Telegram error: ${data.description ?? 'unknown'}`
                    audit('telegram__send_message', { chatId: target, messageId: data.result?.message_id }, opts)
                    return `Sent message ${data.result?.message_id} to chat ${target}`
                } catch (err) {
                    return `Telegram send_message failed: ${err instanceof Error ? err.message : String(err)}`
                }
            },
        }),
    }
}
