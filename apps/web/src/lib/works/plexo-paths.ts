// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 4 — Plexo path registry.
//
// Maps natural-language phrases that show up in instruction works to
// the internal route users should land on. Patterns are matched against
// the text content of markdown nodes at render time; the first match
// wins. Kept pure and JSX-free so it can be unit-tested under the repo
// vitest (node env).

export interface PlexoPathEntry {
    /** Regex matched against text content. Must be case-insensitive. */
    pattern: RegExp
    /** Internal Next.js route to navigate to. */
    href: string
    /** Human label used on the pill when the match substring is ambiguous. */
    label: string
}

// Order matters: more specific patterns first, otherwise a broad
// "Settings" entry would swallow "Settings > AI Models" before the
// deeper path registers.
export const PLEXO_PATHS: PlexoPathEntry[] = [
    // Settings → X (deep paths first)
    { pattern: /settings\s*[>›/→\-]+\s*ai\s*models/i, href: '/app/settings/ai-models', label: 'AI Models' },
    { pattern: /settings\s*[>›/→\-]+\s*channels/i, href: '/app/settings/channels', label: 'Channels' },
    { pattern: /settings\s*[>›/→\-]+\s*connections/i, href: '/app/settings/connections', label: 'Connections' },
    { pattern: /settings\s*[>›/→\-]+\s*federation/i, href: '/app/settings/federation', label: 'Federation' },
    { pattern: /settings\s*[>›/→\-]+\s*integrations/i, href: '/app/connections', label: 'Integrations' },

    // "Go to your X page" / "the X page"
    { pattern: /\b(?:your\s+)?ai\s*models?\s*page\b/i, href: '/app/settings/ai-models', label: 'AI Models' },
    { pattern: /\b(?:your\s+)?tasks\s*page\b/i, href: '/app/tasks', label: 'Tasks' },
    { pattern: /\b(?:your\s+)?projects?\s*page\b/i, href: '/app/projects', label: 'Projects' },
    { pattern: /\b(?:your\s+)?memory\s*page\b/i, href: '/app/memory', label: 'Memory' },
    { pattern: /\b(?:your\s+)?agents?\s*page\b/i, href: '/app/agents', label: 'Agents' },
    { pattern: /\b(?:your\s+)?hub\s*page\b/i, href: '/app/hub', label: 'Hub' },
    { pattern: /\b(?:your\s+)?integrations?\s*page\b/i, href: '/app/connections', label: 'Integrations' },
    { pattern: /\b(?:your\s+)?connections?\s*page\b/i, href: '/app/connections', label: 'Connections' },
    { pattern: /\b(?:your\s+)?channels?\s*page\b/i, href: '/app/settings/channels', label: 'Channels' },
    { pattern: /\b(?:your\s+)?sprints?\s*page\b/i, href: '/app/sprints', label: 'Sprints' },
    { pattern: /\b(?:your\s+)?approvals?\s*page\b/i, href: '/app/approvals', label: 'Approvals' },
    { pattern: /\b(?:your\s+)?insights?\s*page\b/i, href: '/app/memory', label: 'Insights' },
    { pattern: /\b(?:your\s+)?(?:scheduling|schedules?|reminders?)\s*page\b/i, href: '/app/scheduling', label: 'Scheduling' },
    { pattern: /\b(?:your\s+)?logs?\s*page\b/i, href: '/app/logs', label: 'Logs' },
    { pattern: /\b(?:your\s+)?audit\s*(?:log\s*)?page\b/i, href: '/app/audit', label: 'Audit' },
    { pattern: /\b(?:your\s+)?tools?\s*page\b/i, href: '/app/extensions', label: 'Tools' },

    // Direct internal-path references, e.g. "/app/settings/ai-models"
    { pattern: /\/app\/settings\/ai-models\b/i, href: '/app/settings/intelligence/models', label: 'AI Models' },
    { pattern: /\/app\/settings\/channels\b/i, href: '/app/settings/channels', label: 'Channels' },
    { pattern: /\/app\/settings\/federation\b/i, href: '/app/settings/federation', label: 'Federation' },
    { pattern: /\/app\/settings\/connections\b/i, href: '/app/settings/connections', label: 'Connections' },
    { pattern: /\/app\/connections\b/i, href: '/app/connections', label: 'Integrations' },
    { pattern: /\/app\/extensions\b/i, href: '/app/extensions', label: 'Tools' },
    { pattern: /\/app\/memory\b/i, href: '/app/memory', label: 'Memory' },
    { pattern: /\/app\/tasks\b/i, href: '/app/tasks', label: 'Tasks' },
    { pattern: /\/app\/agents\b/i, href: '/app/agents', label: 'Agents' },
    { pattern: /\/app\/hub\b/i, href: '/app/hub', label: 'Hub' },
    { pattern: /\/app\/sprints\b/i, href: '/app/sprints', label: 'Sprints' },
    { pattern: /\/app\/projects\b/i, href: '/app/projects', label: 'Projects' },
    { pattern: /\/app\/insights\b/i, href: '/app/memory', label: 'Insights' },
    { pattern: /\/app\/approvals\b/i, href: '/app/approvals', label: 'Approvals' },
    { pattern: /\/app\/conversations\b/i, href: '/app/conversations', label: 'Conversations' },
    { pattern: /\/app\/scheduling\b/i, href: '/app/scheduling', label: 'Scheduling' },
    { pattern: /\/app\/cron\b/i, href: '/app/scheduling', label: 'Scheduling' },
    { pattern: /\/app\/logs\b/i, href: '/app/logs', label: 'Logs' },
    { pattern: /\/app\/audit\b/i, href: '/app/audit', label: 'Audit' },
    // Broad "Settings" fallback must come last so it doesn't swallow deep paths.
    { pattern: /\/app\/settings\b/i, href: '/app/settings', label: 'Settings' },
    { pattern: /\bsettings\s*page\b/i, href: '/app/settings', label: 'Settings' },
]

/**
 * Find the first Plexo path entry whose pattern matches the text. Returns
 * `null` if nothing matched. Pure for testability.
 */
export function findPlexoPath(text: string): { entry: PlexoPathEntry, match: RegExpMatchArray } | null {
    for (const entry of PLEXO_PATHS) {
        const match = text.match(entry.pattern)
        if (match) return { entry, match }
    }
    return null
}
