// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * PEX Extension Synthesizer
 *
 * When a user requests integration with a service that has no installed extension
 * or connector, this module:
 *   1. Scrapes the service's official docs
 *   2. Generates a valid PEX extension (ESM JS + plexo.json)
 *   3. Writes files to the persistent generated-extensions volume
 *   4. Registers a connections_registry entry so the credential UI appears
 *   5. Installs and auto-activates the extension
 *
 * Generated extensions run in the same PEX sandbox as marketplace extensions.
 * Capabilities are inferred from requested operations and validated against
 * a fixed allowlist — the LLM cannot expand them.
 *
 * ADR-0045: the core generation/transform logic is pure — all IO (filesystem,
 * doc scraping, DB) reaches through the ports in `synthesizer-ports.ts`. The
 * public `synthesizeExtension` entry composes the core with the ports resolved
 * from that module (defaults reproduce prior behaviour; the composition root
 * may override them).
 */

import type { ExtensionManifest } from '@joeybuilt/plexo-sdk'
import {
    type APIResearch,
    getSynthesizerFilesystem,
    getSynthesizerDocFetch,
    getSynthesizerRepository,
} from './synthesizer-ports.js'

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_CODE_BYTES = 100 * 1024 // 100KB hard cap

/** Capabilities the synthesizer may grant. LLM proposes; synthesizer validates. */
const CAPABILITY_ALLOWLIST = new Set([
    'tools:register',
    'storage:read',
    'storage:write',
    'memory:read',
    'memory:write',
    'memory:delete',
    // Entity-scoped memory (v0.3.0)
    'memory:read:person',
    'memory:read:task',
    'memory:read:transaction',
    'memory:read:thread',
    'memory:read:note',
    'memory:write:person',
    'memory:write:task',
    'memory:write:transaction',
    'memory:write:thread',
    'memory:write:note',
    'schedule:register',
    'tasks:create',
    'tasks:read',
    'events:publish',
    'channel:send',
    'ui:notify',
])

/** Capabilities always blocked for generated skills. */
const CAPABILITY_DENYLIST = new Set([
    'ui:register-widget',      // too complex for generated code
    'channel:send-direct',
])

// ── Types ──────────────────────────────────────────────────────────────────────

export interface SynthesizeInput {
    serviceName: string
    serviceWebsite: string
    requestedCapabilities: string[]
    workspaceId: string
}

export interface SynthesizeResult {
    ok: boolean
    /** @deprecated Use extensionName */
    skillName: string
    extensionName: string
    registryId: string
    pluginId: string
    message: string
    error?: string
}

// ── Slug sanitization ─────────────────────────────────────────────────────────

function sanitizeSlug(name: string): string {
    return name
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 60)
}

// ── API Research ──────────────────────────────────────────────────────────────

async function researchAPI(
    input: SynthesizeInput,
    docFetch: ReturnType<typeof getSynthesizerDocFetch>,
): Promise<APIResearch> {
    const { serviceName, serviceWebsite } = input
    const slug = sanitizeSlug(serviceName)

    const blockedReason = await docFetch.isBlocked(serviceWebsite)
    if (blockedReason) throw new Error(`Service website rejected: ${blockedReason}`)

    // Candidate doc URLs to try in order
    const candidates = [
        serviceWebsite.replace(/\/$/, ''),
        `${serviceWebsite.replace(/\/$/, '')}/docs`,
        `${serviceWebsite.replace(/\/$/, '')}/reference`,
        `${serviceWebsite.replace(/\/$/, '')}/api`,
        `${serviceWebsite.replace(/\/$/, '')}/developers`,
    ]

    const scraped: string[] = []

    for (const url of candidates.slice(0, 3)) {
        const clean = await docFetch.fetchText(url)
        if (clean && clean.length > 200) {
            scraped.push(`[${url}]\n${clean.slice(0, 8000)}`)
        }
        if (scraped.length >= 3) break
    }

    const rawContent = scraped.join('\n\n---\n\n').slice(0, 16000)

    // Infer auth scheme from common patterns in scraped content
    const lower = rawContent.toLowerCase()
    let authScheme: APIResearch['authScheme'] = 'api_key'
    let authHeaderName = 'Authorization'
    if (lower.includes('bearer token') || lower.includes('authorization: bearer')) {
        authScheme = 'bearer'
    } else if (lower.includes('oauth')) {
        authScheme = 'oauth2'
    } else if (lower.includes('basic auth')) {
        authScheme = 'basic'
    }

    // Infer x-api-key style headers
    const xApiKeyMatch = lower.match(/x-[a-z-]+-key|api[-_]key:/i)
    if (xApiKeyMatch) {
        authHeaderName = xApiKeyMatch[0].replace(/:\s*/, '')
    }

    return {
        serviceName,
        baseUrl: serviceWebsite.replace(/\/$/, ''),
        authScheme,
        authHeaderName,
        registryId: `generated-${slug}`,
        docsUrl: candidates[0] ?? serviceWebsite,
        endpoints: [], // populated during code gen via LLM
        rawContent,
    }
}

// ── Capability inference ──────────────────────────────────────────────────────

function inferCapabilities(requestedCapabilities: string[]): string[] {
    const text = requestedCapabilities.join(' ').toLowerCase()
    const caps = new Set<string>(['storage:read', 'storage:write']) // always included

    // Connection access is added by generateManifest based on registryId

    if (text.includes('schedul') || text.includes('poll') || text.includes('every hour') || text.includes('cron')) {
        caps.add('schedule:register')
    }
    if (text.includes('creat') && (text.includes('task') || text.includes('ticket') || text.includes('issue'))) {
        caps.add('tasks:create')
    }
    if (text.includes('read task') || text.includes('list task') || text.includes('get task')) {
        caps.add('tasks:read')
    }
    if (text.includes('memory') || text.includes('remember') || text.includes('recall')) {
        caps.add('memory:read:note')
        caps.add('memory:write:note')
    }
    if (text.includes('notif') || text.includes('alert') || text.includes('send message') || text.includes('message')) {
        caps.add('channel:send')
    }

    const allowed = [...caps].filter(
        (c) => CAPABILITY_ALLOWLIST.has(c) && !CAPABILITY_DENYLIST.has(c),
    )
    return allowed
}

// ── Code generation ───────────────────────────────────────────────────────────

async function generateExtensionCode(
    research: APIResearch,
    requestedCapabilities: string[],
    workspaceId: string,
): Promise<string> {
    const systemPrompt = `You are a PEX tool generator for the Plexo AI agent platform.
Your output is a JavaScript ESM module that will run in a sandboxed worker thread.

ABSOLUTE RULES — any violation makes the output unusable:
1. Output ONLY JavaScript. No TypeScript. No type annotations.
2. No import statements. No require(). Global fetch() is available.
3. No access to process.env, __dirname, or the filesystem.
4. No eval(). No setTimeout/setInterval for polling (use sdk.registerSchedule).
5. Credentials MUST be fetched via: const creds = await sdk.connections.getCredentials('${research.registryId}');
6. Every tool MUST be registered via sdk.registerTool({ name, description, parameters, handler }).
7. The "parameters" field must be valid JSON Schema with type: "object" at the top level.
8. Every handler must be async and return a plain JSON-serializable value (not Response, not Buffer).
9. The file must export a single async function: export async function activate(sdk) { ... }
10. Tools must be fully implemented — no stub placeholders or TODOs.

CAPABILITY USE:
${research.registryId} connection access: sdk.connections.getCredentials('${research.registryId}')
Scheduling: sdk.registerSchedule({ name, cron, handler })
Memory: sdk.memory.read(query, { entityType: 'note' }), sdk.memory.write({ content, tags, entityType: 'note' })
Tasks: sdk.tasks.create({ request, type })
Notifications: sdk.channel.send({ text })

ERROR HANDLING:
- Catch fetch errors and return { error: errorMessage } objects
- Never throw unhandled exceptions from tool handlers`

    const userPrompt = `Generate a PEX extension for "${research.serviceName}".

SERVICE WEBSITE: ${research.baseUrl}
AUTH SCHEME: ${research.authScheme} (header: ${research.authHeaderName})
CONNECTION REGISTRY ID: ${research.registryId}

DOCUMENTATION SCRAPED:
${research.rawContent.slice(0, 12000)}

USER REQUESTED THESE CAPABILITIES:
${requestedCapabilities.map((c, i) => `${i + 1}. ${c}`).join('\n')}

Generate the complete activate(sdk) function with all tools fully implemented.
Use fetch() to call ${research.baseUrl} for all API calls.
Auth: get credentials with sdk.connections.getCredentials('${research.registryId}') and use the apiKey field.`

    // Route through the workspace's connected providers — no hardwired provider /
    // env key (feedback_no_hardwired_llm_provider).
    const { resolveWorkspaceModel } = await import('../providers/registry.js')
    const model = await resolveWorkspaceModel(workspaceId)
    // Phase 3 hardening — callModel owns retry + abort + error codes.
    // Stable 60s step timeout matches the prior lack of explicit timeout.
    //
    // Phase 4 NOTE: This site is NOT migrated to callModel({ schema }).
    // The synthesizer's LLM output is raw JavaScript source code, not a
    // JSON object. Forcing it through generateObject would require
    // wrapping the code in a string field (e.g. { code: string }) which
    // adds a pointless serialization round-trip and fights the model's
    // training for code generation. `validateGeneratedCode` below is the
    // authoritative gate — it runs byte-size / activate-presence /
    // export-presence / syntax checks via `new Function(...)` and
    // rejects any output the sandbox couldn't load.
    const { callModel } = await import('../providers/call-model.js')
    const result = await callModel({
        model,
        system: systemPrompt,
        prompt: userPrompt,
        maxTokens: 4000,
        stepTimeoutMs: 60_000,
        taskType: 'plugin_synthesis',
    })

    let code = result.text.trim()

    // Strip markdown code fences if present
    const fenceMatch = code.match(/```(?:javascript|js)?\n([\s\S]*?)```/)
    if (fenceMatch) {
        code = fenceMatch[1]!.trim()
    }

    return code
}

// ── SEC-018: Forbidden-pattern validation (AST-lite via regex) ───────────────

const FORBIDDEN_PATTERNS: { pattern: RegExp; reason: string }[] = [
    { pattern: /\bimport\s*\(/, reason: 'Dynamic import() not allowed' },
    { pattern: /\brequire\s*\(/, reason: 'require() not allowed' },
    { pattern: /\beval\s*\(/, reason: 'eval() not allowed' },
    { pattern: /\bnew\s+Function\s*\(/, reason: 'new Function() not allowed' },
    { pattern: /\bprocess\s*\./, reason: 'process access not allowed' },
    { pattern: /\bglobalThis\s*\./, reason: 'globalThis access not allowed' },
    { pattern: /\bchild_process\b/, reason: 'child_process not allowed' },
    { pattern: /\b__dirname\b|\b__filename\b/, reason: 'Node.js globals not allowed' },
    { pattern: /\bfs\s*\.|\bfs\/promises\b/, reason: 'Filesystem access not allowed' },
    { pattern: /\bWebSocket\s*\(/, reason: 'Raw WebSocket not allowed' },
    { pattern: /\bWorker\s*\(/, reason: 'Worker creation not allowed' },
    { pattern: /\bSharedArrayBuffer\b/, reason: 'SharedArrayBuffer not allowed' },
    { pattern: /\bAtomics\b/, reason: 'Atomics not allowed' },
    { pattern: /\.constructor\s*\.\s*constructor\s*\(/, reason: 'Sandbox escape via constructor chain not allowed' },
]

function checkForbiddenPatterns(code: string): { ok: boolean; reason?: string } {
    // Strip string literals and comments to avoid false positives
    const stripped = code
        .replace(/\/\/.*$/gm, '')               // single-line comments
        .replace(/\/\*[\s\S]*?\*\//g, '')        // multi-line comments
        .replace(/'(?:[^'\\]|\\.)*'/g, '""')     // single-quoted strings
        .replace(/"(?:[^"\\]|\\.)*"/g, '""')     // double-quoted strings
        .replace(/`(?:[^`\\]|\\.)*`/g, '""')     // template literals (simple)

    for (const { pattern, reason } of FORBIDDEN_PATTERNS) {
        if (pattern.test(stripped)) return { ok: false, reason }
    }
    return { ok: true }
}

// ── Validation ────────────────────────────────────────────────────────────────

function validateGeneratedCode(code: string): { valid: boolean; error?: string } {
    if (code.length === 0) return { valid: false, error: 'Empty output' }
    if (Buffer.byteLength(code, 'utf8') > MAX_CODE_BYTES) {
        return { valid: false, error: `Generated code exceeds ${MAX_CODE_BYTES / 1024}KB limit` }
    }
    if (!code.includes('activate')) {
        return { valid: false, error: 'Missing activate function' }
    }
    if (!code.includes('export')) {
        return { valid: false, error: 'Missing export statement' }
    }

    // SEC-018: Check for forbidden patterns before writing to disk
    const patternCheck = checkForbiddenPatterns(code)
    if (!patternCheck.ok) {
        return { valid: false, error: `Forbidden pattern: ${patternCheck.reason}` }
    }

    // Basic syntax check — Function constructor validates syntax without executing
    try {
        // eslint-disable-next-line no-new-func
        new Function(code.replace(/^export\s+/gm, ''))
    } catch (e) {
        return { valid: false, error: `Syntax error: ${(e as Error).message}` }
    }
    return { valid: true }
}

// ── Manifest generation ───────────────────────────────────────────────────────

function generateManifest(
    serviceName: string,
    slug: string,
    registryId: string,
    capabilities: string[],
    entryPath: string,
): ExtensionManifest {
    // Connection capability is always included for the service's own registry entry
    const fullCaps = [...new Set([...capabilities, `connections:${registryId}`])]

    return {
        plexo: '0.4.0',
        name: `@generated/${slug}`,
        version: '1.0.0',
        type: 'tool',
        entry: entryPath,
        displayName: serviceName,
        description: `Auto-generated tool for ${serviceName}. Created by Plexo synthesizer.`,
        author: 'plexo-synthesizer',
        license: 'UNLICENSED',
        capabilities: fullCaps as ExtensionManifest['capabilities'],
        resourceHints: {
            maxInvocationMs: 30000,
        },
        dataResidency: {
            sendsDataExternally: true,
        },
    }
}

// ── Main entry point ──────────────────────────────────────────────────────────

export async function synthesizeExtension(input: SynthesizeInput): Promise<SynthesizeResult> {
    const { serviceName, serviceWebsite, requestedCapabilities, workspaceId } = input
    const slug = sanitizeSlug(serviceName)
    const registryId = `generated-${slug}`

    const filesystem = getSynthesizerFilesystem()
    const docFetch = getSynthesizerDocFetch()
    const repository = getSynthesizerRepository()

    try {
        // 1. Research the API
        const research = await researchAPI(input, docFetch)

        // 2. Infer and validate capabilities
        const capabilities = inferCapabilities(requestedCapabilities)

        // 3. Generate extension code via LLM
        const code = await generateExtensionCode(research, requestedCapabilities, workspaceId)

        // 4. Validate generated code
        const validation = validateGeneratedCode(code)
        if (!validation.valid) {
            return {
                ok: false,
                skillName: `@generated/${slug}`,
                extensionName: `@generated/${slug}`,
                registryId,
                pluginId: '',
                message: '',
                error: `Code validation failed: ${validation.error}`,
            }
        }

        // 5. Build manifest (entry path resolved by the filesystem port)
        const entryPath = filesystem.entryPathFor(slug)
        const manifest = generateManifest(serviceName, slug, registryId, capabilities, entryPath)

        // 6. Write to disk
        await filesystem.writeExtension(slug, code, manifest)

        // 7. Register connection entry (so credential UI appears immediately)
        await repository.registerConnection(research)

        // 8. Install and auto-activate plugin
        const pluginId = await repository.installAndActivate({
            manifest,
            workspaceId,
            serviceSource: slug,
            docsUrl: research.docsUrl,
        })

        return {
            ok: true,
            skillName: manifest.name,
            extensionName: manifest.name,
            registryId,
            pluginId,
            message:
                `✦ ${serviceName} tool is live and active. ` +
                `Go to **Integrations → ${serviceName}** to enter your API key and start using it. ` +
                `Functions generated: ${requestedCapabilities.map((c) => `\`${c}\``).join(', ')}.`,
        }
    } catch (err) {
        return {
            ok: false,
            skillName: `@generated/${slug}`,
            extensionName: `@generated/${slug}`,
            registryId,
            pluginId: '',
            message: '',
            error: `Synthesis failed: ${(err as Error).message}`,
        }
    }
}

/** @deprecated Use synthesizeExtension */
export const synthesizeSkill = synthesizeExtension