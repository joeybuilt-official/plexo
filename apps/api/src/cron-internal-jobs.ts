// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Canonical names of internal cron jobs — those executed as direct function
 * handlers by the in-process scheduler in cron.ts (the INTERNAL_JOBS array)
 * plus the few run directly elsewhere ('RSI Monitor' via runCronJobs).
 *
 * The cron-dispatch engine MUST skip these so it never queues an empty agent
 * task for them. This lives in its own dependency-free module (not cron.ts) so
 * cron-dispatch can import it without pulling in cron.ts's heavy agent/storage
 * import graph.
 *
 * Must be kept in sync with cron.ts INTERNAL_JOBS — a startup assertion in
 * cron.ts (scheduleMemoryConsolidation) logs an error if an INTERNAL_JOBS name
 * is missing here. Also includes a few names not in that array: 'RSI Monitor'
 * (run via runCronJobs) and the legacy 'flush-retrieval-counts' alias (a
 * pre-rename row still present in some deployments alongside
 * '__internal_flush_retrieval_counts').
 */
export const INTERNAL_JOB_NAMES: ReadonlySet<string> = new Set<string>([
    'Memory consolidation',
    'Weekly digest',
    'Artifact cleanup',
    'Orphan user cleanup',
    '__internal_data_retention',
    '__internal_flush_retrieval_counts',
    '__internal_decay_confidence',
    '__internal_stabilization_agents',
    'gmail-poll',
    'Router stats snapshot',
    'Ops alerts flush',
    'RSI Monitor',
    'flush-retrieval-counts',
])
