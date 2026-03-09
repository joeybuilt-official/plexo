// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { Command } from 'commander'
import { requireProfile } from '../config.js'
import { buildClient } from '../client.js'
import { statusBadge, c } from '../output.js'

interface HealthResponse {
    status: string
    services: {
        postgres: { ok: boolean; latencyMs: number }
        redis: { ok: boolean; latencyMs: number }
        anthropic: { ok: boolean; latencyMs: number }
    }
    uptime: number
    version: string
    kapsel?: {
        workers: Array<{ pluginName: string; toolCount: number }>
    }
}

interface DashboardSummary {
    taskCounts: Record<string, number>
    costThisWeek: number
    costCeiling: number
    channels: Array<{ type: string; enabled: boolean }>
}

export function registerStatus(program: Command): void {
    program.command('status')
        .description('Platform health and agent status')
        .option('--watch', 'Refresh every 5s')
        .option('--output <format>', 'table|json', 'table')
        .option('--profile <name>')
        .action(async (opts: { watch?: boolean; output: string; profile?: string }) => {
            const profile = requireProfile(opts.profile)
            const api = buildClient(profile)

            async function printStatus(): Promise<void> {
                const [health, summary] = await Promise.all([
                    api.get<HealthResponse>('/health'),
                    api.get<DashboardSummary>('/api/v1/dashboard/summary').catch(() => null),
                ])

                if (opts.output === 'json') {
                    console.log(JSON.stringify({ health, summary }, null, 2))
                    return
                }

                const pg = health.services.postgres
                const redis = health.services.redis
                const ai = health.services.anthropic

                console.log()
                console.log(`  ${c.bold('Agent:')}        ${statusBadge(health.status)}`)
                console.log(`  ${c.bold('Version:')}      ${health.version}`)
                console.log(`  ${c.bold('Uptime:')}       ${Math.floor(health.uptime / 3600)}h ${Math.floor((health.uptime % 3600) / 60)}m`)
                console.log()
                console.log(`  ${c.bold('Services:')}`)
                console.log(`    postgres  ${statusBadge(pg.ok ? 'ok' : 'error')}  ${pg.latencyMs}ms`)
                console.log(`    redis     ${statusBadge(redis.ok ? 'ok' : 'error')}  ${redis.latencyMs}ms`)
                console.log(`    anthropic ${statusBadge(ai.ok ? 'ok' : 'degraded')}  ${ai.ok ? `${ai.latencyMs}ms` : 'not configured'}`)

                if (health.kapsel?.workers && health.kapsel.workers.length > 0) {
                    console.log()
                    console.log(`  ${c.bold('Extensions:')}`)
                    health.kapsel.workers.forEach(w =>
                        console.log(`    ${c.cyan(w.pluginName)}  ${w.toolCount} tools`)
                    )
                }

                if (summary) {
                    const counts = summary.taskCounts
                    const running = counts['running'] ?? 0
                    const queued = counts['queued'] ?? 0
                    console.log()
                    console.log(`  ${c.bold('Tasks:')}`)
                    console.log(`    Active tasks:  ${c.cyan(String(running))}`)
                    console.log(`    Queue depth:   ${queued}`)
                    console.log(`    API cost:      $${summary.costThisWeek?.toFixed(2) ?? '0.00'} / $${summary.costCeiling?.toFixed(2) ?? '10.00'} this week`)

                    if (summary.channels?.length > 0) {
                        console.log()
                        console.log(`  ${c.bold('Channels:')}`)
                        summary.channels.forEach(ch =>
                            console.log(`    ${ch.type.padEnd(12)} ${statusBadge(ch.enabled ? 'ok' : 'disabled')}`)
                        )
                    }
                }

                console.log()
            }

            if (opts.watch) {
                await printStatus()
                setInterval(async () => {
                    process.stdout.write('\x1Bc') // clear terminal
                    await printStatus()
                }, 5000)
            } else {
                await printStatus()
            }
        })
}
