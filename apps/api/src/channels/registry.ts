// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

import type { ChannelAdapter } from './types.js'

/**
 * Registry of channel adapters keyed by channel name. Outbound dispatch becomes
 * `channelRegistry.get(addr.channel)?.send(...)`; inbound webhooks become
 * `channelRegistry.get(channel)?.parse(raw)` -> shared handler. Adding a channel
 * = register one adapter, no core change.
 */
export class ChannelRegistry {
    private readonly adapters = new Map<string, ChannelAdapter>()

    register(adapter: ChannelAdapter): void {
        this.adapters.set(adapter.channel, adapter)
    }

    get(channel: string): ChannelAdapter | undefined {
        return this.adapters.get(channel)
    }

    has(channel: string): boolean {
        return this.adapters.has(channel)
    }

    list(): string[] {
        return [...this.adapters.keys()]
    }
}

/** Process-wide registry. Adapters self-register at module init (Phase B). */
export const channelRegistry = new ChannelRegistry()
