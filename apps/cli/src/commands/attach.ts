// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

import { Command } from 'commander'
import { EventSource } from 'eventsource'
import { requireProfile } from '../config.js'
import { c } from '../output.js'

// Minimal structural view — canonical types live in @plexo/session-fabric.
interface SessionEvent {
    seq: number
    kind: string
    actorType: string
    actorId?: string
    payload?: unknown
    createdAt: string
}

export function registerAttach(program: Command): void {
    program.command('attach <id>')
        .description('Stream a session\'s events live (read-only)')
        .option('--since <seq>', 'Start from this sequence number', '0')
        .option('--json', 'Emit raw events as newline-delimited JSON')
        .option('--profile <name>')
        .action((id: string, opts: { since: string; json?: boolean; profile?: string }) => {
            const profile = requireProfile(opts.profile)
            const since = Number.parseInt(opts.since, 10) || 0
            const base = profile.host.replace(/\/$/, '')
            const url = `${base}/api/v1/sessions/${id}/events/stream?sinceSeq=${since}`

            const es = new EventSource(url, {
                fetch: (input, init) =>
                    fetch(input, {
                        ...init,
                        headers: {
                            ...init?.headers,
                            'x-user-id': profile.userId,
                            'x-workspace-id': profile.workspace,
                            'authorization': `Bearer ${profile.token}`,
                        },
                    }),
            })

            process.stderr.write(c.dim(`attached to ${id} (since seq ${since})…\n`))

            es.onmessage = (e: MessageEvent) => {
                let ev: SessionEvent
                try {
                    ev = (JSON.parse(e.data as string) as { data: SessionEvent }).data
                } catch {
                    return
                }
                if (opts.json) {
                    console.log(JSON.stringify(ev))
                } else {
                    console.log(
                        `${c.dim(String(ev.seq).padStart(4))}  ${ev.kind}  ${c.dim(ev.actorType)}  ${new Date(ev.createdAt).toLocaleString()}`,
                    )
                }
            }

            es.onerror = (err: unknown) => {
                const { code, message } = (err ?? {}) as { code?: number; message?: string }
                es.close()
                process.stderr.write(`Stream error${code ? ` (${code})` : ''}: ${message ?? 'connection failed'}\n`)
                process.exit(1)
            }

            process.on('SIGINT', () => {
                es.close()
                process.stderr.write(c.dim('\ndetached\n'))
                process.exit(0)
            })
        })
}
