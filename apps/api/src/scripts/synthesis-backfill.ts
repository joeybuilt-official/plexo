// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Synthesis backfill — Phase α.
 *
 * Pull every Nexalog note + bookmark from the `pushd` database (PUSHD_DATABASE_URL)
 * and feed it into Plexo's `storeMemory()`. De-duplicates by `metadata.source_ref`
 * so reruns are idempotent. After capture, runs `clusterMemory` + suggestion
 * generation so the freshly-embedded corpus immediately materializes themes.
 *
 * Run:
 *     pnpm --filter @plexo/api tsx src/scripts/synthesis-backfill.ts <workspaceId>
 *
 * Env (read from process.env):
 *     PUSHD_DATABASE_URL   postgres://… for the pushd host with nexalog.* tables
 *     DATABASE_URL         plexo db (already used by @plexo/db)
 */
import { Client as PgClient } from 'pg'
import { db, sql } from '@plexo/db'
import { storeMemory } from '@plexo/agent/memory/store'
import { clusterMemory } from '@plexo/agent/memory/cluster'
import { generateThemeSuggestions, generateLinkSuggestions } from '@plexo/agent/memory/suggest'

const PROGRESS_EVERY = 50

interface NexalogNote {
    id: string
    workspace_id: string | null
    title: string | null
    content: string | null
    created_at: Date
}

interface NexalogBookmark {
    id: string
    workspace_id: string | null
    title: string | null
    url: string | null
    description: string | null
    created_at: Date
}

/** Has Plexo already absorbed an item with this source_ref? */
async function alreadyStored(workspaceId: string, sourceRef: string): Promise<boolean> {
    const rows = Array.from(await db.execute<{ exists: boolean }>(sql`
        SELECT EXISTS(
            SELECT 1 FROM memory_entries
            WHERE workspace_id = ${workspaceId}::uuid
              AND metadata->>'source_ref' = ${sourceRef}
        ) AS exists
    `))
    return Boolean(rows[0]?.exists)
}

async function main(): Promise<void> {
    const workspaceId = process.argv[2]
    if (!workspaceId) {
        console.error('usage: synthesis-backfill <workspaceId>')
        process.exit(1)
    }

    const pushdUrl = process.env.PUSHD_DATABASE_URL
    if (!pushdUrl) {
        console.error('PUSHD_DATABASE_URL is required')
        process.exit(1)
    }

    const pushd = new PgClient({ connectionString: pushdUrl })
    await pushd.connect()

    let scannedNotes = 0
    let scannedBookmarks = 0
    let stored = 0
    let skipped = 0
    let failed = 0

    try {
        // ── Notes ───────────────────────────────────────────────
        const notesRes = await pushd.query<NexalogNote>(`
            SELECT id, workspace_id, title, content, created_at
            FROM nexalog.notes
            ORDER BY created_at ASC
        `)
        for (const n of notesRes.rows) {
            scannedNotes++
            const sourceRef = `nexalog.note:${n.id}`
            try {
                if (await alreadyStored(workspaceId, sourceRef)) { skipped++; continue }
                const body = [n.title, n.content].filter(Boolean).join('\n\n').trim()
                if (!body) { skipped++; continue }
                await storeMemory({
                    workspaceId,
                    type: 'pattern',
                    content: body.slice(0, 100_000),
                    metadata: {
                        app: 'nexalog',
                        kind: 'note',
                        source_ref: sourceRef,
                        nexalog_note_id: n.id,
                        nexalog_workspace_id: n.workspace_id,
                        original_created_at: n.created_at?.toISOString?.() ?? null,
                    },
                })
                stored++
            } catch (err) {
                failed++
                console.error(`[note ${n.id}] store failed:`, (err as Error).message)
            }
            if ((scannedNotes + scannedBookmarks) % PROGRESS_EVERY === 0) {
                console.log(`progress: scanned=${scannedNotes + scannedBookmarks} stored=${stored} skipped=${skipped} failed=${failed}`)
            }
        }

        // ── Bookmarks (capture_sources) ─────────────────────────
        const bmRes = await pushd.query<NexalogBookmark>(`
            SELECT id, workspace_id, COALESCE(og_title, content) AS title, url, og_description AS description, created_at
            FROM nexalog.capture_sources
            ORDER BY created_at ASC
        `)
        for (const b of bmRes.rows) {
            scannedBookmarks++
            const sourceRef = `nexalog.capture_source:${b.id}`
            try {
                if (await alreadyStored(workspaceId, sourceRef)) { skipped++; continue }
                const body = [b.title, b.url, b.description].filter(Boolean).join('\n').trim()
                if (!body) { skipped++; continue }
                await storeMemory({
                    workspaceId,
                    type: 'pattern',
                    content: body.slice(0, 100_000),
                    metadata: {
                        app: 'nexalog',
                        kind: 'bookmark',
                        source_ref: sourceRef,
                        nexalog_capture_id: b.id,
                        nexalog_workspace_id: b.workspace_id,
                        url: b.url,
                        original_created_at: b.created_at?.toISOString?.() ?? null,
                    },
                })
                stored++
            } catch (err) {
                failed++
                console.error(`[capture ${b.id}] store failed:`, (err as Error).message)
            }
            if ((scannedNotes + scannedBookmarks) % PROGRESS_EVERY === 0) {
                console.log(`progress: scanned=${scannedNotes + scannedBookmarks} stored=${stored} skipped=${skipped} failed=${failed}`)
            }
        }
    } finally {
        await pushd.end()
    }

    console.log(`backfill done: notes=${scannedNotes} bookmarks=${scannedBookmarks} stored=${stored} skipped=${skipped} failed=${failed}`)

    // Wait briefly for fire-and-forget embeddings to settle. storeMemory's
    // embedding write is async and not awaited inside; clustering with
    // empty embedding columns wastes a run, so we sleep a bit before
    // continuing. 5s is plenty for typical batch sizes.
    if (stored > 0) {
        console.log('waiting 5s for async embeddings to flush…')
        await new Promise(r => setTimeout(r, 5000))
    }

    console.log('clustering…')
    const clustered = await clusterMemory(workspaceId)
    console.log(`clusters=${clustered.clusters.length} noise=${clustered.noise.length}`)

    console.log('suggesting…')
    const themes = await generateThemeSuggestions(workspaceId)
    const links = await generateLinkSuggestions(workspaceId)
    console.log(`themes inserted=${themes.inserted} skipped=${themes.skipped} inspected=${themes.inspected}`)
    console.log(`links  inserted=${links.inserted}  skipped=${links.skipped}  inspectedPairs=${links.inspectedPairs}`)
}

main().catch(err => {
    console.error('backfill failed:', err)
    process.exit(1)
})
