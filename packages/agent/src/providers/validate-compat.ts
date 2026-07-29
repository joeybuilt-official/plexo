// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Pre-flight model-compatibility validation.
 *
 * Phase I Stage 2 (post-audit). Sibling to `call-model.ts` and the
 * Phase I Stage 2 commit `c8c7916` that added `generateObjectWithRepair`
 * inside the `callModel` wrapper.
 *
 * Goal: when the user selects/changes a model on a provider instance via
 * `PATCH /api/v1/workspaces/:id/providers/:instanceId`, run a synthetic
 * `generateObject` call with a TINY zod schema and a TRIVIAL prompt to
 * record whether the model is structured-output capable BEFORE the user
 * hits a real failure mid-task.
 *
 * Outcomes recorded on `provider_instances.model_compat_status`:
 *   - 'native'  — direct generateObject succeeded (no repair needed)
 *   - 'repair'  — repair path produced the structured output
 *   - 'failed'  — both native + repair failed (or any other terminal error)
 *
 * Native-vs-repair detection: we use the `repairUsed` flag now exposed on
 * `CallModelObjectResult`. The wrapper sets it true iff the in-wrapper
 * fence-rescue OR `generateText` repair fired. This avoids two SDK round-
 * trips just to distinguish the two paths — single call, single bill.
 */

import { z } from 'zod'
import pino from 'pino'
import { callModel, CallModelError } from './call-model.js'
import { buildModel, type WorkspaceAISettings, type AIProviderConfig, type ProviderKey } from './registry.js'
import { getProvider, updateProvider, type ModelCompatStatus, type ProviderInstanceRow } from './instances.js'

const logger = pino({ name: 'provider:validate-compat' })

/**
 * Tiny synthetic schema. Matches the prompt verbatim — anything other than
 * `{ ok: boolean }` is a clear failure mode.
 */
const SYNTHETIC_SCHEMA = z.object({ ok: z.boolean() })
const SYNTHETIC_PROMPT = 'Reply with { ok: true }'

/** Wall-clock cap for the synthetic test. The PATCH handler shouldn't hang. */
const SYNTHETIC_TIMEOUT_MS = 12_000

export interface CompatValidationResult {
    status: ModelCompatStatus
    /** Latency of the synthetic call in milliseconds. 0 when the call did not run. */
    latencyMs: number
    /** Model id the test ran against. Empty when buildModel itself failed. */
    model: string
    /** Short human-readable reason — surfaced to the frontend warning UI. */
    message: string
}

export interface ValidateCompatOpts {
    /**
     * Optional decrypted API key for the instance. When omitted, only
     * managed providers (no key required) and instances with no key
     * configured will get a real test — others record 'failed' with a
     * "missing key" message. The API route layer owns decryption (the
     * crypto module is workspace-scoped and lives in apps/api), so it
     * decrypts before calling and passes the plain key here.
     */
    apiKey?: string
}

/**
 * Run the synthetic generateObject test for a provider instance, then
 * persist `model_compat_status` + `model_compat_validated_at` on the row.
 *
 * Never throws — catches any error and records 'failed' so the PATCH
 * handler doesn't block on a temporarily-down provider.
 */
export async function validateProviderInstanceCompat(
    instanceId: string,
    opts: ValidateCompatOpts = {},
): Promise<CompatValidationResult> {
    const startedAt = Date.now()
    const validatedAt = new Date()

    let row: ProviderInstanceRow | null = null
    try {
        row = await getProvider(instanceId)
    } catch (err) {
        logger.warn({ err, instanceId }, 'compat-validate: getProvider failed')
    }
    if (!row) {
        return { status: 'failed', latencyMs: 0, model: '', message: 'Provider instance not found.' }
    }

    if (!row.selectedModel) {
        // Nothing to validate — clear any stale status so the UI doesn't
        // show a misleading badge from a previous selection.
        await updateProvider(instanceId, {
            modelCompatStatus: null,
            modelCompatValidatedAt: validatedAt,
        }).catch(() => null)
        return { status: null, latencyMs: 0, model: '', message: 'No model selected.' }
    }

    // Caller is responsible for decryption. If the instance has an encrypted
    // key but the caller didn't pass one in, treat as failed — we won't try
    // to make a real call without auth.
    const apiKey = opts.apiKey
    if (row.encryptedKey && !apiKey) {
        logger.warn({ instanceId }, 'compat-validate: encrypted key present but no plaintext provided')
        await persistResult(instanceId, 'failed', validatedAt)
        return { status: 'failed', latencyMs: 0, model: row.selectedModel, message: 'API key required for compat test but not provided.' }
    }

    // Build the language model. buildModel needs a TaskType + settings shape;
    // we feed it a minimal stub since we explicitly override the model id via
    // config.model (priority #2 in the resolution order).
    const config: AIProviderConfig = {
        provider: row.providerType as ProviderKey,
        apiKey,
        baseUrl: row.endpointUrl ?? undefined,
        model: row.selectedModel,
    }
    const stubSettings: WorkspaceAISettings = {
        primaryProvider: row.providerType as ProviderKey,
        fallbackChain: [],
        providers: { [row.providerType]: config } as WorkspaceAISettings['providers'],
    }

    let model: unknown
    try {
        model = buildModel(row.providerType as ProviderKey, config, 'classification', stubSettings)
    } catch (err) {
        logger.warn({ err, instanceId, providerType: row.providerType, modelId: row.selectedModel }, 'compat-validate: buildModel failed')
        await persistResult(instanceId, 'failed', validatedAt)
        return { status: 'failed', latencyMs: Date.now() - startedAt, model: row.selectedModel, message: 'Could not construct model adapter.' }
    }

    // Run the synthetic call. callModel handles retry, abort, repair, and
    // surfaces `repairUsed` on the result so we don't need a second call.
    try {
        const result = await callModel({
            model,
            prompt: SYNTHETIC_PROMPT,
            schema: SYNTHETIC_SCHEMA,
            schemaName: 'PreflightCompatTest',
            schemaDescription: 'Trivial { ok: boolean } object used for pre-flight model-compat detection.',
            stepTimeoutMs: SYNTHETIC_TIMEOUT_MS,
            workspaceId: row.workspaceId,
            taskType: 'preflight_compat',
            provider: row.providerType,
        })

        const status: ModelCompatStatus = result.repairUsed ? 'repair' : 'native'
        await persistResult(instanceId, status, validatedAt)
        return {
            status,
            latencyMs: result.latencyMs,
            model: result.model,
            message: status === 'native'
                ? 'Model produced structured output natively.'
                : 'Model required the repair wrapper to produce structured output.',
        }
    } catch (err) {
        const message = err instanceof CallModelError
            ? `${err.code}: ${err.message.slice(0, 200)}`
            : err instanceof Error
                ? err.message.slice(0, 200)
                : 'unknown error'
        logger.warn({ err, instanceId, providerType: row.providerType, modelId: row.selectedModel }, 'compat-validate: synthetic call failed')
        await persistResult(instanceId, 'failed', validatedAt)
        return { status: 'failed', latencyMs: Date.now() - startedAt, model: row.selectedModel, message }
    }
}

async function persistResult(
    instanceId: string,
    status: ModelCompatStatus,
    validatedAt: Date,
): Promise<void> {
    try {
        await updateProvider(instanceId, {
            modelCompatStatus: status,
            modelCompatValidatedAt: validatedAt,
        })
    } catch (err) {
        logger.warn({ err, instanceId, status }, 'compat-validate: failed to persist outcome')
    }
}
