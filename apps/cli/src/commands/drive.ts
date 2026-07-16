// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { Command } from 'commander'
import { requireProfile } from '../config.js'
import { buildClient, ApiError } from '../client.js'
import { c } from '../output.js'

// Minimal structural view — canonical types live in @plexo/session-fabric.
interface Lease {
    sessionId: string
    runnerId: string
    claimedAt: string
    claimedUntil: string
}

const DEVICE_TOKEN_HINT =
    'Drive requires a device token. Set PLEXO_DEVICE_TOKEN (operator-minted drive-tier token; mint via POST /api/v1/fabric/tokens).'

function requireDeviceToken(): string {
    const token = process.env.PLEXO_DEVICE_TOKEN
    if (!token) {
        process.stderr.write(`${DEVICE_TOKEN_HINT}\n`)
        process.exit(3)
    }
    return token
}

function leaseBody(runner: string, ttl?: string): { runnerId: string; ttlMs?: number } {
    const body: { runnerId: string; ttlMs?: number } = { runnerId: runner }
    if (ttl !== undefined) {
        const ttlMs = Number.parseInt(ttl, 10)
        if (Number.isFinite(ttlMs)) body.ttlMs = ttlMs
    }
    return body
}

function printLease(lease: Lease, json?: boolean): void {
    if (json) {
        console.log(JSON.stringify(lease, null, 2))
        return
    }
    console.log(`${c.green('Lease held.')} ${c.dim('runner')} ${lease.runnerId}`)
    console.log(`${c.bold('Until:')} ${new Date(lease.claimedUntil).toLocaleString()}`)
}

export function registerDrive(program: Command): void {
    program.command('drive <id>')
        .description('Take the wheel — claim a drive lease on a session (device-token gated)')
        .requiredOption('--runner <name>', 'Runner name to claim as (1-128 chars)')
        .option('--ttl <ms>', 'Lease TTL in ms (default 30000, max 300000)')
        .option('--json', 'Output raw JSON')
        .option('--profile <name>')
        .action(async (id: string, opts: { runner: string; ttl?: string; json?: boolean; profile?: string }) => {
            const profile = requireProfile(opts.profile)
            const token = requireDeviceToken()
            const api = buildClient(profile)
            try {
                const lease = await api.post<Lease>(
                    `/api/v1/sessions/${id}/lease`,
                    leaseBody(opts.runner, opts.ttl),
                    { 'x-fabric-device-token': token },
                )
                printLease(lease, opts.json)
            } catch (err) {
                handleLeaseError(err)
            }
        })

    program.command('drive-renew <id>')
        .description('Renew an active drive lease (device-token gated)')
        .requiredOption('--runner <name>', 'Runner name holding the lease')
        .option('--ttl <ms>', 'Lease TTL in ms (default 30000, max 300000)')
        .option('--json', 'Output raw JSON')
        .option('--profile <name>')
        .action(async (id: string, opts: { runner: string; ttl?: string; json?: boolean; profile?: string }) => {
            const profile = requireProfile(opts.profile)
            const token = requireDeviceToken()
            const api = buildClient(profile)
            try {
                const lease = await api.post<Lease>(
                    `/api/v1/sessions/${id}/lease/renew`,
                    leaseBody(opts.runner, opts.ttl),
                    { 'x-fabric-device-token': token },
                )
                printLease(lease, opts.json)
            } catch (err) {
                handleLeaseError(err)
            }
        })

    program.command('release <id>')
        .description('Release a drive lease — hand the wheel back (user-auth)')
        .requiredOption('--runner <name>', 'Runner name holding the lease')
        .option('--profile <name>')
        .action(async (id: string, opts: { runner: string; profile?: string }) => {
            const profile = requireProfile(opts.profile)
            const api = buildClient(profile)
            try {
                await api.delete(`/api/v1/sessions/${id}/lease`, { runnerId: opts.runner })
                console.log(`${c.green('Released.')} ${c.dim('runner')} ${opts.runner}`)
            } catch (err) {
                if (err instanceof ApiError) {
                    process.stderr.write(`${c.red('Error:')} ${err.message}\n`)
                    process.exit(1)
                }
                throw err
            }
        })
}

function handleLeaseError(err: unknown): never {
    if (err instanceof ApiError) {
        if (err.code === 'DRIVE_GRANT_REQUIRED') {
            process.stderr.write('Denied: this session needs a per-session drive grant (operator-minted).\n')
            process.exit(1)
        }
        if (err.code === 'LEASE_HELD') {
            process.stderr.write(`Lease held: ${err.message}\n`)
            process.exit(1)
        }
        process.stderr.write(`${c.red('Error:')} ${err.message}\n`)
        process.exit(1)
    }
    throw err
}
