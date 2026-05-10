// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Airtable tool factory — produces agent-callable tools from an installed Airtable connection.
 *
 * Tools: airtable__list_records, airtable__create_record, airtable__update_record, airtable__search
 *
 * Auth: Personal Access Token stored as api_key / access_token.
 */

import { tool } from 'ai'
import { z } from 'zod'
import type { ConnectionCredentials, ToolSet } from '../bridge.js'
import pino from 'pino'

const logger = pino({ name: 'airtable:tools' })

const API_BASE = 'https://api.airtable.com/v0'

function buildHeaders(creds: ConnectionCredentials): Record<string, string> {
    const token = (creds.api_key as string) ?? (creds.access_token as string) ?? (creds.token as string) ?? ''
    return {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
    }
}

function audit(toolName: string, detail: Record<string, unknown>, opts: { connectionId: string; workspaceId: string }) {
    logger.info({
        type: 'airtable_tool_call',
        toolName,
        connectionId: opts.connectionId,
        workspaceId: opts.workspaceId,
        ...detail,
    }, `Airtable tool: ${toolName}`)
}

export const AIRTABLE_TOOLS = (creds: ConnectionCredentials, opts: { connectionId: string; workspaceId: string }): ToolSet => {
    const headers = buildHeaders(creds)
    const defaultBaseId = (creds.base_id as string) ?? ''

    return {
        airtable__list_records: tool({
            description: 'List records from an Airtable table. Returns record IDs and their fields.',
            inputSchema: z.object({
                baseId: z.string().optional().describe('Airtable base ID (app...). Uses stored default if omitted.'),
                table: z.string().describe('Table name or ID'),
                limit: z.number().optional().default(20),
            }),
            execute: async ({ baseId, table, limit = 20 }) => {
                try {
                    const base = baseId ?? defaultBaseId
                    if (!base) return 'Airtable error: no base ID supplied and no default configured'
                    const url = `${API_BASE}/${base}/${encodeURIComponent(table)}?maxRecords=${Math.min(limit, 100)}`
                    const res = await fetch(url, { headers })
                    if (!res.ok) return `Airtable error ${res.status}: ${(await res.text()).slice(0, 200)}`
                    const data = await res.json() as { records: Array<{ id: string; fields: Record<string, unknown> }> }
                    audit('airtable__list_records', { baseId: base, table, count: data.records.length }, opts)
                    if (!data.records.length) return 'No records found.'
                    return data.records.map((r) => {
                        const fieldSummary = Object.entries(r.fields)
                            .slice(0, 5)
                            .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
                            .join(' | ')
                        return `${r.id}: ${fieldSummary}`
                    }).join('\n')
                } catch (err) {
                    return `Airtable list_records failed: ${err instanceof Error ? err.message : String(err)}`
                }
            },
        }),

        airtable__create_record: tool({
            description: 'Create a new record in an Airtable table. Fields must match the table schema.',
            inputSchema: z.object({
                baseId: z.string().optional().describe('Airtable base ID. Uses stored default if omitted.'),
                table: z.string().describe('Table name or ID'),
                fields: z.record(z.string(), z.unknown()).describe('Record fields as a JSON object'),
            }),
            execute: async ({ baseId, table, fields }) => {
                try {
                    const base = baseId ?? defaultBaseId
                    if (!base) return 'Airtable error: no base ID supplied and no default configured'
                    const res = await fetch(`${API_BASE}/${base}/${encodeURIComponent(table)}`, {
                        method: 'POST',
                        headers,
                        body: JSON.stringify({ fields }),
                    })
                    if (!res.ok) return `Airtable error ${res.status}: ${(await res.text()).slice(0, 200)}`
                    const data = await res.json() as { id: string }
                    audit('airtable__create_record', { baseId: base, table, id: data.id }, opts)
                    return `Created record ${data.id}`
                } catch (err) {
                    return `Airtable create_record failed: ${err instanceof Error ? err.message : String(err)}`
                }
            },
        }),

        airtable__update_record: tool({
            description: 'Update fields on an existing Airtable record.',
            inputSchema: z.object({
                baseId: z.string().optional().describe('Airtable base ID. Uses stored default if omitted.'),
                table: z.string().describe('Table name or ID'),
                recordId: z.string().describe('Record ID (rec...)'),
                fields: z.record(z.string(), z.unknown()).describe('Fields to update as a JSON object'),
            }),
            execute: async ({ baseId, table, recordId, fields }) => {
                try {
                    const base = baseId ?? defaultBaseId
                    if (!base) return 'Airtable error: no base ID supplied and no default configured'
                    const res = await fetch(`${API_BASE}/${base}/${encodeURIComponent(table)}/${recordId}`, {
                        method: 'PATCH',
                        headers,
                        body: JSON.stringify({ fields }),
                    })
                    if (!res.ok) return `Airtable error ${res.status}: ${(await res.text()).slice(0, 200)}`
                    audit('airtable__update_record', { baseId: base, table, recordId }, opts)
                    return `Updated ${recordId}`
                } catch (err) {
                    return `Airtable update_record failed: ${err instanceof Error ? err.message : String(err)}`
                }
            },
        }),

        airtable__search: tool({
            description: 'Search for records in an Airtable table using a filterByFormula expression. Example: SEARCH("john", {Name})',
            inputSchema: z.object({
                baseId: z.string().optional().describe('Airtable base ID. Uses stored default if omitted.'),
                table: z.string().describe('Table name or ID'),
                formula: z.string().describe('Airtable filterByFormula expression'),
                limit: z.number().optional().default(20),
            }),
            execute: async ({ baseId, table, formula, limit = 20 }) => {
                try {
                    const base = baseId ?? defaultBaseId
                    if (!base) return 'Airtable error: no base ID supplied and no default configured'
                    const url = `${API_BASE}/${base}/${encodeURIComponent(table)}?filterByFormula=${encodeURIComponent(formula)}&maxRecords=${Math.min(limit, 100)}`
                    const res = await fetch(url, { headers })
                    if (!res.ok) return `Airtable error ${res.status}: ${(await res.text()).slice(0, 200)}`
                    const data = await res.json() as { records: Array<{ id: string; fields: Record<string, unknown> }> }
                    audit('airtable__search', { baseId: base, table, count: data.records.length }, opts)
                    if (!data.records.length) return 'No matching records.'
                    return data.records.map((r) => {
                        const fieldSummary = Object.entries(r.fields)
                            .slice(0, 5)
                            .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
                            .join(' | ')
                        return `${r.id}: ${fieldSummary}`
                    }).join('\n')
                } catch (err) {
                    return `Airtable search failed: ${err instanceof Error ? err.message : String(err)}`
                }
            },
        }),
    }
}
