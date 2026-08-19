// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Canonical names of internal cron jobs — those executed as direct function
 * handlers by the in-process scheduler in cron.ts (the INTERNAL_JOBS array).
 *
 * The cron-dispatch engine MUST skip these so it never queues an empty agent
 * task for them. This lives in its own dependency-free module (not cron.ts) so
 * cron-dispatch can import it without pulling in cron.ts's heavy agent/storage
 * import graph.
 *
 * Must be kept in sync with cron.ts INTERNAL_JOBS — a startup assertion in
 * cron.ts (scheduleMemoryConsolidation) logs an error if an INTERNAL_JOBS name
 * is missing here. Also includes the legacy 'flush-retrieval-counts' alias (a
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
    'flush-retrieval-counts',
])
