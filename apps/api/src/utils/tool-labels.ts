// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

function truncate(s: string, n: number): string {
    return s.length > n ? s.slice(0, n) + '…' : s
}

/**
 * Convert a tool name + input into a short human-readable phrase.
 * Returns lowercase (e.g. "reading config.ts"). Callers capitalise as needed.
 */
export function describeToolCall(tool: string, input?: Record<string, unknown>): string {
    const inp = input ?? {}
    const str = (k: string): string | undefined =>
        typeof inp[k] === 'string' ? (inp[k] as string) : undefined

    // Namespaced connection tools: e.g. github__get_repo
    if (tool.includes('__')) {
        const sep = tool.indexOf('__')
        const svc = tool.slice(0, sep)
        const action = tool.slice(sep + 2).replace(/_/g, ' ')
        const svcName = svc.charAt(0).toUpperCase() + svc.slice(1)

        if (svc === 'github') {
            const owner = str('owner')
            const repo = str('repo')
            if (owner && repo) return `checking ${owner}/${repo} on GitHub`
            if (owner) return `looking up ${owner} on GitHub`
            const q = str('q') ?? str('query')
            if (q) return `searching GitHub for "${truncate(q, 40)}"`
        }
if (svc === 'linear') return `querying Linear`
        return `${svcName}: ${action}`
    }

    switch (tool) {
        case 'web_search':
        case 'search_web': {
            const q = str('query')
            return q ? `searching the web for "${truncate(q, 60)}"` : 'searching the web'
        }
        case 'web_fetch':
        case 'fetch_url': {
            const url = str('url')
            if (url) {
                try { return `fetching ${new URL(url).hostname}` } catch { /* ignore */ }
            }
            return 'fetching a URL'
        }
        case 'bash':
        case 'shell': {
            const cmd = str('command') ?? ''
            return cmd ? `running: ${truncate(cmd.split('\n')[0]!, 60)}` : 'running a command'
        }
        case 'read_file': {
            const p = str('path')
            return p ? `reading ${p.split('/').pop()}` : 'reading a file'
        }
        case 'write_file':
        case 'edit_file': {
            const p = str('path')
            return p ? `writing ${p.split('/').pop()}` : 'writing a file'
        }
        case 'write_asset': {
            const f = str('filename')
            return f ? `saving ${f}` : 'saving output'
        }
        case 'task_complete': return 'finalising response'
        case 'self_reflect': return 'reviewing progress'
        case 'synthesize_extension': return 'researching API docs'
        case 'glob': return 'searching files'
        case 'grep': return 'searching code'
        default:
            return tool.replace(/_/g, ' ')
    }
}
