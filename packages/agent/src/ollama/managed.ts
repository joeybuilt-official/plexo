// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Managed Ollama singleton.
 *
 * The managed Ollama sidecar ships with every Plexo installation.
 * This module provides a lazy-initialized singleton adapter for it,
 * used as the final fallback in both LLM and embedding routing.
 *
 * Resolution: OLLAMA_INTERNAL_URL env var → default http://ollama:11434
 */

import pino from 'pino'
import { OllamaAdapter } from './adapter.js'

const logger = pino({ name: 'ollama:managed' })

let _instance: OllamaAdapter | null = null
let _initPromise: Promise<OllamaAdapter | null> | null = null

/**
 * Get the managed Ollama adapter. Lazy-initializes on first call.
 * Returns null if the managed instance is not reachable.
 */
export async function getManagedOllama(): Promise<OllamaAdapter | null> {
    if (_instance) {
        // Re-discover if stale
        await _instance.ensureFresh()
        return _instance
    }

    // Deduplicate concurrent init calls
    if (_initPromise) return _initPromise

    _initPromise = initManagedOllama()
    const result = await _initPromise
    _initPromise = null
    return result
}

async function initManagedOllama(): Promise<OllamaAdapter | null> {
    const url = process.env.OLLAMA_INTERNAL_URL
    if (!url) {
        logger.debug('OLLAMA_INTERNAL_URL not set — managed Ollama not available')
        return null
    }

    const adapter = new OllamaAdapter({
        id: 'managed-ollama',
        endpoint: url,
    })

    const healthy = await adapter.isHealthy()
    if (!healthy) {
        logger.warn({ url }, 'Managed Ollama not reachable — fallback disabled')
        return null
    }

    await adapter.discoverCapabilities()
    _instance = adapter

    const caps = adapter.capabilities
    logger.info({
        url,
        chatModels: caps?.chatModels.length ?? 0,
        embeddingModels: caps?.embeddingModels.length ?? 0,
    }, 'Managed Ollama initialized')

    return adapter
}

/**
 * Reset the singleton (for testing).
 */
export function resetManagedOllama(): void {
    _instance = null
    _initPromise = null
}
