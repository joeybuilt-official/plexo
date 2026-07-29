// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

export type RuleType = 'safety_constraint' | 'operational_rule' | 'communication_style' | 'domain_knowledge' | 'persona_trait' | 'tool_preference' | 'quality_gate'
export type RuleSource = 'platform' | 'workspace' | 'project' | 'task'

export interface RuleValue {
    type: 'boolean' | 'string' | 'number' | 'enum' | 'text_block' | 'json'
    value: unknown
    options?: string[]
    min?: number
    max?: number
}

export interface BehaviorRule {
    id: string
    workspaceId: string
    projectId: string | null
    type: RuleType
    key: string
    label: string
    description: string
    value: RuleValue
    locked: boolean
    source: RuleSource
    tags: string[]
    createdAt: string
    updatedAt: string
}

export interface ResolvedRule {
    key: string
    label: string
    description: string
    type: RuleType
    value: RuleValue
    locked: boolean
    effectiveSource: RuleSource
    ruleId: string
    overriddenBy: { ruleId: string; source: RuleSource } | null
}

export interface GroupDef {
    id: string
    label: string
    description: string
    icon: string
    ruleTypes: RuleType[]
    locked: boolean
    color: string
    displayOrder: number
}

export interface WorkspaceSettings {
    defaultModel?: string
    maxStepsPerTask?: number
    tokenBudgetPerTask?: number
    maxRetries?: number
    costCeilingUsd?: number
    autoApproveThreshold?: number
    safeMode?: boolean
    systemPromptExtra?: string
    agentName?: string
    agentTagline?: string
    agentAvatar?: string
    agentPersona?: string
    ensembleSize?: number
    dissentThreshold?: number
    /** Read-only mode: strip write tools from the agent, block mutation (Phase 9). */
    readOnlyMode?: boolean
}

export interface Snapshot {
    id: string
    compiledPrompt: string
    triggeredBy: string
    triggerResourceId: string | null
    createdAt: string
}

export interface UserSelfData {
    identity?: { name?: string; timezone?: string; locale?: string; primaryEmail?: string }
    communicationStyle?: { formality?: string; verbosity?: string; preferredChannels?: string[] }
    relationships?: string[]
    contexts?: Record<string, { summary: string; lastUpdated: string }>
    preferences?: Record<string, unknown>
}

export const API = (typeof window !== 'undefined' ? '' : ((typeof process !== 'undefined' && process.env.INTERNAL_API_URL) || 'http://localhost:3001'))
