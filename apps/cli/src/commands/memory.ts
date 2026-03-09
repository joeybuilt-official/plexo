// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { Command } from 'commander'
import { requireProfile } from '../config.js'
import { buildClient } from '../client.js'
import { output, c } from '../output.js'
import type { OutputFormat } from '../output.js'

interface MemoryEntry {
    id: string
    content: string
    tags: string[]
    createdAt: string
    relevance?: number
}

export function registerMemory(program: Command): void {
    const memory = program.command('memory').description('Semantic memory operations')

    memory.command('search <query>')
        .description('Hybrid semantic + keyword search across all memory entries')
        .option('--limit <n>', 'Max results', '10')
        .option('--project <id>', 'Scope to a project')
        .option('--output <format>', 'table|json', 'table')
        .option('--profile <name>')
        .action(async (query: string, opts: { limit: string; project?: string; output: OutputFormat; profile?: string }) => {
            const profile = requireProfile(opts.profile)
            const api = buildClient(profile)
            const qs = new URLSearchParams({ q: query, limit: opts.limit })
            if (opts.project) qs.set('projectId', opts.project)
            const data = await api.get<{ entries: MemoryEntry[] }>(`/api/v1/memory/search?${qs}`)
            output(opts.output, ['ID', 'Content', 'Tags', 'Score', 'Created'], data.entries,
                (e) => [
                    e.id.slice(0, 12),
                    e.content.slice(0, 60) + (e.content.length > 60 ? '…' : ''),
                    e.tags.join(', '),
                    e.relevance !== undefined ? e.relevance.toFixed(2) : '—',
                    new Date(e.createdAt).toLocaleDateString(),
                ])
        })

    memory.command('list')
        .description('Recent memory entries (last 20)')
        .option('--output <format>', 'table|json', 'table')
        .option('--profile <name>')
        .action(async (opts: { output: OutputFormat; profile?: string }) => {
            const profile = requireProfile(opts.profile)
            const api = buildClient(profile)
            const data = await api.get<{ entries: MemoryEntry[] }>('/api/v1/memory/search?limit=20&q=')
            output(opts.output, ['ID', 'Content', 'Tags', 'Created'], data.entries,
                (e) => [
                    e.id.slice(0, 12),
                    e.content.slice(0, 70) + (e.content.length > 70 ? '…' : ''),
                    e.tags.join(', ') || '—',
                    new Date(e.createdAt).toLocaleDateString(),
                ])
        })

    memory.command('get <id>')
        .option('--profile <name>')
        .action(async (id: string, opts: { profile?: string }) => {
            const profile = requireProfile(opts.profile)
            const e = await buildClient(profile).get<MemoryEntry>(`/api/v1/memory/${id}`)
            console.log(`${c.bold('ID:')}      ${e.id}`)
            console.log(`${c.bold('Tags:')}    ${e.tags.join(', ') || '—'}`)
            console.log(`${c.bold('Created:')} ${new Date(e.createdAt).toLocaleString()}`)
            console.log(`\n${e.content}`)
        })

    memory.command('delete <id>')
        .option('--profile <name>')
        .action(async (id: string, opts: { profile?: string }) => {
            const profile = requireProfile(opts.profile)
            await buildClient(profile).delete(`/api/v1/memory/${id}`)
            console.log(`Deleted: ${c.red(id)}`)
        })
}
