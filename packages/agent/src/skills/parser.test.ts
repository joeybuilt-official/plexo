// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { describe, it, expect } from 'vitest'
import { parseSkillMd, synthesizeManifest, isSkillMdContent } from './parser.js'

const STANDARD_SKILL = `---
name: my-skill
description: A standard SKILL.md skill
invocation: auto
globs:
  - "**/*.ts"
tags:
  - typescript
---

# My Skill

This skill helps with TypeScript development.
`

const SKILL_PLUS = `---
name: plexo-research
description: Research agent with persistent state
runtime: plexo
capabilities:
  - memory:read
  - connections:stripe
resource_limits:
  max_memory_mb: 256
  timeout_ms: 30000
trust_tier: verified
persistent: true
entry: src/index.ts
version: 1.2.0
author: Joeybuilt
---

# Research Skill+

Extended skill with Plexo runtime features.
`

const NO_FRONTMATTER = `# Just a markdown file

No frontmatter here.
`

const BAD_YAML = `---
name: [invalid yaml
---

body
`

const MISSING_NAME = `---
description: no name field
---

body
`

describe('parseSkillMd', () => {
    it('parses standard SKILL.md', () => {
        const result = parseSkillMd(STANDARD_SKILL)
        expect(result.frontmatter.name).toBe('my-skill')
        expect(result.frontmatter.description).toBe('A standard SKILL.md skill')
        expect(result.frontmatter.invocation).toBe('auto')
        expect(result.frontmatter.globs).toEqual(['**/*.ts'])
        expect(result.markdownBody).toContain('# My Skill')
        expect(result.isSkillPlus).toBe(false)
    })

    it('parses Skill+ with runtime: plexo', () => {
        const result = parseSkillMd(SKILL_PLUS)
        expect(result.isSkillPlus).toBe(true)
        expect(result.frontmatter.name).toBe('plexo-research')
        const fm = result.frontmatter as any
        expect(fm.runtime).toBe('plexo')
        expect(fm.capabilities).toEqual(['memory:read', 'connections:stripe'])
        expect(fm.resource_limits.max_memory_mb).toBe(256)
        expect(fm.persistent).toBe(true)
        expect(fm.entry).toBe('src/index.ts')
    })

    it('throws on missing frontmatter', () => {
        expect(() => parseSkillMd(NO_FRONTMATTER)).toThrow('must start with YAML frontmatter')
    })

    it('throws on invalid YAML', () => {
        expect(() => parseSkillMd(BAD_YAML)).toThrow('Invalid YAML')
    })

    it('throws on missing name', () => {
        expect(() => parseSkillMd(MISSING_NAME)).toThrow('requires a "name" field')
    })
})

describe('synthesizeManifest', () => {
    it('creates valid manifest from standard skill', () => {
        const parsed = parseSkillMd(STANDARD_SKILL)
        const manifest = synthesizeManifest(parsed)
        expect(manifest.name).toBe('my-skill')
        expect(manifest.type).toBe('skill')
        expect(manifest.entry).toBe('SKILL.md')
        expect(manifest.capabilities).toEqual([])
        expect(manifest.version).toBe('0.1.0')
    })

    it('creates manifest with Skill+ capabilities', () => {
        const parsed = parseSkillMd(SKILL_PLUS)
        const manifest = synthesizeManifest(parsed)
        expect(manifest.name).toBe('plexo-research')
        expect(manifest.capabilities).toEqual(['memory:read', 'connections:stripe'])
        expect(manifest.entry).toBe('src/index.ts')
        expect(manifest.version).toBe('1.2.0')
        expect(manifest.author).toBe('Joeybuilt')
        expect(manifest.resourceHints?.maxMemoryMB).toBe(256)
    })
})

describe('isSkillMdContent', () => {
    it('returns true for valid SKILL.md', () => {
        expect(isSkillMdContent(STANDARD_SKILL)).toBe(true)
    })

    it('returns false for plain markdown', () => {
        expect(isSkillMdContent(NO_FRONTMATTER)).toBe(false)
    })
})
