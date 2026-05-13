// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * MCP Prompts — Phase 4
 *
 * Prompts are pre-defined message templates that MCP clients (e.g. Claude Desktop)
 * can use to bootstrap common interactions without knowing Plexo's API schema.
 *
 * create_task    — template for submitting a task to Plexo
 * search_memory  — template for searching workspace memory
 * agent_status   — template for checking agent + cost status
 */

export interface PromptArgument {
    name: string
    description: string
    required: boolean
}

export interface PromptDefinition {
    name: string
    description: string
    arguments: PromptArgument[]
}

export const promptDefinitions: PromptDefinition[] = [
    {
        name: 'create_task',
        description: 'Submit a task to your Plexo agent. Use this to delegate work like research, coding, automation, or analysis.',
        arguments: [
            { name: 'request', description: 'What you want the agent to do', required: true },
            { name: 'type', description: 'Task type: general, research, coding, automation, analysis, or writing', required: false },
        ],
    },
    {
        name: 'search_memory',
        description: 'Search your Plexo workspace memory for stored facts, patterns, and preferences.',
        arguments: [
            { name: 'query', description: 'What to search for in workspace memory', required: true },
        ],
    },
    {
        name: 'agent_status',
        description: 'Check your Plexo agent status — active tasks, weekly cost, and workspace summary.',
        arguments: [],
    },
]

/**
 * Returns the prompt messages for a given prompt name and arguments.
 * These are returned to the MCP client to seed the conversation.
 */
export function getPromptMessages(
    name: string,
    args: Record<string, string>,
): Array<{ role: 'user' | 'assistant'; content: string }> {
    if (name === 'create_task') {
        const type = args.type ?? 'general'
        const request = args.request ?? ''
        return [
            {
                role: 'user',
                content: `Please create a ${type} task in Plexo with the following request:\n\n${request}\n\nUse the plexo_create_task tool to submit this.`,
            },
        ]
    }

    if (name === 'search_memory') {
        const query = args.query ?? ''
        return [
            {
                role: 'user',
                content: `Search my Plexo workspace memory for: "${query}"\n\nUse the plexo_search_memory tool and show me the matching entries.`,
            },
        ]
    }

    if (name === 'agent_status') {
        return [
            {
                role: 'user',
                content: 'Check my Plexo agent status. Use plexo_workspace_info to show active tasks, weekly cost, and overall workspace health.',
            },
        ]
    }

    throw new Error(`Unknown prompt: ${name}`)
}
