// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Linear tool factory — produces agent-callable tools from an installed Linear connection.
 *
 * Tools: linear__create_issue, linear__list_issues, linear__update_issue, linear__search
 *
 * Auth: Personal API key or OAuth token. Linear uses raw API key (not "Bearer ") for
 * personal keys per their docs.
 */

import { tool } from 'ai'
import { z } from 'zod'
import type { ConnectionCredentials, ToolSet } from '../bridge.js'
import pino from 'pino'

const logger = pino({ name: 'linear:tools' })

const ENDPOINT = 'https://api.linear.app/graphql'

function buildHeaders(creds: ConnectionCredentials): Record<string, string> {
    const apiKey = (creds.api_key as string) ?? ''
    const oauth = (creds.access_token as string) ?? (creds.token as string) ?? ''
    const auth = oauth ? `Bearer ${oauth}` : apiKey
    return {
        Authorization: auth,
        'Content-Type': 'application/json',
    }
}

async function gql<T>(headers: Record<string, string>, query: string, variables?: Record<string, unknown>): Promise<{ data?: T; error?: string }> {
    try {
        const res = await fetch(ENDPOINT, {
            method: 'POST',
            headers,
            body: JSON.stringify({ query, variables }),
        })
        if (!res.ok) return { error: `Linear error ${res.status}: ${(await res.text()).slice(0, 200)}` }
        const json = await res.json() as { data?: T; errors?: Array<{ message: string }> }
        if (json.errors?.length) return { error: `Linear GraphQL error: ${json.errors.map((e) => e.message).join('; ')}` }
        return { data: json.data }
    } catch (err) {
        return { error: `Linear request failed: ${err instanceof Error ? err.message : String(err)}` }
    }
}

function audit(toolName: string, detail: Record<string, unknown>, opts: { connectionId: string; workspaceId: string }) {
    logger.info({
        type: 'linear_tool_call',
        toolName,
        connectionId: opts.connectionId,
        workspaceId: opts.workspaceId,
        ...detail,
    }, `Linear tool: ${toolName}`)
}

export const LINEAR_TOOLS = (creds: ConnectionCredentials, opts: { connectionId: string; workspaceId: string }): ToolSet => {
    const headers = buildHeaders(creds)

    return {
        linear__create_issue: tool({
            description: 'Create a new issue in Linear. Requires a team ID (or team key) so the issue is routed correctly.',
            inputSchema: z.object({
                teamKey: z.string().describe('Team key like "ENG" or a full team UUID'),
                title: z.string().describe('Issue title'),
                description: z.string().optional().describe('Markdown description'),
                priority: z.number().int().min(0).max(4).optional().describe('0=none, 1=urgent, 2=high, 3=medium, 4=low'),
            }),
            execute: async ({ teamKey, title, description, priority }) => {
                // Resolve team UUID if a key was supplied
                let teamId = teamKey
                if (!/^[0-9a-f]{8}-/.test(teamKey)) {
                    const teamRes = await gql<{ teams: { nodes: Array<{ id: string; key: string }> } }>(
                        headers,
                        'query($key: String!) { teams(filter: { key: { eq: $key } }) { nodes { id key } } }',
                        { key: teamKey },
                    )
                    if (teamRes.error) return teamRes.error
                    const node = teamRes.data?.teams.nodes[0]
                    if (!node) return `Linear team "${teamKey}" not found`
                    teamId = node.id
                }

                const mutation = `mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier url } } }`
                const result = await gql<{ issueCreate: { success: boolean; issue: { id: string; identifier: string; url: string } } }>(
                    headers,
                    mutation,
                    { input: { teamId, title, description, priority } },
                )
                if (result.error) return result.error
                const issue = result.data?.issueCreate.issue
                if (!issue) return 'Linear: issue creation returned no data'
                audit('linear__create_issue', { identifier: issue.identifier }, opts)
                return `Created Linear issue ${issue.identifier}: ${issue.url}`
            },
        }),

        linear__list_issues: tool({
            description: 'List issues in Linear, optionally filtered by team key and status.',
            inputSchema: z.object({
                teamKey: z.string().optional().describe('Team key like "ENG" to scope the list'),
                state: z.enum(['open', 'closed', 'all']).optional().default('open'),
                limit: z.number().optional().default(20),
            }),
            execute: async ({ teamKey, state = 'open', limit = 20 }) => {
                const filterParts: string[] = []
                if (teamKey) filterParts.push(`team: { key: { eq: "${teamKey}" } }`)
                if (state === 'open') filterParts.push(`state: { type: { nin: ["completed", "canceled"] } }`)
                else if (state === 'closed') filterParts.push(`state: { type: { in: ["completed", "canceled"] } }`)
                const filter = filterParts.length ? `filter: { ${filterParts.join(', ')} }, ` : ''

                const query = `query { issues(${filter}first: ${Math.min(limit, 50)}) { nodes { identifier title state { name } url priority } } }`
                const result = await gql<{ issues: { nodes: Array<{ identifier: string; title: string; state: { name: string }; url: string; priority: number }> } }>(headers, query)
                if (result.error) return result.error
                const nodes = result.data?.issues.nodes ?? []
                audit('linear__list_issues', { count: nodes.length }, opts)
                if (!nodes.length) return 'No issues found.'
                return nodes.map((i) => `${i.identifier} [${i.state.name}] p${i.priority} ${i.title} — ${i.url}`).join('\n')
            },
        }),

        linear__update_issue: tool({
            description: 'Update a Linear issue by identifier (e.g. ENG-123) or full UUID. Can change title, description, or state.',
            inputSchema: z.object({
                identifier: z.string().describe('Issue identifier like "ENG-123" or UUID'),
                title: z.string().optional(),
                description: z.string().optional(),
                stateName: z.string().optional().describe('State name like "In Progress" or "Done"'),
            }),
            execute: async ({ identifier, title, description, stateName }) => {
                // Resolve UUID if identifier used
                let issueId = identifier
                let teamId: string | undefined
                if (/^[A-Z]+-\d+$/.test(identifier)) {
                    const lookup = await gql<{ issue: { id: string; team: { id: string } } | null }>(
                        headers,
                        'query($id: String!) { issue(id: $id) { id team { id } } }',
                        { id: identifier },
                    )
                    if (lookup.error) return lookup.error
                    if (!lookup.data?.issue) return `Linear issue ${identifier} not found`
                    issueId = lookup.data.issue.id
                    teamId = lookup.data.issue.team.id
                }

                const input: Record<string, unknown> = {}
                if (title !== undefined) input.title = title
                if (description !== undefined) input.description = description
                if (stateName !== undefined) {
                    if (!teamId) {
                        const lookup = await gql<{ issue: { team: { id: string } } | null }>(
                            headers,
                            'query($id: String!) { issue(id: $id) { team { id } } }',
                            { id: issueId },
                        )
                        if (lookup.error) return lookup.error
                        teamId = lookup.data?.issue?.team.id
                    }
                    if (teamId) {
                        const states = await gql<{ workflowStates: { nodes: Array<{ id: string; name: string }> } }>(
                            headers,
                            'query($teamId: ID!) { workflowStates(filter: { team: { id: { eq: $teamId } } }) { nodes { id name } } }',
                            { teamId },
                        )
                        if (states.error) return states.error
                        const match = states.data?.workflowStates.nodes.find((s) => s.name.toLowerCase() === stateName.toLowerCase())
                        if (!match) return `Linear state "${stateName}" not found on team`
                        input.stateId = match.id
                    }
                }

                const mutation = `mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success issue { identifier url } } }`
                const result = await gql<{ issueUpdate: { success: boolean; issue: { identifier: string; url: string } } }>(
                    headers,
                    mutation,
                    { id: issueId, input },
                )
                if (result.error) return result.error
                const issue = result.data?.issueUpdate.issue
                if (!issue) return 'Linear: issue update returned no data'
                audit('linear__update_issue', { identifier: issue.identifier }, opts)
                return `Updated ${issue.identifier}: ${issue.url}`
            },
        }),

        linear__search: tool({
            description: 'Search Linear issues by text query across titles and descriptions.',
            inputSchema: z.object({
                query: z.string().describe('Search text'),
                limit: z.number().optional().default(10),
            }),
            execute: async ({ query, limit = 10 }) => {
                const gqlQuery = `query($term: String!, $first: Int!) {
                    searchIssues(term: $term, first: $first) {
                        nodes { identifier title url state { name } }
                    }
                }`
                const result = await gql<{ searchIssues: { nodes: Array<{ identifier: string; title: string; url: string; state: { name: string } }> } }>(
                    headers,
                    gqlQuery,
                    { term: query, first: Math.min(limit, 25) },
                )
                if (result.error) return result.error
                const nodes = result.data?.searchIssues.nodes ?? []
                audit('linear__search', { query, count: nodes.length }, opts)
                if (!nodes.length) return 'No matching issues.'
                return nodes.map((i) => `${i.identifier} [${i.state.name}] ${i.title} — ${i.url}`).join('\n')
            },
        }),
    }
}
