// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { Command } from 'commander'
import { requireProfile } from '../config.js'
import { buildClient, ApiError } from '../client.js'
import { output, spinner, statusBadge, c, fatal, isTTY } from '../output.js'
import { waitForTask, openSse } from '../sse-stream.js'
import type { OutputFormat } from '../output.js'

interface Task {
    id: string
    type: string
    status: string
    qualityScore: number | null
    costUsd: number | null
    createdAt: string
    context: { prompt?: string; description?: string }
    steps?: unknown[]
}

function parseTimeout(t: string): number {
    const m = t.match(/^(\d+)(m|h|s)$/)
    if (!m) return 2 * 60 * 60 * 1000
    const n = parseInt(m[1]!)
    return m[2] === 'h' ? n * 3600_000 : m[2] === 'm' ? n * 60_000 : n * 1000
}

export function registerTask(program: Command): void {
    const task = program.command('task').description('Task operations')

    task.command('run <prompt>')
        .description('Dispatch a task to the agent')
        .option('--type <type>', 'Task type hint: coding|deployment|research|ops|automation')
        .option('--wait', 'Block until task completes, streaming step output')
        .option('--timeout <duration>', 'Timeout for --wait (e.g. 30m, 2h)', '2h')
        .option('--profile <name>')
        .option('--output <format>', 'Output format: table|json', 'table')
        .action(async (prompt: string, opts: { type?: string; wait?: boolean; timeout: string; profile?: string; output: OutputFormat }) => {
            const profile = requireProfile(opts.profile)
            const api = buildClient(profile)
            const spin = spinner('Dispatching task')

            try {
                const result = await api.post<{ id: string; status: string }>('/api/v1/tasks', {
                    prompt,
                    type: opts.type,
                })
                spin.success({ text: `Task created ${c.cyan(result.id)}` })

                if (opts.wait) {
                    console.log(c.dim('Waiting for agent… (Ctrl+C to detach)\n'))
                    try {
                        const final = await waitForTask(profile, result.id, parseTimeout(opts.timeout),
                            (msg) => console.log(`  ${c.dim('▸')} ${msg}`))
                        const badge = statusBadge(final.status)
                        const score = final.qualityScore !== null ? ` quality: ${c.bold(String(final.qualityScore))}` : ''
                        console.log(`\nDone: ${badge}${score}`)
                        process.exit(final.status === 'complete' && (final.qualityScore ?? 10) >= 7 ? 0 : 2)
                    } catch (err) {
                        if (err instanceof Error && err.message === 'TIMEOUT') {
                            console.error(c.yellow('Timed out — task is still running'))
                            process.exit(5)
                        }
                        throw err
                    }
                } else {
                    if (opts.output === 'json') {
                        console.log(JSON.stringify(result, null, 2))
                    } else {
                        console.log(`Task ID: ${c.cyan(result.id)}`)
                        console.log(`Use ${c.bold(`plexo task logs ${result.id}`)} to follow progress.`)
                    }
                }
            } catch (err) {
                spin.error({ text: err instanceof ApiError ? err.message : String(err) })
                fatal(err)
            }
        })

    task.command('list')
        .description('List recent tasks')
        .option('--status <s>', 'Filter: queued|running|complete|failed|blocked')
        .option('--limit <n>', 'Max results', '20')
        .option('--output <format>', 'table|json|csv', 'table')
        .option('--profile <name>')
        .action(async (opts: { status?: string; limit: string; output: OutputFormat; profile?: string }) => {
            const profile = requireProfile(opts.profile)
            const api = buildClient(profile)
            const qs = new URLSearchParams({ limit: opts.limit })
            if (opts.status) qs.set('status', opts.status)
            const data = await api.get<{ tasks: Task[] }>(`/api/v1/tasks?${qs}`)
            output(
                opts.output,
                ['ID', 'Type', 'Status', 'Quality', 'Cost', 'Created'],
                data.tasks,
                (t) => [
                    t.id.slice(0, 16),
                    t.type,
                    statusBadge(t.status),
                    t.qualityScore !== null ? String(t.qualityScore) : '—',
                    t.costUsd !== null ? `$${t.costUsd.toFixed(4)}` : '—',
                    new Date(t.createdAt).toLocaleString(),
                ],
            )
        })

    task.command('get <id>')
        .description('Full task detail — status, steps, quality, cost')
        .option('--output <format>', 'table|json', 'table')
        .option('--profile <name>')
        .action(async (id: string, opts: { output: OutputFormat; profile?: string }) => {
            const profile = requireProfile(opts.profile)
            const api = buildClient(profile)
            const t = await api.get<Task>(`/api/v1/tasks/${id}`)
            if (opts.output === 'json') { console.log(JSON.stringify(t, null, 2)); return }
            console.log(`${c.bold('ID:')}      ${t.id}`)
            console.log(`${c.bold('Status:')}  ${statusBadge(t.status)}`)
            console.log(`${c.bold('Type:')}    ${t.type}`)
            console.log(`${c.bold('Quality:')} ${t.qualityScore ?? '—'}`)
            console.log(`${c.bold('Cost:')}    ${t.costUsd !== null ? `$${t.costUsd!.toFixed(4)}` : '—'}`)
            console.log(`${c.bold('Created:')} ${new Date(t.createdAt).toLocaleString()}`)
            if (t.context.prompt) console.log(`${c.bold('Prompt:')}  ${t.context.prompt}`)
            const steps = t.steps ?? []
            if (steps.length > 0) {
                console.log(`\n${c.bold(`Steps (${steps.length}):`)}\n`)
                steps.forEach((s, i) => console.log(`  ${i + 1}. ${JSON.stringify(s)}`))
            }
        })

    task.command('logs <id>')
        .description('Stream live step output for a running task')
        .option('--profile <name>')
        .action(async (id: string, opts: { profile?: string }) => {
            const profile = requireProfile(opts.profile)
            console.log(c.dim(`Streaming logs for task ${id}… (Ctrl+C to stop)\n`))
            openSse(profile, (event) => {
                const data = event.data as { taskId?: string; message?: string }
                if ((data?.taskId === id) && data?.message) {
                    console.log(`${c.dim(new Date().toISOString())} ${data.message}`)
                }
            })
        })

    task.command('cancel <id>')
        .description('Cancel a running task')
        .option('--profile <name>')
        .action(async (id: string, opts: { profile?: string }) => {
            const profile = requireProfile(opts.profile)
            const api = buildClient(profile)
            await api.delete(`/api/v1/tasks/${id}`)
            console.log(`Cancelled: ${c.cyan(id)}`)
        })

    task.command('block <id>')
        .description('Block a task — triggers human review')
        .option('--profile <name>')
        .action(async (id: string, opts: { profile?: string }) => {
            const profile = requireProfile(opts.profile)
            const api = buildClient(profile)
            await api.patch(`/api/v1/tasks/${id}`, { status: 'blocked' })
            console.log(`Blocked: ${c.yellow(id)}`)
        })

    task.command('approve <id>')
        .description('Approve a one-way-door step (requires confirmation code from your channel)')
        .requiredOption('--code <code>', 'Confirmation code sent to your channel')
        .option('--profile <name>')
        .action(async (id: string, opts: { code: string; profile?: string }) => {
            const profile = requireProfile(opts.profile)
            const api = buildClient(profile)
            await api.post(`/api/v1/approvals/${id}/approve`, { code: opts.code })
            console.log(`Approved: ${c.green(id)}`)
        })
}
