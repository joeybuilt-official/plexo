// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Public skill endpoints — no auth required.
 *
 * POST /api/v1/skills/validate — dry-run SKILL.md parse, no DB access.
 *   Used by IDEs and install tools to check syntax before submission.
 */

import { Router, type Router as RouterType } from 'express'
import { parseSkillMd, synthesizeManifest } from '@plexo/agent/skills/parser'
import { logger } from '../logger.js'

export const publicSkillsRouter: RouterType = Router()

publicSkillsRouter.post('/validate', (req, res) => {
    const { content } = req.body as { content?: string }
    if (!content || typeof content !== 'string') {
        res.status(400).json({ error: { code: 'MISSING_CONTENT', message: 'SKILL.md content required' } })
        return
    }
    try {
        const parsed = parseSkillMd(content)
        const manifest = synthesizeManifest(parsed)
        res.json({ valid: true, frontmatter: parsed.frontmatter, isSkillPlus: parsed.isSkillPlus, manifest })
    } catch (err) {
        logger.warn({ err }, 'Skill validation rejected')
        res.json({ valid: false, error: err instanceof Error ? err.message.slice(0, 300) : 'Invalid skill definition' })
    }
})
