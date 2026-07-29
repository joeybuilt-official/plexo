// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Skill+ type definitions.
 *
 * Standard SKILL.md fields follow the Agent Skills open standard.
 * Fields under the `runtime: plexo` key activate Skill+ extended features.
 */

/** Standard SKILL.md frontmatter (Agent Skills open standard) */
export interface SkillFrontmatter {
    name: string
    description: string
    /** 'auto' = Claude loads when relevant, 'manual' = user must invoke */
    invocation?: 'auto' | 'manual'
    /** Glob patterns — skill auto-loads when editing matching files */
    globs?: string[]
    /** Tool allowlist for this skill */
    'allowed-tools'?: string
    /** If true, only user can invoke (not model) */
    'disable-model-invocation'?: boolean
    /** If true, user can invoke via /skill-name */
    'user-invocable'?: boolean
    /** Model override for this skill */
    model?: string
    /** Effort level override */
    effort?: 'low' | 'medium' | 'high' | 'max'
    /** Run in subagent context */
    context?: 'fork'
    /** Subagent type */
    agent?: string
    /** File patterns for context */
    paths?: string[]
    /** Shell type */
    shell?: 'bash' | 'powershell'
    /** Argument hint for CLI */
    'argument-hint'?: string
    /** Tags for discovery */
    tags?: string[]
    /** Version */
    version?: string
    /** Author */
    author?: string
}

/** Skill+ extended frontmatter (Plexo-specific, activated by `runtime: plexo`) */
export interface SkillPlusFrontmatter extends SkillFrontmatter {
    /** Must be 'plexo' to activate Skill+ features */
    runtime: 'plexo'
    /** Fine-grained capability tokens (e.g., 'memory:read', 'connections:stripe') */
    capabilities?: string[]
    /** Resource limits for sandboxed execution */
    resource_limits?: {
        max_memory_mb?: number
        timeout_ms?: number
        max_cpu_shares?: number
    }
    /** Trust tier for verification */
    trust_tier?: 'community' | 'verified' | 'official'
    /** Enable persistent worker (stateful extension) */
    persistent?: boolean
    /** Escalation contract for destructive actions */
    escalation?: {
        channel?: string
        require_approval?: string[]
    }
    /** Entry point for code-based Skill+ extensions */
    entry?: string
}

/** Result of parsing a SKILL.md file */
export interface ParsedSkillMd {
    /** Parsed YAML frontmatter */
    frontmatter: SkillFrontmatter | SkillPlusFrontmatter
    /** Raw markdown body (after frontmatter) */
    markdownBody: string
    /** Whether this is a Skill+ extension (has runtime: plexo) */
    isSkillPlus: boolean
}
