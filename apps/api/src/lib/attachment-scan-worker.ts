// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Attachment scan worker — Phase N+1 (ADR 0012).
 *
 * One tick =
 *   1. Claim ≤4 pending rows (FOR UPDATE SKIP LOCKED + recover stuck >5min).
 *   2. For each, fetch bytes → INSTREAM via clamd → record result.
 *   3. Fan-out scanStatus / signature into every conversations.attachments
 *      element matching the contentHash (JSONB array element update).
 *   4. Audit log emit per processed row + metric increment.
 *
 * Concurrency cap (4) is enforced by the claim limit; this keeps the worker
 * loop linear. Future scale: replace the per-row sequential loop with a
 * Promise.all bounded pool when ingest exceeds ~8 attachments/sec.
 */

import { db, sql } from '@plexo/db'
import { audit } from '../audit.js'
import { logger } from '../logger.js'
import { incrementCounter, observeHistogram, setGauge } from './metrics.js'
import { getByKey } from '@plexo/storage'
import type { ClamdConfig, ClamdScanResult } from './clamd-client.js'
import { instreamScan } from './clamd-client.js'
import { parseStorageKey as parseStorageKeyShared } from './storage-key.js'

const CLAIM_LIMIT = 4
const STUCK_AFTER_MS = Number(process.env.CLAMD_STUCK_RECOVERY_MS ?? 300_000)
const FAILURE_GIVEUP = 5
const STREAM_MAX_LENGTH_BYTES = 25 * 1024 * 1024

// Indexed by post-bump consecutive_failures (1..5).
// State 1 = first failure → 10s; state 5 = fifth failure → 600s.
// State 0 ("no failures yet") never reaches backoff lookup.
const BACKOFF_SCHEDULE_MS = [10_000, 30_000, 90_000, 270_000, 600_000]

function backoffMs(consecutiveFailures: number): number {
    const idx = Math.min(consecutiveFailures - 1, BACKOFF_SCHEDULE_MS.length - 1)
    return BACKOFF_SCHEDULE_MS[Math.max(0, idx)] ?? 600_000
}

export interface AttachmentScanTickResult {
    claimed: number
    processed: number
    errored: number
}

type ClaimedRow = {
    id: string
    workspace_id: string
    conversation_id: string
    content_hash: string
    storage_url: string
    mime_type: string
    size_bytes: number
    consecutive_failures: number
    [k: string]: unknown
}

/**
 * Back-compat wrapper around the shared `parseStorageKey` helper in
 * `./storage-key.ts`. Returns the bare key string the way the worker's
 * fetcher expects it.
 */
export function parseStorageKey(storageUrl: string): string {
    return parseStorageKeyShared(storageUrl).key
}

function getClamdConfig(): ClamdConfig {
    return {
        host: process.env.CLAMD_HOST ?? 'clamd',
        port: Number(process.env.CLAMD_PORT ?? 3310),
        timeoutMs: Number(process.env.CLAMD_TIMEOUT_MS ?? 30_000),
    }
}

/**
 * Claim up to CLAIM_LIMIT rows in a single transaction.
 *
 * Recovery clause: rows whose `started_at` is non-null but older than 5 min
 * AND completed_at IS NULL are crashed-mid-flight. They're re-claimable but
 * we deliberately do NOT bump consecutive_failures — the worker (not clamd)
 * was at fault (pre-mortem #2).
 */
async function claimRows(): Promise<ClaimedRow[]> {
    const rows = await db.execute<ClaimedRow>(sql`
        WITH picked AS (
            SELECT id
            FROM attachment_scan_queue
            WHERE completed_at IS NULL
              AND next_attempt_at <= now()
              AND (started_at IS NULL OR started_at < now() - make_interval(secs => ${STUCK_AFTER_MS / 1000}))
            ORDER BY enqueued_at
            LIMIT ${CLAIM_LIMIT}
            FOR UPDATE SKIP LOCKED
        )
        UPDATE attachment_scan_queue q
        SET started_at = now()
        FROM picked
        WHERE q.id = picked.id
        RETURNING q.id,
                  q.workspace_id,
                  q.conversation_id,
                  q.content_hash,
                  q.storage_url,
                  q.mime_type,
                  q.size_bytes::bigint AS size_bytes,
                  q.consecutive_failures
    `)
    // db.execute returns either an array or { rows } depending on driver.
    const list = Array.isArray(rows) ? rows : ((rows as unknown as { rows?: ClaimedRow[] }).rows ?? [])
    return list as ClaimedRow[]
}

async function refreshQueueDepth(): Promise<void> {
    try {
        const r = await db.execute<{ depth: number }>(sql`
            SELECT count(*)::int AS depth FROM attachment_scan_queue WHERE completed_at IS NULL
        `)
        const list = Array.isArray(r) ? r : ((r as unknown as { rows?: { depth: number }[] }).rows ?? [])
        const depth = Number(list[0]?.depth ?? 0)
        setGauge('plexo_clamd_scan_queue_depth', depth)
    } catch (err) {
        logger.warn({ err }, 'attachment-scan-worker: refreshQueueDepth failed')
    }
}

async function recordSuccess(row: ClaimedRow, result: ClamdScanResult): Promise<void> {
    await db.execute(sql`
        UPDATE attachment_scan_queue
        SET completed_at = now(),
            result = ${result.status},
            consecutive_failures = 0,
            last_error = ${result.error ?? null}
        WHERE id = ${row.id}
    `)
}

async function recordPermanentError(row: ClaimedRow, errMsg: string): Promise<void> {
    await db.execute(sql`
        UPDATE attachment_scan_queue
        SET completed_at = now(),
            result = 'error',
            consecutive_failures = ${row.consecutive_failures + 1},
            last_error = ${errMsg}
        WHERE id = ${row.id}
    `)
}

/**
 * Transient failure (clamd unreachable / timeout). Bump counter, schedule
 * a backoff by pushing enqueued_at forward, clear started_at so it's
 * re-claimable.
 */
async function recordTransientFailure(row: ClaimedRow, errMsg: string): Promise<void> {
    const failures = row.consecutive_failures + 1
    const delay = backoffMs(failures)
    await db.execute(sql`
        UPDATE attachment_scan_queue
        SET started_at = NULL,
            consecutive_failures = ${failures},
            last_error = ${errMsg},
            next_attempt_at = now() + make_interval(secs => ${delay / 1000})
        WHERE id = ${row.id}
    `)
}

/**
 * Apply scan result to every conversations row whose attachments array
 * contains an element with the matching contentHash. Single SQL
 * statement using jsonb_set indexed by the matching element's array
 * position.
 *
 * Idempotent: re-running the update with the same result is a no-op.
 */
async function fanOutToConversations(
    contentHash: string,
    workspaceId: string,
    scanStatus: 'clean' | 'infected' | 'error',
    signature: string | null,
): Promise<void> {
    await db.execute(sql`
        WITH targets AS (
            SELECT c.id,
                   (idx - 1) AS arr_index,
                   c.attachments -> (idx - 1) AS att
            FROM conversations c,
                 jsonb_array_elements(c.attachments) WITH ORDINALITY AS e(elem, idx)
            WHERE c.workspace_id = ${workspaceId}::uuid
              AND c.attachments @> jsonb_build_array(jsonb_build_object('contentHash', ${contentHash}::text))
              AND (e.elem ->> 'contentHash') = ${contentHash}
        )
        UPDATE conversations c
        SET attachments = jsonb_set(
            c.attachments,
            ARRAY[t.arr_index::text],
            (t.att
                || jsonb_build_object('scanStatus', ${scanStatus}::text)
                || CASE
                       WHEN ${signature}::text IS NULL THEN '{}'::jsonb
                       ELSE jsonb_build_object('signature', ${signature}::text)
                   END
            ),
            false
        )
        FROM targets t
        WHERE c.id = t.id
          AND c.workspace_id = ${workspaceId}::uuid
    `)
}

export async function runAttachmentScanTick(deps?: {
    clamdConfig?: ClamdConfig
    fetcher?: (url: string) => Promise<Buffer>
    scanner?: (bytes: Buffer) => Promise<ClamdScanResult>
}): Promise<AttachmentScanTickResult> {
    await refreshQueueDepth()

    let claimed: ClaimedRow[] = []
    try {
        claimed = await claimRows()
    } catch (err) {
        logger.error({ err }, 'attachment-scan-worker: claim failed')
        return { claimed: 0, processed: 0, errored: 0 }
    }

    if (claimed.length === 0) {
        return { claimed: 0, processed: 0, errored: 0 }
    }

    const cfg = deps?.clamdConfig ?? getClamdConfig()
    const fetcher = deps?.fetcher ?? ((storageUrl: string) => getByKey(parseStorageKey(storageUrl)))
    const scanner = deps?.scanner ?? ((bytes: Buffer) => instreamScan(cfg, bytes))

    let processed = 0
    let errored = 0

    for (const row of claimed) {
        if (Number(row.size_bytes) > STREAM_MAX_LENGTH_BYTES) {
            await recordPermanentError(row, 'size_exceeded')
            await fanOutToConversations(row.content_hash, row.workspace_id, 'error', null)
            emitScanAudit(row, { status: 'error', error: 'size_exceeded', durationMs: 0 })
            incrementCounter('plexo_clamd_scan_total', { result: 'error' })
            errored += 1
            processed += 1
            continue
        }

        let bytes: Buffer
        try {
            bytes = await fetcher(row.storage_url)
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            // Fetch failure is treated like a transient error against the
            // current consecutive_failures counter. After 5 strikes we give
            // up and mark the row 'error' so the UI shows "Scan failed".
            if (row.consecutive_failures + 1 >= FAILURE_GIVEUP) {
                await recordPermanentError(row, `fetch: ${msg}`)
                await fanOutToConversations(row.content_hash, row.workspace_id, 'error', null)
                emitScanAudit(row, { status: 'error', error: msg, durationMs: 0 })
                incrementCounter('plexo_clamd_scan_total', { result: 'error' })
                errored += 1
                processed += 1
            } else {
                await recordTransientFailure(row, `fetch: ${msg}`)
            }
            continue
        }

        let result: ClamdScanResult
        try {
            result = await scanner(bytes)
        } catch (err) {
            result = {
                status: 'error',
                error: err instanceof Error ? err.message : String(err),
                durationMs: 0,
            }
        }

        // clamd up but returned ERROR — terminal (D6: "clamd has decided").
        // clamd unreachable / timeout — transient until FAILURE_GIVEUP.
        const isTransient = result.status === 'error'
            && /timeout|connection|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|closed before reply/i.test(result.error ?? '')

        if (isTransient && row.consecutive_failures + 1 < FAILURE_GIVEUP) {
            await recordTransientFailure(row, result.error ?? 'unknown')
            continue
        }

        if (result.status === 'error' && row.consecutive_failures + 1 >= FAILURE_GIVEUP) {
            await recordPermanentError(row, result.error ?? 'unknown')
            await fanOutToConversations(row.content_hash, row.workspace_id, 'error', null)
        } else if (result.status === 'error') {
            // clamd ERROR (terminal, not transient)
            await recordSuccess(row, result)
            await fanOutToConversations(row.content_hash, row.workspace_id, 'error', null)
        } else {
            await recordSuccess(row, result)
            await fanOutToConversations(
                row.content_hash,
                row.workspace_id,
                result.status,
                result.status === 'infected' ? (result.signature ?? null) : null,
            )
        }

        emitScanAudit(row, result)
        incrementCounter('plexo_clamd_scan_total', { result: result.status })
        observeHistogram('plexo_clamd_scan_duration_ms', result.durationMs, {})
        if (result.status === 'error') errored += 1
        processed += 1
    }

    return { claimed: claimed.length, processed, errored }
}

function emitScanAudit(row: ClaimedRow, result: ClamdScanResult): void {
    audit(null, {
        workspaceId: row.workspace_id,
        action: 'attachment.scanned',
        resource: 'conversations.attachments',
        resourceId: row.content_hash,
        metadata: {
            contentHash: row.content_hash,
            conversationId: row.conversation_id,
            status: result.status,
            scanner: 'clamav',
            ...(result.signature ? { signature: result.signature } : {}),
            durationMs: result.durationMs,
        },
    })
}
