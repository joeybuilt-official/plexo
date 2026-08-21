// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

export { inngest } from './client.js'
export type { GmessagesEvents } from './client.js'
export { gmessagesStaleSessionMonitor } from './functions/gmessages-stale-session-monitor.js'
export { gmessagesSessionRefresh } from './functions/gmessages-session-refresh.js'
export { gmessagesSessionRefreshReceiver } from './functions/gmessages-session-refresh-receiver.js'
export { embedMemoryFn } from '@plexo/agent/memory/inngest'

import { gmessagesStaleSessionMonitor } from './functions/gmessages-stale-session-monitor.js'
import { gmessagesSessionRefresh } from './functions/gmessages-session-refresh.js'
import { gmessagesSessionRefreshReceiver } from './functions/gmessages-session-refresh-receiver.js'
import { embedMemoryFn } from '@plexo/agent/memory/inngest'

/**
 * All Inngest functions registered with the API's `serve` handler. Phase 4b
 * shipped two; Phase 5 added the refresh receiver; Phase 3.5 adds memory embedding.
 * Imported by apps/api/src/index.ts.
 */
export const inngestFunctions = [
    gmessagesStaleSessionMonitor,
    gmessagesSessionRefresh,
    gmessagesSessionRefreshReceiver,
    embedMemoryFn,
] as const
