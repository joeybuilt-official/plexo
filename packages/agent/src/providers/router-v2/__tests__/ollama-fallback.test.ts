// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Permanent free-local-chat fallback: the keyless `ollama` provider must be a
 * scoreable last-resort chat candidate on EVERY task type, resolve gemma3:4b for
 * conversation, and never regress vision (qwen2.5vl stays on the separate
 * name-heuristic path).
 */

import { describe, it, expect } from 'vitest'
import {
    MANIFEST,
    MANIFEST_PROVIDERS,
    PROVIDER_DEFAULT_MODEL_CLASS,
    getManifestEntry,
} from '../manifest.js'
import { selectModel, resolveModelId, type AvailableProvider } from '../selector.js'
import { classifyError } from '../error-classifier.js'
import { modelSupportsVision } from '../../vision.js'
import { DEFAULT_MODEL_ROUTING, type TaskType, type WorkspaceAISettings } from '../../registry.js'

const ALL_TASK_TYPES = Object.keys(DEFAULT_MODEL_ROUTING) as TaskType[]

const ap = (provider: string, model?: string): AvailableProvider =>
    ({ provider, config: { provider, model } } as unknown as AvailableProvider)

const settings = (over: Partial<WorkspaceAISettings> = {}): WorkspaceAISettings =>
    ({ providers: {}, primaryProvider: 'ollama', fallbackChain: [], ...over } as unknown as WorkspaceAISettings)

describe('manifest — ollama chat fallback coverage', () => {
    it('has an ollama entry on every TaskType', () => {
        for (const t of ALL_TASK_TYPES) {
            expect(getManifestEntry(t, 'ollama'), `missing ollama for ${t}`).toBeDefined()
        }
    })

    it('ollama is a low-priority last resort (priorScore 2)', () => {
        for (const t of ALL_TASK_TYPES) {
            expect(getManifestEntry(t, 'ollama')!.priorScore).toBe(2)
        }
    })

    it('lists ollama in MANIFEST_PROVIDERS and PROVIDER_DEFAULT_MODEL_CLASS', () => {
        expect(MANIFEST_PROVIDERS).toContain('ollama')
        expect(PROVIDER_DEFAULT_MODEL_CLASS.ollama).toBe('gemma3:4b')
    })

    it('MANIFEST_PROVIDERS matches the providers actually present in the table', () => {
        for (const p of MANIFEST_PROVIDERS) {
            const anyBlock = ALL_TASK_TYPES.some(t => MANIFEST[t]?.[p])
            expect(anyBlock, `${p} in MANIFEST_PROVIDERS but not in any block`).toBe(true)
        }
    })
})

describe('selector — ollama is chosen when it is the only provider', () => {
    it('conversation → ollama, noManifestMatch false', () => {
        const out = selectModel({
            workspaceId: undefined,
            taskType: 'conversation',
            availableProviders: [ap('ollama', 'gemma3:4b')],
            settings: settings(),
        })
        expect(out.chosen?.provider).toBe('ollama')
        expect(out.noManifestMatch).toBe(false)
        expect(out.chosen?.model).toBe('gemma3:4b')
    })

    it('never preempts a funded paid provider (higher prior wins)', () => {
        const out = selectModel({
            workspaceId: undefined,
            taskType: 'conversation',
            availableProviders: [ap('anthropic', 'claude-sonnet-4-6'), ap('ollama', 'gemma3:4b')],
            settings: settings({ primaryProvider: 'anthropic' }),
        })
        expect(out.chosen?.provider).toBe('anthropic')
    })
})

describe('model resolution — chat vs vision on the same ollama provider', () => {
    it('conversation resolves the configured chat model gemma3:4b', () => {
        const model = resolveModelId('ollama' as never, { provider: 'ollama', model: 'gemma3:4b' } as never, 'conversation', settings())
        expect(model).toBe('gemma3:4b')
    })

    it('the chat fallback model gemma3:4b is NOT treated as vision (no regression)', () => {
        // Vision selection is a separate name/capability path (providers/vision.ts),
        // independent of the conversation manifest — the fallback must never route
        // images to the chat model, and the chat manifest entry carries no vision cap.
        expect(modelSupportsVision('gemma3:4b', 'ollama')).toBe(false)
        expect(modelSupportsVision('llava-phi3', 'ollama')).toBe(true)
        for (const t of ALL_TASK_TYPES) {
            expect(getManifestEntry(t, 'ollama')!.capabilities).not.toContain('vision')
        }
    })
})

describe('error-classifier — dead endpoint cascades', () => {
    it('410 Gone → shouldFallback true', () => {
        const c = classifyError(new Error('Request failed with status 410'))
        expect(c.shouldFallback).toBe(true)
        expect(c.class).toBe('network')
    })
    it('404 Not Found → shouldFallback true', () => {
        expect(classifyError(new Error('HTTP 404 model not found')).shouldFallback).toBe(true)
    })
})
