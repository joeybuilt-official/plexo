// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * PEX Extension Tool Bridge — PEX compliant host
 *
 * Loads enabled PEX extensions using the Persistent Worker Pool (§5.4).
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
import { extensions, workspaces } from '@plexo/db'
import type { ToolSet } from '../connections/bridge.js'
import { getWorker, invokeTool } from './persistent-pool.js'
import pino from 'pino'
import type { ExtensionManifest, JSONSchema } from '@joeybuilt/plexo-sdk'
import { eventBus, TOPICS } from './event-bus.js'
import type { SkillPlusFrontmatter } from '../skills/types.js'
import { logAuditEntry } from '../audit.js'
import { requestEscalation, startEscalationSweeper } from '../escalation/manager.js'

// Kick the background sweeper the first time the bridge module loads in
// any process. Idempotent; safe to call repeatedly.
startEscalationSweeper()

const logger = pino({ name: 'pex-bridge' })

const DEFAULT_TIMEOUT_MS = 10_000

function toolKey(extensionName: string, toolName: string): string {
    const sanitizedExt = extensionName.replace(/^@/, '').replace('/', '_')
    const sanitizedTool = toolName.replace(/[^a-zA-Z0-9_-]/g, '_')
    return `plugin__${sanitizedExt}__${sanitizedTool}`
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
 * Resolve the per-workspace auto-approve cost threshold. Any tool whose
 * estimated USD cost exceeds this figure triggers a Phase 8 escalation
 * instead of running directly. Stored in `workspaces.settings` under
 * `autoApproveThreshold` (defaults to 1.00 USD). An explicit null
 * disables the cost-based escalation path entirely.
 */
async function resolveAutoApproveThreshold(workspaceId: string): Promise<number | null> {
    try {
        const [ws] = await db.select({ settings: workspaces.settings })
            .from(workspaces)
            .where(eq(workspaces.id, workspaceId))
            .limit(1)
        const settings = (ws?.settings ?? {}) as { autoApproveThreshold?: number | null }
        if (settings.autoApproveThreshold === null) return null
        return settings.autoApproveThreshold ?? 1.00
    } catch {
        return 1.00
    }
}

/**
 * Decide whether a tool call must be escalated before running. Returns
 * null when the call can proceed, or a human-readable reason string when
 * it must pause for approval.
 *
 * Two triggers are honored:
 *   1. Tool-level `requiresEscalation` hint on the registration, OR
 *      extension manifest-level `escalation.irreversibleActions`
 *      containing the tool name.
 *   2. Estimated cost (`estimatedCostUsd` on hints) above the workspace's
 *      `autoApproveThreshold`.
 */
function shouldEscalateToolCall(params: {
    toolName: string
    toolHints: Record<string, unknown> | undefined
    manifest: ExtensionManifest
    autoApproveThreshold: number | null
}): string | null {
    const { toolName, toolHints, manifest, autoApproveThreshold } = params

    if (toolHints && (toolHints as { requiresEscalation?: boolean }).requiresEscalation === true) {
        return 'tool declares requiresEscalation'
    }

    const irreversible = manifest.escalation?.irreversibleActions ?? []
    if (Array.isArray(irreversible) && irreversible.includes(toolName)) {
        return 'tool listed in escalation.irreversibleActions'
    }

    if (autoApproveThreshold !== null && toolHints) {
        const estCost = (toolHints as { estimatedCostUsd?: number }).estimatedCostUsd
        if (typeof estCost === 'number' && estCost > autoApproveThreshold) {
            return `estimated cost $${estCost.toFixed(4)} exceeds auto-approve threshold $${autoApproveThreshold.toFixed(4)}`
        }
    }

    return null
}

/**
 * Load enabled PEX extensions via the persistent pool.
 * Returns an AI SDK ToolSet with all successfully registered tools.
 *
 * @param appId - Connection & Profile Standard (ADR 0001 §3): when set and
 *   profile enforcement is enabled, an extension's tools load only when ALL the
 *   capabilities it declares in its manifest are covered by the operator-granted
 *   (app×workspace) effective profile (default-deny).
 */
export async function loadPluginTools(workspaceId: string, appId?: string): Promise<ToolSet> {
    const toolSet: ToolSet = {}

    try {
        const autoApproveThreshold = await resolveAutoApproveThreshold(workspaceId)

        // Profile enforcement (ADR 0001 §3): resolve the granted profile once.
        // null → enforcement does not apply (allow-all).
        const { resolveEnforcedProfile } = await import('../profile/grant.js')
        const { isCapabilityAllowed } = await import('../profile/resolve.js')
        const enforcedProfile = await resolveEnforcedProfile(workspaceId, appId)

        const wsRows = await db.select({ ownerId: workspaces.ownerId }).from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1)
        const workspaceOwnerId = wsRows[0]?.ownerId ?? null

        const enabledExtensions = await db
            .select()
            .from(extensions)
            .where(and(eq(extensions.workspaceId, workspaceId), eq(extensions.enabled, true)))

        for (const ext of enabledExtensions) {
            const manifest = ext.manifest as ExtensionManifest
            const capabilities = manifest.capabilities ?? []

            // Profile enforcement (ADR 0001 §3): skip an extension whose declared
            // capabilities are not all covered by the app's effective profile.
            if (enforcedProfile) {
                const uncovered = capabilities.filter((cap) => !isCapabilityAllowed(enforcedProfile, cap))
                if (uncovered.length > 0) {
                    logger.info({ workspaceId, appId, ext: ext.name, uncovered }, 'Extension excluded by app profile')
                    continue
                }
            }

            const settings: Record<string, unknown> = {
                ...(workspaceOwnerId ? { _workspaceOwnerId: workspaceOwnerId } : {}),
                ...(ext.settings as Record<string, unknown>),
            }
            const timeoutMs = manifest.resourceHints?.maxInvocationMs ?? DEFAULT_TIMEOUT_MS
            // Phase 7 — honor per-workspace identity overrides (stored under settings.identity)
            const identityOverride = (settings?.identity ?? null) as { displayName?: string; avatar?: string } | null
            const effectiveDisplayName = identityOverride?.displayName ?? manifest.displayName ?? ext.name

            // An extension has executable code only when it has a real entry
            // point — an absolute path or a resolvable module name.
            //
            // 'index.js' is the placeholder the Hub catalog normalizer writes
            // for manifests that omit the entry field (skill-only catalog items
            // with no code). 'skill://' is the explicit no-code marker.
            // Synthesizer-generated extensions use type='skill' but store a
            // full absolute path as entry — they MUST NOT be skipped here.
            const hasRealEntry = Boolean(ext.entry)
                && ext.entry !== 'skill://'
                && ext.entry !== 'index.js'

            const isSkillOnly = ext.source === 'skillmd' || !hasRealEntry
            if (isSkillOnly) {
                continue
            }

            // Channel extensions with channelTransport: 'api' use Plexo's chat
            // API for transport — no worker adapter needed. They stay registered
            // in the extension registry for metadata (badge, channelRef routing)
            // but skip worker initialization entirely.
            if (manifest.type === 'channel' && manifest.channelTransport === 'api') {
                logger.info({ ext: ext.name }, 'PEX channel uses api transport — skipping worker activation')
                continue
            }

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
                const capturedManifest = manifest
                const capturedThreshold = autoApproveThreshold
                const capturedHints = toolDef.hints as Record<string, unknown> | undefined

                toolSet[key] = tool({
                    description: `[${extName} v${extVersion}] ${toolDef.description}`,
                    inputSchema,
                    execute: async (args) => {
                        // Phase 8 — per-invocation escalation gate.
                        const escalationReason = shouldEscalateToolCall({
                            toolName,
                            toolHints: capturedHints,
                            manifest: capturedManifest,
                            autoApproveThreshold: capturedThreshold,
                        })
                        if (escalationReason) {
                            try {
                                const decision = await requestEscalation({
                                    workspaceId,
                                    sessionId: workspaceId,
                                    agentId: extName,
                                    toolName: `${extName}.${toolName}`,
                                    payload: args,
                                    reason: escalationReason,
                                })
                                if (decision.status !== 'approved') {
                                    logger.warn({ ext: extName, tool: toolName, status: decision.status }, 'Escalation denied — skipping tool call')
                                    return {
                                        extension: extName,
                                        tool: toolName,
                                        status: decision.status,
                                        reason: decision.reason ?? decision.decisionNote ?? 'escalation denied',
                                    }
                                }
                            } catch (err) {
                                logger.error({ err, ext: extName, tool: toolName }, 'Escalation request failed — denying by default')
                                return {
                                    extension: extName,
                                    tool: toolName,
                                    status: 'denied',
                                    reason: 'escalation subsystem error',
                                }
                            }
                        }

                        const result = await invokeTool(
                            workerHandle,
                            toolName,
                            args as Record<string, unknown>,
                            workspaceId,
                            toolTimeout,
                        )

                        if (!result.ok) {
                            logger.warn({ ext: extName, tool: toolName, error: result.error, timedOut: result.timedOut }, 'PEX tool failed')
                            void logAuditEntry({
                                workspaceId,
                                extensionId: extName,
                                extensionName: effectiveDisplayName,
                                extensionVersion: extVersion,
                                sessionId: workspaceId,
                                action: result.timedOut ? 'tool_timeout' : 'tool_error',
                                target: toolName,
                                payload: args,
                                outcome: result.timedOut ? 'timeout' : 'failure',
                            })
                            return {
                                extension: extName,
                                tool: toolName,
                                status: result.timedOut ? 'timeout' : 'error',
                                error: result.error,
                                durationMs: result.durationMs,
                            }
                        }

                        logger.info({ ext: extName, tool: toolName, durationMs: result.durationMs }, 'PEX tool executed')
                        return result.result
                    },
                })
            }

            logger.info({ ext: ext.name, toolCount: handle.registeredTools.length }, 'PEX tool loaded (persistent worker)')
            void logAuditEntry({
                workspaceId,
                extensionId: ext.name,
                extensionName: effectiveDisplayName,
                extensionVersion: ext.version,
                sessionId: workspaceId,
                action: 'extension_activate',
                target: ext.name,
                payload: { version: ext.version, toolCount: handle.registeredTools.length },
                outcome: 'success',
            })
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

/** A loaded skill's context for system prompt injection. */
export interface SkillContext {
    name: string
    description: string
    markdownBody: string
    isSkillPlus: boolean
}

/**
 * Load enabled SKILL.md / Skill+ extensions as prompt context.
 *
 * Standard SKILL.md (no `runtime: plexo`): returns markdown body for
 * injection into the agent system prompt. No worker, no sandbox.
 *
 * Skill+ with `persistent: true`: loaded via persistent worker pool
 * (handled by loadPluginTools above). Skipped here.
 */
export async function loadSkillContexts(workspaceId: string): Promise<SkillContext[]> {
    const contexts: SkillContext[] = []

    try {
        const skillExtensions = await db
            .select()
            .from(extensions)
            .where(
                and(
                    eq(extensions.workspaceId, workspaceId),
                    eq(extensions.enabled, true),
                    eq(extensions.source, 'skillmd'),
                ),
            )

        for (const ext of skillExtensions) {
            const fm = ext.skillFrontmatter as SkillPlusFrontmatter | null

            // Skill+ with persistent workers are handled by loadPluginTools
            if (fm?.runtime === 'plexo' && fm?.persistent) {
                continue
            }

            // Standard SKILL.md or non-persistent Skill+ → prompt context
            if (ext.skillContent) {
                contexts.push({
                    name: ext.name,
                    description: (fm?.description ?? ext.name),
                    markdownBody: ext.skillContent,
                    isSkillPlus: fm?.runtime === 'plexo',
                })
                logger.info({ ext: ext.name, isSkillPlus: fm?.runtime === 'plexo' }, 'Skill context loaded for prompt injection')
            }
        }
    } catch (err) {
        logger.error({ err, workspaceId }, 'loadSkillContexts failed — continuing without skill contexts')
    }

    return contexts
}

/**
 * Phase 7 — Build an extensionName → identity map for audit logging.
 *
 * Honors per-workspace identity overrides stored under
 * `extensions.settings.identity`:
 *   {
 *     displayName?: string  // overrides manifest.displayName
 *     avatar?: string       // emoji or URL
 *     identityOverrideInChat?: boolean  // surfaced to chat UI (not used here)
 *   }
 */
export async function loadExtensionIdentities(
    workspaceId: string,
): Promise<Map<string, { name: string; version: string; displayName?: string; avatar?: string }>> {
    const map = new Map<string, { name: string; version: string; displayName?: string; avatar?: string }>()
    try {
        const rows = await db
            .select()
            .from(extensions)
            .where(and(eq(extensions.workspaceId, workspaceId), eq(extensions.enabled, true)))
        for (const ext of rows) {
            const manifest = (ext.manifest ?? {}) as ExtensionManifest
            const settings = (ext.settings ?? {}) as { identity?: { displayName?: string; avatar?: string } }
            const override = settings.identity ?? {}
            map.set(ext.name, {
                name: ext.name,
                version: ext.version,
                displayName: override.displayName ?? manifest.displayName ?? ext.name,
                avatar: override.avatar ?? manifest.icon ?? undefined,
            })
        }
    } catch (err) {
        logger.warn({ err, workspaceId }, 'loadExtensionIdentities failed — continuing with empty map')
    }
    return map
}
