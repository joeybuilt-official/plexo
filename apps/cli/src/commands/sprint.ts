// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { Command } from 'commander'
import { requireProfile } from '../config.js'
import { buildClient } from '../client.js'
import { output, spinner, statusBadge, c, fatal } from '../output.js'
import { waitForSprint, openSse } from '../sse-stream.js'
import type { OutputFormat } from '../output.js'

interface Sprint {
    id: string
    name?: string
    status: string
    createdAt: string
    taskCount?: number
}

function parseTimeout(t: string): number {
    const m = t.match(/^(\d+)(m|h|s)$/)
    if (!m) return 4 * 3600_000
    const n = parseInt(m[1]!)
    return m[2] === 'h' ? n * 3600_000 : m[2] === 'm' ? n * 60_000 : n * 1000
}

export function registerSprint(program: Command): void {
    const sprint = program.command('sprint').description('Sprint management')

    sprint.command('start <goal>')
        .description('Start a sprint — agent plans and executes in parallel waves')
        .option('--repo <repo>', 'GitHub repo (owner/name)')
        .option('--branch <branch>', 'Target branch')
        .option('--wait', 'Block until sprint completes, streaming output')
        .option('--timeout <duration>', 'Timeout for --wait (e.g. 2h)', '4h')
        .option('--profile <name>')
        .action(async (goal: string, opts: { repo?: string; branch?: string; wait?: boolean; timeout: string; profile?: string }) => {
            const profile = requireProfile(opts.profile)
            const api = buildClient(profile)
            const spin = spinner('Starting sprint')

            try {
                const sprint = await api.post<{ id: string; status: string }>('/api/v1/sprints', {
                    goal,
                    repo: opts.repo,
                    branch: opts.branch,
                })
                spin.success({ text: `Sprint created ${c.cyan(sprint.id)}` })

                if (opts.wait) {
                    console.log(c.dim('Running sprint… (Ctrl+C to detach)\n'))
                    try {
                        const final = await waitForSprint(profile, sprint.id, parseTimeout(opts.timeout),
                            (msg) => console.log(`  ${c.dim('▸')} ${msg}`))
                        console.log(`\nDone: ${statusBadge(final.status)}`)
                        process.exit(final.status === 'completed' ? 0 : 2)
                    } catch (err) {
                        if (err instanceof Error && err.message === 'TIMEOUT') {
                            console.error(c.yellow('Timed out'))
                            process.exit(5)
                        }
                        throw err
                    }
                } else {
                    console.log(`Sprint ID: ${c.cyan(sprint.id)}`)
                    console.log(`Use ${c.bold(`plexo sprint logs ${sprint.id}`)} to follow progress.`)
                }
            } catch (err) {
                spin.error({ text: String(err) })
                fatal(err)
            }
        })

    sprint.command('list')
        .description('List sprints')
        .option('--output <format>', 'table|json|csv', 'table')
        .option('--profile <name>')
        .action(async (opts: { output: OutputFormat; profile?: string }) => {
            const profile = requireProfile(opts.profile)
            const api = buildClient(profile)
            const data = await api.get<{ sprints: Sprint[] }>('/api/v1/sprints')
            output(opts.output, ['ID', 'Name', 'Status', 'Created'], data.sprints,
                (s) => [s.id.slice(0, 16), s.name ?? '—', statusBadge(s.status), new Date(s.createdAt).toLocaleString()])
        })

    sprint.command('get <id>')
        .description('Sprint detail + linked tasks')
        .option('--output <format>', 'table|json', 'table')
        .option('--profile <name>')
        .action(async (id: string, opts: { output: OutputFormat; profile?: string }) => {
            const profile = requireProfile(opts.profile)
            const api = buildClient(profile)
            const s = await api.get<Sprint & { tasks?: unknown[] }>(`/api/v1/sprints/${id}`)
            if (opts.output === 'json') { console.log(JSON.stringify(s, null, 2)); return }
            console.log(`${c.bold('ID:')}      ${s.id}`)
            console.log(`${c.bold('Status:')}  ${statusBadge(s.status)}`)
            console.log(`${c.bold('Tasks:')}   ${s.tasks?.length ?? s.taskCount ?? '?'}`)
            console.log(`${c.bold('Created:')} ${new Date(s.createdAt).toLocaleString()}`)
        })

    sprint.command('logs <id>')
        .description('Stream live worker output for a sprint')
        .option('--profile <name>')
        .action(async (id: string, opts: { profile?: string }) => {
            const profile = requireProfile(opts.profile)
            console.log(c.dim(`Streaming sprint ${id}… (Ctrl+C to stop)\n`))
            openSse(profile, (event) => {
                const data = event.data as { sprintId?: string; message?: string; workerId?: string }
                if (data?.sprintId === id && data?.message) {
                    const prefix = data.workerId ? c.magenta(`[${data.workerId.slice(0, 8)}] `) : ''
                    console.log(`${prefix}${data.message}`)
                }
            })
        })

    sprint.command('cancel <id>')
        .option('--profile <name>')
        .action(async (id: string, opts: { profile?: string }) => {
            const profile = requireProfile(opts.profile)
            const api = buildClient(profile)
            await api.patch(`/api/v1/sprints/${id}`, { status: 'cancelled' })
            console.log(`Cancelled: ${c.cyan(id)}`)
        })

    sprint.command('workers <id>')
        .description('Show active worker containers for a sprint')
        .option('--output <format>', 'table|json', 'table')
        .option('--profile <name>')
        .action(async (id: string, opts: { output: OutputFormat; profile?: string }) => {
            const profile = requireProfile(opts.profile)
            const api = buildClient(profile)
            const data = await api.get<{ workers: Array<{ id: string; status: string; task?: string }> }>(`/api/v1/sprints/${id}/workers`)
            output(opts.output, ['Worker', 'Status', 'Current Task'], data.workers,
                (w) => [w.id.slice(0, 12), statusBadge(w.status), w.task ?? '—'])
        })

    sprint.command('merge-queue <id>')
        .description('Show merge queue, conflicts, pending merges')
        .option('--output <format>', 'table|json', 'table')
        .option('--profile <name>')
        .action(async (id: string, opts: { output: OutputFormat; profile?: string }) => {
            const profile = requireProfile(opts.profile)
            const api = buildClient(profile)
            const data = await api.get<{ conflicts: Array<{ branch: string; conflict: string }>; pending: string[] }>(`/api/v1/sprints/${id}/conflicts`)
            if (opts.output === 'json') { console.log(JSON.stringify(data, null, 2)); return }
            console.log(c.bold(`Pending merges: ${data.pending.length}`))
            data.pending.forEach(b => console.log(`  ${c.cyan(b)}`))
            if (data.conflicts.length > 0) {
                console.log(c.bold(`\nConflicts: ${data.conflicts.length}`))
                data.conflicts.forEach(con => console.log(`  ${c.red(con.branch)}: ${con.conflict}`))
            }
        })
}
