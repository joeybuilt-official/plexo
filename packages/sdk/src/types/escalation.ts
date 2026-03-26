// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * §23 — Human Oversight & Escalation Contract
 * Plexo Fabric Specification v0.4.0
 *
 * A formal escalation contract all Agent implementations MUST support.
 * No formal spec for when an Agent must pause and request human approval
 * is a critical governance gap for autonomous software touching email,
 * calendar, and finances.
 *
 * Rules:
 *   - Hosts MUST implement at minimum IRREVERSIBLE_ACTION and CAPABILITY_EXPANSION triggers
 *   - Extensions MUST NOT bypass escalation by splitting irreversible actions
 *     into smaller reversible steps — host detects composite irreversibility
 *   - Standing approval rules are user-owned — Extensions cannot create or modify them
 *   - Escalation timeout: no user response within configured window → action denied and logged
 */

// ---------------------------------------------------------------------------
// Escalation Triggers (host-enforced)
// ---------------------------------------------------------------------------

export type EscalationTrigger =
    | 'HIGH_VALUE_ACTION'        // financial transactions above user-configured threshold
    | 'IRREVERSIBLE_ACTION'      // sending external comms, deleting data, publishing
    | 'NOVEL_PATTERN'            // action type not previously approved by this user
    | 'CONFIDENCE_BELOW'         // agent confidence score below host-configured threshold
    | 'CROSS_BOUNDARY'           // action affects entities outside the user's own data
    | 'CAPABILITY_EXPANSION'     // agent requests a capability not in its original grant

// ---------------------------------------------------------------------------
// Escalation Flow
// ---------------------------------------------------------------------------

export interface EscalationRequest {
    trigger: EscalationTrigger
    /** The action the agent wants to take */
    action: string
    /** Relevant context for the user to make a decision */
    context: unknown
    /** Agent's recommendation (approve/deny) with reasoning */
    recommendation?: {
        decision: 'approve' | 'deny'
        reasoning: string
    }
}

export type EscalationUserResponse = 'approve' | 'deny' | 'approve-and-remember'

export interface EscalationResult {
    response: EscalationUserResponse
    /** User-provided feedback or instructions */
    feedback?: string
    /** Timestamp of user response */
    respondedAt: string  // ISO 8601
}

// ---------------------------------------------------------------------------
// Standing Approval Rules (user-owned)
// ---------------------------------------------------------------------------

export interface StandingApproval {
    id: string
    /** The trigger type this approval covers */
    trigger: EscalationTrigger
    /** Pattern matching for the action (e.g. 'channel:send to @internal/*') */
    actionPattern: string
    /** Who created this rule */
    createdBy: 'user'  // Extensions cannot create these
    createdAt: string   // ISO 8601
    /** Optional expiration */
    expiresAt?: string  // ISO 8601
}

// ---------------------------------------------------------------------------
// Manifest Escalation Declaration (§3 addition)
// ---------------------------------------------------------------------------

export interface EscalationDeclaration {
    /** Actions this extension considers irreversible */
    irreversibleActions?: string[]
    /** Whether this extension requests standing approval capability */
    requestsStandingApprovals?: boolean
}
