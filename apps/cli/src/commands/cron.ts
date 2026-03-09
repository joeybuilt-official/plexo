// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { Command } from 'commander'
import { requireProfile } from '../config.js'
import { buildClient } from '../client.js'
import { output, spinner, statusBadge, c } from '../output.js'
import type { OutputFormat } from '../output.js'

interface CronJob {
    id: string
    name: string
    schedule: string
    enabled: boolean
    lastRunAt?: string
    prompt: string
}

export function registerCron(program: Command): void {
    const cron = program.command('cron').description('Cron job management')

    cron.command('list')
        .option('--output <format>', 'table|json|csv', 'table')
        .option('--profile <name>')
        .action(async (opts: { output: OutputFormat; profile?: string }) => {
            const profile = requireProfile(opts.profile)
            const api = buildClient(profile)
            const data = await api.get<{ cronJobs: CronJob[] }>('/api/v1/cron')
            output(opts.output, ['ID', 'Name', 'Schedule', 'Enabled', 'Last Run'], data.cronJobs,
                (j) => [j.id.slice(0, 12), j.name, j.schedule, j.enabled ? c.green('yes') : c.dim('no'), j.lastRunAt ? new Date(j.lastRunAt).toLocaleString() : '—'])
        })

    cron.command('get <id>')
        .option('--output <format>', 'table|json', 'table')
        .option('--profile <name>')
        .action(async (id: string, opts: { output: OutputFormat; profile?: string }) => {
            const profile = requireProfile(opts.profile)
            const api = buildClient(profile)
            const j = await api.get<CronJob>(`/api/v1/cron/${id}`)
            if (opts.output === 'json') { console.log(JSON.stringify(j, null, 2)); return }
            console.log(`${c.bold('ID:')}       ${j.id}`)
            console.log(`${c.bold('Name:')}     ${j.name}`)
            console.log(`${c.bold('Schedule:')} ${j.schedule}`)
            console.log(`${c.bold('Enabled:')}  ${j.enabled ? c.green('yes') : c.dim('no')}`)
            console.log(`${c.bold('Prompt:')}   ${j.prompt}`)
        })

    cron.command('add')
        .description('Create a new cron job')
        .requiredOption('--name <name>', 'Job name')
        .requiredOption('--schedule <cron>', 'Cron expression (e.g. "0 9 * * MON")')
        .requiredOption('--prompt <text>', 'Task prompt to dispatch on schedule')
        .option('--profile <name>')
        .action(async (opts: { name: string; schedule: string; prompt: string; profile?: string }) => {
            const profile = requireProfile(opts.profile)
            const api = buildClient(profile)
            const spin = spinner('Creating cron job')
            const result = await api.post<{ id: string }>('/api/v1/cron', {
                name: opts.name,
                schedule: opts.schedule,
                prompt: opts.prompt,
                enabled: true,
            })
            spin.success({ text: `Created ${c.cyan(result.id)} — ${opts.name}` })
        })

    cron.command('enable <id>')
        .option('--profile <name>')
        .action(async (id: string, opts: { profile?: string }) => {
            const profile = requireProfile(opts.profile)
            await buildClient(profile).patch(`/api/v1/cron/${id}`, { enabled: true })
            console.log(`Enabled: ${c.green(id)}`)
        })

    cron.command('disable <id>')
        .option('--profile <name>')
        .action(async (id: string, opts: { profile?: string }) => {
            const profile = requireProfile(opts.profile)
            await buildClient(profile).patch(`/api/v1/cron/${id}`, { enabled: false })
            console.log(`Disabled: ${c.yellow(id)}`)
        })

    cron.command('delete <id>')
        .option('--profile <name>')
        .action(async (id: string, opts: { profile?: string }) => {
            const profile = requireProfile(opts.profile)
            await buildClient(profile).delete(`/api/v1/cron/${id}`)
            console.log(`Deleted: ${c.red(id)}`)
        })

    cron.command('run <id>')
        .description('Force-trigger immediate execution')
        .option('--profile <name>')
        .action(async (id: string, opts: { profile?: string }) => {
            const profile = requireProfile(opts.profile)
            const result = await buildClient(profile).post<{ taskId: string }>(`/api/v1/cron/${id}/trigger`)
            console.log(`Triggered → task ${c.cyan(result.taskId)}`)
        })

    cron.command('history <id>')
        .description('Last 20 run results')
        .option('--output <format>', 'table|json', 'table')
        .option('--profile <name>')
        .action(async (id: string, opts: { output: OutputFormat; profile?: string }) => {
            const profile = requireProfile(opts.profile)
            const api = buildClient(profile)
            const data = await api.get<{ runs: Array<{ taskId: string; status: string; ranAt: string }> }>(`/api/v1/cron/${id}/history`)
            output(opts.output, ['Task ID', 'Status', 'Ran At'], data.runs,
                (r) => [r.taskId.slice(0, 16), statusBadge(r.status), new Date(r.ranAt).toLocaleString()])
        })
}
