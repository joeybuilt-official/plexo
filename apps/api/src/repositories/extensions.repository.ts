// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Extensions (Tools) data-access repository.
 *
 * arch-findings B1 — owns the raw `extensions` (+ extension_registry,
 * extension_prompts, extension_contexts, behavior_rules cleanup) table SQL
 * behind the extensions router. ONLY the SQL moved; the route keeps ALL
 * security/orchestration: manifest validation (validateManifest), SSRF guards,
 * minHostLevel/compliance enforcement, sideload consent/owner/egress guards,
 * sandbox worker calls (terminateWorker), tool-set cache invalidation, audit,
 * analytics, and SKILL.md parsing. Workspace scoping is preserved verbatim
 * (every read/write filters on workspaceId; ownership checks stay in the route).
 *
 * The install transaction moved here whole: it is pure DB work (the row
 * inserts for the extension + its behavior-rule/prompt/context artifacts share
 * one tx and their non-fatal logging is intrinsic to the DB writes). The route
 * keeps every pre-/post-transaction side-effect.
 */
import { db, eq, and, sql } from '@plexo/db'
import {
    extensions,
    workspaces,
    extensionPrompts,
    extensionContexts,
    extensionRegistry,
} from '@plexo/db'
import { logger } from '../logger.js'
import type { ExtensionManifest } from '@joeybuilt/plexo-sdk'

type ExtensionRow = typeof extensions.$inferSelect

// ── reads ──────────────────────────────────────────────────────────────────

/** List installed extensions for a workspace, optional type filter, paginated. */
export async function listExtensions(workspaceId: string, type: string | undefined, limit: number, offset: number): Promise<ExtensionRow[]> {
    const conditions = [eq(extensions.workspaceId, workspaceId)]
    if (type) {
        conditions.push(eq(extensions.type, type as any))
    }

    return db
        .select()
        .from(extensions)
        .where(and(...conditions))
        .orderBy(extensions.installedAt)
        .limit(limit)
        .offset(offset)
}

/** Full extension row by ID. */
export async function getExtensionById(id: string): Promise<ExtensionRow | undefined> {
    const [plugin] = await db.select().from(extensions).where(eq(extensions.id, id)).limit(1)
    return plugin
}

/** Registry row name lookup by exact name (catalog detection). */
export async function getRegistryRowByName(name: string): Promise<{ name: string } | undefined> {
    const [registryRow] = await db
        .select({ name: extensionRegistry.name })
        .from(extensionRegistry)
        .where(eq(extensionRegistry.name, name))
        .limit(1)
    return registryRow
}

/** Registry manifest lookup by exact name (upgrade source). */
export async function getRegistryManifestByName(name: string): Promise<{ manifest: unknown } | undefined> {
    const [registryRow] = await db
        .select({ manifest: extensionRegistry.manifest })
        .from(extensionRegistry)
        .where(eq(extensionRegistry.name, name))
        .limit(1)
    return registryRow
}

/** Workspace existence by ID. */
export async function getWorkspaceId(workspaceId: string): Promise<{ id: string } | undefined> {
    const [ws] = await db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1)
    return ws
}

/** Duplicate-name check scoped to a workspace. */
export async function getExtensionByWorkspaceAndName(workspaceId: string, name: string): Promise<{ id: string } | undefined> {
    const [existing] = await db.select({ id: extensions.id }).from(extensions)
        .where(and(eq(extensions.workspaceId, workspaceId), eq(extensions.name, name)))
        .limit(1)
    return existing
}

/** Invoke lookup: minimal extension columns scoped by (workspaceId, name). */
export async function getExtensionForInvoke(workspaceId: string, extensionName: string) {
    const [ext] = await db
        .select({ id: extensions.id, name: extensions.name, entry: extensions.entry, enabled: extensions.enabled, manifest: extensions.manifest, settings: extensions.settings })
        .from(extensions)
        .where(and(eq(extensions.workspaceId, workspaceId), eq(extensions.name, extensionName)))
        .limit(1)
    return ext
}

// ── install (POST /) ─────────────────────────────────────────────────────────

/**
 * Install transaction — inserts the extension row plus any behavior-rule,
 * prompt, and context artifacts declared in the manifest. Returns the inserted
 * extension row (throws if the primary insert returns nothing).
 */
export async function installExtensionTx(workspaceId: string, m: ExtensionManifest, settings: Record<string, unknown>): Promise<ExtensionRow> {
    return db.transaction(async (tx) => {
        const [ext] = await tx.insert(extensions).values({
            workspaceId,
            name: m.name,
            version: m.version,
            type: m.type,
            pexVersion: m.plexo ?? '0.4.0',
            entry: m.entry,
            manifest: m as object,
            enabled: false,      // always starts disabled (§9.1 — activate called on enable)
            settings,
        }).returning()

        if (!ext) throw new Error('Insert returned no data')

        // §5d: Auto-register behavior rules from tool manifest
        if (m.behaviorRules && m.behaviorRules.length > 0) {
            const { behaviorRules: dbBehaviorRules } = await import('@plexo/db')
            const rulesToInsert = m.behaviorRules.map((rule) => ({
                workspaceId,
                projectId: null,
                type: rule.type,
                key: rule.key,
                label: rule.label,
                description: rule.description,
                value: rule.defaultValue,
                locked: rule.locked,
                source: 'workspace' as const,
                tags: [`extension:${ext.id}`],
            }))
            await tx.insert(dbBehaviorRules).values(rulesToInsert)
        }

        // §7.6: Extract prompt artifacts from tool manifest and persist (disabled by default)
        if (m.prompts && Array.isArray(m.prompts) && m.prompts.length > 0) {
            try {
                const promptRows = m.prompts.map((p: any) => ({
                    workspaceId,
                    extensionName: m.name,
                    promptId: String(p.id),
                    name: String(p.name ?? ''),
                    description: String(p.description ?? ''),
                    template: String(p.template ?? ''),
                    variables: (p.variables ?? []) as object,
                    tags: Array.isArray(p.tags) ? p.tags.map(String) : [],
                    version: String(p.version ?? '1.0.0'),
                    priority: (['low', 'normal', 'high', 'critical'].includes(String(p.priority)) ? String(p.priority) : 'normal') as 'low' | 'normal' | 'high' | 'critical',
                    dependencies: Array.isArray(p.dependencies) ? p.dependencies.map(String) : [],
                    enabled: false,
                }))
                await tx.insert(extensionPrompts).values(promptRows).onConflictDoNothing()
                logger.info({ extensionName: m.name, count: promptRows.length }, 'Extracted prompt artifacts from tool')
            } catch (promptErr) {
                logger.warn({ err: promptErr, extensionName: m.name }, 'Failed to extract prompt artifacts from tool — non-fatal')
            }
        }

        // §7.7: Extract context artifacts from tool manifest and persist (disabled by default)
        if (m.contexts && Array.isArray(m.contexts) && m.contexts.length > 0) {
            try {
                const contextRows = m.contexts.slice(0, 10).map((c: any) => ({
                    workspaceId,
                    extensionName: m.name,
                    contextId: String(c.id),
                    name: String(c.name ?? ''),
                    description: String(c.description ?? ''),
                    content: String(c.content ?? '').slice(0, 50_000),
                    contentType: String(c.contentType ?? 'text/plain'),
                    priority: (['low', 'normal', 'high', 'critical'].includes(String(c.priority)) ? String(c.priority) : 'normal') as 'low' | 'normal' | 'high' | 'critical',
                    ttl: typeof c.ttl === 'number' ? c.ttl : null,
                    tags: Array.isArray(c.tags) ? c.tags.map(String).slice(0, 10) : [],
                    estimatedTokens: typeof c.estimatedTokens === 'number' ? c.estimatedTokens : null,
                    enabled: false, // disabled by default — user opts in
                }))
                await tx.insert(extensionContexts).values(contextRows).onConflictDoNothing()
                logger.info({ extensionName: m.name, count: contextRows.length }, 'Extracted context artifacts from tool')
            } catch (contextErr) {
                logger.warn({ err: contextErr, extensionName: m.name }, 'Failed to extract context artifacts from tool — non-fatal')
            }
        }

        return ext
    })
}

// ── sideload (POST /sideload) ─────────────────────────────────────────────────

/** Insert a sideloaded extension row; returns the inserted row. */
export async function insertSideloadedExtension(params: {
    workspaceId: string
    m: ExtensionManifest
    sideloadedManifest: object
    settings: Record<string, unknown>
}): Promise<ExtensionRow | undefined> {
    const { workspaceId, m, sideloadedManifest, settings } = params
    const [inserted] = await db.insert(extensions).values({
        workspaceId,
        name: m.name,
        version: m.version,
        type: m.type as any,
        pexVersion: m.plexo ?? '0.4.0',
        entry: m.entry,
        manifest: sideloadedManifest as object,
        enabled: false,
        settings,
        source: 'sideloaded' as any,
    }).returning()
    return inserted
}

// ── skill (POST /skill) ───────────────────────────────────────────────────────

/** Insert a SKILL.md-sourced extension row; returns the inserted row. */
export async function insertSkillExtension(params: {
    workspaceId: string
    manifest: { name: string; version: string; type: string; entry: string } & Record<string, unknown>
    settings: Record<string, unknown>
    skillPath: string | null
    skillContent: string
    skillFrontmatter: object
}): Promise<ExtensionRow | undefined> {
    const { workspaceId, manifest, settings, skillPath, skillContent, skillFrontmatter } = params
    const [inserted] = await db.insert(extensions).values({
        workspaceId,
        name: manifest.name,
        version: manifest.version,
        type: manifest.type as 'skill',
        pexVersion: '0.4.0',
        entry: manifest.entry,
        manifest: manifest as object,
        enabled: false,
        settings,
        source: 'skillmd',
        skillPath,
        skillContent,
        skillFrontmatter,
    }).returning()
    return inserted
}

// ── skill/install-url (POST /skill/install-url) ───────────────────────────────

/** Insert a SKILL.md-from-URL extension row; returns the inserted row. */
export async function insertSkillUrlExtension(params: {
    workspaceId: string
    manifest: { name: string; version: string; type: string; entry: string } & Record<string, unknown>
    skillPath: string
    skillContent: string
    skillFrontmatter: object
}): Promise<ExtensionRow | undefined> {
    const { workspaceId, manifest, skillPath, skillContent, skillFrontmatter } = params
    const [inserted] = await db.insert(extensions).values({
        workspaceId,
        name: manifest.name,
        version: manifest.version,
        type: manifest.type as 'skill',
        pexVersion: '0.4.0',
        entry: manifest.entry,
        manifest: manifest as object,
        enabled: false,
        source: 'skillmd',
        skillPath,
        skillContent,
        skillFrontmatter,
    }).returning()
    return inserted
}

// ── patch (PATCH /:id) ────────────────────────────────────────────────────────

/** Full extension row by ID (toggle/settings read). */
export async function getFullExtensionById(id: string): Promise<ExtensionRow | undefined> {
    const [existing] = await db.select().from(extensions).where(eq(extensions.id, id)).limit(1)
    return existing
}

/** Apply an update set to an extension by ID. */
export async function updateExtension(id: string, update: Record<string, unknown>): Promise<void> {
    await db.update(extensions).set(update).where(eq(extensions.id, id))
}

// ── upgrade (PUT /:id/upgrade) ────────────────────────────────────────────────

/** Update extension version/manifest on upgrade (settings preserved). */
export async function updateExtensionForUpgrade(id: string, set: {
    version: string
    pexVersion: string
    entry: string
    manifest: object
}): Promise<void> {
    await db.update(extensions)
        .set({
            version: set.version,
            pexVersion: set.pexVersion,
            entry: set.entry,
            manifest: set.manifest,
            // settings is intentionally NOT overwritten — user config preserved
        })
        .where(eq(extensions.id, id))
}

// ── delete (DELETE /:id) ──────────────────────────────────────────────────────

/** Minimal extension row for delete (incl. workspaceId for ownership check). */
export async function getExtensionForDelete(id: string) {
    const [existing] = await db
        .select({ id: extensions.id, workspaceId: extensions.workspaceId, name: extensions.name, pexVersion: extensions.pexVersion })
        .from(extensions)
        .where(eq(extensions.id, id))
        .limit(1)
    return existing
}

/** Delete an extension row by ID. */
export async function deleteExtension(id: string): Promise<void> {
    await db.delete(extensions).where(eq(extensions.id, id))
}

/** Soft-delete behavior rules tagged for the given extension ID, scoped to workspace. */
export async function softDeleteBehaviorRules(workspaceId: string, extensionTag: string): Promise<void> {
    await db.execute(sql`
        UPDATE behavior_rules
        SET deleted_at = NOW()
        WHERE workspace_id = ${workspaceId}
          AND ${extensionTag} = ANY(tags)
          AND deleted_at IS NULL
    `)
}

/** Soft-delete prompts + context blocks for an extension name, scoped to workspace. */
export async function softDeletePromptsAndContexts(workspaceId: string, extensionName: string): Promise<void> {
    await db.execute(sql`
        UPDATE extension_prompts
        SET deleted_at = NOW()
        WHERE workspace_id = ${workspaceId}
          AND extension_name = ${extensionName}
          AND deleted_at IS NULL
    `)
    await db.execute(sql`
        UPDATE extension_contexts
        SET deleted_at = NOW()
        WHERE workspace_id = ${workspaceId}
          AND extension_name = ${extensionName}
          AND deleted_at IS NULL
    `)
}
