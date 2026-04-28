// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Memory API
 *
 * GET  /api/memory/search?workspaceId=&q=&type=        Semantic search
 * GET  /api/memory/entries?workspaceId=&type=&tier=    Browse memory entries
 * PUT  /api/memory/entries/:id                         Edit memory entry content
 * DELETE /api/memory/entries/:id                       Delete memory entry
 * POST /api/memory/entries                             Create memory entry (Teach Plexo)
 * GET  /api/memory/preferences?workspaceId=            Workspace preferences
 * GET  /api/memory/improvements?workspaceId=           Agent improvement log
 * POST /api/memory/improvements/run                    Trigger improvement cycle (synchronous)
 * GET  /api/memory/rules/export?workspaceId=           Export learned behavior rules (for repo commit)
 * POST /api/memory/rules/import                        Import behavior rules (from repo/export)
 */
import { Router, type Router as RouterType } from 'express'
import { db, sql } from '@plexo/db'
import { searchMemory, storeMemory, embed as embedMemory, type MemoryType } from '@plexo/agent/memory/store'
import { getPreferences } from '@plexo/agent/memory/preferences'
import { runSelfImprovementCycle, getImprovementLog } from '@plexo/agent/memory/self-improvement'
import { proposePromptImprovements, applyPromptPatch } from '@plexo/agent/memory/prompt-improvement'
import { loadDecryptedAIProviders } from './ai-provider-creds.js'
import type { WorkspaceAISettings, ProviderKey } from '@plexo/agent/providers/registry'
import { uploadToKey } from '@plexo/storage'
import { logger } from '../logger.js'
import { trackEvent } from '../event-tracker.js'
import { UUID_RE } from '../validation.js'
import { audit } from '../audit.js'

/** Max attachments per memory entry */
const MAX_ATTACHMENTS = 5
/** Max single file size (10MB) */
const MAX_FILE_BYTES = 10 * 1024 * 1024
/** Max content length for memory entries (100 KB text) */
const MAX_CONTENT_LENGTH = 100_000
/** Valid memory_type enum values */
const VALID_MEMORY_TYPES = new Set(['task', 'incident', 'session', 'pattern'])

export const memoryRouter: RouterType = Router()


// ── GET /api/memory/entries ───────────────────────────────────────────────────

memoryRouter.get('/entries', async (req, res) => {
    const { workspaceId, type, tier, namespace, q, limit, offset } = req.query as Record<string, string>

    if (!workspaceId || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE', message: 'Valid workspaceId required' } })
        return
    }

    // Phase 4 — optional `namespace` + `q` query params. When `q` is
    // present and tier ≠ cold, delegate to the embedding-aware
    // searchMemory helper so the Memory UI shares the semantic path
    // with the executor. When tier=cold is explicit the raw SQL path
    // below runs regardless so users can dig out evicted entries.
    if (q && q.trim() && tier !== 'cold') {
        try {
            const lim = Math.min(parseInt(limit ?? '100', 10) || 100, 200)
            const results = await searchMemory({
                workspaceId,
                query: q.trim(),
                type: (type as any) || undefined,
                limit: lim,
                useCache: false,
                namespace: namespace || 'default',
            })
            let items: Array<Record<string, unknown>> = results.map(r => ({
                id: r.id,
                type: r.type,
                content: r.content,
                shorthand: r.shorthand ?? null,
                tier: r.tier,
                namespace: r.namespace,
                metadata: r.metadata,
                created_at: r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt,
                similarity: r.similarity,
            }))
            if (tier) items = items.filter(i => i.tier === tier)
            res.json({ items, total: items.length, mode: 'semantic' })
            return
        } catch (err) {
            logger.warn({ err, workspaceId }, 'Semantic memory search failed — falling back to SQL')
            // fall through to the SQL path below
        }
    }

    try {
        const lim = Math.min(parseInt(limit ?? '50', 10), 200)
        const off = parseInt(offset ?? '0', 10)

        let query = sql`
            SELECT id, type, content, shorthand, metadata, tier, namespace, created_at
            FROM memory_entries
            WHERE workspace_id = ${workspaceId}::uuid
        `
        if (type) query = sql`${query} AND type = ${type}::memory_type`
        if (tier) query = sql`${query} AND tier = ${tier}`
        if (namespace) query = sql`${query} AND namespace = ${namespace}`
        if (q && q.trim()) query = sql`${query} AND content ILIKE ${'%' + q.trim().slice(0, 200) + '%'}`
        query = sql`${query} ORDER BY created_at DESC LIMIT ${lim} OFFSET ${off}`

        const [rows, countResult] = await Promise.all([
            db.execute(query).then(r => Array.from(r)),
            db.execute<{ total: number }>(
                sql`SELECT count(*)::int as total FROM memory_entries WHERE workspace_id = ${workspaceId}::uuid`
            ).then(r => Array.from(r)),
        ])
        const total = countResult[0]?.total ?? 0

        res.json({ items: rows, total, mode: q ? 'text' : 'list' })
    } catch (err: unknown) {
        logger.error({ err }, 'Memory entries list failed')
        res.status(500).json({ error: { code: 'LIST_FAILED', message: 'Failed to list memory entries' } })
    }
})


// ── POST /api/memory/entries ──────────────────────────────────────────────────

memoryRouter.post('/entries', async (req, res) => {
    const { workspaceId, content, type, metadata, attachments } = req.body as {
        workspaceId: string
        content: string
        type?: string
        metadata?: Record<string, unknown>
        attachments?: Array<{ name: string; data: string; mimeType?: string }>
    }

    if (!workspaceId || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE', message: 'Valid workspaceId required' } })
        return
    }
    if (!content || content.trim().length === 0) {
        res.status(400).json({ error: { code: 'EMPTY_CONTENT', message: 'Content is required' } })
        return
    }
    if (content.length > MAX_CONTENT_LENGTH) {
        res.status(400).json({ error: { code: 'CONTENT_TOO_LARGE', message: `Content exceeds ${MAX_CONTENT_LENGTH} character limit` } })
        return
    }
    if (attachments && attachments.length > MAX_ATTACHMENTS) {
        res.status(400).json({ error: { code: 'TOO_MANY_FILES', message: `Maximum ${MAX_ATTACHMENTS} attachments` } })
        return
    }
    const resolvedType = type ?? 'pattern'
    if (!VALID_MEMORY_TYPES.has(resolvedType)) {
        res.status(400).json({ error: { code: 'INVALID_TYPE', message: `type must be one of: ${[...VALID_MEMORY_TYPES].join(', ')}` } })
        return
    }

    try {
        // Use storeMemory() so embedding + shorthand are generated (FUN-008 fix).
        // Load AI settings best-effort for embedding generation.
        let aiSettings: WorkspaceAISettings | undefined
        try {
            const { loadSettingsFromInstances } = await import('@plexo/agent/providers/settings-from-instances')
            const loaded = await loadSettingsFromInstances(workspaceId)
            if (loaded) aiSettings = loaded as unknown as WorkspaceAISettings
        } catch { /* non-fatal — storeMemory still inserts without embedding */ }

        const entryId = await storeMemory({
            workspaceId,
            type: resolvedType as MemoryType,
            content: content.trim(),
            metadata: metadata ?? { source: 'user', manual: true },
            tier: 'active',
            namespace: 'default',
            aiSettings,
        })

        // Upload attachments if provided
        const uploaded: Array<{ name: string; key: string; url: string; bytes: number; mimeType: string }> = []
        if (attachments?.length) {
            for (const att of attachments) {
                const b64 = att.data.replace(/^data:[^;]+;base64,/, '')
                const buffer = Buffer.from(b64, 'base64')
                if (buffer.byteLength > MAX_FILE_BYTES) continue
                const mimeType = att.mimeType ?? 'application/octet-stream'
                const key = `memory/${workspaceId}/${entryId}/${att.name}`
                const uploadResult = await uploadToKey({ key, content: buffer, contentType: mimeType })
                uploaded.push({ name: att.name, key: uploadResult.key, url: uploadResult.url, bytes: uploadResult.bytes, mimeType })
            }

            // Update metadata with attachment references
            if (uploaded.length > 0) {
                const meta = { ...(metadata ?? { source: 'user', manual: true }), attachments: uploaded }
                await db.execute(sql`
                    UPDATE memory_entries SET metadata = ${JSON.stringify(meta)}::jsonb
                    WHERE id = ${entryId}::uuid
                `)
            }
        }

        trackEvent('memory.created', 'info', { workspaceId, type: resolvedType, source: 'manual', attachments: uploaded.length })
        audit(req, { workspaceId, userId: req.user?.id, action: 'memory.create', resource: 'memory_entries', resourceId: entryId, metadata: { type: resolvedType } })
        res.status(201).json({ id: entryId, attachments: uploaded })
    } catch (err: unknown) {
        logger.error({ err }, 'Memory entry creation failed')
        res.status(500).json({ error: { code: 'CREATE_FAILED', message: 'Failed to create memory entry' } })
    }
})


// ── PUT /api/memory/entries/:id ───────────────────────────────────────────────

memoryRouter.put('/entries/:id', async (req, res) => {
    const { id } = req.params
    if (!id || !UUID_RE.test(id)) {
        res.status(400).json({ error: { code: 'INVALID_ID', message: 'Valid UUID required for entry id' } })
        return
    }
    const { workspaceId, content } = req.body as { workspaceId: string; content: string }

    if (!workspaceId || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE', message: 'Valid workspaceId required' } })
        return
    }
    if (!content || content.trim().length === 0) {
        res.status(400).json({ error: { code: 'EMPTY_CONTENT', message: 'Content is required' } })
        return
    }
    if (content.length > MAX_CONTENT_LENGTH) {
        res.status(400).json({ error: { code: 'CONTENT_TOO_LARGE', message: `Content exceeds ${MAX_CONTENT_LENGTH} character limit` } })
        return
    }

    try {
        const result = Array.from(await db.execute<{ id: string }>(sql`
            UPDATE memory_entries SET content = ${content.trim()}
            WHERE id = ${id}::uuid AND workspace_id = ${workspaceId}::uuid
            RETURNING id
        `))
        if (result.length === 0) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Memory entry not found' } })
            return
        }
        audit(req, { workspaceId, userId: req.user?.id, action: 'memory.update', resource: 'memory_entries', resourceId: id })

        // FUN-030: fire-and-forget embedding regeneration after content edit
        void embedMemory(content.trim(), workspaceId).then(async (vector) => {
            if (!vector) return
            const vecStr = `[${vector.join(',')}]`
            await db.execute(sql`UPDATE memory_entries SET embedding = ${vecStr}::vector WHERE id = ${id}::uuid`)
        }).catch((err) => logger.error({ err, id }, 'Failed to re-embed memory entry after edit'))

        res.json({ ok: true })
    } catch (err: unknown) {
        logger.error({ err, id }, 'Memory entry update failed')
        res.status(500).json({ error: { code: 'UPDATE_FAILED', message: 'Failed to update memory entry' } })
    }
})


// ── DELETE /api/memory/entries/:id ────────────────────────────────────────────

memoryRouter.delete('/entries/:id', async (req, res) => {
    const { id } = req.params
    if (!id || !UUID_RE.test(id)) {
        res.status(400).json({ error: { code: 'INVALID_ID', message: 'Valid UUID required for entry id' } })
        return
    }
    const { workspaceId } = req.query as Record<string, string>

    if (!workspaceId || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE', message: 'Valid workspaceId required' } })
        return
    }

    try {
        const result = Array.from(await db.execute<{ id: string }>(sql`
            DELETE FROM memory_entries
            WHERE id = ${id}::uuid AND workspace_id = ${workspaceId}::uuid
            RETURNING id
        `))
        if (result.length === 0) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Memory entry not found' } })
            return
        }
        trackEvent('memory.deleted', 'info', { workspaceId })
        audit(req, { workspaceId, userId: req.user?.id, action: 'memory.delete', resource: 'memory_entries', resourceId: id })
        res.json({ ok: true })
    } catch (err: unknown) {
        logger.error({ err, id }, 'Memory entry deletion failed')
        res.status(500).json({ error: { code: 'DELETE_FAILED', message: 'Failed to delete memory entry' } })
    }
})


// ── GET /api/memory/search ────────────────────────────────────────────────────

memoryRouter.get('/search', async (req, res) => {
    const { workspaceId, q, type, limit } = req.query as Record<string, string>

    if (!workspaceId || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE', message: 'Valid workspaceId required' } })
        return
    }

    try {
        const results = await searchMemory({
            workspaceId,
            query: q,
            type: type as 'task' | 'incident' | 'session' | 'pattern' | undefined,
            limit: Math.min(parseInt(limit ?? '5', 10), 20),
        })
        res.json({ results, total: results.length })
    } catch (err: unknown) {
        logger.error({ err }, 'Memory search failed')
        res.status(500).json({ error: { code: 'SEARCH_FAILED', message: 'Memory search failed' } })
    }
})

// ── GET /api/memory/preferences ───────────────────────────────────────────────

memoryRouter.get('/preferences', async (req, res) => {
    const { workspaceId } = req.query as Record<string, string>

    if (!workspaceId || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE', message: 'Valid workspaceId required' } })
        return
    }

    try {
        const preferences = await getPreferences(workspaceId)
        res.json({ preferences, count: Object.keys(preferences).length })
    } catch (err: unknown) {
        logger.error({ err }, 'Get preferences failed')
        res.status(500).json({ error: { code: 'PREF_FETCH_FAILED', message: 'Failed to load preferences' } })
    }
})

// ── GET /api/memory/improvements ─────────────────────────────────────────────

memoryRouter.get('/improvements', async (req, res) => {
    const { workspaceId, limit } = req.query as Record<string, string>

    if (!workspaceId || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE', message: 'Valid workspaceId required' } })
        return
    }

    try {
        const log = await getImprovementLog(workspaceId, Math.min(parseInt(limit ?? '20', 10), 100))
        res.json({ items: log, total: log.length })
    } catch (err: unknown) {
        logger.error({ err }, 'Get improvement log failed')
        res.status(500).json({ error: { code: 'LOG_FETCH_FAILED', message: 'Failed to load improvement log' } })
    }
})

// ── POST /api/memory/improvements/run ────────────────────────────────────────
// Synchronous — waits for the cycle to complete and returns the actual count.
// Times out at 90s (generous for claude-haiku).

memoryRouter.post('/improvements/run', async (req, res) => {
    const { workspaceId, lookbackDays } = req.body as {
        workspaceId?: string
        lookbackDays?: number
    }

    if (!workspaceId || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE', message: 'Valid workspaceId required' } })
        return
    }

    // Load workspace AI settings so the cycle uses the configured provider, not just env fallback
    let aiSettings: WorkspaceAISettings | undefined
    try {
        const ap = await loadDecryptedAIProviders(workspaceId)
        if (ap?.providers) {
            aiSettings = {
                inferenceMode: ap.inferenceMode as WorkspaceAISettings['inferenceMode'],
                primaryProvider: (ap.primary ?? ap.primaryProvider) as ProviderKey,
                fallbackChain: (ap.fallbackOrder ?? ap.fallbackChain ?? []) as ProviderKey[],
                providers: Object.fromEntries(
                    Object.entries(ap.providers as Record<string, Record<string, unknown>>).map(([k, p]) => [k, {
                        provider: k as ProviderKey,
                        apiKey: p.apiKey as string | undefined,
                        baseUrl: p.baseUrl as string | undefined,
                        model: (p.selectedModel ?? p.defaultModel) as string | undefined,
                        enabled: p.enabled as boolean | undefined,
                    }])
                ) as WorkspaceAISettings['providers'],
            }
        }
    } catch (err) {
        logger.warn({ err, workspaceId }, 'memory/run: failed to load workspace AI settings — using env fallback')
    }

    try {
        const result = await runSelfImprovementCycle({
            workspaceId,
            lookbackDays: lookbackDays ?? 7,
            aiSettings,
        })

        // Reload the improvement log so UI can display results immediately
        const log = await getImprovementLog(workspaceId, 30)

        trackEvent('memory.improvement_cycle_complete', 'info', { workspaceId, proposals: result.proposals, applied: result.applied })

        res.json({
            ok: true,
            count: result.proposals,
            applied: result.applied,
            message: `Cycle complete — ${result.proposals} proposal(s) generated`,
            proposals: log,
        })
    } catch (err: unknown) {
        trackEvent('memory.improvement_cycle_failed', 'error', { workspaceId, error: err instanceof Error ? err.message : String(err) })
        logger.error({ err, workspaceId }, 'Self-improvement cycle failed')
        res.status(500).json({ error: { code: 'CYCLE_FAILED', message: 'Self-improvement cycle failed' } })
    }
})

// ── GET /api/memory/rules/export ─────────────────────────────────────────────
// Exports all learned behavior rules for a workspace as a portable JSON
// document. This is the bridge from "runtime learning" to "code-level knowledge":
// the caller can commit the exported rules to the repo so they persist
// across deployments and instance migrations.

memoryRouter.get('/rules/export', async (req, res) => {
    const { workspaceId } = req.query as Record<string, string>

    if (!workspaceId || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE', message: 'Valid workspaceId required' } })
        return
    }

    try {
        const rows = await db.execute<{
            id: string
            key: string
            type: string
            label: string
            description: string
            value: unknown
            source: string
            tags: string[]
            locked: boolean
            created_at: string
            updated_at: string
        }>(sql`
            SELECT id, key, type, label, description, value, source, tags, locked, created_at, updated_at
            FROM behavior_rules
            WHERE workspace_id = ${workspaceId}::uuid
              AND deleted_at IS NULL
            ORDER BY type, key
        `)

        // Convert to plain array for easy manipulation
        const rules = Array.from(rows)

        // Group by source for readability
        const grouped: Record<string, typeof rules> = {}
        for (const r of rules) {
            const bucket = r.source || 'unknown'
            if (!grouped[bucket]) grouped[bucket] = []
            grouped[bucket]!.push(r)
        }

        res.json({
            workspaceId,
            exportedAt: new Date().toISOString(),
            version: 1,
            totalRules: rules.length,
            bySource: grouped,
            rules: rules.map(r => ({
                key: r.key,
                type: r.type,
                label: r.label,
                description: r.description,
                value: r.value,
                source: r.source,
                tags: r.tags,
                locked: r.locked,
            })),
        })
    } catch (err: unknown) {
        logger.error({ err }, 'Rules export failed')
        res.status(500).json({ error: { code: 'EXPORT_FAILED', message: 'Failed to export behavior rules' } })
    }
})

// ── POST /api/memory/rules/import ───────────────────────────────────────────
// Import behavior rules from a previously exported JSON document.
// This is the reverse bridge: code → runtime. Rules with matching keys
// are updated; new keys are inserted; no rules are deleted.

memoryRouter.post('/rules/import', async (req, res) => {
    const { workspaceId, rules } = req.body as {
        workspaceId?: string
        rules?: Array<{
            key: string
            type: string
            label: string
            description?: string
            value: unknown
            source?: string
            tags?: string[]
            locked?: boolean
        }>
    }

    if (!workspaceId || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE', message: 'Valid workspaceId required' } })
        return
    }
    if (!Array.isArray(rules) || rules.length === 0) {
        res.status(400).json({ error: { code: 'NO_RULES', message: 'rules array is required and must be non-empty' } })
        return
    }
    if (rules.length > 200) {
        res.status(400).json({ error: { code: 'TOO_MANY_RULES', message: 'Maximum 200 rules per import' } })
        return
    }

    try {
        let imported = 0
        let updated = 0

        for (const rule of rules) {
            if (!rule.key || !rule.type || !rule.label) continue

            const result = await db.execute(sql`
                INSERT INTO behavior_rules
                    (id, workspace_id, type, key, label, description, value, source, tags, locked)
                VALUES
                    (gen_random_uuid(), ${workspaceId}::uuid,
                     ${rule.type}, ${rule.key}, ${rule.label},
                     ${rule.description ?? ''},
                     ${JSON.stringify(rule.value ?? {})}::jsonb,
                     ${rule.source ?? 'import'},
                     ${sql`ARRAY[${sql.join((rule.tags ?? ['imported']).map(t => sql`${t}`), sql`,`)}]::text[]`},
                     ${rule.locked ?? false})
                ON CONFLICT (workspace_id, key) WHERE deleted_at IS NULL
                DO UPDATE SET
                    label = EXCLUDED.label,
                    description = EXCLUDED.description,
                    value = EXCLUDED.value,
                    source = EXCLUDED.source,
                    tags = EXCLUDED.tags,
                    updated_at = now()
            `)
            // Drizzle returns affected row count — 0 = conflict ignored, >0 = insert or update
            if (result && (result as any).rowCount > 0) {
                imported++
            } else {
                updated++
            }
        }

        logger.info({ workspaceId, imported, updated, total: rules.length }, 'Behavior rules imported')
        res.json({ ok: true, imported, updated, total: rules.length })
    } catch (err: unknown) {
        logger.error({ err }, 'Rules import failed')
        res.status(500).json({ error: { code: 'IMPORT_FAILED', message: 'Failed to import behavior rules' } })
    }
})

// ── POST /api/memory/improvements/prompt ─────────────────────────────────────

memoryRouter.post('/improvements/prompt', async (req, res) => {
    const { workspaceId, lookbackDays } = req.body as {
        workspaceId?: string
        lookbackDays?: number
    }

    if (!workspaceId || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE', message: 'Valid workspaceId required' } })
        return
    }

    res.status(202).json({ message: 'Prompt improvement analysis started', workspaceId })

    proposePromptImprovements({
        workspaceId,
        lookbackDays: lookbackDays ?? 14,
    }).catch((err: unknown) => {
        logger.error({ err, workspaceId }, 'Prompt improvement analysis failed')
    })
})

// ── POST /api/memory/improvements/:id/apply ───────────────────────────────────
// Routes by pattern_type:
//   prompt_patch → applies the diff to workspace prompt_overrides preference
//   all others   → marks applied=true (operator takes manual action externally)

memoryRouter.post('/improvements/:id/apply', async (req, res) => {
    const { id } = req.params
    const { workspaceId } = req.body as { workspaceId?: string }

    if (!UUID_RE.test(id as string)) {
        res.status(400).json({ error: { code: 'INVALID_ID', message: 'Valid UUID required for improvement id' } })
        return
    }
    if (!workspaceId || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE', message: 'Valid workspaceId required' } })
        return
    }

    try {
        const rows = await db.execute<{
            pattern_type: string
            applied: boolean
        }>(sql`
            SELECT pattern_type, applied FROM agent_improvement_log
            WHERE id = ${id}::uuid AND workspace_id = ${workspaceId}::uuid
            LIMIT 1
        `)
        const row = rows[0]
        if (!row) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Improvement log entry not found' } })
            return
        }
        if (row.applied) {
            res.status(409).json({ error: { code: 'ALREADY_APPLIED', message: 'Patch already applied' } })
            return
        }

        if (row.pattern_type === 'prompt_patch') {
            // Full prompt-override apply
            await applyPromptPatch({ workspaceId, improvementLogId: id as string })
            res.json({ ok: true, message: 'Prompt patch applied and active' })
        } else {
            // Informational proposals — just mark acknowledged/applied
            await db.execute(sql`
                UPDATE agent_improvement_log SET applied = true
                WHERE id = ${id}::uuid AND workspace_id = ${workspaceId}::uuid
            `)
            res.json({ ok: true, message: 'Proposal acknowledged' })
        }
    } catch (err: unknown) {
        logger.error({ err, id }, 'Improvement apply failed')
        res.status(400).json({ error: { code: 'APPLY_FAILED', message: 'Failed to apply improvement' } })
    }
})

// ── Phase 4 — Tier / namespace / eviction ────────────────────────────────────

// PATCH /api/v1/memory/entries/:id/tier — body { workspaceId, tier }
memoryRouter.patch('/entries/:id/tier', async (req, res) => {
    const entryId = String(req.params.id ?? '')
    if (!entryId || !UUID_RE.test(entryId)) {
        res.status(400).json({ error: { code: 'INVALID_ID', message: 'Valid UUID required for entry id' } })
        return
    }
    const { workspaceId, tier } = (req.body ?? {}) as { workspaceId?: string; tier?: string }
    if (!workspaceId || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE', message: 'Valid workspaceId required' } })
        return
    }
    if (!tier || !['hot', 'active', 'cold'].includes(tier)) {
        res.status(400).json({ error: { code: 'INVALID_TIER', message: 'tier must be hot, active, or cold' } })
        return
    }
    try {
        const rows = Array.from(await db.execute<{ id: string }>(sql`
            UPDATE memory_entries
            SET tier = ${tier}
            WHERE id = ${entryId}::uuid AND workspace_id = ${workspaceId}::uuid
            RETURNING id
        `))
        if (rows.length === 0) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Memory entry not found' } })
            return
        }
        res.json({ ok: true, id: entryId, tier })
    } catch (err) {
        logger.error({ err, entryId }, 'Memory tier update failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to update tier' } })
    }
})

// GET /api/v1/memory/namespaces?workspaceId=...
memoryRouter.get('/namespaces', async (req, res) => {
    const workspaceId = req.query.workspaceId as string | undefined
    if (!workspaceId || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE', message: 'Valid workspaceId required' } })
        return
    }
    try {
        const rows = Array.from(await db.execute<{
            namespace: string; total: number; hot: number; active: number; cold: number
        }>(sql`
            SELECT namespace,
                   COUNT(*)::int AS total,
                   COUNT(*) FILTER (WHERE tier = 'hot')::int AS hot,
                   COUNT(*) FILTER (WHERE tier = 'active')::int AS active,
                   COUNT(*) FILTER (WHERE tier = 'cold')::int AS cold
            FROM memory_entries
            WHERE workspace_id = ${workspaceId}::uuid
            GROUP BY namespace
            ORDER BY total DESC, namespace ASC
        `))
        res.json({ namespaces: rows.map(r => ({
            namespace: String(r.namespace),
            total: Number(r.total ?? 0),
            hot: Number(r.hot ?? 0),
            active: Number(r.active ?? 0),
            cold: Number(r.cold ?? 0),
        })) })
    } catch (err) {
        logger.error({ err, workspaceId }, 'Memory namespaces query failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to load namespaces' } })
    }
})

interface EvictionSettings {
    enabled: boolean
    coldMaxAgeDays: number
    activeMaxAgeDays: number
}

const MEMORY_EVICTION_DEFAULTS: EvictionSettings = {
    enabled: false,
    coldMaxAgeDays: 90,
    activeMaxAgeDays: 30,
}

const MEMORY_EVICTION_BOUNDS = {
    coldMaxAgeDays: { min: 7, max: 3650 },
    activeMaxAgeDays: { min: 1, max: 365 },
} as const

function readEvictionFromIntelligence(s: Record<string, unknown> | null | undefined): EvictionSettings {
    const memoryBlock = ((s ?? {}) as any).memory ?? {}
    const block = memoryBlock.eviction ?? {}
    return {
        enabled: typeof block.enabled === 'boolean' ? block.enabled : MEMORY_EVICTION_DEFAULTS.enabled,
        coldMaxAgeDays: typeof block.coldMaxAgeDays === 'number' ? block.coldMaxAgeDays : MEMORY_EVICTION_DEFAULTS.coldMaxAgeDays,
        activeMaxAgeDays: typeof block.activeMaxAgeDays === 'number' ? block.activeMaxAgeDays : MEMORY_EVICTION_DEFAULTS.activeMaxAgeDays,
    }
}

// GET /api/v1/memory/eviction?workspaceId=...
memoryRouter.get('/eviction', async (req, res) => {
    const workspaceId = req.query.workspaceId as string | undefined
    if (!workspaceId || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE', message: 'Valid workspaceId required' } })
        return
    }
    try {
        const rows = Array.from(await db.execute<{ s: Record<string, unknown> | null }>(sql`
            SELECT intelligence_settings AS s
            FROM workspaces
            WHERE id = ${workspaceId}::uuid
            LIMIT 1
        `))
        const view = readEvictionFromIntelligence(rows[0]?.s)
        res.json({ eviction: view, defaults: MEMORY_EVICTION_DEFAULTS, bounds: MEMORY_EVICTION_BOUNDS })
    } catch (err) {
        logger.error({ err, workspaceId }, 'Memory eviction read failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to load eviction settings' } })
    }
})

// PATCH /api/v1/memory/eviction — body { workspaceId, enabled?, coldMaxAgeDays?, activeMaxAgeDays? }
memoryRouter.patch('/eviction', async (req, res) => {
    const { workspaceId, ...body } = (req.body ?? {}) as { workspaceId?: string } & Partial<EvictionSettings>
    if (!workspaceId || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE', message: 'Valid workspaceId required' } })
        return
    }
    const errors: string[] = []
    const patch: Partial<EvictionSettings> = {}
    if (body.enabled !== undefined) {
        if (typeof body.enabled !== 'boolean') errors.push('enabled must be boolean')
        else patch.enabled = body.enabled
    }
    if (body.coldMaxAgeDays !== undefined) {
        const n = Math.round(Number(body.coldMaxAgeDays))
        const b = MEMORY_EVICTION_BOUNDS.coldMaxAgeDays
        if (!Number.isFinite(n) || n < b.min || n > b.max) errors.push(`coldMaxAgeDays must be between ${b.min} and ${b.max}`)
        else patch.coldMaxAgeDays = n
    }
    if (body.activeMaxAgeDays !== undefined) {
        const n = Math.round(Number(body.activeMaxAgeDays))
        const b = MEMORY_EVICTION_BOUNDS.activeMaxAgeDays
        if (!Number.isFinite(n) || n < b.min || n > b.max) errors.push(`activeMaxAgeDays must be between ${b.min} and ${b.max}`)
        else patch.activeMaxAgeDays = n
    }
    if (errors.length > 0) {
        res.status(400).json({ error: { code: 'INVALID_EVICTION', message: errors.join('; ') } })
        return
    }
    if (Object.keys(patch).length === 0) {
        res.status(400).json({ error: { code: 'NO_FIELDS', message: 'no recognized fields in body' } })
        return
    }
    try {
        const rows = Array.from(await db.execute<{ s: Record<string, unknown> | null }>(sql`
            SELECT intelligence_settings AS s FROM workspaces
            WHERE id = ${workspaceId}::uuid LIMIT 1
        `))
        const existing = (rows[0]?.s ?? {}) as Record<string, any>
        const memoryBlock = (existing.memory ?? {}) as Record<string, any>
        const evictionBlock = (memoryBlock.eviction ?? {}) as Record<string, any>
        const merged = { ...evictionBlock, ...patch }

        await db.execute(sql`
            UPDATE workspaces
            SET intelligence_settings = jsonb_set(
                COALESCE(intelligence_settings, '{}'::jsonb),
                '{memory,eviction}',
                ${JSON.stringify(merged)}::jsonb,
                true
            )
            WHERE id = ${workspaceId}::uuid
        `)
        try {
            const cache = await import('../lib/intelligence-cache.js')
            cache.invalidateIntelligenceSettings(workspaceId)
        } catch { /* non-fatal */ }

        res.json({
            ok: true,
            eviction: readEvictionFromIntelligence({ memory: { eviction: merged } }),
        })
    } catch (err) {
        logger.error({ err, workspaceId }, 'Memory eviction update failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to update eviction settings' } })
    }
})

// ── Synthesis (Phase α) ─────────────────────────────────────────
//
// Endpoints below are mounted twice:
//   - cluster + suggest are appended to the workspace-gated memoryRouter
//     (routes are user-driven from the dashboard).
//   - inbox/accept/dismiss go on `synthesisRouter` (service-key only).
//
// Both write into `synthesis_suggestions` (ON CONFLICT (workspace_id,dedupe_key) DO UPDATE),
// so re-running cluster + suggest on the same data is idempotent.
import { clusterMemory } from '@plexo/agent/memory/cluster'
import {
    generateThemeSuggestions,
    generateLinkSuggestions,
} from '@plexo/agent/memory/suggest'
import { requireServiceKey } from '../middleware/service-key-auth.js'
import crypto from 'crypto'

/**
 * Stable identity hash for a cluster's member set, so re-runs upsert
 * against the same theme row instead of creating duplicates.
 */
function memberSetHash(memberIds: string[]): string {
    const sorted = [...memberIds].sort()
    return crypto.createHash('sha256').update(sorted.join(',')).digest('hex').slice(0, 32)
}

// POST /api/v1/memory/cluster — recompute clusters and persist into memory_themes.
memoryRouter.post('/cluster', async (req, res) => {
    const { workspaceId, minClusterSize, coherenceFloor } = (req.body ?? {}) as {
        workspaceId?: string
        minClusterSize?: number
        coherenceFloor?: number
    }
    if (!workspaceId || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE', message: 'Valid workspaceId required' } })
        return
    }
    try {
        const result = await clusterMemory(workspaceId, {
            minClusterSize: typeof minClusterSize === 'number' ? minClusterSize : undefined,
            coherenceFloor: typeof coherenceFloor === 'number' ? coherenceFloor : undefined,
        })

        // Upsert each cluster by member-set hash → label + size + coherence + centroid.
        const persisted: Array<{ id: string; label: string; memberIds: string[]; coherence: number; size: number }> = []
        for (const c of result.clusters) {
            const hash = memberSetHash(c.memberIds)
            const centroidLiteral = `[${c.centroid.join(',')}]`
            const sortedKey = [...c.memberIds].sort().join(',')

            // Find an existing theme with the same member-set hash.
            const existing = Array.from(await db.execute<{ id: string }>(sql`
                SELECT id FROM memory_themes
                WHERE workspace_id = ${workspaceId}::uuid
                  AND md5(array_to_string(
                        ARRAY(SELECT unnest(member_ids) ORDER BY 1), ','
                      )) = md5(${sortedKey})
                LIMIT 1
            `))

            let themeId: string
            if (existing[0]?.id) {
                themeId = existing[0].id
                await db.execute(sql`
                    UPDATE memory_themes
                    SET label = ${c.label},
                        size = ${c.memberIds.length},
                        coherence = ${c.coherence},
                        centroid = ${centroidLiteral}::vector,
                        last_member_at = NOW()
                    WHERE id = ${themeId}::uuid
                `)
            } else {
                const inserted = Array.from(await db.execute<{ id: string }>(sql`
                    INSERT INTO memory_themes
                        (workspace_id, label, member_ids, centroid, size, coherence, last_member_at)
                    VALUES
                        (${workspaceId}::uuid, ${c.label}, ${c.memberIds}::uuid[],
                         ${centroidLiteral}::vector, ${c.memberIds.length}, ${c.coherence}, NOW())
                    RETURNING id
                `))
                themeId = inserted[0]!.id
            }
            persisted.push({ id: themeId, label: c.label, memberIds: c.memberIds, coherence: c.coherence, size: c.memberIds.length })
            void hash
        }

        res.json({
            workspaceId,
            clusters: persisted,
            noiseCount: result.noise.length,
        })
    } catch (err) {
        logger.error({ err, workspaceId }, 'memory.cluster failed')
        res.status(500).json({ error: { code: 'CLUSTER_FAILED', message: 'Cluster run failed' } })
    }
})

// POST /api/v1/memory/suggest — generate theme + link suggestions.
memoryRouter.post('/suggest', async (req, res) => {
    const { workspaceId } = (req.body ?? {}) as { workspaceId?: string }
    if (!workspaceId || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE', message: 'Valid workspaceId required' } })
        return
    }
    try {
        const themes = await generateThemeSuggestions(workspaceId)
        const links = await generateLinkSuggestions(workspaceId)
        res.json({
            workspaceId,
            themes,
            links,
        })
    } catch (err) {
        logger.error({ err, workspaceId }, 'memory.suggest failed')
        res.status(500).json({ error: { code: 'SUGGEST_FAILED', message: 'Suggestion run failed' } })
    }
})

// ── Synthesis Router (service-key) ──────────────────────────────
// Mounted in index.ts at /api/v1/synthesis. All routes require X-App-Id +
// PLEXO_SERVICE_KEY since they are consumed by other Joeybuilt apps as well
// as the dashboard's server-side proxy.
export const synthesisRouter: RouterType = Router()
synthesisRouter.use(requireServiceKey)

// GET /api/v1/synthesis/inbox?workspaceId=&kinds=&limit=
synthesisRouter.get('/inbox', async (req, res) => {
    const workspaceId = String(req.query.workspaceId ?? '')
    const kindsRaw = String(req.query.kinds ?? '').trim()
    const limitRaw = String(req.query.limit ?? '7').trim()
    if (!workspaceId || !UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE', message: 'Valid workspaceId required' } })
        return
    }
    const limit = Math.min(Math.max(parseInt(limitRaw, 10) || 7, 1), 100)
    const kinds = kindsRaw ? kindsRaw.split(',').map(s => s.trim()).filter(Boolean) : []
    try {
        const rows = Array.from(await db.execute(
            kinds.length > 0
                ? sql`
                    SELECT id, workspace_id, kind, payload, score, source, status,
                           surfaced_at, dismissed_at, accepted_at, dedupe_key, created_at
                    FROM synthesis_suggestions
                    WHERE workspace_id = ${workspaceId}::uuid
                      AND status = 'pending'
                      AND kind = ANY(string_to_array(${kinds.join(",")}, ","))
                    ORDER BY score DESC, created_at DESC
                    LIMIT ${limit}
                  `
                : sql`
                    SELECT id, workspace_id, kind, payload, score, source, status,
                           surfaced_at, dismissed_at, accepted_at, dedupe_key, created_at
                    FROM synthesis_suggestions
                    WHERE workspace_id = ${workspaceId}::uuid
                      AND status = 'pending'
                    ORDER BY score DESC, created_at DESC
                    LIMIT ${limit}
                  `
        ))
        res.json({ workspaceId, items: rows, total: rows.length })
    } catch (err) {
        logger.error({ err, workspaceId }, 'synthesis.inbox failed')
        res.status(500).json({ error: { code: 'INBOX_FAILED', message: 'Failed to load inbox' } })
    }
})

// POST /api/v1/synthesis/:id/accept
synthesisRouter.post('/:id/accept', async (req, res) => {
    const { id } = req.params as { id: string }
    if (!id || !UUID_RE.test(id)) {
        res.status(400).json({ error: { code: 'INVALID_ID', message: 'Valid suggestion id required' } })
        return
    }
    try {
        const rows = Array.from(await db.execute(sql`
            UPDATE synthesis_suggestions
            SET status = 'accepted', accepted_at = NOW()
            WHERE id = ${id}::uuid AND status = 'pending'
            RETURNING id, workspace_id, kind, payload, score, source, status,
                      surfaced_at, dismissed_at, accepted_at, dedupe_key, created_at
        `))
        if (rows.length === 0) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Pending suggestion not found' } })
            return
        }
        res.json({ suggestion: rows[0] })
    } catch (err) {
        logger.error({ err, id }, 'synthesis.accept failed')
        res.status(500).json({ error: { code: 'ACCEPT_FAILED', message: 'Failed to accept suggestion' } })
    }
})

// POST /api/v1/synthesis/:id/dismiss
synthesisRouter.post('/:id/dismiss', async (req, res) => {
    const { id } = req.params as { id: string }
    if (!id || !UUID_RE.test(id)) {
        res.status(400).json({ error: { code: 'INVALID_ID', message: 'Valid suggestion id required' } })
        return
    }
    try {
        const rows = Array.from(await db.execute(sql`
            UPDATE synthesis_suggestions
            SET status = 'dismissed', dismissed_at = NOW()
            WHERE id = ${id}::uuid AND status = 'pending'
            RETURNING id, workspace_id, kind, payload, score, source, status,
                      surfaced_at, dismissed_at, accepted_at, dedupe_key, created_at
        `))
        if (rows.length === 0) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Pending suggestion not found' } })
            return
        }
        res.json({ suggestion: rows[0] })
    } catch (err) {
        logger.error({ err, id }, 'synthesis.dismiss failed')
        res.status(500).json({ error: { code: 'DISMISS_FAILED', message: 'Failed to dismiss suggestion' } })
    }
})
