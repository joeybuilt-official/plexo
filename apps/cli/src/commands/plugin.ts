// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { Command } from 'commander'
import { requireProfile } from '../config.js'
import { buildClient } from '../client.js'
import { output, spinner, c } from '../output.js'
import { openSse } from '../sse-stream.js'
import type { OutputFormat } from '../output.js'

interface Extension {
    id: string
    name: string
    type: string
    enabled: boolean
    version?: string
}

export function registerExtension(program: Command): void {
    const ext = program.command('extension').description('Extension management')

    ext.command('list')
        .description('List installed extensions')
        .option('--available', 'Browse registry (requires network)')
        .option('--output <format>', 'table|json', 'table')
        .option('--profile <name>')
        .action(async (opts: { available?: boolean; output: OutputFormat; profile?: string }) => {
            const profile = requireProfile(opts.profile)
            const api = buildClient(profile)
            const path_ = opts.available ? '/api/v1/registry' : '/api/v1/extensions'
            const data = await api.get<{ extensions?: Extension[] }>(path_)
            const items = data.extensions ?? []
            output(opts.output, ['Name', 'Type', 'Version', 'Enabled'], items,
                (p) => [p.name, p.type, p.version ?? '—', p.enabled ? c.green('yes') : c.dim('no')])
        })

    ext.command('install <name>')
        .description('Install an extension by name or path')
        .option('--path <path>', 'Local path to extension directory')
        .option('--profile <name>')
        .action(async (name: string, opts: { path?: string; profile?: string }) => {
            const profile = requireProfile(opts.profile)
            const spin = spinner(`Installing ${name}`)
            await buildClient(profile).post('/api/v1/extensions', {
                name,
                source: opts.path ? 'local' : 'registry',
                path: opts.path,
                enabled: true,
            })
            spin.success({ text: c.green(`Installed: ${name}`) })
        })

    ext.command('remove <name>')
        .option('--profile <name_>')
        .action(async (name: string, opts: { name_?: string; profile?: string }) => {
            const profile = requireProfile(opts.profile)
            // Find by name then delete
            const api = buildClient(profile)
            const data = await api.get<{ extensions: Extension[] }>('/api/v1/extensions')
            const found = data.extensions.find(p => p.name === name)
            if (!found) { console.error(`Not found: ${name}`); process.exit(1) }
            await api.delete(`/api/v1/extensions/${found.id}`)
            console.log(`Removed: ${c.red(name)}`)
        })

    ext.command('enable <name>')
        .option('--profile <name_>')
        .action(async (name: string, opts: { profile?: string }) => {
            const profile = requireProfile(opts.profile)
            const api = buildClient(profile)
            const data = await api.get<{ extensions: Extension[] }>('/api/v1/extensions')
            const found = data.extensions.find(p => p.name === name)
            if (!found) { console.error(`Not found: ${name}`); process.exit(1) }
            await api.patch(`/api/v1/extensions/${found.id}`, { enabled: true })
            console.log(`Enabled: ${c.green(name)}`)
        })

    ext.command('disable <name>')
        .option('--profile <name_>')
        .action(async (name: string, opts: { profile?: string }) => {
            const profile = requireProfile(opts.profile)
            const api = buildClient(profile)
            const data = await api.get<{ extensions: Extension[] }>('/api/v1/extensions')
            const found = data.extensions.find(p => p.name === name)
            if (!found) { console.error(`Not found: ${name}`); process.exit(1) }
            await api.patch(`/api/v1/extensions/${found.id}`, { enabled: false })
            console.log(`Disabled: ${c.yellow(name)}`)
        })

    ext.command('logs <name>')
        .description('Stream extension worker thread output')
        .option('--profile <name_>')
        .action((name: string, opts: { profile?: string }) => {
            const profile = requireProfile(opts.profile)
            console.log(c.dim(`Streaming logs for extension ${c.bold(name)}… (Ctrl+C to stop)\n`))
            openSse(profile, (event) => {
                const data = event.data as { extensionName?: string; message?: string }
                const isThis = data?.extensionName === name
                if (isThis && data?.message) {
                    console.log(`${c.magenta(`[${name}]`)} ${data.message}`)
                }
            })
        })
}
