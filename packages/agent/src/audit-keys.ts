// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Phase 7 — pure helpers for mapping tool bridge keys to their owning
 * extension. Kept in a DB-free module so unit tests run without the
 * full db runtime.
 */

/**
 * Parse a tool-bridge tool key into its owning extension.
 *
 * Format (see packages/agent/src/plugins/bridge.ts :: toolKey()):
 *   plugin__{scopeSanitized}__{toolName}
 *   where scopeSanitized = extensionName.replace(/^@/, '').replace('/', '_')
 *
 * Returns `null` for non-plugin tool keys (system tools like `task_complete`,
 * `read_file`, etc.) so the caller can fall back to `'system'`.
 */
export function parseToolKey(toolKey: string): { extensionName: string; toolName: string } | null {
    if (!toolKey.startsWith('plugin__')) return null
    const rest = toolKey.slice('plugin__'.length)
    const sep = rest.indexOf('__')
    if (sep < 0) return null
    const scopeSanitized = rest.slice(0, sep)
    const toolName = rest.slice(sep + 2)
    if (!scopeSanitized || !toolName) return null
    // Reverse the sanitization: first underscore becomes slash, prepend @
    const firstUnderscore = scopeSanitized.indexOf('_')
    const extensionName = firstUnderscore >= 0
        ? `@${scopeSanitized.slice(0, firstUnderscore)}/${scopeSanitized.slice(firstUnderscore + 1)}`
        : scopeSanitized
    return { extensionName, toolName }
}
