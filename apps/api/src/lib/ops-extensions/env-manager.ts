// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

import { eq, and } from 'drizzle-orm'
import { db, workspacePreferences } from '@plexo/db'
import { encrypt, decrypt } from '../../crypto.js'

const SENSITIVE_RE = /key|secret|password|token|auth|credential|private|cert|signing/i

function isSensitive(key: string): boolean {
    return SENSITIVE_RE.test(key)
}

// Namespace used to scope env overrides in workspace_preferences
const NS = 'ops-env'
const PREFIX = 'env:'

async function loadPersistedOverrides(workspaceId: string): Promise<void> {
    try {
        const rows = await db
            .select({ key: workspacePreferences.key, value: workspacePreferences.value })
            .from(workspacePreferences)
            .where(and(
                eq(workspacePreferences.workspaceId, workspaceId),
                eq(workspacePreferences.namespace, NS),
            ))
        for (const row of rows) {
            if (!row.key.startsWith(PREFIX)) continue
            const envKey = row.key.slice(PREFIX.length)
            const val = row.value as { encrypted?: string }
            if (!val?.encrypted) continue
            try {
                const parsed = JSON.parse(decrypt(val.encrypted, workspaceId)) as { value: string }
                if (process.env[envKey] === undefined) {
                    process.env[envKey] = parsed.value
                }
            } catch { /* corrupt entry — skip */ }
        }
    } catch { /* non-fatal — proceed without persisted overrides */ }
}

export async function activate(sdk: {
    registerTool(tool: {
        name: string
        handler: (params: unknown, ctx?: unknown) => Promise<unknown>
    }): void
}) {
    sdk.registerTool({
        name: 'list_env_vars',
        async handler(_params: unknown, ctx: unknown) {
            const { workspaceId } = ctx as { workspaceId: string }
            await loadPersistedOverrides(workspaceId)

            const SKIP = /^(npm_|PNPM_|npm_config_|_=|SHLVL|PWD|OLDPWD)/
            const vars = Object.entries(process.env)
                .filter(([k]) => !SKIP.test(k))
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([key, value]) => ({
                    key,
                    value: isSensitive(key) ? '' : (value ?? ''),
                    masked: isSensitive(key),
                }))
            return { vars }
        },
    })

    sdk.registerTool({
        name: 'reveal_env_var',
        async handler(params: unknown) {
            const { key } = params as { key?: string }
            if (!key) throw new Error('key is required')
            const value = process.env[key]
            if (value === undefined) return { value: '', found: false }
            return { value, found: true }
        },
    })

    sdk.registerTool({
        name: 'set_env_var',
        async handler(params: unknown, ctx: unknown) {
            const { key, value } = params as { key?: string; value?: string }
            if (!key) throw new Error('key is required')
            if (!/^[A-Z_][A-Z0-9_]*$/i.test(key)) throw new Error(`Invalid env var name: ${key}`)
            const { workspaceId } = ctx as { workspaceId: string }

            const val = value ?? ''
            process.env[key] = val

            // Persist encrypted so it survives agent restarts within the session
            const encVal = encrypt(JSON.stringify({ value: val }), workspaceId)
            await db
                .insert(workspacePreferences)
                .values({
                    workspaceId,
                    key: `${PREFIX}${key}`,
                    value: { encrypted: encVal },
                    namespace: NS,
                    confidence: 1,
                    evidenceCount: 1,
                })
                .onConflictDoUpdate({
                    target: [workspacePreferences.workspaceId, workspacePreferences.key],
                    set: {
                        value: { encrypted: encVal },
                        lastUpdated: new Date(),
                    },
                })

            return { ok: true, key, applied: true }
        },
    })

    sdk.registerTool({
        name: 'delete_env_var',
        async handler(params: unknown, ctx: unknown) {
            const { key } = params as { key?: string }
            if (!key) throw new Error('key is required')
            const { workspaceId } = ctx as { workspaceId: string }

            delete process.env[key]

            await db
                .delete(workspacePreferences)
                .where(and(
                    eq(workspacePreferences.workspaceId, workspaceId),
                    eq(workspacePreferences.key, `${PREFIX}${key}`),
                    eq(workspacePreferences.namespace, NS),
                ))

            return { ok: true, key }
        },
    })
}
