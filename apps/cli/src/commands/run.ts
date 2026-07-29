// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

import { Command } from 'commander'
import { requireProfile } from '../config.js'
import { buildClient, ApiError } from '../client.js'
import { c } from '../output.js'

// Minimal structural view — canonical types live in @plexo/session-fabric.
interface RunOutcome {
    status: 'completed' | 'denied' | 'paused' | 'no_lease'
    executedStepIds: string[]
    pausedOnStepId?: string
    deniedStepId?: string
    verdict?: { outcomeKind: string; reward: number; rewardSource: string; note?: string }
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

function printOutcome(outcome: RunOutcome, id: string, runner: string, json?: boolean): void {
    if (json) {
        console.log(JSON.stringify(outcome, null, 2))
        return
    }
    console.log(`${c.bold('Status:')}   ${outcome.status}`)
    console.log(`${c.bold('Executed:')} ${outcome.executedStepIds.length} step(s)`)
    if (outcome.status === 'paused' && outcome.pausedOnStepId) {
        console.log(`${c.yellow('Paused on:')} ${outcome.pausedOnStepId}`)
        console.log(c.dim(`Approve with: px approve ${id} ${outcome.pausedOnStepId} --runner ${runner}`))
        console.log(c.dim(`Deny with:    px deny ${id} ${outcome.pausedOnStepId} --runner ${runner}`))
    }
    if (outcome.status === 'denied' && outcome.deniedStepId) {
        console.log(`${c.red('Denied on:')} ${outcome.deniedStepId}`)
    }
    if (outcome.status === 'completed' && outcome.verdict) {
        console.log(`${c.bold('Reward:')}   ${outcome.verdict.reward} ${c.dim(`(${outcome.verdict.rewardSource})`)}`)
        if (outcome.verdict.note) console.log(`${c.bold('Note:')}     ${outcome.verdict.note}`)
    }
}

function handleRunError(err: unknown): never {
    if (err instanceof ApiError) {
        if (err.code === 'DRIVE_GRANT_REQUIRED') {
            process.stderr.write('Denied: this session needs a per-session drive grant (operator-minted).\n')
            process.exit(1)
        }
        if (err.status === 409) {
            process.stderr.write(`${err.message}\n`)
            process.exit(1)
        }
        process.stderr.write(`${c.red('Error:')} ${err.message}\n`)
        process.exit(1)
    }
    throw err
}

export function registerRun(program: Command): void {
    program.command('run <id>')
        .description('Run a goal on a session via the drive runner (device-token gated)')
        .requiredOption('--goal <text>', 'Goal for the runner to pursue')
        .requiredOption('--runner <name>', 'Runner name holding the lease')
        .option('--tier <tier>', 'observe|steer|drive')
        .option('--json', 'Output raw JSON')
        .option('--profile <name>')
        .action(async (id: string, opts: { goal: string; runner: string; tier?: string; json?: boolean; profile?: string }) => {
            const profile = requireProfile(opts.profile)
            const token = requireDeviceToken()
            const api = buildClient(profile)
            const body: { goal: string; runnerId: string; tier?: string } = { goal: opts.goal, runnerId: opts.runner }
            if (opts.tier !== undefined) body.tier = opts.tier
            try {
                const outcome = await api.post<RunOutcome>(
                    `/api/v1/sessions/${id}/drive`,
                    body,
                    { 'x-fabric-device-token': token },
                )
                printOutcome(outcome, id, opts.runner, opts.json)
            } catch (err) {
                handleRunError(err)
            }
        })

    program.command('approve <id> <stepId>')
        .description('Approve a paused gated step')
        .requiredOption('--runner <name>', 'Runner name holding the lease')
        .option('--json', 'Output raw JSON')
        .option('--profile <name>')
        .action(async (id: string, stepId: string, opts: { runner: string; json?: boolean; profile?: string }) => {
            await decide(id, stepId, 'approve', opts)
        })

    program.command('deny <id> <stepId>')
        .description('Deny a paused gated step')
        .requiredOption('--runner <name>', 'Runner name holding the lease')
        .option('--json', 'Output raw JSON')
        .option('--profile <name>')
        .action(async (id: string, stepId: string, opts: { runner: string; json?: boolean; profile?: string }) => {
            await decide(id, stepId, 'deny', opts)
        })
}

async function decide(
    id: string,
    stepId: string,
    decision: 'approve' | 'deny',
    opts: { runner: string; json?: boolean; profile?: string },
): Promise<void> {
    const profile = requireProfile(opts.profile)
    const token = requireDeviceToken()
    const api = buildClient(profile)
    try {
        const outcome = await api.post<RunOutcome>(
            `/api/v1/sessions/${id}/approve`,
            { stepId, decision, runnerId: opts.runner },
            { 'x-fabric-device-token': token },
        )
        printOutcome(outcome, id, opts.runner, opts.json)
    } catch (err) {
        handleRunError(err)
    }
}
