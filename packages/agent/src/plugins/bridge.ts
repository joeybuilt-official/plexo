// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Kapsel Plugin Tool Bridge — Kapsel Full compliant host
 *
 * Loads enabled Kapsel extensions using the Persistent Worker Pool (§5.4).
 * Each extension gets one long-lived worker reused across all tool invocations.
 *
 * Activation model (§9.1):
 *   1. getWorker() spawns a persistent sandbox worker + runs activate(sdk)
 *   2. Worker registers tools via sdk.registerTool()
 *   3. Bridge wraps registrations as Vercel AI SDK ToolSet
 *   4. Subsequent tool calls use invokeTool() on the same worker
 *
 * Tool key format: plugin__{scope}__{toolName}
 *   e.g. @acme/stripe-monitor → plugin__acme_stripe-monitor__stripe_get_mrr
 *
 * Non-fatal: skips broken extensions, continues building ToolSet with the rest.
 */
import { tool } from 'ai'
import { z } from 'zod'
import { db, eq, and } from '@plexo/db'
import { plugins } from '@plexo/db'
import type { ToolSet } from '../connections/bridge.js'
import { getWorker, invokeTool } from './persistent-pool.js'
import pino from 'pino'
import type { KapselManifest, JSONSchema } from '@plexo/sdk'
import { eventBus, TOPICS } from './event-bus.js'

const logger = pino({ name: 'kapsel-bridge' })

const DEFAULT_TIMEOUT_MS = 10_000

function toolKey(extensionName: string, toolName: string): string {
    const sanitized = extensionName.replace(/^@/, '').replace('/', '_')
    return `plugin__${sanitized}__${toolName}`
}

function buildZodShape(
    properties: Record<string, JSONSchema> = {},
    required: string[] = [],
): Record<string, z.ZodTypeAny> {
    const reqSet = new Set(required)
    const shape: Record<string, z.ZodTypeAny> = {}
    for (const [key, def] of Object.entries(properties)) {
        const base = (() => {
            switch (def.type) {
                case 'number':
                case 'integer': return z.number()
                case 'boolean': return z.boolean()
                case 'array': return z.array(z.unknown())
                case 'object': return z.record(z.unknown())
                default: return z.string()
            }
        })()
        shape[key] = reqSet.has(key) ? base : base.optional()
    }
    return shape
}

/**
 * Load enabled Kapsel extensions via the persistent pool.
 * Returns an AI SDK ToolSet with all successfully registered tools.
 */
export async function loadPluginTools(workspaceId: string): Promise<ToolSet> {
    const toolSet: ToolSet = {}

    try {
        const enabledExtensions = await db
            .select()
            .from(plugins)
            .where(and(eq(plugins.workspaceId, workspaceId), eq(plugins.enabled, true)))

        for (const ext of enabledExtensions) {
            const manifest = ext.kapselManifest as KapselManifest
            const capabilities = manifest.capabilities ?? []
            const settings = ext.settings as Record<string, unknown>
            const timeoutMs = manifest.resourceHints?.maxInvocationMs ?? DEFAULT_TIMEOUT_MS

            let handle
            try {
                handle = await getWorker({
                    pluginName: ext.name,
                    entry: ext.entry,
                    permissions: capabilities,
                    settings,
                    workspaceId,
                    activateTimeoutMs: Math.min(timeoutMs, 30_000),
                })
            } catch (err) {
                logger.warn({ ext: ext.name, err }, 'Persistent worker activation failed — skipping')
                eventBus.emitSystem(TOPICS.EXTENSION_CRASHED, {
                    extension: ext.name,
                    error: err instanceof Error ? err.message : String(err),
                    workspaceId,
                })
                continue
            }

            for (const toolDef of handle.registeredTools) {
                const key = toolKey(ext.name, toolDef.name)
                const params = toolDef.parameters as JSONSchema | undefined
                const props = params?.properties ?? {}
                const required = params?.required ?? []
                const zodShape = buildZodShape(props, required)

                const inputSchema = Object.keys(zodShape).length > 0
                    ? z.object(zodShape)
                    : z.object({}).passthrough()

                const extName = ext.name
                const extVersion = ext.version
                const toolName = toolDef.name
                const toolTimeout = toolDef.hints?.timeoutMs ?? timeoutMs
                const workerHandle = handle

                toolSet[key] = tool({
                    description: `[${extName} v${extVersion}] ${toolDef.description}`,
                    inputSchema,
                    execute: async (args) => {
                        const result = await invokeTool(
                            workerHandle,
                            toolName,
                            args as Record<string, unknown>,
                            workspaceId,
                            toolTimeout,
                        )

                        if (!result.ok) {
                            logger.warn({ ext: extName, tool: toolName, error: result.error, timedOut: result.timedOut }, 'Kapsel tool failed')
                            return {
                                extension: extName,
                                tool: toolName,
                                status: result.timedOut ? 'timeout' : 'error',
                                error: result.error,
                                durationMs: result.durationMs,
                            }
                        }

                        logger.info({ ext: extName, tool: toolName, durationMs: result.durationMs }, 'Kapsel tool executed')
                        return result.result
                    },
                })
            }

            logger.info({ ext: ext.name, toolCount: handle.registeredTools.length }, 'Kapsel extension loaded (persistent worker)')
            eventBus.emitSystem(TOPICS.EXTENSION_ACTIVATED, {
                extension: ext.name,
                version: ext.version,
                toolCount: handle.registeredTools.length,
                workspaceId,
            })
        }
    } catch (err) {
        logger.error({ err, workspaceId }, 'loadPluginTools failed — continuing without plugin tools')
    }

    return toolSet
}
