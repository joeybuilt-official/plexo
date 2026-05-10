// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Phase 4 — channel adapter coverage gate.
 *
 * Asserts every channel adapter route invokes the conversation-bridge
 * (extractConversationMemory) so turns from any channel land in memory.
 *
 * Catches the regression where a new channel ships without bridge wiring.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))

const CHANNEL_ROUTES = [
    { name: 'web chat',          file: 'chat.ts' },
    { name: 'telegram',          file: 'telegram.ts' },
    { name: 'slack',             file: 'slack.ts' },
    { name: 'discord',           file: 'discord.ts' },
    { name: 'app-transport',     file: 'chat-app-transport.ts' },
]

function readRoute(file: string): string {
    return readFileSync(resolve(HERE, '..', file), 'utf-8')
}

describe('channel adapter coverage — conversation-bridge invocation', () => {
    for (const { name, file } of CHANNEL_ROUTES) {
        it(`${name} (${file}) imports and invokes extractConversationMemory`, () => {
            const src = readRoute(file)
            // Match both static (from '...') and dynamic (import('...')) forms.
            expect(src).toMatch(/['"]@plexo\/agent\/memory\/conversation-bridge['"]/)
            expect(src).toMatch(/extractConversationMemory\(/)
        })
    }
})
