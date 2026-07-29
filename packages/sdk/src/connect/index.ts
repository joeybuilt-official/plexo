// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * @joeybuilt/plexo-sdk — connect module
 *
 * Universal client for connecting any app to Plexo Core.
 *
 * Quick start:
 *
 *   import { createPlexoClient } from '@joeybuilt/plexo-sdk/connect'
 *
 *   export const plexo = createPlexoClient({
 *     appId:      process.env.APP_ID      ?? 'my-app',
 *     plexoUrl:   process.env.PLEXO_URL   ?? '',
 *     serviceKey: process.env.SERVICE_KEY ?? '',
 *     extensions: [
 *       { id: 'my-app.todos.list', type: 'tool', name: 'List Todos',
 *         config: { description: 'List todos for the current user' } },
 *     ],
 *     eventContracts: ['my-app.todo.created'],
 *   })
 *
 * Register at boot (Next.js instrumentation.ts, Express server start, etc.):
 *   await plexo.register()
 *
 * Per-user workspace (call once on first login):
 *   const workspaceId = await plexo.ensureWorkspace(userId, email)
 *
 * AI / chat:
 *   const text = await plexo.aiComplete(workspaceId, { messages: [...] })
 *   const reply = await plexo.chatMessage(workspaceId, userId, { message })
 *
 * Inbound events + data queries (mount at POST /api/plexo/events):
 *   export const POST = (req: Request) =>
 *     plexo.inbound({ onEvent, onDataQuery }).handle(req)
 */

export { PlexoClient } from './client.js'
export {
    PlexoApiError,
    PlexoAuthError,
    PlexoNotConfiguredError,
    PlexoProtocolError,
    PlexoRateLimitedError,
    PlexoUnreachableError,
} from './errors.js'
export { verifyInboundSignature } from './inbound.js'
export { PEX_CONTRACT_VERSION, isContractCompatible } from '../contract.js'
export type {
    AiCompleteOptions,
    AiMessage,
    AnalyzeImageHints,
    AnalyzeImageOptions,
    AnalyzeImageResult,
    AppChannelConfig,
    AppConnectorConfig,
    AppExtension,
    AppProfile,
    AppToolConfig,
    ChatOptions,
    ChatReply,
    ConnectOptions,
    ConnectProfile,
    LocalInstanceDescriptor,
    NegotiatedSession,
    DataQuery,
    DataResponse,
    DispatchContext,
    DispatchOptions,
    DispatchResult,
    GmessagesLastMessage,
    GmessagesListThreadsOptions,
    GmessagesSendOptions,
    GmessagesSendResult,
    GmessagesThread,
    GmessagesThreadParticipant,
    InboundEvent,
    InboundEventType,
    InboundHandlers,
    InboundVerifyResult,
    InstallConnectionOptions,
    MemoryEntry,
    MemorySearchResult,
    OcrResult,
    PlexoClientOptions,
    PlexoConnection,
    PlexoConversation,
    PlexoTask,
    PlexoToken,
    PlexoTokenWithConnection,
    PublishEventOptions,
    ResilienceOptions,
    RunCustomOptions,
    RunCustomResult,
    RunCustomStep,
    RunCustomTool,
    StoreMemoryOptions,
    TestConnectionResult,
} from './types.js'

import { PlexoClient } from './client.js'
import type { PlexoClientOptions } from './types.js'

/**
 * Create a configured Plexo client.
 * Call `await client.register()` once at app boot to announce this app to
 * Plexo Core and make its extensions discoverable.
 */
export function createPlexoClient(opts: PlexoClientOptions): PlexoClient {
    return new PlexoClient(opts)
}
