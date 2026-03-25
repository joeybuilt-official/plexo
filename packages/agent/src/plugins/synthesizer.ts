// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Fabric Extension Synthesizer
 *
 * When a user requests integration with a service that has no installed extension
 * or connector, this module:
 *   1. Scrapes the service's official docs
 *   2. Generates a valid Fabric extension (ESM JS + plexo.json)
 *   3. Writes files to the persistent generated-extensions volume
 *   4. Registers a connections_registry entry so the credential UI appears
 *   5. Installs and auto-activates the extension
 *
 * Generated extensions run in the same Fabric sandbox as marketplace extensions.
 * Capabilities are inferred from requested operations and validated against
 * a fixed allowlist — the LLM cannot expand them.
 */

import { db, eq, and, sql } from '@plexo/db'
import { extensions, connectionsRegistry, workspaces } from '@plexo/db'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { terminateWorker } from './persistent-pool.js'
import type { ExtensionManifest, ManifestType } from '@plexo/sdk'

// ── Constants ─────────────────────────────────────────────────────────────────

const GENERATED_EXTENSIONS_DIR =
    process.env.GENERATED_SKILLS_DIR ?? '/var/plexo/generated-skills'

const MAX_CODE_BYTES = 100 * 1024 // 100KB hard cap

/** Capabilities the synthesizer may grant. LLM proposes; synthesizer validates. */
const CAPABILITY_ALLOWLIST = new Set([
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

interface APIEndpoint {
    method: string
    path: string
    description: string
    parameters?: Record<string, unknown>
}

interface APIResearch {
    serviceName: string
    baseUrl: string
    authScheme: 'api_key' | 'bearer' | 'basic' | 'oauth2'
    authHeaderName: string
    registryId: string
    docsUrl: string
    endpoints: APIEndpoint[]
    rawContent: string
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

async function researchAPI(input: SynthesizeInput): Promise<APIResearch> {
    const { serviceName, serviceWebsite } = input
    const slug = sanitizeSlug(serviceName)

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
        try {
            const res = await fetch(url, {
                headers: {
                    'User-Agent': 'Plexo-Synthesizer/1.0 (API documentation scraper)',
                    Accept: 'text/html,application/json,*/*',
                },
                signal: AbortSignal.timeout(10_000),
            })
            if (!res.ok) continue
            const text = await res.text()
            // Strip HTML tags, normalise whitespace
            const clean = text
                .replace(/<script[\s\S]*?<\/script>/gi, '')
                .replace(/<style[\s\S]*?<\/style>/gi, '')
                .replace(/<[^>]+>/g, ' ')
                .replace(/\s+/g, ' ')
                .trim()
                .slice(0, 8000) // cap per page
            if (clean.length > 200) scraped.push(`[${url}]\n${clean}`)
            if (scraped.length >= 3) break
        } catch {
            // non-fatal — try next candidate
        }
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
    _workspaceId: string,
): Promise<string> {
    const { generateText } = await import('ai')

    const systemPrompt = `You are a Fabric extension generator for the Plexo AI agent platform.
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

    const userPrompt = `Generate a Fabric extension for "${research.serviceName}".

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

    // Use resolveModelFromEnv for internal synthesizer calls — the workspace aiSettings
    // is a raw JSONB object, not a WorkspaceAISettings, so withFallback would fail.
    // resolveModelFromEnv prioritises OPENAI_API_KEY → GEMINI_API_KEY → OPENROUTER → Ollama.
    const { resolveModelFromEnv } = await import('../providers/registry.js')
    const model = resolveModelFromEnv()
    const result = await generateText({
        model,
        system: systemPrompt,
        prompt: userPrompt,
        maxOutputTokens: 4000,
    })

    let code = result.text.trim()

    // Strip markdown code fences if present
    const fenceMatch = code.match(/```(?:javascript|js)?\n([\s\S]*?)```/)
    if (fenceMatch) {
        code = fenceMatch[1]!.trim()
    }

    return code
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
        type: 'skill',
        entry: entryPath,
        displayName: serviceName,
        description: `Auto-generated extension for ${serviceName}. Created by Plexo synthesizer.`,
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

// ── Disk I/O ──────────────────────────────────────────────────────────────────

async function writeExtensionToDisk(
    slug: string,
    code: string,
    manifest: ExtensionManifest,
): Promise<string> {
    const safeSlug = sanitizeSlug(slug)
    if (!safeSlug) throw new Error('Invalid slug — service name produced empty sanitized value')

    const dir = path.join(GENERATED_EXTENSIONS_DIR, safeSlug)
    await fs.mkdir(dir, { recursive: true })

    const indexPath = path.join(dir, 'index.js')
    const manifestPath = path.join(dir, 'plexo.json')

    // Back up existing file
    try {
        await fs.access(indexPath)
        await fs.rename(indexPath, path.join(dir, 'index.js.bak'))
    } catch {
        // no existing file — fine
    }

    await fs.writeFile(indexPath, code, 'utf-8')
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8')

    return indexPath
}

// ── Connection registry entry ─────────────────────────────────────────────────

async function registerConnection(research: APIResearch): Promise<void> {
    const { serviceName, registryId, docsUrl, authScheme } = research

    await db.execute(sql`
        INSERT INTO connections_registry
            (id, name, description, category, auth_type, oauth_scopes, setup_fields,
             tools_provided, cards_provided, is_core, is_generated, doc_url, created_at)
        VALUES
            (${registryId},
             ${serviceName},
             ${'Auto-generated connection for ' + serviceName + '. Created by Plexo agent synthesizer.'},
             ${'custom'},
             ${'api_key'},
             ${'[]'}::jsonb,
             ${JSON.stringify([{ key: 'apiKey', label: 'API Key', type: 'password', required: true }])}::jsonb,
             ${'[]'}::jsonb,
             ${'[]'}::jsonb,
             ${false},
             ${true},
             ${docsUrl},
             now())
        ON CONFLICT (id) DO UPDATE SET
            name = EXCLUDED.name,
            description = EXCLUDED.description,
            doc_url = EXCLUDED.doc_url,
            is_generated = true
    `)

    // For oauth2 services, note that we fall back to API key flow
    void authScheme // used for research context, not stored separately for generated connections
}

// ── Plugin install + activate ─────────────────────────────────────────────────

async function installAndActivate(
    manifest: ExtensionManifest,
    workspaceId: string,
    serviceSource: string,
    docsUrl: string,
    taskId?: string,
): Promise<string> {
    const settings = {
        isGenerated: true,
        generatedAt: new Date().toISOString(),
        sourceService: serviceSource,
        apiDocsUrl: docsUrl,
        generationTaskId: taskId ?? null,
    }

    try {
        terminateWorker(manifest.name)
    } catch {
        // no existing worker — fine
    }

    const [row] = await db
        .insert(extensions)
        .values({
            workspaceId,
            name: manifest.name,
            version: manifest.version,
            type: manifest.type as any,
            fabricVersion: manifest.plexo,
            entry: manifest.entry,
            manifest: manifest as unknown as Record<string, unknown>,
            enabled: true,
            settings: settings as Record<string, unknown>,
        })
        .onConflictDoUpdate({
            target: [extensions.workspaceId, extensions.name],
            set: {
                version: manifest.version,
                entry: manifest.entry,
                manifest: manifest as unknown as Record<string, unknown>,
                enabled: true,
                settings: settings as Record<string, unknown>,
            },
        })
        .returning({ id: extensions.id })

    return row!.id
}

// ── Main entry point ──────────────────────────────────────────────────────────

export async function synthesizeExtension(input: SynthesizeInput): Promise<SynthesizeResult> {
    const { serviceName, serviceWebsite, requestedCapabilities, workspaceId } = input
    const slug = sanitizeSlug(serviceName)
    const registryId = `generated-${slug}`

    try {
        // 1. Research the API
        const research = await researchAPI(input)

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

        // 5. Build manifest (entry path determined after writing)
        const entryPath = path.join(GENERATED_EXTENSIONS_DIR, slug, 'index.js')
        const manifest = generateManifest(serviceName, slug, registryId, capabilities, entryPath)

        // 6. Write to disk
        await writeExtensionToDisk(slug, code, manifest)

        // 7. Register connection entry (so credential UI appears immediately)
        await registerConnection(research)

        // 8. Install and auto-activate plugin
        const pluginId = await installAndActivate(
            manifest,
            workspaceId,
            slug,
            research.docsUrl,
        )

        return {
            ok: true,
            skillName: manifest.name,
            extensionName: manifest.name,
            registryId,
            pluginId,
            message:
                `✦ ${serviceName} extension is live and active. ` +
                `Go to **Connections → ${serviceName}** to enter your API key and start using it. ` +
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
