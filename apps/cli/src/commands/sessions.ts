// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

import { Command } from 'commander'
import { requireProfile } from '../config.js'
import { buildClient } from '../client.js'
import { output, statusBadge, c, fatal } from '../output.js'
import type { OutputFormat } from '../output.js'

// Minimal structural views — canonical types live in @plexo/session-fabric.
interface Session {
    id: string
    workspaceId: string
    title: string
    status: string
    policyTier: string
    createdBy: string
    createdAt: string
}

interface SessionListItem {
    session: { id: string; title: string; status: string; createdAt: string }
    driverId: string | null
    lease: unknown
    runnerStatus: string
    participants: { total: number; present: number }
}

interface SessionEvent {
    seq: number
    kind: string
    actorType: string
    createdAt: string
}

interface SessionUsage {
    tokensIn: number
    tokensOut: number
    costUsd: number
    eventCount: number
    byModel: Array<{ model: string; tokensIn: number; tokensOut: number; costUsd: number }>
}

const TIERS = ['observe', 'steer', 'drive'] as const
type Tier = typeof TIERS[number]

export function registerSessions(program: Command): void {
    const sessions = program.command('sessions').description('Session fabric — collaborative agent sessions')

    sessions.command('list')
        .description('List sessions in the active workspace')
        .option('--output <format>', 'table|json|csv', 'table')
        .option('--json', 'Shorthand for --output json')
        .option('--profile <name>')
        .action(async (opts: { output: OutputFormat; json?: boolean; profile?: string }) => {
            const profile = requireProfile(opts.profile)
            const api = buildClient(profile)
            const fmt: OutputFormat = opts.json ? 'json' : opts.output
            const qs = new URLSearchParams({ workspaceId: profile.workspace })
            const data = await api.get<{ items: SessionListItem[]; total: number }>(`/api/v1/sessions?${qs}`)
            output(
                fmt,
                ['ID', 'Title', 'Status', 'Driver', 'Participants'],
                data.items,
                (i) => [
                    i.session.id.slice(0, 16),
                    i.session.title,
                    statusBadge(i.session.status),
                    i.driverId ? i.driverId.slice(0, 16) : '—',
                    `${i.participants.present}/${i.participants.total}`,
                ],
            )
        })

    sessions.command('create')
        .description('Create a new session in the active workspace')
        .option('--title <t>', 'Session title')
        .option('--tier <observe|steer|drive>', 'Policy tier (observe|steer|drive)')
        .option('--json', 'Output raw JSON')
        .option('--profile <name>')
        .action(async (opts: { title?: string; tier?: string; json?: boolean; profile?: string }) => {
            if (opts.tier && !TIERS.includes(opts.tier as Tier)) {
                fatal(`Invalid --tier "${opts.tier}". Must be one of: ${TIERS.join(', ')}`)
            }
            const profile = requireProfile(opts.profile)
            const api = buildClient(profile)
            const body: { workspaceId: string; title?: string; policyTier?: Tier } = {
                workspaceId: profile.workspace,
            }
            if (opts.title) body.title = opts.title
            if (opts.tier) body.policyTier = opts.tier as Tier
            const s = await api.post<Session>('/api/v1/sessions', body)

            if (opts.json) {
                console.log(JSON.stringify(s, null, 2))
                return
            }
            console.log(`${c.green('✓')} Created session ${c.bold(s.id)}`)
            console.log(`  ${c.dim('Title:')}  ${s.title ?? c.dim('(untitled)')}`)
            console.log(`  ${c.dim('Status:')} ${statusBadge(s.status)}`)
            console.log(`  ${c.dim('Policy:')} ${s.policyTier}`)
        })

    const session = program.command('session').description('Inspect a single session')

    session.command('show <id>')
        .description('Show session detail')
        .option('--json', 'Output raw JSON')
        .option('--events', 'Also list session events')
        .option('--profile <name>')
        .action(async (id: string, opts: { json?: boolean; events?: boolean; profile?: string }) => {
            const profile = requireProfile(opts.profile)
            const api = buildClient(profile)
            const s = await api.get<Session>(`/api/v1/sessions/${id}`)

            if (opts.json) {
                if (opts.events) {
                    const ev = await api.get<{ items: SessionEvent[] }>(`/api/v1/sessions/${id}/events`)
                    console.log(JSON.stringify({ session: s, events: ev.items }, null, 2))
                } else {
                    console.log(JSON.stringify(s, null, 2))
                }
                return
            }

            console.log(`${c.bold('ID:')}         ${s.id}`)
            console.log(`${c.bold('Workspace:')}  ${s.workspaceId}`)
            console.log(`${c.bold('Title:')}      ${s.title}`)
            console.log(`${c.bold('Status:')}     ${statusBadge(s.status)}`)
            console.log(`${c.bold('Policy:')}     ${s.policyTier}`)
            console.log(`${c.bold('Created by:')} ${s.createdBy}`)
            console.log(`${c.bold('Created:')}    ${new Date(s.createdAt).toLocaleString()}`)

            if (opts.events) {
                const ev = await api.get<{ items: SessionEvent[] }>(`/api/v1/sessions/${id}/events`)
                console.log(`\n${c.bold(`Events (${ev.items.length}):`)}\n`)
                ev.items.forEach((e) =>
                    console.log(`  ${c.dim(String(e.seq).padStart(4))}  ${e.kind}  ${c.dim(e.actorType)}  ${new Date(e.createdAt).toLocaleString()}`),
                )
            }
        })

    session.command('usage <id>')
        .description('Show token + cost usage for a session')
        .option('--json', 'Output raw JSON')
        .option('--profile <name>')
        .action(async (id: string, opts: { json?: boolean; profile?: string }) => {
            const profile = requireProfile(opts.profile)
            const api = buildClient(profile)
            const u = await api.get<SessionUsage>(`/api/v1/sessions/${id}/usage`)

            if (opts.json) {
                console.log(JSON.stringify(u, null, 2))
                return
            }

            const usd = (n: number) => `$${n.toFixed(4)}`
            console.log(`${c.bold('Tokens in:')}   ${u.tokensIn}`)
            console.log(`${c.bold('Tokens out:')}  ${u.tokensOut}`)
            console.log(`${c.bold('Cost:')}        ${usd(u.costUsd)}`)
            console.log(`${c.bold('Events:')}      ${u.eventCount}`)

            if (u.byModel.length > 0) {
                console.log(`\n${c.bold('By model:')}\n`)
                output(
                    'table',
                    ['Model', 'In', 'Out', 'Cost'],
                    u.byModel,
                    (m) => [m.model, String(m.tokensIn), String(m.tokensOut), usd(m.costUsd)],
                )
            }
        })
}
