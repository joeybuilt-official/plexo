// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Injection ports for the PEX Extension Synthesizer (ADR-0045).
 *
 * The synthesizer's core generation/transform logic is pure and must not
 * reach IO directly. The three IO concerns it needs — persistent
 * generated-extensions filesystem, API doc scraping, and the
 * connections_registry / extensions DB writes + worker termination — are
 * declared here as ports and injected at the composition root (apps/api)
 * via the `setSynthesizer*` setters.
 *
 * Defaults: each port has a built-in adapter that reproduces the prior
 * behaviour (node:fs on the GENERATED_EXTENSIONS_DIR, global fetch +
 * web-tools URL blocklist, @plexo/db singleton + persistent-pool worker
 * termination). With no override wired, `synthesizeExtension` behaves
 * exactly as before. Tests / alternate runtimes override the ports.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { sql } from 'drizzle-orm'
import { db, extensions } from '@plexo/db'
import { isBlockedUrl } from '../tools/web-tools.js'
import { terminateWorker } from './persistent-pool.js'
import type { ExtensionManifest } from '@joeybuilt/plexo-sdk'

// ── Shared types (also used by the repository port) ───────────────────────────

export interface APIEndpoint {
    method: string
    path: string
    description: string
    parameters?: Record<string, unknown>
}

export interface APIResearch {
    serviceName: string
    baseUrl: string
    authScheme: 'api_key' | 'bearer' | 'basic' | 'oauth2'
    authHeaderName: string
    registryId: string
    docsUrl: string
    endpoints: APIEndpoint[]
    rawContent: string
}

// ── Filesystem port ───────────────────────────────────────────────────────────

export interface SynthesizerFilesystem {
    /** Resolve the on-disk entry path for a generated extension slug. */
    entryPathFor(slug: string): string
    /** Persist the generated extension (code + manifest). Returns entry path. */
    writeExtension(slug: string, code: string, manifest: ExtensionManifest): Promise<string>
}

const GENERATED_EXTENSIONS_DIR =
    process.env.GENERATED_SKILLS_DIR ?? '/var/plexo/generated-skills'

function sanitizeSlug(name: string): string {
    return name
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 60)
}

const defaultFilesystem: SynthesizerFilesystem = {
    entryPathFor(slug: string): string {
        return path.join(GENERATED_EXTENSIONS_DIR, sanitizeSlug(slug), 'index.js')
    },
    async writeExtension(slug: string, code: string, manifest: ExtensionManifest): Promise<string> {
        const safeSlug = sanitizeSlug(slug)
        if (!safeSlug) throw new Error('Invalid slug — service name produced empty sanitized value')

        const dir = path.join(GENERATED_EXTENSIONS_DIR, safeSlug)
        await fs.mkdir(dir, { recursive: true })

        const indexPath = path.join(dir, 'index.js')
        const manifestPath = path.join(dir, 'plexo.json')

        try {
            await fs.access(indexPath)
            await fs.rename(indexPath, path.join(dir, 'index.js.bak'))
        } catch {
            // no existing file — fine
        }

        await fs.writeFile(indexPath, code, 'utf-8')
        await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8')

        return indexPath
    },
}

// ── Doc-fetch port ────────────────────────────────────────────────────────────

export interface SynthesizerDocFetch {
    /** Fetch a URL and return cleaned text, or null if unavailable. Never throws. */
    fetchText(url: string, opts?: { timeoutMs?: number; userAgent?: string }): Promise<string | null>
    /** Return a block reason if the URL is blocked, else null. */
    isBlocked(url: string): Promise<string | null>
}

const defaultDocFetch: SynthesizerDocFetch = {
    async fetchText(url: string, opts?: { timeoutMs?: number; userAgent?: string }): Promise<string | null> {
        try {
            const res = await fetch(url, {
                headers: {
                    'User-Agent': opts?.userAgent ?? 'Plexo-Synthesizer/1.0 (API documentation scraper)',
                    Accept: 'text/html,application/json,*/*',
                },
                signal: AbortSignal.timeout(opts?.timeoutMs ?? 10_000),
            })
            if (!res.ok) return null
            const text = await res.text()
            const clean = text
                .replace(/<script[\s\S]*?<\/script>/gi, '')
                .replace(/<style[\s\S]*?<\/style>/gi, '')
                .replace(/<[^>]+>/g, ' ')
                .replace(/\s+/g, ' ')
                .trim()
                .slice(0, 8000)
            return clean.length > 200 ? clean : null
        } catch {
            return null
        }
    },
    async isBlocked(url: string): Promise<string | null> {
        return isBlockedUrl(url)
    },
}

// ── Repository port (DB + worker termination) ─────────────────────────────────

export interface SynthesizerInstallInput {
    manifest: ExtensionManifest
    workspaceId: string
    serviceSource: string
    docsUrl: string
    taskId?: string
}

export interface SynthesizerRepository {
    /** Upsert a connections_registry entry for a generated connection. */
    registerConnection(research: APIResearch): Promise<void>
    /** Persist + activate the generated extension row. Returns the extension id. */
    installAndActivate(input: SynthesizerInstallInput): Promise<string>
}

const defaultRepository: SynthesizerRepository = {
    async registerConnection(research: APIResearch): Promise<void> {
        const { serviceName, registryId, docsUrl } = research

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
    },

    async installAndActivate(input: SynthesizerInstallInput): Promise<string> {
        const { manifest, workspaceId, serviceSource, docsUrl, taskId } = input
        const settings = {
            isGenerated: true,
            generatedAt: new Date().toISOString(),
            sourceService: serviceSource,
            apiDocsUrl: docsUrl,
            generationTaskId: taskId ?? null,
        }

        try {
            await terminateWorker(manifest.name)
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
                pexVersion: manifest.plexo,
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
    },
}

// ── Setters / getters (composition-root wiring) ───────────────────────────────

let filesystem: SynthesizerFilesystem = defaultFilesystem
let docFetch: SynthesizerDocFetch = defaultDocFetch
let repository: SynthesizerRepository = defaultRepository

export function setSynthesizerFilesystem(fs: SynthesizerFilesystem | null): void {
    filesystem = fs ?? defaultFilesystem
}

export function setSynthesizerDocFetch(df: SynthesizerDocFetch | null): void {
    docFetch = df ?? defaultDocFetch
}

export function setSynthesizerRepository(repo: SynthesizerRepository | null): void {
    repository = repo ?? defaultRepository
}

export function getSynthesizerFilesystem(): SynthesizerFilesystem {
    return filesystem
}

export function getSynthesizerDocFetch(): SynthesizerDocFetch {
    return docFetch
}

export function getSynthesizerRepository(): SynthesizerRepository {
    return repository
}