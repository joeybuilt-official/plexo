// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { Command } from 'commander'
import {
    showConfig, setConfigValue, setActiveProfile,
    listProfiles, deleteProfile, saveProfile, getProfile,
    getProfileName,
} from '../config.js'
import { c } from '../output.js'

export function registerConfig(program: Command): void {
    const config = program.command('config').description('CLI configuration')

    config.command('show')
        .option('--profile <name>')
        .action((opts: { profile?: string }) => {
            console.log(JSON.stringify(showConfig(opts.profile), null, 2))
        })

    config.command('set <key> <value>')
        .description('Set a config value (host, workspace, default-channel)')
        .option('--profile <name>')
        .action((key: string, value: string, opts: { profile?: string }) => {
            const validKeys = ['host', 'workspace', 'defaultChannel', 'default-channel']
            const normalized = key === 'default-channel' ? 'defaultChannel' : key
            if (!validKeys.includes(normalized)) {
                console.error(`Unknown config key: ${key}. Valid: host, workspace, default-channel`)
                process.exit(1)
            }
            setConfigValue(normalized, value, opts.profile)
            console.log(`Set ${c.bold(normalized)} = ${c.cyan(value)}`)
        })

    const profile = config.command('profile').description('Profile management')

    profile.command('list')
        .action(() => {
            const profiles = listProfiles()
            if (profiles.length === 0) {
                console.log('No profiles configured. Run: plexo auth login')
                return
            }
            profiles.forEach(p => {
                const marker = p.active ? c.green('●') : c.dim('○')
                console.log(`  ${marker} ${c.bold(p.name)}  ${c.dim(p.host)}`)
            })
        })

    profile.command('add <name>')
        .description('Alias for plexo auth login --profile <name>')
        .action(() => {
            console.log('Use: plexo auth login --profile <name>')
        })

    profile.command('use <name>')
        .description('Switch the active profile')
        .action((name: string) => {
            const current = getProfile(name)
            if (!current) {
                console.error(`Profile "${name}" does not exist. Run: plexo auth login --profile ${name}`)
                process.exit(1)
            }
            setActiveProfile(name)
            console.log(`Active profile: ${c.bold(name)}`)
        })

    profile.command('delete <name>')
        .action((name: string) => {
            deleteProfile(name)
            console.log(`Deleted profile: ${c.red(name)}`)
        })
}
