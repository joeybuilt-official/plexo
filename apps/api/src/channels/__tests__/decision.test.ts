// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

import { describe, it, expect, vi } from 'vitest'
import { applyDecision, type DecisionHandlers } from '../decision.js'
import { ChannelRegistry } from '../registry.js'
import type { ChannelAdapter } from '../types.js'

function handlers(over: Partial<DecisionHandlers> = {}): DecisionHandlers {
    return {
        recordVerdict: vi.fn(async () => {}),
        applyRevision: vi.fn(async () => ({ ok: true })),
        rejectRevision: vi.fn(async () => ({ ok: true })),
        ...over,
    }
}

describe('applyDecision — unified decision routing', () => {
    it('revision/approve → applyRevision(actor) and surfaces its result', async () => {
        const h = handlers({ applyRevision: vi.fn(async () => ({ ok: true })) })
        const r = await applyDecision({ targetType: 'revision', targetId: 'rev1', choice: 'approve', actor: 'alice' }, h)
        expect(h.applyRevision).toHaveBeenCalledWith('rev1', 'alice')
        expect(h.rejectRevision).not.toHaveBeenCalled()
        expect(r).toEqual({ targetType: 'revision', targetId: 'rev1', ok: true, error: undefined })
    })

    it('revision/reject → rejectRevision', async () => {
        const h = handlers()
        await applyDecision({ targetType: 'revision', targetId: 'rev1', choice: 'reject', actor: 'bob' }, h)
        expect(h.rejectRevision).toHaveBeenCalledWith('rev1', 'bob')
        expect(h.applyRevision).not.toHaveBeenCalled()
    })

    it('revision domain rejection (stale prompt) propagates ok:false + error', async () => {
        const h = handlers({ applyRevision: vi.fn(async () => ({ ok: false, error: 'prompt_changed_stale' })) })
        const r = await applyDecision({ targetType: 'revision', targetId: 'rev1', choice: 'approve', actor: 'a' }, h)
        expect(r).toMatchObject({ ok: false, error: 'prompt_changed_stale' })
    })

    it('task/approve maps to recordVerdict("accept")', async () => {
        const h = handlers()
        const r = await applyDecision({ targetType: 'task', targetId: 't1', choice: 'approve', actor: 'a' }, h)
        expect(h.recordVerdict).toHaveBeenCalledWith('t1', 'accept')
        expect(r.ok).toBe(true)
    })

    it('task/reject maps to recordVerdict("reject")', async () => {
        const h = handlers()
        await applyDecision({ targetType: 'task', targetId: 't1', choice: 'reject', actor: 'a' }, h)
        expect(h.recordVerdict).toHaveBeenCalledWith('t1', 'reject')
    })

    it('unknown target type → ok:false unknown_target_type', async () => {
        const h = handlers()
        // @ts-expect-error — exercising the defensive default branch
        const r = await applyDecision({ targetType: 'project', targetId: 'x', choice: 'approve', actor: 'a' }, h)
        expect(r).toMatchObject({ ok: false, error: 'unknown_target_type' })
    })
})

describe('ChannelRegistry', () => {
    const stub = (channel: string): ChannelAdapter => ({
        channel,
        send: async () => {},
        parse: () => null,
    })

    it('registers, gets, has, lists adapters by channel', () => {
        const reg = new ChannelRegistry()
        reg.register(stub('telegram'))
        reg.register(stub('web'))
        expect(reg.has('telegram')).toBe(true)
        expect(reg.get('web')?.channel).toBe('web')
        expect(reg.get('slack')).toBeUndefined()
        expect(reg.list().sort()).toEqual(['telegram', 'web'])
    })

    it('re-registering a channel replaces the adapter', () => {
        const reg = new ChannelRegistry()
        const a = stub('telegram')
        reg.register(a)
        const b = stub('telegram')
        reg.register(b)
        expect(reg.get('telegram')).toBe(b)
        expect(reg.list()).toEqual(['telegram'])
    })
})
