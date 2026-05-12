// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { Command } from 'commander'
import { requireProfile } from '../config.js'
import { buildClient } from '../client.js'
import { output, spinner, statusBadge, c } from '../output.js'
import type { OutputFormat } from '../output.js'

interface Connection {
    slug: string
    name: string
    type: string
    status?: string
    installed?: boolean
}

export function registerConnection(program: Command): void {
    const conn = program.command('connection').description('Connection/integration management')

    conn.command('list')
        .description('List available services (use --installed to filter)')
        .option('--installed', 'Only show installed connections')
        .option('--output <format>', 'table|json', 'table')
        .option('--profile <name>')
        .action(async (opts: { installed?: boolean; output: OutputFormat; profile?: string }) => {
            const profile = requireProfile(opts.profile)
            const api = buildClient(profile)
            const path = opts.installed ? '/api/v1/connections?installed=true' : '/api/v1/connections/registry'
            const data = await api.get<{ connections: Connection[] }>(path)
            output(opts.output, ['Slug', 'Name', 'Type', 'Status'], data.connections,
                (c_) => [c_.slug, c_.name, c_.type, statusBadge(c_.status ?? (c_.installed ? 'installed' : 'available'))])
        })

    conn.command('get <slug>')
        .description('Detail on a specific service connection')
        .option('--output <format>', 'table|json', 'table')
        .option('--profile <name>')
        .action(async (slug: string, opts: { output: OutputFormat; profile?: string }) => {
            const profile = requireProfile(opts.profile)
            const api = buildClient(profile)
            const conn_ = await api.get<Connection>(`/api/v1/connections/registry/${slug}`)
            if (opts.output === 'json') { console.log(JSON.stringify(conn_, null, 2)); return }
            console.log(`${c.bold('Slug:')}   ${conn_.slug}`)
            console.log(`${c.bold('Name:')}   ${conn_.name}`)
            console.log(`${c.bold('Type:')}   ${conn_.type}`)
            console.log(`${c.bold('Status:')} ${statusBadge(conn_.status ?? 'available')}`)
        })

    conn.command('install <slug>')
        .description('Install a connection (prompts for API key; OAuth prints URL)')
        .option('--key <apiKey>', 'API key (skip interactive prompt)')
        .option('--profile <name>')
        .action(async (slug: string, opts: { key?: string; profile?: string }) => {
            const profile = requireProfile(opts.profile)
            const api = buildClient(profile)

            let key = opts.key
            if (!key) {
                // Check if OAuth — the API will tell us
                const info = await api.get<{ authType: string; oauthUrl?: string }>(`/api/v1/connections/registry/${slug}`)
                if (info.authType === 'oauth2' && info.oauthUrl) {
                    console.log(`Open this URL to authorize ${c.bold(slug)}:`)
                    console.log(c.cyan(info.oauthUrl))
                    console.log('Complete the flow in your browser, then re-run this command.')
                    return
                }
                const readline = await import('node:readline')
                const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
                key = await new Promise<string>(r => rl.question(`API key for ${c.bold(slug)}: `, v => { rl.close(); r(v) }))
            }

            const spin = spinner(`Installing ${slug}`)
            await api.post(`/api/v1/connections`, { slug, credentials: { apiKey: key } })
            spin.success({ text: `Installed: ${c.green(slug)}` })
        })

    conn.command('remove <slug>')
        .option('--profile <name>')
        .action(async (slug: string, opts: { profile?: string }) => {
            const profile = requireProfile(opts.profile)
            await buildClient(profile).delete(`/api/v1/connections/${slug}`)
            console.log(`Removed: ${c.red(slug)}`)
        })

    conn.command('test <slug>')
        .description('Run a connectivity check')
        .option('--profile <name>')
        .action(async (slug: string, opts: { profile?: string }) => {
            const profile = requireProfile(opts.profile)
            const spin = spinner(`Testing ${slug}`)
            const result = await buildClient(profile).post<{ ok: boolean; message?: string }>(`/api/v1/connections/${slug}/test`)
            if (result.ok) {
                spin.success({ text: `${c.green('OK')} — ${result.message ?? slug}` })
            } else {
                spin.error({ text: `Failed: ${result.message ?? 'unknown error'}` })
                process.exit(1)
            }
        })
}
