// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Notion tool factory — produces agent-callable tools from an installed Notion connection.
 *
 * Tools: notion__search, notion__create_page, notion__update_page, notion__get_page,
 *        notion__list_databases, notion__query_database
 *
 * Auth: Integration token stored as api_key / access_token / token.
 */

import { tool } from 'ai'
import { z } from 'zod'
import type { ConnectionCredentials, ToolSet } from '../bridge.js'
import pino from 'pino'

const logger = pino({ name: 'notion:tools' })

const NOTION_VERSION = '2022-06-28'
const BASE_URL = 'https://api.notion.com/v1'

function buildHeaders(creds: ConnectionCredentials): Record<string, string> {
    const token = (creds.access_token as string)
        ?? (creds.api_key as string)
        ?? (creds.token as string)
        ?? (creds.integration_token as string)
        ?? ''
    return {
        Authorization: `Bearer ${token}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json',
    }
}

function audit(toolName: string, detail: Record<string, unknown>, opts: { connectionId: string; workspaceId: string }) {
    logger.info({
        type: 'notion_tool_call',
        toolName,
        connectionId: opts.connectionId,
        workspaceId: opts.workspaceId,
        ...detail,
    }, `Notion tool: ${toolName}`)
}

export const NOTION_TOOLS = (creds: ConnectionCredentials, opts: { connectionId: string; workspaceId: string }): ToolSet => {
    const headers = buildHeaders(creds)

    return {
        notion__search: tool({
            description: 'Search across all pages and databases in the Notion workspace. Returns titles, IDs, and URLs.',
            inputSchema: z.object({
                query: z.string().describe('Search query text'),
                filter: z.enum(['page', 'database', 'both']).optional().default('both').describe('Limit results to pages, databases, or both'),
                limit: z.number().optional().default(10).describe('Max results (1-50)'),
            }),
            execute: async ({ query, filter = 'both', limit = 10 }) => {
                try {
                    const body: Record<string, unknown> = { query, page_size: Math.min(limit, 50) }
                    if (filter !== 'both') {
                        body.filter = { value: filter, property: 'object' }
                    }
                    const res = await fetch(`${BASE_URL}/search`, {
                        method: 'POST',
                        headers,
                        body: JSON.stringify(body),
                    })
                    if (!res.ok) return `Notion error ${res.status}: ${(await res.text()).slice(0, 200)}`
                    const data = await res.json() as {
                        results: Array<{
                            id: string
                            object: string
                            url?: string
                            properties?: Record<string, unknown>
                            title?: Array<{ plain_text: string }>
                        }>
                    }
                    audit('notion__search', { query, resultCount: data.results.length }, opts)
                    if (!data.results.length) return 'No results.'
                    return data.results.map((r) => {
                        let title = '(untitled)'
                        if (r.title && Array.isArray(r.title) && r.title.length) {
                            title = r.title.map((t) => t.plain_text).join('')
                        } else if (r.properties) {
                            for (const prop of Object.values(r.properties)) {
                                const p = prop as { title?: Array<{ plain_text: string }>; type?: string }
                                if (p.type === 'title' && Array.isArray(p.title) && p.title.length) {
                                    title = p.title.map((t) => t.plain_text).join('')
                                    break
                                }
                            }
                        }
                        return `[${r.object}] ${title} — id: ${r.id}${r.url ? ` — ${r.url}` : ''}`
                    }).join('\n')
                } catch (err) {
                    return `Notion search failed: ${err instanceof Error ? err.message : String(err)}`
                }
            },
        }),

        notion__create_page: tool({
            description: 'Create a new Notion page inside a parent page or database. For database pages, use properties matching the database schema.',
            inputSchema: z.object({
                parentId: z.string().describe('Parent page ID or database ID'),
                parentType: z.enum(['page', 'database']).describe('Whether parentId is a page or database'),
                title: z.string().describe('Page title'),
                content: z.string().optional().describe('Markdown-ish body text (rendered as paragraph blocks)'),
            }),
            execute: async ({ parentId, parentType, title, content }) => {
                try {
                    const parent = parentType === 'database'
                        ? { database_id: parentId }
                        : { page_id: parentId }

                    const properties: Record<string, unknown> = parentType === 'database'
                        ? { Name: { title: [{ text: { content: title } }] } }
                        : { title: [{ text: { content: title } }] }

                    const children: Array<Record<string, unknown>> = []
                    if (content) {
                        for (const para of content.split(/\n\n+/)) {
                            if (!para.trim()) continue
                            children.push({
                                object: 'block',
                                type: 'paragraph',
                                paragraph: { rich_text: [{ type: 'text', text: { content: para.slice(0, 2000) } }] },
                            })
                        }
                    }

                    const res = await fetch(`${BASE_URL}/pages`, {
                        method: 'POST',
                        headers,
                        body: JSON.stringify({ parent, properties, children }),
                    })
                    if (!res.ok) return `Notion error ${res.status}: ${(await res.text()).slice(0, 200)}`
                    const page = await res.json() as { id: string; url: string }
                    audit('notion__create_page', { pageId: page.id, parentType }, opts)
                    return `Created Notion page: ${page.url} (id: ${page.id})`
                } catch (err) {
                    return `Notion create_page failed: ${err instanceof Error ? err.message : String(err)}`
                }
            },
        }),

        notion__update_page: tool({
            description: 'Update properties on a Notion page (title, archived state, or arbitrary property values).',
            inputSchema: z.object({
                pageId: z.string().describe('Notion page ID'),
                title: z.string().optional().describe('New page title'),
                archived: z.boolean().optional().describe('Set to true to archive the page'),
            }),
            execute: async ({ pageId, title, archived }) => {
                try {
                    const body: Record<string, unknown> = {}
                    if (title !== undefined) {
                        body.properties = {
                            title: [{ text: { content: title } }],
                        }
                    }
                    if (archived !== undefined) body.archived = archived

                    const res = await fetch(`${BASE_URL}/pages/${pageId}`, {
                        method: 'PATCH',
                        headers,
                        body: JSON.stringify(body),
                    })
                    if (!res.ok) return `Notion error ${res.status}: ${(await res.text()).slice(0, 200)}`
                    audit('notion__update_page', { pageId, title: !!title, archived }, opts)
                    return `Updated Notion page ${pageId}`
                } catch (err) {
                    return `Notion update_page failed: ${err instanceof Error ? err.message : String(err)}`
                }
            },
        }),

        notion__get_page: tool({
            description: 'Retrieve a Notion page with its properties and child block content.',
            inputSchema: z.object({
                pageId: z.string().describe('Notion page ID'),
            }),
            execute: async ({ pageId }) => {
                try {
                    const pageRes = await fetch(`${BASE_URL}/pages/${pageId}`, { headers })
                    if (!pageRes.ok) return `Notion error ${pageRes.status}: ${(await pageRes.text()).slice(0, 200)}`
                    const page = await pageRes.json() as {
                        id: string
                        url: string
                        archived: boolean
                        properties: Record<string, { type?: string; title?: Array<{ plain_text: string }>; rich_text?: Array<{ plain_text: string }> }>
                    }

                    const blocksRes = await fetch(`${BASE_URL}/blocks/${pageId}/children?page_size=50`, { headers })
                    let blockText = ''
                    if (blocksRes.ok) {
                        const blocks = await blocksRes.json() as {
                            results: Array<{ type: string; [k: string]: unknown }>
                        }
                        const textParts: string[] = []
                        for (const b of blocks.results) {
                            const content = (b[b.type] as { rich_text?: Array<{ plain_text: string }> } | undefined)
                            if (content?.rich_text?.length) {
                                textParts.push(content.rich_text.map((r) => r.plain_text).join(''))
                            }
                        }
                        blockText = textParts.join('\n')
                    }

                    let title = '(untitled)'
                    for (const prop of Object.values(page.properties)) {
                        if (prop.type === 'title' && prop.title?.length) {
                            title = prop.title.map((t) => t.plain_text).join('')
                            break
                        }
                    }
                    audit('notion__get_page', { pageId }, opts)
                    return `Title: ${title}\nURL: ${page.url}\nArchived: ${page.archived}\n\n${blockText || '(no content)'}`
                } catch (err) {
                    return `Notion get_page failed: ${err instanceof Error ? err.message : String(err)}`
                }
            },
        }),

        notion__list_databases: tool({
            description: 'List all databases the integration can access in the Notion workspace.',
            inputSchema: z.object({
                limit: z.number().optional().default(20),
            }),
            execute: async ({ limit = 20 }) => {
                try {
                    const res = await fetch(`${BASE_URL}/search`, {
                        method: 'POST',
                        headers,
                        body: JSON.stringify({
                            filter: { value: 'database', property: 'object' },
                            page_size: Math.min(limit, 50),
                        }),
                    })
                    if (!res.ok) return `Notion error ${res.status}: ${(await res.text()).slice(0, 200)}`
                    const data = await res.json() as {
                        results: Array<{
                            id: string
                            url?: string
                            title?: Array<{ plain_text: string }>
                        }>
                    }
                    audit('notion__list_databases', { count: data.results.length }, opts)
                    if (!data.results.length) return 'No databases found.'
                    return data.results.map((d) => {
                        const title = d.title?.map((t) => t.plain_text).join('') || '(untitled)'
                        return `${title} — id: ${d.id}${d.url ? ` — ${d.url}` : ''}`
                    }).join('\n')
                } catch (err) {
                    return `Notion list_databases failed: ${err instanceof Error ? err.message : String(err)}`
                }
            },
        }),

        notion__query_database: tool({
            description: 'Query a Notion database for rows/entries. Returns row IDs and their title properties.',
            inputSchema: z.object({
                databaseId: z.string().describe('Database ID'),
                limit: z.number().optional().default(20),
            }),
            execute: async ({ databaseId, limit = 20 }) => {
                try {
                    const res = await fetch(`${BASE_URL}/databases/${databaseId}/query`, {
                        method: 'POST',
                        headers,
                        body: JSON.stringify({ page_size: Math.min(limit, 100) }),
                    })
                    if (!res.ok) return `Notion error ${res.status}: ${(await res.text()).slice(0, 200)}`
                    const data = await res.json() as {
                        results: Array<{
                            id: string
                            url?: string
                            properties: Record<string, { type?: string; title?: Array<{ plain_text: string }> }>
                        }>
                    }
                    audit('notion__query_database', { databaseId, count: data.results.length }, opts)
                    if (!data.results.length) return 'Database is empty.'
                    return data.results.map((row) => {
                        let title = '(untitled)'
                        for (const prop of Object.values(row.properties)) {
                            if (prop.type === 'title' && prop.title?.length) {
                                title = prop.title.map((t) => t.plain_text).join('')
                                break
                            }
                        }
                        return `${title} — id: ${row.id}${row.url ? ` — ${row.url}` : ''}`
                    }).join('\n')
                } catch (err) {
                    return `Notion query_database failed: ${err instanceof Error ? err.message : String(err)}`
                }
            },
        }),
    }
}
