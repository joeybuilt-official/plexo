// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * SKILL.md / Skill+ parser.
 *
 * Parses YAML frontmatter from markdown files following the Agent Skills
 * open standard. Detects `runtime: plexo` to activate Skill+ features.
 */

import { parse as parseYaml } from 'yaml'
import type { ParsedSkillMd, SkillFrontmatter, SkillPlusFrontmatter } from './types.js'
import type { ExtensionManifest } from '@joeybuilt/plexo-sdk'

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/

/**
 * Parse a SKILL.md file into structured frontmatter + markdown body.
 * Throws if frontmatter is missing or invalid.
 */
export function parseSkillMd(content: string): ParsedSkillMd {
    const match = content.match(FRONTMATTER_RE)
    if (!match) {
        throw new Error('SKILL.md must start with YAML frontmatter (--- delimited)')
    }

    const rawYaml = match[1]!
    const markdownBody = match[2]!.trim()

    let frontmatter: SkillFrontmatter | SkillPlusFrontmatter
    try {
        frontmatter = parseYaml(rawYaml) as SkillFrontmatter
    } catch (err) {
        throw new Error(`Invalid YAML frontmatter: ${(err as Error).message}`)
    }

    if (!frontmatter || typeof frontmatter !== 'object') {
        throw new Error('YAML frontmatter must be an object')
    }
    if (!frontmatter.name || typeof frontmatter.name !== 'string') {
        throw new Error('SKILL.md frontmatter requires a "name" field')
    }
    if (!frontmatter.description || typeof frontmatter.description !== 'string') {
        throw new Error('SKILL.md frontmatter requires a "description" field')
    }

    const isSkillPlus = (frontmatter as SkillPlusFrontmatter).runtime === 'plexo'

    return { frontmatter, markdownBody, isSkillPlus }
}

/**
 * Synthesize an ExtensionManifest from a parsed SKILL.md.
 * This allows Skill+ extensions to flow through the same installation
 * pipeline as PEX extensions.
 */
export function synthesizeManifest(parsed: ParsedSkillMd): ExtensionManifest {
    const fm = parsed.frontmatter
    const isPlus = parsed.isSkillPlus
    const plusFm = isPlus ? (fm as SkillPlusFrontmatter) : null

    return {
        plexo: '0.4.0',
        name: fm.name,
        version: fm.version ?? '0.1.0',
        type: 'skill',
        entry: plusFm?.entry ?? 'SKILL.md',
        capabilities: plusFm?.capabilities ?? [],
        displayName: fm.name.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
        description: fm.description,
        author: fm.author ?? 'unknown',
        license: 'MIT',
        keywords: fm.tags,
        resourceHints: plusFm?.resource_limits
            ? {
                  maxMemoryMB: plusFm.resource_limits.max_memory_mb,
                  maxInvocationMs: plusFm.resource_limits.timeout_ms,
              }
            : undefined,
    } as ExtensionManifest
}

/**
 * Check if a string looks like SKILL.md content (has YAML frontmatter
 * with at least name and description).
 */
export function isSkillMdContent(content: string): boolean {
    try {
        parseSkillMd(content)
        return true
    } catch {
        return false
    }
}
