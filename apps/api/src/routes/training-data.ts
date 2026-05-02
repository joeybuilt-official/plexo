// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Training Data API — read-only endpoints for collecting domain-specific
 * training data. Used by Command Center to browse, preview, and export
 * data for fine-tuning models.
 *
 * All routes require super-admin auth. No data is modified.
 *
 * GET  /sources              — available data sources with row counts
 * GET  /sources/:source/sample — preview rows from a source
 * POST /export               — export selected sources as JSONL
 */

import { Router, type Request, type Response } from 'express'
import { db, sql } from '@plexo/db'
import { logger } from '../logger.js'

export const trainingDataRouter: ReturnType<typeof Router> = Router()

// ── Data source definitions ─────────────────────────────────────────────

interface DataSource {
    id: string
    label: string
    description: string
    table: string
    /** SQL for counting rows (can include WHERE clauses) */
    countSql: string
    /** SQL for sampling rows */
    sampleSql: string
    /** How to convert rows to chat-format training examples */
    format: 'chat' | 'knowledge' | 'behavior'
}

const DATA_SOURCES: DataSource[] = [
    {
        id: 'inference_logs',
        label: 'Inference Logs (consented)',
        description: 'Scrubbed input/output pairs from LLM calls where training consent is enabled',
        table: 'inference_logs',
        countSql: `SELECT count(*) AS count FROM inference_logs WHERE training_consent = TRUE AND scrub_input_pattern IS NOT NULL AND scrub_output_pattern IS NOT NULL`,
        sampleSql: `SELECT id, model, provider, task_type, domain_region, scrub_input_pattern, scrub_output_pattern, input_tokens, output_tokens, latency_ms, created_at FROM inference_logs WHERE training_consent = TRUE AND scrub_input_pattern IS NOT NULL AND scrub_output_pattern IS NOT NULL ORDER BY created_at DESC LIMIT $1`,
        format: 'chat',
    },
    {
        id: 'conversations',
        label: 'Conversations',
        description: 'User messages and agent replies across all channels',
        table: 'conversations',
        countSql: `SELECT count(*) AS count FROM conversations WHERE status = 'complete' AND reply IS NOT NULL`,
        sampleSql: `SELECT id, source, intent, message, reply, created_at FROM conversations WHERE status = 'complete' AND reply IS NOT NULL ORDER BY created_at DESC LIMIT $1`,
        format: 'chat',
    },
    {
        id: 'task_steps',
        label: 'Task Execution Steps',
        description: 'Step-by-step agent execution traces with tool calls and outcomes',
        table: 'task_steps',
        countSql: `SELECT count(*) AS count FROM task_steps WHERE outcome IS NOT NULL`,
        sampleSql: `SELECT ts.id, ts.task_id, ts.step_number, ts.model, ts.tokens_in, ts.tokens_out, ts.tool_calls, ts.outcome, ts.is_terminal, ts.created_at FROM task_steps ts WHERE ts.outcome IS NOT NULL ORDER BY ts.created_at DESC LIMIT $1`,
        format: 'chat',
    },
    {
        id: 'memory_entries',
        label: 'Memory Entries',
        description: 'Agent-learned facts, patterns, and shorthand knowledge',
        table: 'memory_entries',
        countSql: `SELECT count(*) AS count FROM memory_entries`,
        sampleSql: `SELECT id, workspace_id, type, content, shorthand, tier, namespace, created_at FROM memory_entries ORDER BY created_at DESC LIMIT $1`,
        format: 'knowledge',
    },
    {
        id: 'behavior_snapshots',
        label: 'Behavior Snapshots',
        description: 'Compiled system prompts and resolved behavior rule sets',
        table: 'behavior_snapshots',
        countSql: `SELECT count(*) AS count FROM behavior_snapshots`,
        sampleSql: `SELECT id, workspace_id, compiled_prompt, triggered_by, trigger_resource_id, created_at FROM behavior_snapshots ORDER BY created_at DESC LIMIT $1`,
        format: 'behavior',
    },
    {
        id: 'scl_concept_graphs',
        label: 'SCL Concept Graphs',
        description: 'Domain-region concept maps extracted from task completions',
        table: 'scl_concept_graphs',
        countSql: `SELECT count(*) AS count FROM scl_concept_graphs`,
        sampleSql: `SELECT id, domain_region, graph_json, created_at FROM scl_concept_graphs ORDER BY created_at DESC LIMIT $1`,
        format: 'knowledge',
    },
]

// ── GET /sources ────────────────────────────────────────────────────────

trainingDataRouter.get('/sources', async (_req: Request, res: Response) => {
    try {
        const sources = await Promise.all(
            DATA_SOURCES.map(async (src) => {
                try {
                    const [[row], [range]] = await Promise.all([
                        db.execute<{ count: string }>(sql.raw(src.countSql)),
                        db.execute<{ min_date: string | null; max_date: string | null }>(
                            sql`SELECT MIN(created_at) AS min_date, MAX(created_at) AS max_date FROM ${sql.identifier(src.table)}`
                        ),
                    ])
                    const count = Number(row?.count ?? 0)

                    return {
                        id: src.id,
                        label: src.label,
                        description: src.description,
                        format: src.format,
                        count,
                        dateRange: {
                            earliest: range?.min_date ?? null,
                            latest: range?.max_date ?? null,
                        },
                    }
                } catch (err) {
                    logger.warn({ err, source: src.id }, 'Failed to count training data source')
                    return {
                        id: src.id,
                        label: src.label,
                        description: src.description,
                        format: src.format,
                        count: 0,
                        dateRange: { earliest: null, latest: null },
                        error: 'Failed to query',
                    }
                }
            })
        )

        const totalExamples = sources.reduce((sum, s) => sum + s.count, 0)

        res.json({
            sources,
            totalExamples,
            consentStatus: {
                hasConsentedData: sources.find(s => s.id === 'inference_logs')?.count ?? 0 > 0,
                note: 'Only inference logs with training_consent=true include scrubbed I/O patterns',
            },
        })
    } catch (err) {
        logger.error({ err }, 'Failed to list training data sources')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to list sources' } })
    }
})

// ── GET /sources/:source/sample ─────────────────────────────────────────

trainingDataRouter.get('/sources/:source/sample', async (req: Request, res: Response) => {
    const sourceId = req.params.source
    const limit = Math.min(parseInt(String(req.query.limit ?? '10'), 10), 50)

    const src = DATA_SOURCES.find(s => s.id === sourceId)
    if (!src) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: `Unknown source: ${sourceId}` } })
        return
    }

    try {
        // baseQuery is a compile-time constant from DATA_SOURCES — no user data flows into it.
        // The semicolon check is a defensive guard against future maintenance mistakes.
        const baseQuery = src.sampleSql.replace(/\s+LIMIT\s+\$1\s*$/i, '')
        if (/;/.test(baseQuery)) throw new Error('Unsafe query structure detected')
        const rows = await db.execute(sql`${sql.raw(baseQuery)} LIMIT ${limit}`)
        res.json({ source: sourceId, rows, count: (rows as unknown[]).length })
    } catch (err) {
        logger.error({ err, source: sourceId }, 'Failed to sample training data')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to sample data' } })
    }
})

// ── POST /export ────────────────────────────────────────────────────────

interface ExportRequest {
    sources: string[]
    format?: 'jsonl_chat' | 'jsonl_raw'
    limit?: number
}

trainingDataRouter.post('/export', async (req: Request, res: Response) => {
    const { sources: requestedSources, format = 'jsonl_chat', limit = 10000 } = req.body as ExportRequest

    if (!Array.isArray(requestedSources) || requestedSources.length === 0) {
        res.status(400).json({ error: { code: 'INVALID_SOURCES', message: 'Provide an array of source IDs' } })
        return
    }

    const validSources = requestedSources.filter(id => DATA_SOURCES.find(s => s.id === id))
    if (validSources.length === 0) {
        res.status(400).json({ error: { code: 'NO_VALID_SOURCES', message: 'None of the requested sources exist' } })
        return
    }

    const cappedLimit = Math.min(limit, 50000)

    res.setHeader('Content-Type', 'application/x-ndjson')
    res.setHeader('Content-Disposition', `attachment; filename="plexo-training-${Date.now()}.jsonl"`)

    try {
        for (const sourceId of validSources) {
            const src = DATA_SOURCES.find(s => s.id === sourceId)!

            const baseQuery = src.sampleSql.replace(/\s+LIMIT\s+\$1\s*$/i, '')
            const rows = await db.execute(sql`${sql.raw(baseQuery)} LIMIT ${cappedLimit}`)

            for (const row of rows as Record<string, unknown>[]) {
                if (format === 'jsonl_raw') {
                    res.write(JSON.stringify({ source: sourceId, ...row }) + '\n')
                    continue
                }

                const chatLine = toChatFormat(sourceId, row)
                if (chatLine) res.write(JSON.stringify(chatLine) + '\n')
            }
        }

        res.end()
    } catch (err) {
        logger.error({ err }, 'Failed to export training data')
        if (res.headersSent) {
            res.end()
        } else {
            res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Export failed' } })
        }
    }
})

// ── Format converters ───────────────────────────────────────────────────

interface ChatMessage {
    role: 'system' | 'user' | 'assistant'
    content: string
}

function toChatFormat(
    sourceId: string,
    row: Record<string, unknown>,
): { messages: ChatMessage[] } | null {
    switch (sourceId) {
        case 'inference_logs': {
            const input = row.scrub_input_pattern as string | null
            const output = row.scrub_output_pattern as string | null
            if (!input || !output) return null
            return {
                messages: [
                    { role: 'system', content: `You are Plexo, a workspace AI agent. Task type: ${row.task_type ?? 'unknown'}. Domain: ${row.domain_region ?? 'general'}.` },
                    { role: 'user', content: input },
                    { role: 'assistant', content: output },
                ],
            }
        }

        case 'conversations': {
            const message = row.message as string | null
            const reply = row.reply as string | null
            if (!message || !reply) return null
            return {
                messages: [
                    { role: 'system', content: `You are Plexo, a workspace AI agent. Channel: ${row.source ?? 'dashboard'}.` },
                    { role: 'user', content: message },
                    { role: 'assistant', content: reply },
                ],
            }
        }

        case 'task_steps': {
            const outcome = row.outcome as string | null
            const toolCalls = row.tool_calls as unknown
            if (!outcome) return null
            const toolSummary = toolCalls ? `Tool calls: ${JSON.stringify(toolCalls)}` : ''
            return {
                messages: [
                    { role: 'system', content: `You are Plexo, executing step ${row.step_number ?? '?'} of a task. Model: ${row.model ?? 'unknown'}.` },
                    { role: 'user', content: `Execute this step.${toolSummary ? ' ' + toolSummary : ''}` },
                    { role: 'assistant', content: outcome },
                ],
            }
        }

        case 'memory_entries': {
            const content = row.content as string | null
            const shorthand = row.shorthand as string | null
            if (!content) return null
            return {
                messages: [
                    { role: 'system', content: 'Use the provided memory facts directly — do not summarize or compress them.' },
                    { role: 'user', content: `Compress this memory entry (type: ${row.type ?? 'unknown'}, tier: ${row.tier ?? 'active'}):\n${content}` },
                    { role: 'assistant', content: shorthand ?? content.slice(0, 200) },
                ],
            }
        }

        case 'behavior_snapshots': {
            const prompt = row.compiled_prompt as string | null
            if (!prompt) return null
            return {
                messages: [
                    { role: 'system', content: prompt },
                    { role: 'user', content: 'What are your current behavioral rules?' },
                    { role: 'assistant', content: `My behavior is configured with the following compiled prompt:\n${prompt}` },
                ],
            }
        }

        case 'scl_concept_graphs': {
            const graph = row.graph_json as unknown
            if (!graph) return null
            return {
                messages: [
                    { role: 'system', content: 'You are an SCL knowledge extractor for Plexo.' },
                    { role: 'user', content: `Extract the concept graph for domain region: ${row.domain_region ?? 'unknown'}` },
                    { role: 'assistant', content: JSON.stringify(graph) },
                ],
            }
        }

        case 'golden_records': {
            // Golden records are exported as raw knowledge, not chat format
            return {
                messages: [
                    { role: 'system', content: 'You are Plexo. This is your semantic knowledge lattice.' },
                    { role: 'user', content: 'What do you know about this workspace?' },
                    { role: 'assistant', content: `Golden Record v${row.golden_record_version ?? '?'} — ${row.task_count ?? 0} tasks processed.` },
                ],
            }
        }

        default:
            return null
    }
}
