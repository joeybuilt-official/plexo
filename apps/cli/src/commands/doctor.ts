// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * `plexo doctor` — health checks + actionable fix suggestions.
 *
 * Difference from `plexo status`:
 *   - status: snapshot of platform state, raw numbers
 *   - doctor: opinionated checks, each prints a fix suggestion when it
 *     fails, and the command exits non-zero if any check produced an
 *     actionable issue. Suitable for CI gates and human troubleshooting.
 *
 * Inspired by `claude doctor` and OpenClaw's `oc doctor` pattern.
 *
 * Sprint A′ L4.6 (2026-05-23).
 */

import { Command } from 'commander'
import { getProfile, getProfileName } from '../config.js'
import { buildClient } from '../client.js'
import { c } from '../output.js'

type CheckLevel = 'ok' | 'warn' | 'error'

interface CheckResult {
    name: string
    level: CheckLevel
    detail: string
    /** Actionable fix — printed when level !== 'ok'. */
    fix?: string
}

interface HealthResponse {
    status: string
    services: {
        postgres: { ok: boolean; latencyMs: number }
        redis: { ok: boolean; latencyMs: number }
        anthropic: { ok: boolean; latencyMs: number }
    }
    uptime: number
    version: string
    pex?: {
        workers: Array<{ extensionName: string; toolCount: number }>
    }
}

interface DashboardSummary {
    taskCounts: Record<string, number>
    costThisWeek: number
    costCeiling: number
    channels: Array<{ type: string; enabled: boolean }>
}

interface ProviderRow {
    provider: string
    enabled: boolean
    selectedModel?: string
}

interface WorkspaceProviderSummary {
    workspaceId: string
    name?: string
    providers: ProviderRow[]
}

const TAG_OK = c.green('✓')
const TAG_WARN = c.yellow('!')
const TAG_ERR = c.red('✗')

function tagFor(level: CheckLevel): string {
    if (level === 'ok') return TAG_OK
    if (level === 'warn') return TAG_WARN
    return TAG_ERR
}

function printCheck(r: CheckResult): void {
    console.log(`  ${tagFor(r.level)} ${c.bold(r.name)}  ${c.dim('—')} ${r.detail}`)
    if (r.level !== 'ok' && r.fix) {
        console.log(`      ${c.dim('fix:')} ${r.fix}`)
    }
}

export function registerDoctor(program: Command): void {
    program.command('doctor')
        .description('Run health checks + print actionable fix suggestions for any issues')
        .option('--profile <name>', 'Config profile to use')
        .option('--output <format>', 'table|json', 'table')
        .action(async (opts: { profile?: string; output: string }) => {
            const checks: CheckResult[] = []

            // 1. CLI config: is there a profile to talk to a Plexo at all?
            const profileName = getProfileName(opts.profile)
            const profile = getProfile(opts.profile)
            if (!profile) {
                checks.push({
                    name: 'CLI profile',
                    level: 'error',
                    detail: `No profile "${profileName}" configured — CLI cannot reach a Plexo instance`,
                    fix: 'Run `plexo auth login` to set up your default profile, or `plexo config add-profile <name>` for a named one.',
                })
                // Without a profile we can't do any HTTP checks; print + exit.
                renderAndExit(checks, opts.output)
                return
            }

            checks.push({
                name: 'CLI profile',
                level: 'ok',
                detail: `${profileName} → ${profile.host}`,
            })

            const api = buildClient(profile)

            // 2. API reachable + healthy
            let health: HealthResponse | null = null
            try {
                health = await api.get<HealthResponse>('/health')
                checks.push({
                    name: 'API reachable',
                    level: 'ok',
                    detail: `v${health.version} · uptime ${Math.floor(health.uptime / 60)}m`,
                })
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err)
                checks.push({
                    name: 'API reachable',
                    level: 'error',
                    detail: msg.slice(0, 120),
                    fix: `Confirm ${profile.host} is reachable and the auth token is valid. Try \`curl ${profile.host}/health\`.`,
                })
                renderAndExit(checks, opts.output)
                return
            }

            // 3. Core services
            const pg = health.services.postgres
            checks.push({
                name: 'Postgres',
                level: pg.ok ? 'ok' : 'error',
                detail: `${pg.latencyMs}ms`,
                fix: pg.ok ? undefined : 'Restart postgres or check `docker logs plexo-postgres`. DATABASE_URL must point to a live instance.',
            })

            const redis = health.services.redis
            checks.push({
                name: 'Redis/Valkey',
                level: redis.ok ? 'ok' : 'error',
                detail: `${redis.latencyMs}ms`,
                fix: redis.ok ? undefined : 'Restart the redis/valkey container. REDIS_URL must point to a live instance.',
            })

            const ai = health.services.anthropic
            checks.push({
                name: 'Anthropic (system-level)',
                level: ai.ok ? 'ok' : 'warn',
                detail: ai.ok ? `${ai.latencyMs}ms` : 'not configured at system level',
                fix: ai.ok ? undefined : 'Optional. System-level Anthropic key is the env-fallback path for cron/self-host. Workspace-level keys (Settings → AI Providers) cover the request paths.',
            })

            // 4. Pex extensions loaded
            const workerCount = health.pex?.workers?.length ?? 0
            checks.push({
                name: 'Pex extension workers',
                level: workerCount > 0 ? 'ok' : 'warn',
                detail: `${workerCount} loaded`,
                fix: workerCount > 0 ? undefined : 'No persistent workers active. If your workspace expects connectors (Fylo, Levio, Nexalog, etc.) verify they\'re installed and the worker processes started — `docker logs plexo-api | grep pex-bridge`.',
            })

            // 5. Workspace summary (best-effort; some routes 404 on older instances)
            try {
                const summary = await api.get<DashboardSummary>('/api/v1/dashboard/summary')
                const queued = summary.taskCounts['queued'] ?? 0
                const running = summary.taskCounts['running'] ?? 0
                const failed = summary.taskCounts['failed'] ?? 0

                // Backlog: > 200 queued is a smell.
                checks.push({
                    name: 'Task backlog',
                    level: queued > 200 ? 'warn' : 'ok',
                    detail: `${running} running · ${queued} queued · ${failed} failed (lifetime)`,
                    fix: queued > 200
                        ? 'Backlog > 200 queued. Check provider quotas (rate limits, credit balance) and OWD approval queue. Run `plexo task list --status queued` to inspect.'
                        : undefined,
                })

                // Cost ceiling proximity
                const cost = summary.costThisWeek ?? 0
                const ceiling = summary.costCeiling ?? 0
                if (ceiling > 0) {
                    const pct = (cost / ceiling) * 100
                    checks.push({
                        name: 'Weekly cost',
                        level: pct >= 90 ? 'warn' : 'ok',
                        detail: `$${cost.toFixed(2)} of $${ceiling.toFixed(2)} ceiling (${pct.toFixed(0)}%)`,
                        fix: pct >= 90
                            ? 'Approaching weekly cost ceiling. Raise it in Settings → Cost or audit expensive tasks with `plexo task list --order cost`.'
                            : undefined,
                    })
                }
            } catch {
                // Older API or workspace not selected — skip silently.
            }

            // 6. Workspace provider configuration
            try {
                const ws = await api.get<WorkspaceProviderSummary | null>('/api/v1/providers/summary')
                if (ws && Array.isArray(ws.providers)) {
                    const enabled = ws.providers.filter(p => p.enabled)
                    if (enabled.length === 0) {
                        checks.push({
                            name: 'AI providers (workspace)',
                            level: 'error',
                            detail: '0 enabled providers',
                            fix: 'Workspace has no enabled AI provider. Add one in Settings → AI Providers (Anthropic / OpenAI / Ollama Cloud / Groq / DeepSeek).',
                        })
                    } else if (enabled.length === 1) {
                        checks.push({
                            name: 'AI providers (workspace)',
                            level: 'warn',
                            detail: `1 enabled (${enabled[0]!.provider}); no fallback`,
                            fix: 'A single enabled provider has no fallback path. If it rate-limits or returns malformed JSON, every task fails. Add a second provider so router-v2 can cascade.',
                        })
                    } else {
                        const names = enabled.map(p => p.provider).join(', ')
                        checks.push({
                            name: 'AI providers (workspace)',
                            level: 'ok',
                            detail: `${enabled.length} enabled (${names})`,
                        })
                    }
                }
            } catch {
                // Endpoint may not exist on older instances; skip.
            }

            renderAndExit(checks, opts.output)
        })
}

function renderAndExit(checks: CheckResult[], format: string): void {
    if (format === 'json') {
        console.log(JSON.stringify({ checks }, null, 2))
    } else {
        console.log()
        console.log(`  ${c.bold('plexo doctor')}`)
        console.log()
        checks.forEach(printCheck)
        console.log()
        const errors = checks.filter(c => c.level === 'error').length
        const warns = checks.filter(c => c.level === 'warn').length
        const oks = checks.filter(c => c.level === 'ok').length
        const summary =
            errors > 0 ? c.red(`${errors} error${errors === 1 ? '' : 's'}`) :
                warns > 0 ? c.yellow(`${warns} warning${warns === 1 ? '' : 's'}`) :
                    c.green('all clear')
        console.log(`  ${summary} · ${oks} ok${errors + warns > 0 ? `, ${errors} error${errors === 1 ? '' : 's'}, ${warns} warning${warns === 1 ? '' : 's'}` : ''}`)
        console.log()
    }

    const anyError = checks.some(c => c.level === 'error')
    process.exit(anyError ? 1 : 0)
}
