// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Plexo Fabric — Context Layer Types
 * Corresponds to §7.7 of the Plexo Fabric Specification v0.4.0
 *
 * Push-based mechanism for extensions to contribute structured, prioritized
 * context blocks injected into LLM system prompt at execution time.
 */

/**
 * A context block contributed by an extension.
 * Declared in the extension manifest's `contexts` array or registered at runtime.
 */
export interface ContextArtifact {
    /** Unique within the extension */
    id: string
    /** Max 100 chars */
    name: string
    /** Max 500 chars */
    description: string
    /** Static text or {{variable}} template */
    content: string
    /** MIME type; default: "text/plain" */
    contentType?: string
    /** Injection priority */
    priority: 'low' | 'normal' | 'high' | 'critical'
    /** Seconds; undefined = no expiry */
    ttl?: number
    /** Max 10, for discovery */
    tags?: string[]
    /** For budget allocation */
    estimatedTokens?: number
}

/**
 * Registration payload passed to sdk.registerContext() during activate().
 */
export interface ContextRegistration {
    id: string
    name: string
    description: string
    content: string
    contentType?: string
    priority: 'low' | 'normal' | 'high' | 'critical'
    ttl?: number
    tags?: string[]
    estimatedTokens?: number
}

/**
 * Summary returned by sdk.context.list().
 */
export interface ContextSummary {
    id: string
    name: string
    description: string
    priority: 'low' | 'normal' | 'high' | 'critical'
    ownerExtension: string
    enabled: boolean
    estimatedTokens?: number
    expired: boolean
}
