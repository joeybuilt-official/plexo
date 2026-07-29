// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * PEX manifest validation
 * Corresponds to §3.3 of the Plexo Extension Protocol (PEX) Specification v0.4.0
 *
 * Used by:
 * - POST /api/plugins (host install validation)
 * - @plexo/cli (publish validation)
 */

import type { ExtensionManifest, ManifestType, CapabilityToken, HostComplianceLevel, EntityTypeName } from '../types/manifest.js'
import type { TrustTier } from '../types/trust.js'

// ---------------------------------------------------------------------------
// Valid values
// ---------------------------------------------------------------------------

const VALID_TYPES: ManifestType[] = ['agent', 'skill', 'channel', 'tool', 'connector']
const LEGACY_TYPES = new Set(['function', 'mcp-server'])

const VALID_ENTITY_TYPES: EntityTypeName[] = [
    'person', 'task', 'thread', 'note', 'transaction', 'calendar_event', 'file',
]

const VALID_TRUST_TIERS: TrustTier[] = ['owner', 'verified', 'community']

const DISPLAY_NAME_MAX = 50

/**
 * Standard capability tokens (non-parameterized).
 * Entity-scoped memory tokens are validated dynamically.
 */
const STANDARD_CAPABILITIES = new Set<string>([
    // Legacy (deprecated at Standard + Full)
    'memory:read',
    'memory:write',
    'memory:delete',
    // Entity-scoped memory wildcards (owner tier only)
    'memory:read:*',
    'memory:write:*',
    // Channel
    'channel:send',
    'channel:send-direct',
    'channel:receive',
    // Scheduling
    'schedule:register',
    'schedule:manage',
    // UI
    'ui:register-widget',
    'ui:notify',
    // Tasks
    'tasks:create',
    'tasks:read',
    'tasks:read-all',
    // Events
    'events:subscribe',
    'events:publish',
    // Storage
    'storage:read',
    'storage:write',
    // §20 — UserSelf
    'self:read',
    'self:write',
    // §18 — Audit
    'audit:read',
    // §21 — Identity
    'identity:present',
    // §22 — A2A
    'a2a:delegate',
    // §24 — Model
    'model:override',
    // Prompts
    'prompts:register',
    'prompts:read',
    // Context
    'context:register',
    'context:write',
    'context:read',
])

// ---------------------------------------------------------------------------
// Validation types
// ---------------------------------------------------------------------------

export interface ValidationError {
    field: string
    message: string
    severity?: 'error' | 'warning'
}

export interface ValidationResult {
    valid: boolean
    errors: ValidationError[]
}

export interface ValidationOptions {
    /** Host compliance level — affects which capabilities are valid */
    hostComplianceLevel?: HostComplianceLevel
    /**
     * Install source context. When set to `'sideload'` the validator applies
     * the sideload capability ceiling (rejects owner-only tokens regardless of
     * the declared `trust` value). Default: `'registry'`.
     */
    source?: 'registry' | 'sideload'
}

/**
 * Capability tokens that require `trust: 'owner'` and can never be granted to a
 * sideloaded extension. Kept in sync with `TrustTierCeilings` in `types/trust.ts`.
 */
const OWNER_ONLY_CAPABILITIES = new Set<string>([
    'memory:read:*',
    'memory:write:*',
    'audit:read',
    'model:override',
])

/**
 * Capabilities considered "universally safe" — rationale is always optional
 * for these, even at verified/owner tier. Everything else that verified/owner
 * extensions request must have a rationale.
 */
const RATIONALE_OPTIONAL_CAPABILITIES = new Set<string>([
    'storage:read',
    'storage:write',
    'events:subscribe',
    'events:publish',
    'ui:register-widget',
    'ui:notify',
    'identity:present',
    'prompts:register',
    'prompts:read',
    'context:register',
    'context:read',
    'schedule:register',
])

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

export function validateManifest(raw: unknown, options?: ValidationOptions): ValidationResult {
    const errors: ValidationError[] = []
    const complianceLevel = options?.hostComplianceLevel ?? 'core'
    const installSource = options?.source ?? 'registry'

    if (typeof raw !== 'object' || raw === null) {
        return { valid: false, errors: [{ field: 'root', message: 'Manifest must be a JSON object' }] }
    }

    const m = raw as Record<string, unknown>

    // plexo version
    if (typeof m['plexo'] !== 'string' || !isSemver(m['plexo'])) {
        errors.push({ field: 'plexo', message: 'Must be a valid semver string (e.g. "0.4.0")' })
    }

    // name — @scope/name format
    if (typeof m['name'] !== 'string' || !isValidPackageName(m['name'])) {
        errors.push({ field: 'name', message: 'Must match @scope/name format (lowercase alphanumeric, hyphens, dots allowed)' })
    }

    // version
    if (typeof m['version'] !== 'string' || !isSemver(m['version'])) {
        errors.push({ field: 'version', message: 'Must be a valid semver string' })
    }

    // type
    const rawType = m['type'] as string
    if (LEGACY_TYPES.has(rawType)) {
        const replacement = rawType === 'function' ? 'tool (or skill)' : 'connector'
        errors.push({
            field: 'type',
            message: `Type "${rawType}" is deprecated in v0.4.0. Use "${replacement}" instead.`,
            severity: 'warning',
        })
    } else if (!VALID_TYPES.includes(rawType as ManifestType)) {
        errors.push({ field: 'type', message: `Must be one of: ${VALID_TYPES.join(', ')}` })
    }

    // entry
    if (typeof m['entry'] !== 'string' || m['entry'].length === 0) {
        errors.push({ field: 'entry', message: 'Must be a non-empty string path to the entry point' })
    }

    // capabilities
    if (!Array.isArray(m['capabilities'])) {
        errors.push({ field: 'capabilities', message: 'Must be an array of capability token strings' })
    } else {
        ; (m['capabilities'] as unknown[]).forEach((cap, i) => {
            if (typeof cap !== 'string') {
                errors.push({ field: `capabilities[${i}]`, message: 'Each capability must be a string' })
                return
            }

            if (!isValidCapability(cap)) {
                errors.push({
                    field: `capabilities[${i}]`,
                    message: `Unknown capability token "${cap}". Must be a standard token, entity-scoped memory, connections:<service>, or host:<hostname>:<capability>`,
                })
                return
            }

            if (isHostScopedCapability(cap)) {
                errors.push({
                    field: `capabilities[${i}]`,
                    message: `Host-scoped capability "${cap}" is not validated by this tool. The target host must confirm this token is supported.`,
                    severity: 'warning',
                })
            }

            // §4 — Reject unscoped memory at Standard + Full compliance
            if (isUnscopedMemoryCapability(cap) && (complianceLevel === 'standard' || complianceLevel === 'full')) {
                errors.push({
                    field: `capabilities[${i}]`,
                    message: `Unscoped memory capability "${cap}" is invalid at ${complianceLevel} compliance. Use entity-scoped tokens (e.g. memory:read:person, memory:write:task).`,
                })
            }

            // §17 — Wildcard memory only for owner tier
            if (isWildcardMemoryCapability(cap)) {
                const trust = m['trust'] as string | undefined
                if (trust !== 'owner') {
                    errors.push({
                        field: `capabilities[${i}]`,
                        message: `Wildcard memory capability "${cap}" is only allowed at trust tier: owner. Declared trust: ${trust ?? 'none'}`,
                    })
                }
            }

            // §17 — audit:read only for owner tier
            if (cap === 'audit:read') {
                const trust = m['trust'] as string | undefined
                if (trust !== 'owner') {
                    errors.push({
                        field: `capabilities[${i}]`,
                        message: `audit:read capability is only allowed at trust tier: owner. Declared trust: ${trust ?? 'none'}`,
                    })
                }
            }

            // §8 / sideload ceiling — owner-only tokens can never appear on a
            // sideloaded manifest. The host also downgrades `trust` to `local`
            // before install, so these capabilities would otherwise slip past
            // the per-tier checks above.
            if (installSource === 'sideload' && OWNER_ONLY_CAPABILITIES.has(cap)) {
                errors.push({
                    field: `capabilities[${i}]`,
                    message: `Capability "${cap}" is restricted to owner-tier extensions and cannot be used in a sideloaded install.`,
                })
            }
        })
    }

    // §3.3 — capabilitiesRationale enforcement
    const trustValue = m['trust'] as TrustTier | undefined
    const capabilitiesList = Array.isArray(m['capabilities'])
        ? (m['capabilities'] as unknown[]).filter((c): c is string => typeof c === 'string')
        : []
    const rationale = m['capabilitiesRationale']
    if (rationale !== undefined) {
        if (typeof rationale !== 'object' || rationale === null || Array.isArray(rationale)) {
            errors.push({
                field: 'capabilitiesRationale',
                message: 'Must be an object mapping capability tokens to explanation strings',
            })
        } else {
            const r = rationale as Record<string, unknown>
            for (const [token, explanation] of Object.entries(r)) {
                if (!capabilitiesList.includes(token)) {
                    errors.push({
                        field: `capabilitiesRationale.${token}`,
                        message: `Rationale declared for "${token}" but the capability is not in capabilities[]`,
                    })
                    continue
                }
                if (typeof explanation !== 'string') {
                    errors.push({
                        field: `capabilitiesRationale.${token}`,
                        message: 'Rationale value must be a string',
                    })
                    continue
                }
                if (explanation.length === 0) {
                    errors.push({
                        field: `capabilitiesRationale.${token}`,
                        message: 'Rationale value must be non-empty',
                    })
                } else if (explanation.length > 200) {
                    errors.push({
                        field: `capabilitiesRationale.${token}`,
                        message: 'Rationale must be 200 characters or fewer',
                    })
                }
            }
        }
    }

    // Verified + owner tier extensions MUST explain each non-trivial capability.
    // Sideload (`local`) and community extensions get a warning only.
    if (trustValue === 'owner' || trustValue === 'verified') {
        const r = (rationale && typeof rationale === 'object' && !Array.isArray(rationale))
            ? (rationale as Record<string, unknown>)
            : {}
        for (const token of capabilitiesList) {
            if (RATIONALE_OPTIONAL_CAPABILITIES.has(token)) continue
            if (typeof r[token] !== 'string' || (r[token] as string).length === 0) {
                errors.push({
                    field: 'capabilitiesRationale',
                    message: `Capability "${token}" requires a rationale entry for trust tier "${trustValue}". Add capabilitiesRationale["${token}"].`,
                })
            }
        }
    } else if (trustValue === 'community' && capabilitiesList.length > 0) {
        const r = (rationale && typeof rationale === 'object' && !Array.isArray(rationale))
            ? (rationale as Record<string, unknown>)
            : {}
        for (const token of capabilitiesList) {
            if (RATIONALE_OPTIONAL_CAPABILITIES.has(token)) continue
            if (typeof r[token] !== 'string' || (r[token] as string).length === 0) {
                errors.push({
                    field: 'capabilitiesRationale',
                    message: `Capability "${token}" has no rationale — community extensions are strongly encouraged to explain each capability.`,
                    severity: 'warning',
                })
            }
        }
    }

    // displayName
    if (typeof m['displayName'] !== 'string' || m['displayName'].length === 0) {
        errors.push({ field: 'displayName', message: 'Must be a non-empty string' })
    } else if (m['displayName'].length > DISPLAY_NAME_MAX) {
        errors.push({ field: 'displayName', message: `Must be ${DISPLAY_NAME_MAX} characters or fewer` })
    }

    // description
    if (typeof m['description'] !== 'string') {
        errors.push({ field: 'description', message: 'Must be a string' })
    } else if (m['description'].length > 280) {
        errors.push({ field: 'description', message: 'Must be 280 characters or fewer' })
    }

    // author
    if (typeof m['author'] !== 'string' || m['author'].length === 0) {
        errors.push({ field: 'author', message: 'Must be a non-empty string' })
    }

    // license
    if (typeof m['license'] !== 'string' || m['license'].length === 0) {
        errors.push({ field: 'license', message: 'Must be a valid SPDX license identifier' })
    }

    // Optional: keywords limit
    if (m['keywords'] !== undefined) {
        if (!Array.isArray(m['keywords'])) {
            errors.push({ field: 'keywords', message: 'Must be an array of strings' })
        } else if ((m['keywords'] as unknown[]).length > 10) {
            errors.push({ field: 'keywords', message: 'Max 10 keywords allowed' })
        }
    }

    // Optional: screenshots limit
    if (m['screenshots'] !== undefined) {
        if (!Array.isArray(m['screenshots'])) {
            errors.push({ field: 'screenshots', message: 'Must be an array of HTTPS URLs' })
        } else if ((m['screenshots'] as unknown[]).length > 5) {
            errors.push({ field: 'screenshots', message: 'Max 5 screenshots allowed' })
        }
    }

    // connector requires mcpServer config
    if (m['type'] === 'connector' && m['mcpServer'] === undefined) {
        errors.push({ field: 'mcpServer', message: 'Required for connector type extensions' })
    }

    // channelTransport validation — only valid for channel type
    if (m['channelTransport'] !== undefined) {
        if (m['type'] !== 'channel') {
            errors.push({ field: 'channelTransport', message: 'channelTransport is only valid for channel type extensions' })
        } else if (m['channelTransport'] !== 'worker' && m['channelTransport'] !== 'api') {
            errors.push({ field: 'channelTransport', message: 'Must be "worker" or "api"' })
        }
    }

    // §17 — trust tier validation
    if (m['trust'] !== undefined) {
        if (!VALID_TRUST_TIERS.includes(m['trust'] as TrustTier)) {
            errors.push({ field: 'trust', message: `Must be one of: ${VALID_TRUST_TIERS.join(', ')}` })
        }
    }

    // §19 — Data residency validation
    if (m['dataResidency'] !== undefined) {
        validateDataResidency(m['dataResidency'], errors)
    } else if (complianceLevel === 'full') {
        errors.push({
            field: 'dataResidency',
            message: 'dataResidency is required at Full compliance. Omission treated as sendsDataExternally: true with unknown destinations.',
            severity: 'warning',
        })
    }

    // §23 — Escalation declaration for agents
    if (m['type'] === 'agent' && m['escalation'] !== undefined) {
        validateEscalation(m['escalation'], errors)
    }

    // §24 — Model requirements validation
    if (m['modelRequirements'] !== undefined) {
        validateModelRequirements(m['modelRequirements'], errors)
    }

    // Only hard errors count for validity
    const hardErrors = errors.filter((e) => e.severity !== 'warning')
    return { valid: hardErrors.length === 0, errors }
}

// ---------------------------------------------------------------------------
// Sub-validators
// ---------------------------------------------------------------------------

function validateDataResidency(dr: unknown, errors: ValidationError[]) {
    if (typeof dr !== 'object' || dr === null) {
        errors.push({ field: 'dataResidency', message: 'Must be an object' })
        return
    }
    const obj = dr as Record<string, unknown>
    if (typeof obj['sendsDataExternally'] !== 'boolean') {
        errors.push({ field: 'dataResidency.sendsDataExternally', message: 'Must be a boolean' })
    }
    if (obj['sendsDataExternally'] === true && !Array.isArray(obj['externalDestinations'])) {
        errors.push({
            field: 'dataResidency.externalDestinations',
            message: 'Must be provided when sendsDataExternally is true',
        })
    }
}

function validateEscalation(esc: unknown, errors: ValidationError[]) {
    if (typeof esc !== 'object' || esc === null) {
        errors.push({ field: 'escalation', message: 'Must be an object' })
        return
    }
    const obj = esc as Record<string, unknown>
    if (obj['irreversibleActions'] !== undefined && !Array.isArray(obj['irreversibleActions'])) {
        errors.push({ field: 'escalation.irreversibleActions', message: 'Must be an array of strings' })
    }
}

function validateModelRequirements(mr: unknown, errors: ValidationError[]) {
    if (typeof mr !== 'object' || mr === null) {
        errors.push({ field: 'modelRequirements', message: 'Must be an object' })
        return
    }
    const obj = mr as Record<string, unknown>
    if (obj['minimumContextWindow'] !== undefined && typeof obj['minimumContextWindow'] !== 'number') {
        errors.push({ field: 'modelRequirements.minimumContextWindow', message: 'Must be a number' })
    }
    if (obj['localModelAcceptable'] !== undefined && typeof obj['localModelAcceptable'] !== 'boolean') {
        errors.push({ field: 'modelRequirements.localModelAcceptable', message: 'Must be a boolean' })
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isSemver(s: string): boolean {
    return /^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?(\+[a-zA-Z0-9.]+)?$/.test(s)
}

function isValidPackageName(s: string): boolean {
    return /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/.test(s)
}

function isValidCapability(token: string): boolean {
    if (STANDARD_CAPABILITIES.has(token)) return true
    // Entity-scoped memory: memory:read:<type> or memory:write:<type>
    if (/^memory:(read|write):([a-z_]+)$/.test(token)) {
        const entityType = token.split(':')[2]
        if (VALID_ENTITY_TYPES.includes(entityType as EntityTypeName)) return true
    }
    // Entity operations: entity:create:<type>, entity:modify:<type>, entity:delete:<type>
    if (/^entity:(create|modify|delete):([a-z_]+)$/.test(token)) {
        const entityType = token.split(':')[2]
        if (VALID_ENTITY_TYPES.includes(entityType as EntityTypeName)) return true
    }
    // Connections
    if (/^connections:[a-z0-9-]+$/.test(token)) return true
    // Host-scoped
    if (/^host:[a-z0-9-]+:[a-z0-9-:]+$/.test(token)) return true
    return false
}

function isHostScopedCapability(token: string): boolean {
    return /^host:[a-z0-9-]+:[a-z0-9-:]+$/.test(token)
}

function isUnscopedMemoryCapability(token: string): boolean {
    return token === 'memory:read' || token === 'memory:write'
}

function isWildcardMemoryCapability(token: string): boolean {
    return token === 'memory:read:*' || token === 'memory:write:*'
}
