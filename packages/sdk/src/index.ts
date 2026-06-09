// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * @joeybuilt/plexo-sdk — PEX extension SDK types
 *
 * Plexo implements the PEX specification (plexo: "0.4.0").
 * This package exports the protocol types so extensions targeting
 * Plexo use the same contract.
 *
 * Extensions should import from '@joeybuilt/plexo-sdk' in their plexo.json entry point:
 *   import type { PlexoSDK } from '@joeybuilt/plexo-sdk'
 *   export async function activate(sdk: PlexoSDK): Promise<void> { ... }
 *
 * Host compliance: Standard (target)
 * PEX spec version: 0.4.0
 *
 * Core Architecture — Three Distinct Pillars:
 *   Connection  — Authenticated pipe to an external service
 *   Extension   — Capability package (tools + schedules + widgets + memory)
 *   Agent       — Autonomous actor that orchestrates Extensions
 */

// ---------------------------------------------------------------------------
// §3 — Manifest types
// ---------------------------------------------------------------------------
export type {
    ExtensionManifest,
    ManifestType,
    ExtensionSubtype,
    ExtensionType,          // deprecated — use ManifestType
    CapabilityToken,
    EntityTypeName,
    HostComplianceLevel,
    MCPServerConfig,
    AgentHints,
    ResourceHints,
    JSONSchema,
    BehaviorRuleDefinition,
    AgentStackManifest,
} from './types/manifest.js'

// ---------------------------------------------------------------------------
// Appendix A — SDK interface
// ---------------------------------------------------------------------------
export type {
    PlexoSDK,
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

// ---------------------------------------------------------------------------
// §6 — Message protocol
// ---------------------------------------------------------------------------
export type {
    PexMessage,
    PexError,
    ErrorCode,
    MessageType,
} from './types/messages.js'

// ---------------------------------------------------------------------------
// §7.6 — Prompt Library
// ---------------------------------------------------------------------------
export type {
    PromptArtifact,
    PromptVariable,
    PromptRegistration,
    PromptSummary,
} from './types/prompts.js'

// ---------------------------------------------------------------------------
// §7.7 — Context Layer
// ---------------------------------------------------------------------------
export type {
    ContextArtifact,
    ContextRegistration,
    ContextSummary,
} from './types/context.js'

// ---------------------------------------------------------------------------
// §8 — Agent contract
// ---------------------------------------------------------------------------
export type {
    AgentExtension,
    Plan,
    PlanStep,
    StepResult,
    ShouldActivateResult,
    OneWayDoor,
    OneWayDoorType,
    EscalationReason,
    EscalationResponse,
    ToolCall,
} from './types/agent.js'

// ---------------------------------------------------------------------------
// §2.3, §9.2 — Channel contract
// ---------------------------------------------------------------------------
export type {
    ChannelExtension,
    ChannelHealthResult,
    ChannelSendResult,
    PexVersion,
    ChannelType,
    ConnectionState,
    ChannelAttachmentRef,
    ChannelMessage,
    ChannelThread,
    ChannelDescriptor,
    PairedConnectionDescriptor,
    ChannelEvent,
    ChannelSubscription,
    ChannelScope,
    ChannelSendRequest,
    ChannelMessagePage,
    ChannelThreadPage,
} from './types/channel.js'
export { PEX_VERSION } from './types/channel.js'

// ---------------------------------------------------------------------------
// ADR-0002 — Channel subscription runtime client
// ---------------------------------------------------------------------------
export { createChannelClient } from './channel-client.js'
export type {
    ChannelClient,
    ChannelClientOptions,
} from './channel-client.js'

// ---------------------------------------------------------------------------
// §7.4 — Event bus
// ---------------------------------------------------------------------------
export { TOPICS, customTopic } from './types/events.js'
export type {
    StandardTopic,
    TaskCreatedPayload,
    TaskCompletedPayload,
    TaskFailedPayload,
    TaskBlockedPayload,
    ChannelMessageReceivedPayload,
    ChannelHealthChangedPayload,
    ExtensionActivatedPayload,
    ExtensionDeactivatedPayload,
    ExtensionCrashedPayload,
    ConnectionAddedPayload,
    ConnectionRemovedPayload,
    MemoryWrittenPayload,
    // v0.3.0 payloads
    EntityCreatedPayload,
    EntityModifiedPayload,
    EntityDeletedPayload,
    EntityLinkedPayload,
    EscalationTriggeredPayload,
    EscalationResolvedPayload,
    EscalationTimedOutPayload,
    AuditEntryCreatedPayload,
    SelfUpdatedPayload,
    SelfProposalReceivedPayload,
    AgentActivatedPayload,
    AgentDeactivatedPayload,
    AgentPlanCreatedPayload,
    AgentStepCompletedPayload,
    AgentStepFailedPayload,
    A2AInboundReceivedPayload,
    A2ADelegationSentPayload,
    A2ADelegationCompletedPayload,
    // v0.4.0 payloads
    PromptRegisteredPayload,
    PromptEnabledPayload,
    ContextRegisteredPayload,
    ContextUpdatedPayload,
    ContextExpiredPayload,
} from './types/events.js'

// ---------------------------------------------------------------------------
// §16 — Personal Entity Schema
// ---------------------------------------------------------------------------
export type {
    PersonEntity,
    TaskEntity,
    ThreadEntity,
    NoteEntity,
    TransactionEntity,
    CalendarEventEntity,
    FileEntity,
    PlexoEntity,
    EntityTypeMap,
    LinkedEntity,
    EntitySearchQuery,
    EntitySearchResult,
} from './types/entities.js'

// ---------------------------------------------------------------------------
// §17 — Trust Tiers
// ---------------------------------------------------------------------------
export type {
    TrustTier,
    TrustTierPolicy,
    TrustTierCeilings,
} from './types/trust.js'

// ---------------------------------------------------------------------------
// §18 — Audit Trail
// ---------------------------------------------------------------------------
export type {
    AuditEntry,
    AuditAction,
    AuditOutcome,
    AuditQuery,
    AuditQueryResult,
    EscalationOutcome,
} from './types/audit.js'

// ---------------------------------------------------------------------------
// §19 — Data Residency
// ---------------------------------------------------------------------------
export type {
    DataResidencyDeclaration,
    ExternalDestination,
} from './types/data-residency.js'

// ---------------------------------------------------------------------------
// §20 — Persistent UserSelf
// ---------------------------------------------------------------------------
export type {
    UserSelf,
    UserSelfField,
    UserIdentity,
    UserCommunicationStyle,
    UserContext,
    UserSelfProposal,
    UserSelfConflictResolution,
} from './types/user-self.js'

// ---------------------------------------------------------------------------
// §21 — DID + Verifiable Credentials
// ---------------------------------------------------------------------------
export type {
    PlexoDIDDocument,
    PlexoVerifiableCredential,
    SelectiveDisclosureRequest,
    SelectiveDisclosureResponse,
} from './types/did.js'

// ---------------------------------------------------------------------------
// §22 — A2A Bridge Layer
// ---------------------------------------------------------------------------
export type {
    A2AAgentCard,
    A2ATask,
    A2ATaskStatus,
    A2ATaskResult,
    A2AInboundRequest,
    A2ADelegation,
} from './types/a2a.js'

// ---------------------------------------------------------------------------
// §23 — Human Oversight & Escalation Contract
// ---------------------------------------------------------------------------
export type {
    EscalationTrigger,
    EscalationRequest,
    EscalationUserResponse,
    EscalationResult,
    StandingApproval,
    EscalationDeclaration,
} from './types/escalation.js'

// ---------------------------------------------------------------------------
// §24 — LLM Identity & Model Context
// ---------------------------------------------------------------------------
export type {
    ModelRequirements,
    ModelContextEntry,
} from './types/model-context.js'

// ---------------------------------------------------------------------------
// §25 — Plexo-Native Service Discovery
// ---------------------------------------------------------------------------
export type {
    WellKnownPlexo,
    WellKnownExtensionRef,
    ServiceDiscoveryResult,
} from './types/discovery.js'

// ---------------------------------------------------------------------------
// ADR 0001 §5 — Connection & Profile Standard contract version
// ---------------------------------------------------------------------------
export { PEX_CONTRACT_VERSION, isContractCompatible } from './contract.js'

// ---------------------------------------------------------------------------
// §3.3 — Manifest validation
// ---------------------------------------------------------------------------
export { validateManifest } from './validation/manifest.js'
export type { ValidationResult, ValidationError, ValidationOptions } from './validation/manifest.js'

// ---------------------------------------------------------------------------
// Phase F — graphiti per-app schema registry (ADR 0029)
// ---------------------------------------------------------------------------
export {
    PLEXO_SCHEMA,
    LEVIO_SCHEMA,
    HELM_SCHEMA,
    SCHEMA_REGISTRY,
    getAppSchema,
    graphName,
    validateNode,
    validateEdge,
} from './graphiti-schema.js'
export type {
    AppSchema,
    LabelSchema,
    EdgeSchema,
    ValidationResult as GraphitiSchemaValidationResult,
} from './graphiti-schema.js'

// ---------------------------------------------------------------------------
// §3.3 — Signature verification (stub v1)
// ---------------------------------------------------------------------------
export { verifySignature } from './validation/signature.js'
export type {
    SignatureMetadata,
    SignatureType,
    SignatureVerificationResult,
} from './validation/signature.js'
