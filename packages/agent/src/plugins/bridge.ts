/**
 * Kapsel Plugin Tool Bridge — Kapsel Full compliant host
 *
 * Loads enabled Kapsel extensions for a workspace. For each extension,
 * runs its entry point in a sandbox worker which calls activate(sdk).
 * The host SDK captures registerTool() registrations, which are then
 * converted into Vercel AI SDK tool objects.
 *
 * Tool key format: plugin__{scope}_{name}__{toolName}
 *   e.g. @acme/stripe-monitor → plugin__acme_stripe-monitor__stripe_get_mrr
 *
 * The activation model (§9.1):
 *   1. Host instantiates SDK with extension's capabilities + settings
 *   2. Host calls activate(sdk) on the extension entry point in a worker
 *   3. Extension calls sdk.registerTool() / sdk.registerSchedule() etc.
 *   4. Host collects registrations and builds the ToolSet
 *
 * Non-fatal — returns empty ToolSet if any step fails.
 */
import { tool } from 'ai'
import { z } from 'zod'
import { db, eq, and } from '@plexo/db'
import { plugins } from '@plexo/db'
import type { ToolSet } from '../connections/bridge.js'
import { runInSandbox } from './pool.js'
import pino from 'pino'
import type { KapselManifest, JSONSchema } from '@plexo/sdk'
import type { ToolRegistration } from '@plexo/sdk'
import { eventBus, TOPICS } from './event-bus.js'

const logger = pino({ name: 'kapsel-bridge' })

const DEFAULT_TIMEOUT_MS = 10_000

/** Derive a stable tool key from a scoped extension name + tool name */
function toolKey(extensionName: string, toolName: string): string {
    const sanitized = extensionName.replace(/^@/, '').replace('/', '_')
    return `plugin__${sanitized}__${toolName}`
}

/** Build a flat zod input schema from a Kapsel JSONSchema parameters object */
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
 * Load enabled Kapsel extensions, activate them in sandboxed workers,
 * and return an AI SDK ToolSet with all registered tools.
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

            // Activate the extension in a worker — it calls sdk.registerTool() etc.
            // The worker returns the list of registered tools.
            const activationResult = await runInSandbox({
                pluginName: ext.name,
                toolName: '__activate__',   // sentinel: worker runs activate() not a tool
                args: {},
                permissions: capabilities,
                settings,
                entry: ext.entry,
                timeoutMs: Math.min(timeoutMs, 30_000), // activation capped at 30s
            })

            if (!activationResult.ok) {
                logger.warn(
                    { ext: ext.name, error: activationResult.error },
                    'Kapsel extension activation failed — skipping',
                )
                eventBus.emitSystem(TOPICS.EXTENSION_CRASHED, {
                    extension: ext.name,
                    error: activationResult.error,
                    timedOut: activationResult.timedOut,
                    workspaceId,
                })
                continue
            }

            // Worker returns { registeredTools: ToolRegistration[] }
            const registeredTools = (activationResult.result as { registeredTools?: ToolRegistration[] })?.registeredTools ?? []

            for (const toolDef of registeredTools) {
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
                const entry = ext.entry

                toolSet[key] = tool({
                    description: `[${extName} v${extVersion}] ${toolDef.description}`,
                    inputSchema,
                    execute: async (args) => {
                        const result = await runInSandbox({
                            pluginName: extName,
                            toolName,
                            args: args as Record<string, unknown>,
                            permissions: capabilities,
                            settings,
                            entry,
                            timeoutMs: toolTimeout,
                        })

                        if (!result.ok) {
                            logger.warn(
                                { ext: extName, tool: toolName, error: result.error, timedOut: result.timedOut },
                                'Kapsel extension tool failed',
                            )
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

            logger.info({ ext: ext.name, toolCount: registeredTools.length }, 'Kapsel extension activated')
            eventBus.emitSystem(TOPICS.EXTENSION_ACTIVATED, {
                extension: ext.name,
                version: ext.version,
                toolCount: registeredTools.length,
                workspaceId,
            })
        }
    } catch (err) {
        logger.error({ err, workspaceId }, 'loadPluginTools failed — continuing without plugin tools')
    }

    return toolSet
}
