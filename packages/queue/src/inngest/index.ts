// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

export { inngest } from './client.js'
export type { GmessagesEvents } from './client.js'
export { gmessagesStaleSessionMonitor } from './functions/gmessages-stale-session-monitor.js'
export { gmessagesSessionRefresh } from './functions/gmessages-session-refresh.js'
export { gmessagesSessionRefreshReceiver } from './functions/gmessages-session-refresh-receiver.js'

import { gmessagesStaleSessionMonitor } from './functions/gmessages-stale-session-monitor.js'
import { gmessagesSessionRefresh } from './functions/gmessages-session-refresh.js'
import { gmessagesSessionRefreshReceiver } from './functions/gmessages-session-refresh-receiver.js'

/**
 * Queue-owned Inngest functions registered with the API's `serve` handler.
 * Phase 4b shipped two; Phase 5 added the refresh receiver. Cross-package
 * functions (agent memory: embedMemoryFn, extractTurnFn) are NOT listed
 * here — importing them would make queue depend on agent, a package cycle
 * turbo hard-fails. apps/api registers them via the `extra` parameter of
 * createInngestExpressHandler (see packages/queue/src/inngest/express.ts).
 * Imported by apps/api/src/index.ts.
 */
export const inngestFunctions = [
    gmessagesStaleSessionMonitor,
    gmessagesSessionRefresh,
    gmessagesSessionRefreshReceiver,
] as const
