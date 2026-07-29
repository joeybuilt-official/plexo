// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

import { channelRegistry } from './registry.js'
import { webAdapter } from './adapters/web-adapter.js'
import { telegramAdapter } from './adapters/telegram-adapter.js'
import { makeLegacyAdapter } from './adapters/legacy-adapter.js'

/** Channels still served by the legacy channel-delivery.ts if/else (outbound). */
const LEGACY_CHANNELS = ['slack', 'discord', 'twilio', 'gmail'] as const

let registered = false

/** Idempotent — called once at API startup. */
export function registerChannelAdapters(): void {
    if (registered) return
    registered = true
    channelRegistry.register(webAdapter)
    channelRegistry.register(telegramAdapter)
    for (const channel of LEGACY_CHANNELS) {
        channelRegistry.register(makeLegacyAdapter(channel))
    }
}
