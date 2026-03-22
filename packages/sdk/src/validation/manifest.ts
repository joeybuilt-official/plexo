// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Kapsel manifest validation
 * Corresponds to §3.3 of the Kapsel Protocol Specification v0.3.0
 *
 * Used by:
 * - POST /api/plugins (host install validation)
 * - @kapsel/cli (publish validation)
 */

import type { ManifestType, CapabilityToken, HostComplianceLevel, EntityTypeName } from '../types/manifest.js'
import type { TrustTier } from '../types/trust.js'

// ---------------------------------------------------------------------------
// Valid values
// ---------------------------------------------------------------------------

const VALID_TYPES: ManifestType[] = ['agent', 'function', 'channel', 'mcp-server']
const LEGACY_TYPES = new Set(['tool', 'skill'])

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
}

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

export function validateManifest(raw: unknown, options?: ValidationOptions): ValidationResult {
    const errors: ValidationError[] = []
    const complianceLevel = options?.hostComplianceLevel ?? 'core'

    if (typeof raw !== 'object' || raw === null) {
        return { valid: false, errors: [{ field: 'root', message: 'Manifest must be a JSON object' }] }
    }

    const m = raw as Record<string, unknown>

    // kapsel version
    if (typeof m['kapsel'] !== 'string' || !isSemver(m['kapsel'])) {
        errors.push({ field: 'kapsel', message: 'Must be a valid semver string (e.g. "0.3.0")' })
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
        const replacement = rawType === 'tool' ? 'function' : 'function (or channel / mcp-server)'
        errors.push({
            field: 'type',
            message: `Type "${rawType}" is deprecated in v0.3.0. Use "${replacement}" instead.`,
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
        })
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

    // mcp-server requires mcpServer config
    if (m['type'] === 'mcp-server' && m['mcpServer'] === undefined) {
        errors.push({ field: 'mcpServer', message: 'Required for mcp-server type extensions' })
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
