// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Session Fabric — policy contract + evaluation (Phase 1c / D9, pure domain).
 *
 * Rules are DECLARATIVE and passed in; loading a rule document is an adapter
 * concern. `evaluatePolicy` is a pure, deterministic first-match resolver.
 */

import { z } from 'zod'
import { policyTier } from './contract'
import { tierAtLeast, type Tier } from './tiers'

export const policyDecision = z.enum(['allow', 'gate', 'deny'])
export type PolicyDecision = z.infer<typeof policyDecision>

export const policyMatch = z.object({
    tool: z.string().optional(),
    cmd_pattern: z.string().optional(),
    cwd: z.string().optional(),
    path_glob: z.string().optional(),
})
export type PolicyMatch = z.infer<typeof policyMatch>

export const policyRule = z.object({
    id: z.string(),
    match: policyMatch,
    tier: policyTier.optional(),
    decision: policyDecision,
    teach: z.string().optional(),
})
export type PolicyRule = z.infer<typeof policyRule>

export const policyDocument = z.object({
    version: z.number().int().positive(),
    rules: z.array(policyRule),
})
export type PolicyDocument = z.infer<typeof policyDocument>

export interface PolicyAction {
    tool?: string
    cmd?: string
    cwd?: string
    path?: string
}

export interface PolicyEvaluation {
    decision: PolicyDecision
    teach?: string
    ruleId?: string
}

function globToRegExp(glob: string): RegExp {
    // Single pass, no sentinel: escape regex metachars, translate ** -> .* and * -> [^/]*.
    let out = ''
    for (let i = 0; i < glob.length; i += 1) {
        const c = glob[i]!
        if (c === '*') {
            if (glob[i + 1] === '*') { out += '.*'; i += 1 } else { out += '[^/]*' }
        } else if ('.+^${}()|[]\\'.includes(c)) {
            out += `\\${c}`
        } else {
            out += c
        }
    }
    return new RegExp(`^${out}$`)
}

function matches(rule: PolicyRule, action: PolicyAction): boolean {
    const m = rule.match
    if (m.tool !== undefined && m.tool !== action.tool) return false
    if (m.cmd_pattern !== undefined) {
        if (action.cmd === undefined) return false
        try {
            if (!new RegExp(m.cmd_pattern).test(action.cmd)) return false
        } catch {
            return false
        }
    }
    if (m.cwd !== undefined) {
        if (action.cwd === undefined || !action.cwd.startsWith(m.cwd)) return false
    }
    if (m.path_glob !== undefined) {
        if (action.path === undefined || !globToRegExp(m.path_glob).test(action.path)) return false
    }
    return true
}

/** Hard cap on any action field the (operator-authored) regexes run against. */
export const MAX_ACTION_FIELD_LEN = 16_384

/**
 * First matching rule wins (rule order is authoritative). No match → allow.
 * A matched `allow` rule carrying a `tier` requirement the actor cannot meet
 * is downgraded to `gate` (needs elevation/approval); `deny` is never softened.
 * Over-length input fails CLOSED to `gate` — never silently allowed and never
 * fed to a backtracking regex (defense-in-depth vs ReDoS, beyond the route cap).
 */
export function evaluatePolicy(action: PolicyAction, tier: Tier, rules: readonly PolicyRule[]): PolicyEvaluation {
    for (const field of [action.tool, action.cmd, action.cwd, action.path]) {
        if (field !== undefined && field.length > MAX_ACTION_FIELD_LEN) {
            return { decision: 'gate', teach: 'action field exceeds evaluable length; manual review required' }
        }
    }
    for (const rule of rules) {
        if (!matches(rule, action)) continue
        let decision = rule.decision
        if (decision === 'allow' && rule.tier !== undefined && !tierAtLeast(tier, rule.tier)) {
            decision = 'gate'
        }
        return { decision, teach: rule.teach, ruleId: rule.id }
    }
    return { decision: 'allow' }
}
