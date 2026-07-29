// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Read/write classifier for connection tool names.
 *
 * Used by the bridge to implement workspace-level read-only mode
 * (Phase 9): when `workspaces.settings.readOnlyMode = true`, every
 * tool classified as a write is stripped before the agent sees it.
 *
 * Classification is verb-based on the short name (everything after
 * the `provider__` prefix). Unknown verbs are treated as WRITES so
 * the failure mode is "agent loses a read tool" rather than "agent
 * mutates state while supposedly in read-only mode".
 */

/**
 * Verb stems that indicate read-only operations. Matched against the
 * short tool name with an optional trailing underscore (so both
 * `list` and `list_repos` classify as reads).
 */
const READ_VERBS = [
    'get',
    'list',
    'search',
    'read',
    'fetch',
    'view',
    'find',
    'query',
    'transcribe',
    'analyze',
    'detect',
    'count',
    'describe',
    'inspect',
    'check',
    'show',
    'download',
    'summarize',
] as const

/**
 * Returns true if the tool is classified as a write (mutates state).
 *
 * @param name - Full tool name (e.g. `github__create_issue` or
 *               a bare tool like `synthesize_extension`)
 */
export function isWriteTool(name: string): boolean {
    const short = (name.split('__')[1] ?? name).toLowerCase()
    for (const v of READ_VERBS) {
        if (short === v || short.startsWith(`${v}_`)) return false
    }
    return true
}
