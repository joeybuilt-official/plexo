// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { Command } from 'commander'
import readline from 'node:readline'
import { saveProfile, getProfile, getProfileName, deleteProfile } from '../config.js'
import { c, spinner, fatal } from '../output.js'

function prompt(question: string, hidden = false): Promise<string> {
    return new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
        if (hidden && process.stdin.isTTY) {
            process.stdout.write(question)
            process.stdin.setRawMode(true)
            let input = ''
            process.stdin.on('data', function handler(chunk: Buffer) {
                const char = chunk.toString()
                if (char === '\r' || char === '\n') {
                    process.stdin.setRawMode(false)
                    process.stdin.removeListener('data', handler)
                    process.stdout.write('\n')
                    rl.close()
                    resolve(input)
                } else if (char === '\u0003') {
                    process.exit(0)
                } else if (char === '\u007f') {
                    if (input.length > 0) input = input.slice(0, -1)
                } else {
                    input += char
                }
            })
        } else {
            rl.question(question, (answer) => {
                rl.close()
                resolve(answer)
            })
        }
    })
}

export function registerAuth(program: Command): void {
    const auth = program.command('auth').description('Authentication management')

    auth.command('login')
        .description('Log in to a Plexo instance and store credentials')
        .option('--profile <name>', 'Profile name to save as', 'default')
        .action(async (opts: { profile: string }) => {
            const host = await prompt(`Host URL [https://plexo.yourdomain.com]: `)
            const email = await prompt('Email: ')
            const password = await prompt('Password: ', true)

            const resolvedHost = (host.trim() || 'https://plexo.yourdomain.com').replace(/\/$/, '')
            const spin = spinner('Authenticating')

            try {
                const res = await fetch(`${resolvedHost}/api/auth/verify-password`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ email: email.trim(), password }),
                })

                if (!res.ok) {
                    const err = await res.json() as { error?: string }
                    spin.error({ text: `Auth failed: ${err?.error ?? `HTTP ${res.status}`}` })
                    process.exit(4)
                }

                const user = await res.json() as { id: string; email: string; name: string }

                // Fetch workspace for this user
                const wsRes = await fetch(`${resolvedHost}/api/workspaces?ownerId=${user.id}`, {
                    headers: { 'x-user-id': user.id },
                })
                const wsData = await wsRes.json() as { workspaces?: Array<{ id: string; name: string }> }
                const wsList = wsData.workspaces ?? []
                const workspace = wsList[0]

                if (!workspace) {
                    spin.error({ text: 'No workspace found for this account. Create one at the dashboard.' })
                    process.exit(1)
                }

                saveProfile(opts.profile, {
                    host: resolvedHost,
                    token: user.id,        // used as Bearer token + x-user-id
                    userId: user.id,
                    workspace: workspace.id,
                })

                spin.success({ text: `Logged in as ${c.bold(user.email)} → workspace ${c.cyan(workspace.name)} (${workspace.id})` })
                console.log(`Profile saved: ${c.bold(opts.profile)}`)
            } catch (err) {
                spin.error({ text: String(err) })
                process.exit(1)
            }
        })

    auth.command('logout')
        .description('Remove stored credentials for a profile')
        .option('--profile <name>', 'Profile to remove')
        .action((opts: { profile?: string }) => {
            const name = getProfileName(opts.profile)
            deleteProfile(name)
            console.log(`Logged out of profile: ${c.bold(name)}`)
        })

    auth.command('status')
        .description('Show current authentication status')
        .option('--profile <name>', 'Profile to check')
        .action((opts: { profile?: string }) => {
            const profile = getProfile(opts.profile)
            if (!profile) {
                console.log(c.yellow('Not logged in.') + ' Run: plexo auth login')
                return
            }
            console.log(`${c.green('●')} Logged in`)
            console.log(`  Host:      ${c.cyan(profile.host)}`)
            console.log(`  Workspace: ${profile.workspace}`)
            console.log(`  User ID:   ${profile.userId}`)
        })

    auth.command('token')
        .description('Print the current auth token (for CI)')
        .option('--profile <name>', 'Profile')
        .action((opts: { profile?: string }) => {
            const profile = getProfile(opts.profile)
            if (!profile) fatal('Not logged in. Run: plexo auth login', 4)
            console.log(profile.token)
        })
}
