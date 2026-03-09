// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Kapsel Channel Contract Types
 * Corresponds to §2.3 and §9.2 of the Kapsel Protocol Specification v0.2.0
 */

import type { InboundMessage } from './messages.js'

export interface ChannelHealthResult {
    healthy: boolean
    latencyMs?: number
    error?: string
}

export interface ChannelSendResult {
    ok: boolean
    messageId?: string
    error?: string
}

export interface ChannelExtension {
    /**
     * Called on activate. Channel should start listening for inbound messages
     * and call sdk.channel.send() to route them into the host.
     */
    onActivate(): Promise<void>

    /**
     * Called when the host wants to send a message via this channel.
     * Requires channel:receive capability.
     */
    onMessage(message: InboundMessage): Promise<void>

    /**
     * Called periodically by the host Channel Router.
     * Return healthy: false to trigger failover.
     */
    healthCheck(): Promise<ChannelHealthResult>

    /**
     * Called on deactivate. Channel should stop listeners and clean up.
     */
    onDeactivate(): Promise<void>
}
