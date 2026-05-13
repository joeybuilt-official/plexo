// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// @joeybuilt/fylo-bridge — Pex bridge extension. Minimal scaffold focused
// on Phase 5 synthesis promotion (recurring spend pattern → Fylo budget
// signal). Mirrors @joeybuilt/levio-bridge / @joeybuilt/fonto-bridge.
// Fylo's full PEX tool surface (account list, transaction search, etc.)
// can be layered on later — this scaffold only registers the synthesis
// subscriber so the Phase 5 pipeline has a target.

import type { PlexoSDK } from '@joeybuilt/plexo-sdk'

function fyloBase(): string {
    const host = process.env.FYLO_BASE_URL
    if (!host) throw new Error('FYLO_BASE_URL env var is required for the Fylo bridge extension')
    return host.replace(/\/$/, '')
}

function serviceHeaders(): Record<string, string> {
    return {
        Authorization: `Bearer ${process.env.PLEXO_SERVICE_KEY ?? ''}`,
        'Content-Type': 'application/json',
    }
}

const TIMEOUT_MS = 10_000

let _cachedUserId: string | null = null

async function fyloPost(body: Record<string, unknown>): Promise<unknown> {
    const res = await fetch(`${fyloBase()}/api/plexo/data`, {
        method: 'POST',
        headers: serviceHeaders(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`Fylo API error ${res.status}: ${text.slice(0, 200)}`)
    }
    return res.json()
}

// ── Synthesis promotion subscriber ──────────────────────────────────────────
// Plexo emits `ext.synthesis-promote.fylo.budget.signal` when it detects
// a recurring merchant + amount band in the user's spend stream. Fylo
// records this as a soft budget signal — non-fatal, idempotent.
async function handlePromotionToBudgetSignal(payload: unknown): Promise<void> {
    if (!payload || typeof payload !== 'object') return
    const p = payload as { workspaceId?: string; suggestionId?: string; payload?: unknown }
    const inner = (p.payload && typeof p.payload === 'object')
        ? p.payload as { merchant?: unknown; amountBand?: unknown; occurrences?: unknown }
        : {}
    const merchant = typeof inner.merchant === 'string' ? inner.merchant : null
    const amountBand = typeof inner.amountBand === 'string' || typeof inner.amountBand === 'number'
        ? inner.amountBand
        : null
    const occurrences = typeof inner.occurrences === 'number' ? inner.occurrences : 0
    const userId = _cachedUserId
    if (!userId || !merchant || amountBand === null) return

    try {
        await fyloPost({
            entity: 'budgetSignal',
            userId,
            merchant,
            amountBand,
            occurrences,
            source: 'plexo.synthesis',
            sourceId: p.suggestionId,
        })
    } catch {
        // Non-fatal; suggestion is already promoted upstream.
    }
}

export async function activate(sdk: PlexoSDK): Promise<void> {
    try {
        _cachedUserId = await sdk.storage.get('fylo_user_id')
    } catch { /* fall through to owner-id fallback */ }

    if (!_cachedUserId) {
        try {
            _cachedUserId = (await sdk.storage.get('_workspaceOwnerId')) ?? null
        } catch { /* ignore */ }
    }

    try {
        sdk.events.subscribe('ext.synthesis-promote.fylo.budget.signal', (payload) => {
            void handlePromotionToBudgetSignal(payload)
        })
    } catch {
        // events:subscribe may not be granted; promotion is opt-in.
    }
}
