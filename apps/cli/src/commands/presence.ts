// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { Command } from 'commander'
import { requireProfile } from '../config.js'
import { buildClient } from '../client.js'
import { output } from '../output.js'
import type { OutputFormat } from '../output.js'

// Minimal structural view — canonical type lives in @plexo/session-fabric.
interface PresenceInstance {
    id: string
    kind: 'head' | 'runner'
    surface: string | null
    capabilities: unknown
    status: string | null
    role: string | null
    lastHeartbeat: string
    alive: boolean
    drivingSessionId: string | null
}

export function registerPresence(program: Command): void {
    program.command('presence')
        .description('List head + runner instances (presence) in the active workspace')
        .option('--output <format>', 'table|json|csv', 'table')
        .option('--json', 'Shorthand for --output json')
        .option('--profile <name>')
        .action(async (opts: { output: OutputFormat; json?: boolean; profile?: string }) => {
            const profile = requireProfile(opts.profile)
            const api = buildClient(profile)
            const fmt: OutputFormat = opts.json ? 'json' : opts.output
            const qs = new URLSearchParams({ workspaceId: profile.workspace })
            const data = await api.get<{ items: PresenceInstance[]; total: number }>(`/api/v1/presence?${qs}`)
            output(
                fmt,
                ['ID', 'Kind', 'Surface', 'Status/Role', 'Alive', 'Driving'],
                data.items,
                (i) => [
                    i.id.slice(0, 16),
                    i.kind,
                    i.surface ?? '—',
                    i.status ?? i.role ?? '—',
                    i.alive ? 'yes' : 'no',
                    i.drivingSessionId ? i.drivingSessionId.slice(0, 16) : '—',
                ],
            )
        })
}
