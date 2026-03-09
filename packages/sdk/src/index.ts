// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * @plexo/sdk — Kapsel-compatible extension SDK types
 *
 * Plexo is a Kapsel Standard-compliant host (kapsel: "0.2.0").
 * This package re-exports the Kapsel protocol types so extensions
 * targeting Plexo use the same contract as any other Kapsel host.
 *
 * Extensions should import from '@plexo/sdk' in their kapsel.json entry point:
 *   import type { KapselSDK } from '@plexo/sdk'
 *   export async function activate(sdk: KapselSDK): Promise<void> { ... }
 *
 * Host compliance: Standard (target)
 * Spec version: 0.2.0
 */

// Manifest types (§3 of the spec)
export type {
    KapselManifest,
    ExtensionType,
    CapabilityToken,
    HostComplianceLevel,
    MCPServerConfig,
    AgentHints,
    ResourceHints,
    JSONSchema,
} from './types/manifest.js'

// SDK interface (Appendix A)
export type {
    KapselSDK,
    HostInfo,
    MemoryEntry,
    ConnectionCredentials,
    ScheduleRegistration,
    WidgetRegistration,
    ToolRegistration,
    ToolSummary,
    InvokeContext,
    NotificationLevel,
    TaskCreateOptions,
    TaskFilter,
} from './types/sdk.js'

// Message protocol (§6)
export type {
    KapselMessage,
    KapselError,
    ErrorCode,
    MessageType,
} from './types/messages.js'

// Agent contract (§8)
export type {
    AgentExtension,
    Plan,
    PlanStep,
    StepResult,
    ShouldActivateResult,
} from './types/agent.js'

// Manifest validation (used by host on install, §3.3)
export { validateManifest } from './validation/manifest.js'
export type { ValidationResult, ValidationError } from './validation/manifest.js'
