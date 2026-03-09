// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Shared types for the Agent Behavior Configuration system (Phase 5).
 * These mirror the DB enums and are used by the resolver, compiler, and UI.
 */

export type RuleType =
    | 'safety_constraint'
    | 'operational_rule'
    | 'communication_style'
    | 'domain_knowledge'
    | 'persona_trait'
    | 'tool_preference'
    | 'quality_gate'

export type RuleSource = 'platform' | 'workspace' | 'project' | 'task'

export type RuleValue =
    | { type: 'boolean'; value: boolean }
    | { type: 'string'; value: string }
    | { type: 'number'; value: number; min?: number; max?: number }
    | { type: 'enum'; value: string; options: string[] }
    | { type: 'text_block'; value: string }
    | { type: 'json'; value: unknown }

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
    overridesRuleId: string | null
    tags: string[]
    deletedAt: Date | null
    createdAt: Date
    updatedAt: Date
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
    /** Which scope overrode this rule (if any child overrode a parent) */
    overriddenBy: { ruleId: string; source: RuleSource } | null
}

export interface ResolvedBehavior {
    workspaceId: string
    projectId: string | null
    resolvedAt: Date
    rules: ResolvedRule[]
    /** Full compiled system prompt fragment */
    compiledPrompt: string
}

export interface BehaviorGroupDef {
    id: string
    label: string
    description: string
    icon: string  // Lucide icon name
    ruleTypes: RuleType[]
    locked: boolean
    color: string
    displayOrder: number
}

// ── Platform defaults (seeded constants, not in DB) ───────────────────────────

export const PLATFORM_DEFAULT_GROUPS: BehaviorGroupDef[] = [
    {
        id: 'safety',
        label: 'Safety Constraints',
        description: 'Non-negotiable structural limits enforced on every task.',
        icon: 'Shield',
        ruleTypes: ['safety_constraint'],
        locked: true,
        color: 'red',
        displayOrder: 0,
    },
    {
        id: 'operational',
        label: 'Operational Rules',
        description: 'How the agent executes work — retry logic, confirmation thresholds, step limits.',
        icon: 'Settings2',
        ruleTypes: ['operational_rule'],
        locked: false,
        color: 'amber',
        displayOrder: 1,
    },
    {
        id: 'communication',
        label: 'Communication Style',
        description: 'Tone, verbosity, formality, and response format preferences.',
        icon: 'MessageSquare',
        ruleTypes: ['communication_style'],
        locked: false,
        color: 'blue',
        displayOrder: 2,
    },
    {
        id: 'domain',
        label: 'Domain Knowledge',
        description: 'Project-specific context the agent always carries into tasks.',
        icon: 'BookOpen',
        ruleTypes: ['domain_knowledge'],
        locked: false,
        color: 'green',
        displayOrder: 3,
    },
    {
        id: 'persona',
        label: 'Persona',
        description: 'Personality traits, expertise emphasis, and character.',
        icon: 'Sparkles',
        ruleTypes: ['persona_trait'],
        locked: false,
        color: 'purple',
        displayOrder: 4,
    },
    {
        id: 'tools',
        label: 'Tool Preferences',
        description: 'Which tools to prefer or avoid for given task types.',
        icon: 'Wrench',
        ruleTypes: ['tool_preference'],
        locked: false,
        color: 'slate',
        displayOrder: 5,
    },
    {
        id: 'quality',
        label: 'Quality Gates',
        description: 'Custom evaluation rubric additions per task type.',
        icon: 'Target',
        ruleTypes: ['quality_gate'],
        locked: false,
        color: 'orange',
        displayOrder: 6,
    },
]

export const PLATFORM_DEFAULT_RULES: Omit<BehaviorRule, 'id' | 'workspaceId' | 'projectId' | 'overridesRuleId' | 'deletedAt' | 'createdAt' | 'updatedAt'>[] = [
    {
        type: 'safety_constraint',
        key: 'never_output_secrets',
        label: 'Never output secrets',
        description: 'The agent must never include credentials, API keys, tokens, or passwords in any tool call or message.',
        value: { type: 'boolean', value: true },
        locked: true,
        source: 'platform',
        tags: ['security'],
    },
    {
        type: 'safety_constraint',
        key: 'confirm_destructive_ops',
        label: 'Confirm destructive operations',
        description: 'File deletions, database drops, and irreversible API calls require OWD approval.',
        value: { type: 'boolean', value: true },
        locked: true,
        source: 'platform',
        tags: ['security', 'ood'],
    },
    {
        type: 'operational_rule',
        key: 'max_retries',
        label: 'Max retries per step',
        description: 'Number of times the agent retries a failed tool call before aborting the step.',
        value: { type: 'number', value: 3, min: 1, max: 10 },
        locked: false,
        source: 'platform',
        tags: [],
    },
    {
        type: 'communication_style',
        key: 'response_verbosity',
        label: 'Response verbosity',
        description: 'How detailed the agent\'s task completion summaries should be.',
        value: { type: 'enum', value: 'concise', options: ['minimal', 'concise', 'detailed', 'verbose'] },
        locked: false,
        source: 'platform',
        tags: [],
    },
]
