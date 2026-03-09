// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { Command } from 'commander'
import { requireProfile } from '../config.js'
import { openSse } from '../sse-stream.js'
import { c } from '../output.js'
import type { SseEvent } from '../sse-stream.js'

const LEVEL_ORDER = ['debug', 'info', 'warn', 'error']

function parseSince(since: string): Date | null {
    const m = since.match(/^(\d+)(h|d|m)$/)
    if (m) {
        const n = parseInt(m[1]!)
        const ms = m[2] === 'h' ? n * 3600_000 : m[2] === 'd' ? n * 86400_000 : n * 60_000
        return new Date(Date.now() - ms)
    }
    const d = new Date(since)
    return isNaN(d.getTime()) ? null : d
}

export function registerLogs(program: Command): void {
    program.command('logs')
        .description('Tail live agent logs via SSE stream')
        .option('--task <id>', 'Scope to a specific task')
        .option('--sprint <id>', 'Scope to a specific sprint')
        .option('--level <level>', 'Minimum level: debug|info|warn|error', 'info')
        .option('--since <time>', 'Show logs since (e.g. 1h, 2d, 2026-03-01)')
        .option('--output <format>', 'raw|json', 'raw')
        .option('--profile <name>')
        .action((opts: { task?: string; sprint?: string; level: string; since?: string; output: string; profile?: string }) => {
            const profile = requireProfile(opts.profile)
            const minLevel = LEVEL_ORDER.indexOf(opts.level)
            const since = opts.since ? parseSince(opts.since) : null

            console.log(c.dim(
                `Tailing logs${opts.task ? ` for task ${opts.task}` : ''}${opts.sprint ? ` for sprint ${opts.sprint}` : ''} (Ctrl+C to stop)\n`
            ))

            openSse(profile, (event: SseEvent) => {
                const data = event.data as {
                    level?: string
                    message?: string
                    taskId?: string
                    sprintId?: string
                    ts?: string
                    time?: string
                    [key: string]: unknown
                }

                // Level filter
                const lvl = data.level ?? 'info'
                if (LEVEL_ORDER.indexOf(lvl) < minLevel) return

                // Time filter
                if (since) {
                    const ts = data.ts ?? data.time
                    if (ts && new Date(ts) < since) return
                }

                // Scope filter
                if (opts.task && data.taskId !== opts.task) return
                if (opts.sprint && data.sprintId !== opts.sprint) return

                if (opts.output === 'json') {
                    console.log(JSON.stringify(event.data))
                    return
                }

                const ts = c.dim(new Date().toISOString())
                const levelColor: Record<string, (s: string) => string> = {
                    debug: c.gray,
                    info: c.cyan,
                    warn: c.yellow,
                    error: c.red,
                }
                const badge = (levelColor[lvl] ?? c.dim)(lvl.toUpperCase().padEnd(5))
                console.log(`${ts} ${badge} ${data.message ?? JSON.stringify(data)}`)
            })
        })
}
