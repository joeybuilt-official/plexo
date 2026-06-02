// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Channel-agnostic interaction layer — shared types.
 * See docs/channel-interaction-layer-design.md.
 *
 * Every human-in-the-loop action is expressed as a CanonicalAction (outbound)
 * or an InboundIntent (inbound). Channels translate to/from their own wire
 * shapes via a ChannelAdapter; the core never sees channel-specific formats.
 */

export type DecisionTargetType = 'task' | 'revision'
export type DecisionChoice = 'approve' | 'reject'

/**
 * The unified decision intent (locked decision 1). `request_verdict` (task) and
 * `request_approval` (revision) collapse into one shape; downstream routing is
 * by `targetType` (handlers stay distinct).
 */
export interface DecisionIntent {
    targetType: DecisionTargetType
    targetId: string
    choice: DecisionChoice
    actor: string
}

export interface DecisionResult {
    ok: boolean
    error?: string
    targetType: DecisionTargetType
    targetId: string
}

/** Outbound: core -> channel. */
export type CanonicalAction =
    | { kind: 'notify'; taskId: string; workspaceId: string; text: string; level?: 'info' | 'warn' | 'error' }
    | { kind: 'deliver'; taskId: string; workspaceId: string; text: string; assets?: string[] }
    | { kind: 'request_decision'; workspaceId: string; targetType: DecisionTargetType; targetId: string; prompt: string }
    | { kind: 'steer'; taskId: string; workspaceId: string; message: string }

/** Inbound: channel -> core (after the adapter parses a raw transport event). */
export type InboundIntent =
    | { kind: 'inject'; taskId: string; text: string }
    | ({ kind: 'decision' } & DecisionIntent)

/** Generic channel addressing — wire form stays `channel:address`. */
export interface ChannelAddress {
    channel: string
    address: string
    thread?: string
}

export interface ChannelAdapter {
    readonly channel: string
    /** Render a canonical action for this channel and send it. */
    send(addr: ChannelAddress, action: CanonicalAction): Promise<void>
    /** Parse a raw transport event into a canonical intent (null if not an action). */
    parse(raw: unknown): InboundIntent | null
    /** Optional lifecycle (e.g. token registration). */
    init?(workspaceId: string, cfg?: unknown): void
}
