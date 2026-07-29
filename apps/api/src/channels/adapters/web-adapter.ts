// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

import { emitToWorkspace } from '../../sse-emitter.js'
import type { ChannelAdapter, DecisionChoice, DecisionTargetType, InboundIntent } from '../types.js'

/**
 * Web is a first-class adapter, not a special case.
 *  - send(): emit the canonical action to the workspace SSE topic (the Phase-2
 *    stream infra the web app already consumes) — "delivery to web" = an event.
 *  - parse(): a web POST body (decision or inject) → canonical intent, landing
 *    on the same shared handler Telegram uses.
 */
export const webAdapter: ChannelAdapter = {
    channel: 'web',

    async send(_addr, action) {
        emitToWorkspace(action.workspaceId, { type: `channel.${action.kind}`, ...action })
    },

    parse(raw): InboundIntent | null {
        if (!raw || typeof raw !== 'object') return null
        const o = raw as Record<string, unknown>

        // decision: { targetType, targetId, choice, actor? }
        if (
            (o.targetType === 'task' || o.targetType === 'revision') &&
            typeof o.targetId === 'string' &&
            (o.choice === 'approve' || o.choice === 'reject')
        ) {
            return {
                kind: 'decision',
                targetType: o.targetType as DecisionTargetType,
                targetId: o.targetId,
                choice: o.choice as DecisionChoice,
                actor: typeof o.actor === 'string' ? o.actor : 'web',
            }
        }

        // inject: { taskId, text }
        if (typeof o.taskId === 'string' && typeof o.text === 'string') {
            return { kind: 'inject', taskId: o.taskId, text: o.text }
        }

        return null
    },
}
