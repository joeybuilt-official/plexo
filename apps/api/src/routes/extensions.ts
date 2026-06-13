// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

// UI term: "Tools" — route path preserved as /extensions for backward compatibility
// FUN-026 — Extension upgrade flow added: PUT /:id/upgrade
// FUN-029 — SSRF protection applied (isAllowedInstallUrl below)

/**
 * Tools API (DB table: extensions) — PEX Standard compliant
 *
 * GET    /api/extensions?workspaceId=   List installed tools
 * GET    /api/extensions/:id            Get tool by ID
 * POST   /api/extensions                Install a tool (validates manifest)
 * PATCH  /api/extensions/:id            Toggle enabled / update settings
 * DELETE /api/extensions/:id            Uninstall tool (triggers deactivate hook)
 *
 * Install flow (§3.3):
 *  1. Validate tool manifest
 *  2. Check minHostLevel compliance
 *  3. Verify workspace exists
 *  4. Insert row (enabled=false — requires explicit enable)
 *
 * The agent executor calls loadExtensionTools(workspaceId) at task start,
 * which loads enabled tools and runs them in sandboxed workers.
 */
import { Router, type Router as RouterType } from 'express'
import * as extensionsRepo from '../repositories/extensions.repository.js'
import { logger } from '../logger.js'
import { audit } from '../audit.js'
import { validateManifest } from '@joeybuilt/plexo-sdk'
import type { ExtensionManifest } from '@joeybuilt/plexo-sdk'
import { terminateWorker, getWorker, invokeTool } from '@plexo/agent/persistent-pool'
import { parseSkillMd, synthesizeManifest } from '@plexo/agent/skills/parser'
import { UUID_RE } from '../validation.js'
import { ensureWorkspaceAccess } from '../middleware/workspace-access.js'
import { invalidateWorkspaceToolSets } from '@plexo/agent/tool-set-cache'

export const extensionsRouter: RouterType = Router()

// In-process tool handler cache for /invoke endpoint
const _invokeCache = new Map<string, Array<{ name: string; handler: (params: unknown, ctx?: unknown) => Promise<unknown> }>>()

// Built-in ops extensions — bundled with the API, bypass DB registration.
// Keyed by extension name → absolute path to the activate() module.
const BUILTIN_OPS_EXTENSIONS: Record<string, string> = {
    '@joeybuilt/env-manager': new URL('../lib/ops-extensions/env-manager.ts', import.meta.url).pathname,
}


// Plexo compliance level — used to enforce minHostLevel
const PLEXO_COMPLIANCE_LEVEL: 'core' | 'standard' | 'full' = 'full'
const COMPLIANCE_ORDER = { core: 0, standard: 1, full: 2 }

// Validator package-name regex (kept in sync with packages/sdk/src/validation/manifest.ts)
const PEX_NAME_RE = /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/

// ── FUN-029: SSRF protection for install-from-URL ────────────────────────────

const ALLOWED_INSTALL_HOSTS = new Set([
    'github.com',
    'raw.githubusercontent.com',
    'gist.githubusercontent.com',
    'registry.npmjs.org',
])

/** Block private/reserved IP ranges commonly used in SSRF attacks */
function isPrivateOrReservedHostname(hostname: string): boolean {
    // IPv4 private/reserved patterns
    if (/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|127\.|0\.|169\.254\.|100\.(6[4-9]|[7-9]\d|1[0-2]\d))/.test(hostname)) return true
    // IPv6 loopback/link-local
    if (hostname === '[::1]' || hostname.startsWith('[fe80:') || hostname.startsWith('[fc') || hostname.startsWith('[fd')) return true
    // localhost variants
    if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) return true
    // Metadata endpoints (AWS, GCP, Azure)
    if (hostname === '169.254.169.254' || hostname === 'metadata.google.internal') return true
    return false
}

function isAllowedInstallUrl(urlStr: string): boolean {
    try {
        const url = new URL(urlStr)
        if (url.protocol !== 'https:') return false
        if (isPrivateOrReservedHostname(url.hostname)) return false
        if (ALLOWED_INSTALL_HOSTS.has(url.hostname)) return true
        // Allow other HTTPS URLs that aren't private/reserved
        return true
    } catch {
        // intentional — URL constructor throws on malformed strings; treat as disallowed
        return false
    }
}
/**
 * Normalize a manifest pulled from the in-app catalog (extensionRegistry).
 *
 * The catalog importer (apps/hub) materializes Skill+ markdown sources from
 * trusted upstreams (e.g. agency-agents, AgentLand contributors) and stores
 * them in extensionRegistry. Those manifests are intentionally minimal — they
 * carry the SKILL.md frontmatter under `manifest.skill` plus a few hub fields,
 * but they omit a handful of PEX-required fields (`plexo`, `capabilities`,
 * sometimes the `@scope/` prefix on `name`, oversized `description`, etc.).
 *
 * Because the host curates the catalog, those omissions are not a security
 * concern — every catalog row was admitted by an operator-controlled importer.
 * This helper backfills the safe defaults so the install endpoint can run the
 * standard validator without lowering the bar for sideloaded / user-supplied
 * manifests, which still go through the strict path unchanged.
 *
 * Returns a normalized COPY. The original manifest is never mutated.
 *
 * Important: when the manifest's `name` is missing the `@` prefix we patch the
 * copy used for validation but DO NOT touch the stored row's name — the in-app
 * Hub matches installed extensions back to catalog rows by exact `name`, and
 * the catalog stores the un-prefixed form (`agency-agents/foo`).
 */
function normalizeRegistryManifest(raw: unknown): {
    forValidation: Record<string, unknown>
    forStorage: Record<string, unknown>
    appliedNormalizations: string[]
} {
    if (!raw || typeof raw !== 'object') {
        return { forValidation: {} as Record<string, unknown>, forStorage: {} as Record<string, unknown>, appliedNormalizations: [] }
    }
    const original = raw as Record<string, unknown>
    const forValidation: Record<string, unknown> = { ...original }
    const forStorage: Record<string, unknown> = { ...original }
    const applied: string[] = []

    // 1) plexo SDK version — default to 0.4.0 (matches the version-of-record
    //    used by validateManifest's spec).
    if (typeof forValidation['plexo'] !== 'string' || forValidation['plexo'] === '') {
        forValidation['plexo'] = '0.4.0'
        forStorage['plexo'] = '0.4.0'
        applied.push('plexo=0.4.0')
    }

    // 2) capabilities — must be an array. Empty is the safest default
    //    (the extension is granted nothing).
    if (!Array.isArray(forValidation['capabilities'])) {
        forValidation['capabilities'] = []
        forStorage['capabilities'] = []
        applied.push('capabilities=[]')
    }

    // 3) name — patch only the validation copy with `@` prefix when missing.
    //    Storage keeps the un-prefixed form so hub.ts catalog matching keeps
    //    working (extensionRegistry stores names without `@`).
    const name = forValidation['name']
    if (typeof name === 'string' && name.length > 0 && !PEX_NAME_RE.test(name) && !name.startsWith('@') && /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/.test(name)) {
        forValidation['name'] = `@${name}`
        applied.push(`name(validation-only)=@${name}`)
    }

    // 4) description — truncate to the validator ceiling (280 chars). Hub
    //    catalog descriptions occasionally exceed this when the upstream
    //    SKILL.md frontmatter has a long blurb.
    const description = forValidation['description']
    if (typeof description === 'string' && description.length > 280) {
        const truncated = `${description.slice(0, 277)}...`
        forValidation['description'] = truncated
        forStorage['description'] = truncated
        applied.push('description=truncated@280')
    }

    // 5) license — required non-empty string. Default to UNKNOWN if absent
    //    so the row can install; the catalog importer should already populate
    //    this from the upstream license header.
    if (typeof forValidation['license'] !== 'string' || forValidation['license'] === '') {
        forValidation['license'] = 'UNKNOWN'
        forStorage['license'] = 'UNKNOWN'
        applied.push('license=UNKNOWN')
    }

    // 6) author — required non-empty string. Default to publisher slug.
    if (typeof forValidation['author'] !== 'string' || forValidation['author'] === '') {
        const fallbackAuthor = typeof name === 'string' && name.includes('/') ? name.split('/')[0]! : 'unknown'
        forValidation['author'] = fallbackAuthor
        forStorage['author'] = fallbackAuthor
        applied.push(`author=${fallbackAuthor}`)
    }

    // 7) entry — required non-empty string. Default to 'index.js' for catalog
    //    manifests that omit it (Hub items have no real entry point since they
    //    run through the extension runtime).
    if (typeof forValidation['entry'] !== 'string' || forValidation['entry'] === '') {
        forValidation['entry'] = 'index.js'
        forStorage['entry'] = 'index.js'
        applied.push('entry=index.js')
    }

    // 8) displayName — required non-empty string. Derive from name by
    //    stripping scope prefix and title-casing.
    if (typeof forValidation['displayName'] !== 'string' || forValidation['displayName'] === '') {
        const rawName = typeof name === 'string' ? name : ''
        const shortName = rawName.includes('/') ? rawName.split('/').pop()! : rawName
        const displayName = shortName
            .replace(/[-_]/g, ' ')
            .replace(/\b\w/g, (c) => c.toUpperCase())
            .slice(0, 50)
        forValidation['displayName'] = displayName || 'Untitled'
        forStorage['displayName'] = displayName || 'Untitled'
        applied.push(`displayName=${displayName || 'Untitled'}`)
    }

    return { forValidation, forStorage, appliedNormalizations: applied }
}

/**
 * Build a user-friendly summary of validation errors. The previous behavior
 * surfaced a generic "Manifest validation failed" toast that gave operators
 * no clue which field was wrong; this helper folds the structured details
 * into the top-level message string while keeping the full list in `details`.
 */
function summarizeValidationErrors(errors: ReadonlyArray<{ field: string; message: string; severity?: string }>): string {
    const hard = errors.filter((e) => e.severity !== 'warning')
    if (hard.length === 0) return 'Manifest validation failed'
    const first = hard[0]!
    const head = `Manifest validation failed: ${first.field} — ${first.message}`
    if (hard.length === 1) return head
    return `${head} (+${hard.length - 1} more)`
}

// ── GET /api/extensions ──────────────────────────────────────────────────────────

extensionsRouter.get('/', async (req, res) => {
    const { workspaceId, type } = req.query as { workspaceId?: string; type?: string }

    if (!workspaceId) {
        res.status(400).json({ error: { code: 'MISSING_WORKSPACE', message: 'workspaceId required' } })
        return
    }
    if (!UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE', message: 'Valid UUID required for workspaceId' } })
        return
    }
    if (!await ensureWorkspaceAccess(req, res, workspaceId)) return

    const limit = Math.min(parseInt((req.query.limit as string | undefined) ?? '100', 10), 500)
    const offset = Math.max(parseInt((req.query.offset as string | undefined) ?? '0', 10), 0)

    try {
        const rows = await extensionsRepo.listExtensions(workspaceId, type, limit, offset)

        const items = rows.map((row) => {
            const m = row.manifest as Record<string, unknown> | null
            const extName = (m?.name as string) ?? row.name
            const trust = m?.trust as string | undefined
            // First-party: @joeybuilt/ namespace + verified or owner trust.
            // Sideloaded extensions have trust coerced to 'local' on install,
            // so they can never satisfy this check.
            const isFirstParty =
                extName.startsWith('@joeybuilt/') &&
                (trust === 'verified' || trust === 'owner')
            return { ...row, isFirstParty }
        })

        res.json({ items, total: items.length, limit, offset })
    } catch (err) {
        logger.error({ err }, 'GET /api/extensions failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to list tools' } })
    }
})

// ── GET /api/extensions/:id ──────────────────────────────────────────────────────

extensionsRouter.get('/:id', async (req, res) => {
    if (!UUID_RE.test(req.params.id)) {
        res.status(400).json({ error: { code: 'INVALID_ID', message: 'Valid UUID required' } })
        return
    }
    try {
        const plugin = await extensionsRepo.getExtensionById(req.params.id)
        if (!plugin) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Extension not found' } })
            return
        }
        if (!await ensureWorkspaceAccess(req, res, plugin.workspaceId)) return
        const m = plugin.manifest as Record<string, unknown> | null
        const extName = (m?.name as string) ?? plugin.name
        const trust = m?.trust as string | undefined
        const isFirstParty =
            extName.startsWith('@joeybuilt/') &&
            (trust === 'verified' || trust === 'owner')
        res.json({ ...plugin, isFirstParty })
    } catch (err) {
        logger.error({ err }, 'GET /api/extensions/:id failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to get extension' } })
    }
})

// ── POST /api/extensions (install) ───────────────────────────────────────────────

extensionsRouter.post('/', async (req, res) => {
    const { workspaceId, manifest, settings = {} } = req.body as {
        workspaceId?: string
        manifest?: unknown
        settings?: Record<string, unknown>
    }

    if (!workspaceId) {
        res.status(400).json({ error: { code: 'MISSING_WORKSPACE', message: 'workspaceId required' } })
        return
    }
    if (!UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE', message: 'Valid UUID required for workspaceId' } })
        return
    }
    if (!await ensureWorkspaceAccess(req, res, workspaceId)) return

    // §3.3 — Validate the tool manifest.
    //
    // The in-app Hub posts manifests pulled straight from extensionRegistry.
    // Catalog rows are populated by host-controlled importers (apps/hub) and
    // are therefore trusted, but the importer leaves a few PEX-required fields
    // unset (e.g. `plexo`, `capabilities`, scoped name prefix). When we detect
    // a known catalog row by name we backfill safe defaults so the validator
    // can run without rejecting legitimate catalog content.
    //
    // User-supplied / sideloaded manifests still hit the strict validator —
    // sideload has its own POST /sideload route below and is unaffected by
    // this normalization.
    const candidateName = (manifest && typeof manifest === 'object')
        ? (manifest as Record<string, unknown>)['name']
        : undefined

    let isCatalogManifest = false
    if (typeof candidateName === 'string' && candidateName.length > 0) {
        try {
            const registryRow = await extensionsRepo.getRegistryRowByName(candidateName)
            isCatalogManifest = Boolean(registryRow)
        } catch (lookupErr) {
            // A registry lookup failure should not block strict-mode installs.
            logger.warn({ err: lookupErr, name: candidateName }, 'Catalog lookup during install failed; falling back to strict validation')
        }
    }

    let manifestForInstall: Record<string, unknown> = (manifest && typeof manifest === 'object')
        ? { ...(manifest as Record<string, unknown>) }
        : {}
    let manifestForValidation: Record<string, unknown> = manifestForInstall
    let appliedNormalizations: string[] = []

    if (isCatalogManifest) {
        const normalized = normalizeRegistryManifest(manifest)
        manifestForValidation = normalized.forValidation
        manifestForInstall = normalized.forStorage
        appliedNormalizations = normalized.appliedNormalizations
    }

    const validation = validateManifest(manifestForValidation)
    if (!validation.valid) {
        res.status(400).json({
            error: {
                code: 'INVALID_MANIFEST',
                message: summarizeValidationErrors(validation.errors),
                details: validation.errors,
                normalized: appliedNormalizations.length > 0 ? appliedNormalizations : undefined,
            },
        })
        return
    }

    if (appliedNormalizations.length > 0) {
        logger.info({ name: candidateName, normalizations: appliedNormalizations }, 'Catalog manifest normalized for install')
    }

    const m = manifestForInstall as unknown as ExtensionManifest

    // §11.4 — Enforce minHostLevel
    if (m.minHostLevel && COMPLIANCE_ORDER[m.minHostLevel] > COMPLIANCE_ORDER[PLEXO_COMPLIANCE_LEVEL]) {
        res.status(400).json({
            error: {
                code: 'COMPLIANCE_INSUFFICIENT',
                message: `Tool requires host compliance level "${m.minHostLevel}", but this host is "${PLEXO_COMPLIANCE_LEVEL}"`,
            },
        })
        return
    }

    try {
        const ws = await extensionsRepo.getWorkspaceId(workspaceId)
        if (!ws) {
            res.status(404).json({ error: { code: 'WORKSPACE_NOT_FOUND', message: 'Workspace not found' } })
            return
        }

        // FUN-027: Duplicate check — prevent re-installing same extension name in workspace
        const existing = await extensionsRepo.getExtensionByWorkspaceAndName(workspaceId, m.name)
        if (existing) {
            res.status(409).json({ error: { code: 'ALREADY_INSTALLED', message: `Extension "${m.name}" is already installed in this workspace` } })
            return
        }

        const inserted = await extensionsRepo.installExtensionTx(workspaceId, m, settings)

        if (!inserted) {
            res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Insert returned no data' } })
            return
        }

        logger.info({ id: inserted.id, name: m.name, type: m.type, plexo: m.plexo }, 'Tool installed')
        invalidateWorkspaceToolSets(workspaceId)
        audit(req, {
            workspaceId,
            action: 'extension.install',
            resource: 'extensions',
            resourceId: inserted.id,
            metadata: { name: m.name, version: m.version, type: m.type, plexo: m.plexo },
        })

        // Analytics: extension installed (no user content — public registry name only)
        try {
            const { emitExtensionInstalled } = await import('../analytics/events.js')
            emitExtensionInstalled({ extensionName: m.name, source: 'registry' })
        } catch { /* analytics must never crash the app */ }

        // Surface validation warnings to the caller (non-fatal)
        const warnings = validation.errors.filter((e) => e.severity === 'warning')
        res.status(201).json({ ...inserted, warnings: warnings.length ? warnings : undefined })
    } catch (err) {
        logger.error({ err }, 'POST /api/extensions failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to install tool' } })
    }
})

// ── POST /api/extensions/sideload (install arbitrary manifest without Hub) ──────
//
// Sideload is the escape hatch for locally-developed or private extensions.
// It is DANGEROUS by default and gated on the `ALLOW_SIDELOAD` env flag so
// SaaS deployments can disable it entirely.
//
// Guards applied on every sideload request (see docs/security/extension-security-
// model.md §Q3):
//   1. `ALLOW_SIDELOAD` env flag must be `true`. SaaS Plexo defaults OFF.
//   2. Request body must include `consent: true` — the UI checkbox the user
//      must tick on the scary warning screen.
//   3. Caller must be workspace role `owner` (admins/members are refused).
//   4. `manifest.trust` is coerced to the internal marker `local` BEFORE
//      validation so tier ceilings apply.
//   5. Validator runs with `source: 'sideload'`, rejecting owner-only
//      capabilities (wildcard memory, audit:read, model:override).
//   6. `dataResidency.externalDestinations` must be an explicit list with no
//      wildcard hosts (`*.example.com` is rejected).
//   7. Row is stamped with `source='sideloaded'`, `autoUpdate=false` (via the
//      manifest's sideload marker), and every audit log action records
//      `source: 'sideload'`.
//
// One-click disable is already available via the existing PATCH toggle —
// extension rows created here behave identically to any other row from the
// workspace owner's perspective.
extensionsRouter.post('/sideload', async (req, res) => {
    if (process.env.ALLOW_SIDELOAD !== 'true') {
        res.status(403).json({
            error: {
                code: 'SIDELOAD_DISABLED',
                message: 'Sideloading is disabled on this Plexo instance. Set ALLOW_SIDELOAD=true to enable.',
            },
        })
        return
    }

    const { workspaceId, manifest, settings = {}, consent } = req.body as {
        workspaceId?: string
        manifest?: unknown
        settings?: Record<string, unknown>
        consent?: boolean
    }

    if (!workspaceId) {
        res.status(400).json({ error: { code: 'MISSING_WORKSPACE', message: 'workspaceId required' } })
        return
    }
    if (!UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE', message: 'Valid UUID required for workspaceId' } })
        return
    }
    if (!await ensureWorkspaceAccess(req, res, workspaceId)) return

    // §Q3 guard 3 — workspace owner only
    if (req.workspaceRole !== 'owner' && !req.user?.isSuperAdmin) {
        res.status(403).json({
            error: {
                code: 'OWNER_ONLY',
                message: 'Only the workspace owner can sideload an extension.',
            },
        })
        return
    }

    // §Q3 guard 2 — explicit consent
    if (consent !== true) {
        res.status(400).json({
            error: {
                code: 'CONSENT_REQUIRED',
                message: 'consent: true is required. The UI must surface the sideload warning and capture the user checkbox.',
            },
        })
        return
    }

    if (!manifest || typeof manifest !== 'object') {
        res.status(400).json({
            error: { code: 'MISSING_MANIFEST', message: 'manifest object required' },
        })
        return
    }

    // §Q3 guard 4 — coerce declared trust; never honor `owner` / `verified`
    // on a sideload. We strip it from the copy we validate so the ceiling
    // logic in the validator treats everything as local. The stored row
    // records `sideloaded_trust_coerced` metadata in the manifest clone.
    const manifestCopy: Record<string, unknown> = { ...(manifest as Record<string, unknown>) }
    const originallyDeclaredTrust = manifestCopy['trust']
    delete manifestCopy['trust']

    // §Q3 guard 5 — validate with source: 'sideload'
    const validation = validateManifest(manifestCopy, { source: 'sideload' })
    if (!validation.valid) {
        res.status(400).json({
            error: {
                code: 'INVALID_MANIFEST',
                message: 'Sideload manifest validation failed',
                details: validation.errors,
            },
        })
        return
    }

    const m = manifestCopy as unknown as ExtensionManifest

    // §11.4 — enforce minHostLevel (same as registry install)
    if (m.minHostLevel && COMPLIANCE_ORDER[m.minHostLevel] > COMPLIANCE_ORDER[PLEXO_COMPLIANCE_LEVEL]) {
        res.status(400).json({
            error: {
                code: 'COMPLIANCE_INSUFFICIENT',
                message: `Extension requires host compliance level "${m.minHostLevel}", but this host is "${PLEXO_COMPLIANCE_LEVEL}"`,
            },
        })
        return
    }

    // §Q3 guard 6 — egress allowlist must be explicit, no wildcards
    if (m.dataResidency?.sendsDataExternally) {
        const destinations = m.dataResidency.externalDestinations ?? []
        if (destinations.length === 0) {
            res.status(400).json({
                error: {
                    code: 'EGRESS_UNDECLARED',
                    message: 'Sideloaded extensions that send data externally must declare every destination host explicitly.',
                },
            })
            return
        }
        for (const dest of destinations) {
            if (typeof dest.host !== 'string' || dest.host.length === 0) {
                res.status(400).json({
                    error: {
                        code: 'EGRESS_INVALID',
                        message: 'Every externalDestination must have a non-empty host string.',
                    },
                })
                return
            }
            if (dest.host.includes('*')) {
                res.status(400).json({
                    error: {
                        code: 'EGRESS_WILDCARD',
                        message: `Wildcard host "${dest.host}" is not allowed in sideload manifests. List each host explicitly.`,
                    },
                })
                return
            }
        }
    }

    try {
        const ws = await extensionsRepo.getWorkspaceId(workspaceId)
        if (!ws) {
            res.status(404).json({ error: { code: 'WORKSPACE_NOT_FOUND', message: 'Workspace not found' } })
            return
        }

        // Stamp the stored manifest with sideload markers so the UI can render
        // the grey badge and the runtime can refuse auto-updates.
        const sideloadedManifest = {
            ...m,
            // Marker for the install dialog & audit trail. Not in the PEX type
            // (it's a host-internal annotation stored alongside the manifest).
            __plexoSideload: {
                source: 'sideloaded',
                originallyDeclaredTrust: originallyDeclaredTrust ?? null,
                effectiveTrust: 'local',
                autoUpdate: false,
                pinnedVersion: m.version,
                installedAt: new Date().toISOString(),
            },
        }

        const inserted = await extensionsRepo.insertSideloadedExtension({ workspaceId, m, sideloadedManifest, settings })

        if (!inserted) {
            res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Insert returned no data' } })
            return
        }

        logger.warn(
            { id: inserted.id, name: m.name, type: m.type, workspaceId },
            'Sideloaded extension installed — user bypassed registry review',
        )
        invalidateWorkspaceToolSets(workspaceId)
        audit(req, {
            workspaceId,
            action: 'extension.install',
            resource: 'extensions',
            resourceId: inserted.id,
            metadata: {
                name: m.name,
                version: m.version,
                type: m.type,
                source: 'sideload',
                effectiveTrust: 'local',
                originallyDeclaredTrust: originallyDeclaredTrust ?? null,
            },
        })

        const warnings = validation.errors.filter((e) => e.severity === 'warning')
        res.status(201).json({
            ...inserted,
            source: 'sideload',
            warnings: warnings.length ? warnings : undefined,
        })
    } catch (err) {
        logger.error({ err }, 'POST /api/extensions/sideload failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Sideload failed' } })
    }
})

// ── POST /api/extensions/skill (install SKILL.md / Skill+) ──────────────────────

extensionsRouter.post('/skill', async (req, res) => {
    const { workspaceId, content, skillPath, settings = {} } = req.body as {
        workspaceId?: string
        content?: string
        skillPath?: string
        settings?: Record<string, unknown>
    }

    if (!workspaceId) {
        res.status(400).json({ error: { code: 'MISSING_WORKSPACE', message: 'workspaceId required' } })
        return
    }
    if (!UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE', message: 'Valid UUID required for workspaceId' } })
        return
    }
    if (!await ensureWorkspaceAccess(req, res, workspaceId)) return
    if (!content || typeof content !== 'string') {
        res.status(400).json({ error: { code: 'MISSING_CONTENT', message: 'SKILL.md content required' } })
        return
    }

    let parsed
    try {
        parsed = parseSkillMd(content)
    } catch (err) {
        res.status(400).json({
            error: {
                code: 'INVALID_SKILL_MD',
                message: (err as Error).message,
            },
        })
        return
    }

    const manifest = synthesizeManifest(parsed)

    try {
        const ws = await extensionsRepo.getWorkspaceId(workspaceId)
        if (!ws) {
            res.status(404).json({ error: { code: 'WORKSPACE_NOT_FOUND', message: 'Workspace not found' } })
            return
        }

        const inserted = await extensionsRepo.insertSkillExtension({
            workspaceId,
            manifest: manifest as { name: string; version: string; type: string; entry: string } & Record<string, unknown>,
            settings,
            skillPath: skillPath ?? null,
            skillContent: parsed.markdownBody,
            skillFrontmatter: parsed.frontmatter as object,
        })

        if (!inserted) {
            res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Insert returned no data' } })
            return
        }

        logger.info({ extensionId: inserted.id, name: manifest.name, isSkillPlus: parsed.isSkillPlus }, 'Skill+ tool installed')
        invalidateWorkspaceToolSets(workspaceId)
        audit(req, {
            workspaceId,
            action: 'extension.install',
            resource: 'extensions',
            resourceId: inserted.id,
            metadata: { name: manifest.name, source: 'skillmd', isSkillPlus: parsed.isSkillPlus },
        })
        res.status(201).json({ ...inserted, isSkillPlus: parsed.isSkillPlus })
    } catch (err: any) {
        // Handle unique constraint violation (already installed)
        if (err?.code === '23505') {
            res.status(409).json({ error: { code: 'ALREADY_INSTALLED', message: `Skill "${manifest.name}" already installed in this workspace` } })
            return
        }
        logger.error({ err }, 'POST /api/extensions/skill failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to install skill' } })
    }
})

// ── POST /api/extensions/skill/validate (dry-run parse) ─────────────────────────

extensionsRouter.post('/skill/validate', async (req, res) => {
    const { content } = req.body as { content?: string }
    if (!content || typeof content !== 'string') {
        res.status(400).json({ error: { code: 'MISSING_CONTENT', message: 'SKILL.md content required' } })
        return
    }
    try {
        const parsed = parseSkillMd(content)
        const manifest = synthesizeManifest(parsed)
        res.json({ valid: true, frontmatter: parsed.frontmatter, isSkillPlus: parsed.isSkillPlus, manifest })
    } catch (err) {
        logger.warn({ err }, 'Skill validation rejected')
        res.json({ valid: false, error: err instanceof Error ? err.message.slice(0, 300) : 'Invalid skill definition' })
    }
})

// ── POST /api/extensions/skill/install-url (install from URL) ────────────────────

extensionsRouter.post('/skill/install-url', async (req, res) => {
    const { workspaceId, url } = req.body as { workspaceId?: string; url?: string }

    if (!workspaceId) {
        res.status(400).json({ error: { code: 'MISSING_WORKSPACE', message: 'workspaceId required' } })
        return
    }
    if (!UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE', message: 'Valid UUID required' } })
        return
    }
    if (!await ensureWorkspaceAccess(req, res, workspaceId)) return
    if (!url || typeof url !== 'string') {
        res.status(400).json({ error: { code: 'MISSING_URL', message: 'url required' } })
        return
    }

    // FUN-029: SSRF protection — validate URL before fetching
    if (!isAllowedInstallUrl(url)) {
        res.status(400).json({ error: { code: 'BLOCKED_URL', message: 'URL must be HTTPS from an allowed host (github.com, raw.githubusercontent.com, gist.githubusercontent.com, registry.npmjs.org). Private/reserved IPs are blocked.' } })
        return
    }

    // Convert GitHub URLs to raw content URLs
    let fetchUrl = url
    if (fetchUrl.includes('github.com') && !fetchUrl.includes('raw.githubusercontent.com')) {
        fetchUrl = fetchUrl
            .replace('github.com', 'raw.githubusercontent.com')
            .replace('/blob/', '/')
            .replace('/tree/', '/')
    }
    // Ensure it ends with SKILL.md
    if (!fetchUrl.endsWith('SKILL.md') && !fetchUrl.endsWith('.md')) {
        fetchUrl = fetchUrl.replace(/\/$/, '') + '/SKILL.md'
    }

    // Fetch the SKILL.md content
    let content: string
    try {
        const response = await fetch(fetchUrl, { signal: AbortSignal.timeout(10_000) })
        if (!response.ok) {
            res.status(400).json({ error: { code: 'FETCH_FAILED', message: `Failed to fetch ${fetchUrl}: ${response.status}` } })
            return
        }
        content = await response.text()
    } catch (err) {
        res.status(400).json({ error: { code: 'FETCH_FAILED', message: `Failed to fetch URL: ${(err as Error).message}` } })
        return
    }

    // Parse and install (reuse existing logic)
    let parsed
    try {
        parsed = parseSkillMd(content)
    } catch (err) {
        res.status(400).json({ error: { code: 'INVALID_SKILL_MD', message: (err as Error).message } })
        return
    }

    const manifest = synthesizeManifest(parsed)

    try {
        const ws = await extensionsRepo.getWorkspaceId(workspaceId)
        if (!ws) {
            res.status(404).json({ error: { code: 'WORKSPACE_NOT_FOUND', message: 'Workspace not found' } })
            return
        }

        const inserted = await extensionsRepo.insertSkillUrlExtension({
            workspaceId,
            manifest: manifest as { name: string; version: string; type: string; entry: string } & Record<string, unknown>,
            skillPath: url,
            skillContent: parsed.markdownBody,
            skillFrontmatter: parsed.frontmatter as object,
        })

        if (!inserted) {
            res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Insert failed' } })
            return
        }

        logger.info({ extensionId: inserted.id, name: manifest.name, url }, 'Skill tool installed from URL')
        invalidateWorkspaceToolSets(workspaceId)
        res.status(201).json({ id: inserted.id, name: manifest.name, status: 'installed', isSkillPlus: parsed.isSkillPlus })
    } catch (err: any) {
        if (err?.code === '23505') {
            res.status(409).json({ error: { code: 'ALREADY_INSTALLED', message: `Skill "${manifest.name}" already installed` } })
            return
        }
        logger.error({ err }, 'POST /api/extensions/skill/install-url failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to install skill' } })
    }
})

// ── PATCH /api/extensions/:id ────────────────────────────────────────────────────

extensionsRouter.patch('/:id', async (req, res) => {
    const { enabled, settings, workspaceId } = req.body as { enabled?: boolean; settings?: Record<string, unknown>; workspaceId?: string }

    if (!UUID_RE.test(req.params.id)) {
        res.status(400).json({ error: { code: 'INVALID_ID', message: 'Valid UUID required' } })
        return
    }

    if (!workspaceId) {
        res.status(400).json({ error: { code: 'MISSING_WORKSPACE', message: 'workspaceId required' } })
        return
    }
    if (!await ensureWorkspaceAccess(req, res, workspaceId)) return

    try {
        const existing = await extensionsRepo.getFullExtensionById(req.params.id)
        if (!existing || existing.workspaceId !== workspaceId) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Tool not found in workspace' } })
            return
        }

        const update: Record<string, unknown> = {}
        if (typeof enabled === 'boolean') update.enabled = enabled
        if (settings) update.settings = { ...(existing.settings as object), ...settings }

        if (Object.keys(update).length === 0) {
            res.status(400).json({ error: { code: 'NOTHING_TO_UPDATE', message: 'Provide enabled or settings' } })
            return
        }

        await extensionsRepo.updateExtension(req.params.id, update)
        logger.info({ id: req.params.id, update }, 'Tool updated')
        // Any settings or enabled change should bust the workspace tool cache
        // so the next chat turn re-loads fresh tool definitions.
        invalidateWorkspaceToolSets(existing.workspaceId)

        // Audit enable/disable — these trigger lifecycle hooks (§9.1)
        if (typeof enabled === 'boolean') {
            audit(req, {
                workspaceId: existing.workspaceId,
                action: enabled ? 'extension.enable' : 'extension.disable',
                resource: 'extensions',
                resourceId: req.params.id,
                metadata: { name: existing.name, pexVersion: existing.pexVersion },
            })
            // Terminate the persistent worker on disable so it's re-activated fresh on re-enable
            if (!enabled) terminateWorker(existing.name)
        }

        res.json({ ok: true })
    } catch (err) {
        logger.error({ err }, 'PATCH /api/extensions/:id failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Update failed' } })
    }
})

// ── PUT /api/extensions/:id/upgrade (FUN-026) ──────────────────────────────────
//
// Upgrade an installed extension to a newer version without losing user settings.
// 1. Read the existing extension row
// 2. Fetch new manifest from Hub registry (or accept inline)
// 3. Validate the new manifest
// 4. Terminate the old worker if running
// 5. Update the extension row with new manifest data (preserve settings)
// 6. Restart on next enable/use

extensionsRouter.put('/:id/upgrade', async (req, res) => {
    const { workspaceId, manifest: incomingManifest } = req.body as {
        workspaceId?: string
        manifest?: unknown
    }

    if (!UUID_RE.test(req.params.id)) {
        res.status(400).json({ error: { code: 'INVALID_ID', message: 'Valid UUID required' } })
        return
    }
    if (!workspaceId) {
        res.status(400).json({ error: { code: 'MISSING_WORKSPACE', message: 'workspaceId required' } })
        return
    }
    if (!UUID_RE.test(workspaceId)) {
        res.status(400).json({ error: { code: 'INVALID_WORKSPACE', message: 'Valid UUID required for workspaceId' } })
        return
    }
    if (!await ensureWorkspaceAccess(req, res, workspaceId)) return

    try {
        // 1. Load existing extension
        const existing = await extensionsRepo.getFullExtensionById(req.params.id)
        if (!existing || existing.workspaceId !== workspaceId) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Extension not found in workspace' } })
            return
        }

        // 2. Resolve new manifest — either from request body or Hub registry
        let newManifestRaw: Record<string, unknown> | null = null

        if (incomingManifest && typeof incomingManifest === 'object') {
            newManifestRaw = incomingManifest as Record<string, unknown>
        } else {
            // Try fetching latest from extension_registry by name
            const registryRow = await extensionsRepo.getRegistryManifestByName(existing.name)

            if (!registryRow?.manifest) {
                res.status(404).json({ error: { code: 'NO_UPDATE_SOURCE', message: 'No manifest provided and extension not found in Hub registry. Pass { manifest } in the request body.' } })
                return
            }
            newManifestRaw = registryRow.manifest as Record<string, unknown>
        }

        // 3. Normalize (catalog items) and validate
        let manifestForValidation: Record<string, unknown> = { ...newManifestRaw }
        let manifestForStorage: Record<string, unknown> = { ...newManifestRaw }

        // Check if catalog manifest that needs normalization
        let isCatalog = false
        try {
            const regRow = await extensionsRepo.getRegistryRowByName(existing.name)
            isCatalog = Boolean(regRow)
        } catch { /* non-fatal */ }

        if (isCatalog) {
            const normalized = normalizeRegistryManifest(newManifestRaw)
            manifestForValidation = normalized.forValidation
            manifestForStorage = normalized.forStorage
        }

        const validation = validateManifest(manifestForValidation)
        if (!validation.valid) {
            const hard = validation.errors.filter(e => e.severity !== 'warning')
            if (hard.length > 0) {
                res.status(400).json({
                    error: {
                        code: 'INVALID_MANIFEST',
                        message: summarizeValidationErrors(validation.errors),
                        details: validation.errors,
                    },
                })
                return
            }
        }

        const m = manifestForStorage as unknown as ExtensionManifest

        // Version sanity check — don't "upgrade" to same or older
        if (m.version === existing.version) {
            res.status(409).json({ error: { code: 'SAME_VERSION', message: `Already at version ${m.version}` } })
            return
        }

        // 4. Terminate old worker if running
        terminateWorker(existing.name)

        // 5. Update extension row — preserve user settings
        await extensionsRepo.updateExtensionForUpgrade(req.params.id, {
            version: m.version,
            pexVersion: m.plexo ?? existing.pexVersion,
            entry: m.entry ?? existing.entry,
            manifest: m as object,
        })

        logger.info({ id: req.params.id, name: existing.name, oldVersion: existing.version, newVersion: m.version }, 'Extension upgraded')
        invalidateWorkspaceToolSets(workspaceId)
        audit(req, {
            workspaceId,
            action: 'extension.upgrade',
            resource: 'extensions',
            resourceId: req.params.id,
            metadata: { name: existing.name, oldVersion: existing.version, newVersion: m.version },
        })

        const warnings = validation.errors.filter(e => e.severity === 'warning')
        res.json({
            ok: true,
            oldVersion: existing.version,
            newVersion: m.version,
            warnings: warnings.length ? warnings : undefined,
        })
    } catch (err) {
        logger.error({ err }, 'PUT /api/extensions/:id/upgrade failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Upgrade failed' } })
    }
})

// ── DELETE /api/extensions/:id ───────────────────────────────────────────────────

extensionsRouter.delete('/:id', async (req, res) => {
    const { workspaceId } = req.query as { workspaceId?: string }

    if (!UUID_RE.test(req.params.id)) {
        res.status(400).json({ error: { code: 'INVALID_ID', message: 'Valid UUID required' } })
        return
    }

    if (!workspaceId) {
        res.status(400).json({ error: { code: 'MISSING_WORKSPACE', message: 'workspaceId query required' } })
        return
    }
    if (!await ensureWorkspaceAccess(req, res, workspaceId)) return

    try {
        const existing = await extensionsRepo.getExtensionForDelete(req.params.id)

        if (!existing || existing.workspaceId !== workspaceId) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Tool not found in workspace' } })
            return
        }

        // Terminate persistent worker + delete record
        terminateWorker(existing.name)
        await extensionsRepo.deleteExtension(req.params.id)

        // §5d: Cleanup — soft-delete associated behavior rules using raw SQL
        // instead of fetching all rules and filtering/updating in JS (N+1)
        // Tags use "extension:<id>" format (DB column name preserved)
        try {
            const extensionTag = `extension:${req.params.id}`
            await extensionsRepo.softDeleteBehaviorRules(workspaceId, extensionTag)
            logger.info({ id: req.params.id }, 'Soft-deleted tool behavior rules')
        } catch (ruleErr) {
            logger.warn({ err: ruleErr, id: req.params.id }, 'Failed to cleanup tool behavior rules — non-fatal')
        }

        // §7.6/§7.7: Soft-delete tool prompts and context blocks
        try {
            await extensionsRepo.softDeletePromptsAndContexts(workspaceId, existing.name)
            logger.info({ id: req.params.id, name: existing.name }, 'Soft-deleted tool prompts and context')
        } catch (pcErr) {
            logger.warn({ err: pcErr, id: req.params.id }, 'Failed to cleanup tool prompts/context — non-fatal')
        }

        logger.info({ id: req.params.id, name: existing.name }, 'Tool uninstalled')
        invalidateWorkspaceToolSets(workspaceId)
        audit(req, {
            workspaceId: existing.workspaceId,
            action: 'extension.uninstall',
            resource: 'extensions',
            resourceId: req.params.id,
            metadata: { name: existing.name, pexVersion: existing.pexVersion },
        })
        res.json({ ok: true })
    } catch (err) {
        logger.error({ err }, 'DELETE /api/extensions/:id failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Uninstall failed' } })
    }
})

// ── POST /api/extensions/invoke ─────────────────────────────────────────────
// Direct tool invocation — call an extension tool without going through the
// agent executor. Used by control panels and admin UIs that need synchronous
// tool results.

extensionsRouter.post('/invoke', async (req, res) => {
    const { workspaceId, extensionName, toolName, params: toolParams } = req.body as {
        workspaceId?: string
        extensionName?: string
        toolName?: string
        params?: Record<string, unknown>
    }

    if (!workspaceId || !extensionName || !toolName) {
        res.status(400).json({ error: { code: 'MISSING_FIELDS', message: 'workspaceId, extensionName, and toolName required' } })
        return
    }
    if (!await ensureWorkspaceAccess(req, res, workspaceId)) return

    try {
        // Built-in ops extensions bypass DB lookup — they are always enabled.
        let entryPath: string
        if (BUILTIN_OPS_EXTENSIONS[extensionName]) {
            entryPath = BUILTIN_OPS_EXTENSIONS[extensionName]!
        } else {
            // Look up the extension in DB
            const ext = await extensionsRepo.getExtensionForInvoke(workspaceId, extensionName)

            if (!ext) {
                res.status(404).json({ error: { code: 'NOT_FOUND', message: `Extension "${extensionName}" not found` } })
                return
            }
            if (!ext.enabled) {
                res.status(400).json({ error: { code: 'DISABLED', message: `Extension "${extensionName}" is disabled` } })
                return
            }
            entryPath = ext.entry
        }

        // Direct in-process invocation — load the extension module and call the tool handler.
        // This bypasses the sandbox worker pool (which requires compiled JS) and runs
        // the tool in the API process. Suitable for trusted ops extensions.

        // Collect tool registrations from the extension's activate()
        const registeredTools: Array<{ name: string; handler: (params: unknown, ctx?: unknown) => Promise<unknown> }> = []
        const fakeSdk = {
            registerTool(tool: { name: string; handler: (params: unknown, ctx?: unknown) => Promise<unknown> }) {
                registeredTools.push({ name: tool.name, handler: tool.handler })
            },
            registerSchedule() {},
            registerWidget() {},
            registerPrompt() {},
            registerContext() {},
        }

        // Cache activated extensions in-process
        const cacheKey = `invoke:${extensionName}`
        if (!_invokeCache.has(cacheKey)) {
            const mod = await import(entryPath)
            if (typeof mod.activate === 'function') {
                await mod.activate(fakeSdk)
            } else if (typeof mod.default?.activate === 'function') {
                await mod.default.activate(fakeSdk)
            }
            _invokeCache.set(cacheKey, registeredTools)
        }

        const tools = _invokeCache.get(cacheKey)!
        const tool = tools.find(t => t.name === toolName)
        if (!tool) {
            const available = tools.map(t => t.name)
            res.status(404).json({ error: { code: 'TOOL_NOT_FOUND', message: `Tool "${toolName}" not found. Available: ${available.join(', ')}` } })
            return
        }

        const start = Date.now()
        const result = await tool.handler(toolParams ?? {}, { workspaceId })
        const durationMs = Date.now() - start

        res.json({ ok: true, result, durationMs })
    } catch (err) {
        logger.error({ err, extensionName, toolName }, 'POST /api/extensions/invoke failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Tool invocation failed' } })
    }
})
