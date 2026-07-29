// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Edge adapter — Anthropic Messages API `ModelClient` for the session-fabric
 * `AgentSdkBackend` (Phase 2 slice 2b, SAFE half).
 *
 * Clean Architecture: this is the outer-ring driver that owns the provider SDK.
 * session-fabric declares the `ModelClient` port; this file implements it and is
 * wired in at the composition root (apps/api). The type below is declared
 * structurally (not imported from @plexo/session-fabric) so this package needs
 * no new cross-package dependency — it plugs in by structural compatibility.
 *
 * SECURITY: pure text completion. No tools, no bash tool, no execution surface.
 * The Agent SDK's built-in tool-use is intentionally NOT enabled here — real
 * step execution stays gated behind D2 container isolation (ADR 0050).
 */

import Anthropic from '@anthropic-ai/sdk'

/** Structural mirror of session-fabric's `ModelClient` port. */
export interface ModelClient {
    complete(input: { system: string; user: string }): Promise<string>
}

export interface AnthropicModelClientOptions {
    apiKey?: string
    model?: string
    maxTokens?: number
}

/**
 * Build a `ModelClient` backed by Anthropic Messages. Defaults to claude-opus-4-8
 * with adaptive extended thinking + high effort (per operator-locked §8 config).
 */
export function anthropicModelClient(opts: AnthropicModelClientOptions = {}): ModelClient {
    const client = new Anthropic(opts.apiKey ? { apiKey: opts.apiKey } : {})
    const model = opts.model ?? 'claude-opus-4-8'
    const maxTokens = opts.maxTokens ?? 8192

    return {
        async complete({ system, user }) {
            const res = await client.messages.create({
                model,
                max_tokens: maxTokens,
                system,
                messages: [{ role: 'user', content: user }],
                // ponytail: SDK 0.39 types only allow thinking {type:'enabled',budget_tokens};
                // claude-opus-4-8 accepts adaptive thinking + top-level effort at runtime.
                // NO budget_tokens — it 400s on 4.8. Drop this cast when the SDK is bumped.
                thinking: { type: 'adaptive' },
                effort: 'high',
            } as unknown as Anthropic.MessageCreateParamsNonStreaming)

            return res.content
                .filter((b): b is Anthropic.TextBlock => b.type === 'text')
                .map((b) => b.text)
                .join('')
        },
    }
}
