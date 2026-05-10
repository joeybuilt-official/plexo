// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * PAX CLI subcommands — PAX Protocol §12
 *
 * plexo pax init         — interactive pax.json generator
 * plexo pax validate     — validate pax.json against schema
 * plexo pax register     — POST to /api/v1/pax/register
 * plexo pax status       — show registration info
 * plexo pax rotate       — rotate PAX token
 * plexo pax revoke       — revoke registration
 */
import { Command } from 'commander'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { requireProfile } from '../config.js'
import { buildClient } from '../client.js'
import { output, spinner, c, fatal } from '../output.js'
import type { OutputFormat } from '../output.js'

// ── Manifest validation (matches API-side + JSON Schema) ─────────────────────

const PAX_NAME_RE = /^(@[a-z0-9-]+\/)?[a-z0-9-]+$/
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/
const CAPABILITY_RE = /^(ai:(complete|embed)|memory:(read|write|search):[a-z0-9:.]+|events:(publish|subscribe):[a-z0-9:.]+|entities:(read|create):[a-z_]+|agents:invoke|connections:proxy:[a-z0-9*-]+)$/

interface ValidationError {
    field: string
    message: string
}

function validateManifest(manifest: unknown): ValidationError[] {
    const errors: ValidationError[] = []
    if (!manifest || typeof manifest !== 'object') {
        return [{ field: 'manifest', message: 'Must be a JSON object' }]
    }

    const m = manifest as Record<string, unknown>

    for (const field of ['plexo', 'name', 'version', 'displayName', 'description', 'author', 'license']) {
        if (typeof m[field] !== 'string' || !m[field]) {
            errors.push({ field, message: `Required field '${field}' missing or empty` })
        }
    }

    if (errors.length > 0) return errors

    if (m.plexo !== '0.1.0') errors.push({ field: 'plexo', message: "Must be '0.1.0'" })
    if (!PAX_NAME_RE.test(m.name as string)) errors.push({ field: 'name', message: 'Invalid name format' })
    if (!SEMVER_RE.test(m.version as string)) errors.push({ field: 'version', message: 'Invalid semver' })

    if (m.capabilities !== undefined) {
        if (!Array.isArray(m.capabilities)) {
            errors.push({ field: 'capabilities', message: 'Must be an array' })
        } else {
            for (const cap of m.capabilities) {
                if (typeof cap !== 'string' || !CAPABILITY_RE.test(cap)) {
                    errors.push({ field: 'capabilities', message: `Invalid token: ${cap}` })
                }
            }
        }
    }

    if (m.memoryNamespace !== undefined && (typeof m.memoryNamespace !== 'string' || !m.memoryNamespace.startsWith('pax:'))) {
        errors.push({ field: 'memoryNamespace', message: "Must start with 'pax:'" })
    }
    if (m.eventNamespace !== undefined && (typeof m.eventNamespace !== 'string' || !m.eventNamespace.startsWith('pax.'))) {
        errors.push({ field: 'eventNamespace', message: "Must start with 'pax.'" })
    }

    return errors
}

function readManifestFile(filePath?: string): unknown {
    const p = resolve(filePath ?? 'pax.json')
    if (!existsSync(p)) fatal(new Error(`File not found: ${p}`))
    const raw = readFileSync(p, 'utf-8')
    try {
        return JSON.parse(raw)
    } catch {
        fatal(new Error(`Invalid JSON in ${p}`))
    }
}

// ── Registration ─────────────────────────────────────────────────────────────

export function registerPax(program: Command): void {
    const pax = program.command('pax').description('PAX app registration and management')

    // ── plexo pax init ───────────────────────────────────────────────────────

    pax.command('init')
        .description('Generate a pax.json manifest interactively')
        .action(async () => {
            const readline = await import('node:readline')
            const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
            const ask = (q: string, def?: string): Promise<string> =>
                new Promise(r => rl.question(`${q}${def ? ` (${def})` : ''}: `, v => r(v.trim() || def || '')))

            const name = await ask('App name (lowercase, e.g. @org/myapp)')
            const version = await ask('Version', '1.0.0')
            const displayName = await ask('Display name')
            const description = await ask('Description')
            const author = await ask('Author')
            const license = await ask('License', 'MIT')
            const capsRaw = await ask('Capabilities (comma-separated, e.g. ai:complete,memory:read:pax:myapp)', '')

            rl.close()

            const capabilities = capsRaw ? capsRaw.split(',').map(s => s.trim()).filter(Boolean) : []
            const baseName = name.replace(/^@[^/]+\//, '')

            const manifest = {
                plexo: '0.1.0',
                name,
                version,
                displayName,
                description,
                author,
                license,
                ...(capabilities.length > 0 ? { capabilities } : {}),
                memoryNamespace: `pax:${baseName}`,
                eventNamespace: `pax.${baseName}`,
            }

            const outPath = resolve('pax.json')
            writeFileSync(outPath, JSON.stringify(manifest, null, 2) + '\n')
            console.log(`${c.green('Created')} ${outPath}`)
        })

    // ── plexo pax validate ───────────────────────────────────────────────────

    pax.command('validate')
        .description('Validate a pax.json manifest')
        .option('--file <path>', 'Path to pax.json', 'pax.json')
        .action(async (opts: { file: string }) => {
            const manifest = readManifestFile(opts.file)
            const errors = validateManifest(manifest)
            if (errors.length === 0) {
                console.log(`${c.green('Valid')} — ${opts.file}`)
            } else {
                console.error(`${c.red('Invalid')} — ${errors.length} error(s):`)
                for (const e of errors) {
                    console.error(`  ${c.yellow(e.field)}: ${e.message}`)
                }
                process.exit(1)
            }
        })

    // ── plexo pax register ───────────────────────────────────────────────────

    pax.command('register')
        .description('Register a PAX app with the Plexo host')
        .option('--file <path>', 'Path to pax.json', 'pax.json')
        .option('--save-token', 'Append token to .env file')
        .option('--profile <name>')
        .action(async (opts: { file: string; saveToken?: boolean; profile?: string }) => {
            const profile = requireProfile(opts.profile)
            const api = buildClient(profile)
            const manifest = readManifestFile(opts.file)

            // Validate locally first
            const errors = validateManifest(manifest)
            if (errors.length > 0) {
                console.error(`${c.red('Manifest invalid')} — fix errors first:`)
                for (const e of errors) console.error(`  ${c.yellow(e.field)}: ${e.message}`)
                process.exit(1)
            }

            const spin = spinner('Registering PAX app')
            const result = await api.post<{
                ok: boolean
                appName: string
                token: string
                capabilities: string[]
                expiresAt: string
                message: string
            }>('/api/v1/pax/register', { manifest })

            spin.success({ text: `Registered: ${c.green(result.appName)}` })
            console.log(`\n${c.bold('Token:')}        ${result.token}`)
            console.log(`${c.bold('Capabilities:')} ${result.capabilities.join(', ')}`)
            console.log(`${c.bold('Expires:')}      ${new Date(result.expiresAt).toLocaleDateString()}`)
            console.log(`\n${c.dim(result.message)}`)

            if (opts.saveToken) {
                const envLine = `\nPAX_TOKEN=${result.token}\n`
                const envPath = resolve('.env')
                writeFileSync(envPath, envLine, { flag: 'a' })
                console.log(`\nToken appended to ${c.cyan(envPath)}`)
            }
        })

    // ── plexo pax status ─────────────────────────────────────────────────────

    pax.command('status <appName>')
        .description('Show registration info for a PAX app')
        .option('--output <format>', 'table|json', 'table')
        .option('--profile <name>')
        .action(async (appName: string, opts: { output: OutputFormat; profile?: string }) => {
            const profile = requireProfile(opts.profile)
            const api = buildClient(profile)
            const info = await api.get<{
                appName: string
                version: string
                capabilities: string[]
                manifestHash: string
                issuedAt: string
                lastUsedAt: string | null
                tokenExpiresAt: string | null
                revoked: boolean
                revokedAt: string | null
            }>(`/api/v1/pax/status/${encodeURIComponent(appName)}`)

            if (opts.output === 'json') {
                console.log(JSON.stringify(info, null, 2))
                return
            }

            console.log(`${c.bold('App:')}          ${info.appName}`)
            console.log(`${c.bold('Version:')}      ${info.version}`)
            console.log(`${c.bold('Capabilities:')} ${info.capabilities.join(', ')}`)
            console.log(`${c.bold('Manifest:')}     ${info.manifestHash.slice(0, 16)}...`)
            console.log(`${c.bold('Issued:')}       ${new Date(info.issuedAt).toLocaleString()}`)
            console.log(`${c.bold('Last Used:')}    ${info.lastUsedAt ? new Date(info.lastUsedAt).toLocaleString() : c.dim('never')}`)
            console.log(`${c.bold('Expires:')}      ${info.tokenExpiresAt ? new Date(info.tokenExpiresAt).toLocaleDateString() : c.dim('none')}`)
            console.log(`${c.bold('Revoked:')}      ${info.revoked ? c.red('yes') : c.green('no')}`)
        })

    // ── plexo pax rotate ─────────────────────────────────────────────────────

    pax.command('rotate <appName>')
        .description('Rotate the PAX token for a registered app')
        .option('--profile <name>')
        .action(async (appName: string, opts: { profile?: string }) => {
            const profile = requireProfile(opts.profile)
            const api = buildClient(profile)
            const spin = spinner(`Rotating token for ${appName}`)
            const result = await api.post<{
                ok: boolean
                appName: string
                token: string
                expiresAt: string
                message: string
            }>('/api/v1/pax/rotate', { appName })

            spin.success({ text: `Token rotated: ${c.green(appName)}` })
            console.log(`\n${c.bold('New Token:')} ${result.token}`)
            console.log(`${c.bold('Expires:')}   ${new Date(result.expiresAt).toLocaleDateString()}`)
            console.log(`\n${c.dim(result.message)}`)
        })

    // ── plexo pax revoke ─────────────────────────────────────────────────────

    pax.command('revoke <appName>')
        .description('Revoke a PAX app registration')
        .option('--profile <name>')
        .action(async (appName: string, opts: { profile?: string }) => {
            const profile = requireProfile(opts.profile)
            const api = buildClient(profile)
            const spin = spinner(`Revoking ${appName}`)
            await api.delete(`/api/v1/pax/register/${encodeURIComponent(appName)}`)
            spin.success({ text: `Revoked: ${c.red(appName)}` })
        })
}
