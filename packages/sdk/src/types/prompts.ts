// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Plexo Fabric — Prompt Library Types
 * Corresponds to §7.6 of the Plexo Fabric Specification v0.4.0
 *
 * Extension-contributed prompt templates that are versioned, discovered,
 * and resolved across extensions. Host maps these to LLM prompt primitives
 * at runtime.
 */

/**
 * A prompt template contributed by an extension.
 * Declared in the extension manifest's `prompts` array.
 */
export interface PromptArtifact {
    /** Unique within the extension */
    id: string
    /** Max 100 chars */
    name: string
    /** Max 500 chars */
    description: string
    /** Template text with {{variable}} placeholders */
    template: string
    /** Variables the host must resolve before injection */
    variables?: PromptVariable[]
    /** Max 10, for discovery */
    tags?: string[]
    /** Semver, independent of extension version */
    version: string
    /** Injection priority */
    priority?: 'low' | 'normal' | 'high' | 'critical'
    /** Format: "context:<name>:<id>" */
    dependencies?: string[]
}

/**
 * A variable declared in a prompt template.
 * Host resolves all required variables before injection.
 */
export interface PromptVariable {
    name: string
    description: string
    type: 'string' | 'number' | 'boolean' | 'enum'
    /** Default: true */
    required?: boolean
    default?: string | number | boolean
    enum?: string[]
}

/**
 * Registration payload passed to sdk.registerPrompt() during activate().
 */
export interface PromptRegistration {
    id: string
    name: string
    description: string
    template: string
    variables?: PromptVariable[]
    tags?: string[]
    version: string
    priority?: 'low' | 'normal' | 'high' | 'critical'
    dependencies?: string[]
}

/**
 * Summary returned by sdk.prompts.list().
 */
export interface PromptSummary {
    id: string
    name: string
    description: string
    tags?: string[]
    version: string
    priority: 'low' | 'normal' | 'high' | 'critical'
    ownerExtension: string
    enabled: boolean
}
