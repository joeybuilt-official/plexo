// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Jira tool factory — produces agent-callable tools from an installed Jira connection.
 *
 * Tools: jira__create_issue, jira__list_issues, jira__update_issue, jira__search
 *
 * Auth: Jira Cloud uses Basic auth with email + API token.
 * Credentials expected: { email, api_token, site } where site is e.g. "myorg.atlassian.net".
 */

import { tool } from 'ai'
import { z } from 'zod'
import type { ConnectionCredentials, ToolSet } from '../bridge.js'
import pino from 'pino'

const logger = pino({ name: 'jira:tools' })

function buildAuth(creds: ConnectionCredentials): { headers: Record<string, string>; baseUrl: string } {
    const email = (creds.email as string) ?? (creds.username as string) ?? ''
    const token = (creds.api_token as string) ?? (creds.api_key as string) ?? (creds.token as string) ?? ''
    const siteRaw = (creds.site as string) ?? (creds.base_url as string) ?? (creds.url as string) ?? ''
    const site = siteRaw.replace(/^https?:\/\//, '').replace(/\/$/, '')
    const basic = Buffer.from(`${email}:${token}`).toString('base64')
    return {
        headers: {
            Authorization: `Basic ${basic}`,
            Accept: 'application/json',
            'Content-Type': 'application/json',
        },
        baseUrl: `https://${site}/rest/api/3`,
    }
}

function audit(toolName: string, detail: Record<string, unknown>, opts: { connectionId: string; workspaceId: string }) {
    logger.info({
        type: 'jira_tool_call',
        toolName,
        connectionId: opts.connectionId,
        workspaceId: opts.workspaceId,
        ...detail,
    }, `Jira tool: ${toolName}`)
}

export const JIRA_TOOLS = (creds: ConnectionCredentials, opts: { connectionId: string; workspaceId: string }): ToolSet => {
    const { headers, baseUrl } = buildAuth(creds)

    return {
        jira__create_issue: tool({
            description: 'Create a new Jira issue in a given project.',
            inputSchema: z.object({
                projectKey: z.string().describe('Project key like "ENG"'),
                summary: z.string().describe('Issue summary / title'),
                description: z.string().optional().describe('Plain-text description'),
                issueType: z.string().optional().default('Task').describe('Issue type name: Task, Bug, Story, etc.'),
            }),
            execute: async ({ projectKey, summary, description, issueType = 'Task' }) => {
                try {
                    const body = {
                        fields: {
                            project: { key: projectKey },
                            summary,
                            issuetype: { name: issueType },
                            ...(description && {
                                description: {
                                    type: 'doc',
                                    version: 1,
                                    content: [{
                                        type: 'paragraph',
                                        content: [{ type: 'text', text: description }],
                                    }],
                                },
                            }),
                        },
                    }
                    const res = await fetch(`${baseUrl}/issue`, {
                        method: 'POST',
                        headers,
                        body: JSON.stringify(body),
                    })
                    if (!res.ok) return `Jira error ${res.status}: ${(await res.text()).slice(0, 200)}`
                    const data = await res.json() as { key: string; self: string }
                    audit('jira__create_issue', { key: data.key }, opts)
                    return `Created Jira issue ${data.key}`
                } catch (err) {
                    return `Jira create_issue failed: ${err instanceof Error ? err.message : String(err)}`
                }
            },
        }),

        jira__list_issues: tool({
            description: 'List Jira issues for a project, optionally filtered by status.',
            inputSchema: z.object({
                projectKey: z.string().describe('Project key like "ENG"'),
                status: z.string().optional().describe('Status name like "In Progress" or "Done"'),
                limit: z.number().optional().default(20),
            }),
            execute: async ({ projectKey, status, limit = 20 }) => {
                try {
                    const jqlParts = [`project = "${projectKey}"`]
                    if (status) jqlParts.push(`status = "${status}"`)
                    const jql = jqlParts.join(' AND ') + ' ORDER BY updated DESC'
                    const url = `${baseUrl}/search?jql=${encodeURIComponent(jql)}&maxResults=${Math.min(limit, 50)}&fields=summary,status,issuetype,priority`
                    const res = await fetch(url, { headers })
                    if (!res.ok) return `Jira error ${res.status}: ${(await res.text()).slice(0, 200)}`
                    const data = await res.json() as {
                        issues: Array<{
                            key: string
                            fields: {
                                summary: string
                                status: { name: string }
                                issuetype: { name: string }
                                priority?: { name: string }
                            }
                        }>
                    }
                    audit('jira__list_issues', { projectKey, count: data.issues.length }, opts)
                    if (!data.issues.length) return 'No issues found.'
                    return data.issues.map((i) =>
                        `${i.key} [${i.fields.status.name}] ${i.fields.issuetype.name}${i.fields.priority ? ` p:${i.fields.priority.name}` : ''} — ${i.fields.summary}`
                    ).join('\n')
                } catch (err) {
                    return `Jira list_issues failed: ${err instanceof Error ? err.message : String(err)}`
                }
            },
        }),

        jira__update_issue: tool({
            description: 'Update a Jira issue by key. Can update summary, description, or transition to a new status.',
            inputSchema: z.object({
                issueKey: z.string().describe('Issue key like "ENG-123"'),
                summary: z.string().optional(),
                description: z.string().optional(),
                transitionTo: z.string().optional().describe('Target status name to transition to'),
            }),
            execute: async ({ issueKey, summary, description, transitionTo }) => {
                try {
                    if (summary !== undefined || description !== undefined) {
                        const fields: Record<string, unknown> = {}
                        if (summary !== undefined) fields.summary = summary
                        if (description !== undefined) {
                            fields.description = {
                                type: 'doc',
                                version: 1,
                                content: [{
                                    type: 'paragraph',
                                    content: [{ type: 'text', text: description }],
                                }],
                            }
                        }
                        const res = await fetch(`${baseUrl}/issue/${issueKey}`, {
                            method: 'PUT',
                            headers,
                            body: JSON.stringify({ fields }),
                        })
                        if (!res.ok) return `Jira error ${res.status}: ${(await res.text()).slice(0, 200)}`
                    }

                    if (transitionTo) {
                        const transRes = await fetch(`${baseUrl}/issue/${issueKey}/transitions`, { headers })
                        if (!transRes.ok) return `Jira error fetching transitions: ${transRes.status}`
                        const trans = await transRes.json() as { transitions: Array<{ id: string; name: string; to: { name: string } }> }
                        const match = trans.transitions.find((t) =>
                            t.name.toLowerCase() === transitionTo.toLowerCase() ||
                            t.to.name.toLowerCase() === transitionTo.toLowerCase(),
                        )
                        if (!match) return `No transition to "${transitionTo}" available. Options: ${trans.transitions.map((t) => t.name).join(', ')}`
                        const doRes = await fetch(`${baseUrl}/issue/${issueKey}/transitions`, {
                            method: 'POST',
                            headers,
                            body: JSON.stringify({ transition: { id: match.id } }),
                        })
                        if (!doRes.ok) return `Jira transition error: ${doRes.status}`
                    }

                    audit('jira__update_issue', { issueKey, transitionTo }, opts)
                    return `Updated ${issueKey}`
                } catch (err) {
                    return `Jira update_issue failed: ${err instanceof Error ? err.message : String(err)}`
                }
            },
        }),

        jira__search: tool({
            description: 'Search Jira issues using JQL (Jira Query Language) or a plain text query.',
            inputSchema: z.object({
                jql: z.string().describe('JQL like: text ~ "login bug" OR a plain search term'),
                limit: z.number().optional().default(20),
            }),
            execute: async ({ jql, limit = 20 }) => {
                try {
                    const query = jql.match(/[~=]|project|status|assignee/i) ? jql : `text ~ "${jql}"`
                    const url = `${baseUrl}/search?jql=${encodeURIComponent(query)}&maxResults=${Math.min(limit, 50)}&fields=summary,status,issuetype`
                    const res = await fetch(url, { headers })
                    if (!res.ok) return `Jira error ${res.status}: ${(await res.text()).slice(0, 200)}`
                    const data = await res.json() as {
                        issues: Array<{
                            key: string
                            fields: { summary: string; status: { name: string }; issuetype: { name: string } }
                        }>
                    }
                    audit('jira__search', { query, count: data.issues.length }, opts)
                    if (!data.issues.length) return 'No matching issues.'
                    return data.issues.map((i) => `${i.key} [${i.fields.status.name}] ${i.fields.issuetype.name} — ${i.fields.summary}`).join('\n')
                } catch (err) {
                    return `Jira search failed: ${err instanceof Error ? err.message : String(err)}`
                }
            },
        }),
    }
}
