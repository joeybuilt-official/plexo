// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Memory write-backend selector.
 *
 * Postgres is the canonical memory store. Graphiti memory mirror was retired
 * 2026-06-27; the bridge + sidecar were removed and every read/write now
 * lands on `memory_entries` only. The selector functions are kept as a thin
 * compatibility shim for in-tree callers so the call-site shape doesn't
 * have to change while the cleanup is rolling out.
 */

export type WriteBackend = 'postgres'

export function getWriteBackend(): WriteBackend {
    return 'postgres'
}

export function shouldWritePostgres(_backend: WriteBackend = 'postgres'): boolean {
    return true
}
