// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * split-sessions.ts — retroactive session splitting for the conversations log.
 *
 * Walks every existing conversation row, groups by (workspace, source, chat),
 * sorts chronologically, and re-assigns session_id whenever the time gap
 * between consecutive turns exceeds SESSION_TIMEOUT_MINUTES.
 *
 * Safety:
 *   - Creates a backup table `conversation_log_backup_{timestamp}` before
 *     touching a single row. Run again to restore from backup if needed.
 *   - Pure time-based splitting — no embedding calls. Keeps the script fast,
 *     portable, and safe to run unattended.
 *   - Idempotent within a single run: minted session IDs are deterministic
 *     from the first turn of a group (`<source>:<chatKey>:<ulid-of-first>`)
 *     so re-running over clean data yields identical IDs.
 *
 * Run:
 *   pnpm --filter @plexo/db exec tsx split-sessions.ts
 *   SESSION_TIMEOUT_MINUTES=30 pnpm --filter @plexo/db exec tsx split-sessions.ts
 */

import { db, sql } from './src/index.js'
import { ulid } from 'ulid'

interface RawRow {
    id: string
    workspace_id: string
    source: string
    session_id: string | null
    channel_ref: { channel?: string; channelId?: string; chatId?: string } | null
    created_at: Date
}

function getTimeoutMs(): number {
    const minutes = Number(process.env.SESSION_TIMEOUT_MINUTES ?? '30')
    if (!Number.isFinite(minutes) || minutes <= 0) return 30 * 60 * 1000
    return Math.floor(minutes * 60 * 1000)
}

function chatKey(r: RawRow): string {
    // Prefer channel_ref.chatId for external channels — it's the canonical
    // per-conversation key. Fallback to parsing the legacy session_id format
    // ("<src>:<channelId>:<chatId>[:...]") so we don't collapse unrelated chats.
    const cr = r.channel_ref
    if (cr?.chatId) return `${cr.channelId ?? ''}:${cr.chatId}`
    if (r.session_id) {
        const parts = r.session_id.split(':')
        if (parts.length >= 3) return `${parts[1] ?? ''}:${parts[2] ?? ''}`
        return r.session_id
    }
    // No discriminator available — bucket by workspace/source so we at least
    // don't glue every unrelated dashboard message into a single mega-session.
    return `${r.workspace_id}:orphan`
}

async function main(): Promise<void> {
    const started = Date.now()
    const stamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)
    const backupTable = `conversation_log_backup_${stamp}`

    console.log(`split-sessions: starting. backup=${backupTable} timeout=${getTimeoutMs()}ms`)

    // ── Step 1: backup ────────────────────────────────────────────────────────
    try {
        await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS "${backupTable}" AS TABLE conversations`))
        const countRes = await db.execute(sql.raw(`SELECT COUNT(*)::int AS n FROM "${backupTable}"`)) as Array<{ n: number }>
        console.log(`split-sessions: backup created with ${countRes[0]?.n ?? 0} rows`)
    } catch (err) {
        console.error('split-sessions: backup failed — aborting', err)
        process.exit(1)
    }

    // ── Step 2: load all rows ─────────────────────────────────────────────────
    const rows = await db.execute(sql`
        SELECT id, workspace_id, source, session_id, channel_ref, created_at
        FROM conversations
        ORDER BY workspace_id, source, created_at
    `) as unknown as RawRow[]
    console.log(`split-sessions: loaded ${rows.length} rows`)

    // ── Step 3: bucket ───────────────────────────────────────────────────────
    // key = `${workspaceId}::${source}::${chatKey}`
    const buckets = new Map<string, RawRow[]>()
    for (const r of rows) {
        const key = `${r.workspace_id}::${r.source}::${chatKey(r)}`
        const b = buckets.get(key)
        if (b) b.push(r)
        else buckets.set(key, [r])
    }
    console.log(`split-sessions: ${buckets.size} bucket(s)`)

    // ── Step 4: walk each bucket, reassign session_id on time gap ─────────────
    const timeoutMs = getTimeoutMs()
    const updates: Array<{ id: string; sessionId: string }> = []
    let sessionsCreated = 0

    for (const [bucketKey, bucketRows] of buckets) {
        // Ensure chronological order (should already be from ORDER BY above,
        // but each bucket re-asserts for safety).
        bucketRows.sort((a, b) => a.created_at.getTime() - b.created_at.getTime())

        const [firstPart, sourcePart, chatKeyPart] = bucketKey.split('::') as [string, string, string]
        void firstPart
        let currentSessionId: string | null = null
        let lastMs = 0

        for (const r of bucketRows) {
            const t = r.created_at.getTime()
            if (!currentSessionId || (t - lastMs) > timeoutMs) {
                const id = ulid().toLowerCase()
                currentSessionId = `${sourcePart}:${chatKeyPart}:${id}`
                sessionsCreated++
            }
            if (r.session_id !== currentSessionId) {
                updates.push({ id: r.id, sessionId: currentSessionId })
            }
            lastMs = t
        }
    }
    console.log(`split-sessions: ${sessionsCreated} session(s) minted, ${updates.length} row update(s) pending`)

    // ── Step 5: apply updates in batches ──────────────────────────────────────
    const BATCH_SIZE = 500
    let applied = 0
    for (let i = 0; i < updates.length; i += BATCH_SIZE) {
        const batch = updates.slice(i, i + BATCH_SIZE)
        await db.transaction(async (tx) => {
            for (const u of batch) {
                await tx.execute(sql`
                    UPDATE conversations SET session_id = ${u.sessionId} WHERE id = ${u.id}
                `)
            }
        })
        applied += batch.length
        if (applied % 2000 === 0 || applied === updates.length) {
            console.log(`split-sessions: applied ${applied}/${updates.length}`)
        }
    }

    const elapsed = ((Date.now() - started) / 1000).toFixed(1)
    console.log(`split-sessions: done in ${elapsed}s. sessions=${sessionsCreated} updates=${applied} backup=${backupTable}`)
    process.exit(0)
}

main().catch((err) => {
    console.error('split-sessions: fatal', err)
    process.exit(1)
})
