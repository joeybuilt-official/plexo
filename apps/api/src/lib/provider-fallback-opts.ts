// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Shared `FallbackOptions` factory.
 *
 * ADR 0012 makes two promises about provider fallback:
 *   - "preference is a hard input to the selector" (which fallback is chosen)
 *   - "degradation is logged, not hidden" (a fallback is indicated)
 *
 * The routing layer owns the first (chain-dictated cascade). This module owns
 * the second for every API call site that routes a workspace call, so a
 * fallback cannot be silent on one path (chat) and hidden on another
 * (channels, app transport, inference). One factory, one event shape.
 */

import { logger } from '../logger.js'
import { emitToWorkspace } from '../sse-emitter.js'
import type { FallbackOptions } from '@plexo/agent/providers/registry'

/**
 * Build the standard fallback options for a workspace call: an auth failure is
 * surfaced as a `provider_auth_error` event, and a fallback that actually serves
 * a call is logged + surfaced as a `provider_fallback` event naming the failed
 * primary, the provider that served, and the ones skipped.
 *
 * @param workspaceId  workspace the call belongs to (event + log scope)
 * @param label        optional call-site tag for the log line (e.g. 'webchat')
 */
export function buildProviderFallbackOpts(workspaceId: string, label?: string): FallbackOptions {
    const where = label ? `${label}: ` : ''
    return {
        workspaceId,
        onAuthFailure: (provider, error) => {
            logger.warn({ workspaceId, provider, error }, `${where}provider auth failed — removed from fallback chain`)
            emitToWorkspace(workspaceId, {
                type: 'provider_auth_error',
                provider,
                message: `API key for "${provider}" is invalid or expired. Update it in Settings → AI Providers.`,
            })
        },
        onFallbackEngaged: (info) => {
            logger.warn({
                workspaceId: info.workspaceId ?? workspaceId,
                taskType: info.taskType,
                primary: info.primary,
                used: info.used,
                skipped: info.skipped,
                lastError: info.lastError,
            }, `${where}provider fallback engaged — primary failed, served by chain fallback`)
            emitToWorkspace(workspaceId, {
                type: 'provider_fallback',
                primary: info.primary,
                used: info.used,
                skipped: info.skipped,
                taskType: info.taskType,
                message: `Primary provider "${info.primary}" failed; "${info.used}" served this call.`,
            })
        },
    }
}
