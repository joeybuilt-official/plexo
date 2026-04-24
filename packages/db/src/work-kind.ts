// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 2 — WorkKind taxonomy
//
// A Work is any agent-produced output saved via `write_asset`. The `kind`
// tells the UI how to render it, independent of file extension. See
// docs/works-plan/next/phase-2-work-kind-taxonomy.md.
//
// This module is the single source of truth for:
//   - the enum values
//   - the inference fallback used when the agent forgets to declare `kind`
//   - a lightweight language hint for code/config kinds

export const WORK_KINDS = [
    'markdown',      // default, free-form structured markdown
    'instructions',  // step-by-step guide; renderer adds link enrichment
    'code',          // source code; language from ext; copy/download
    'html',          // HTML fragment; preview + code tabs
    'mockup',        // full-page visual UI mockup; rendered no-chrome
    'json',          // structured data; tree view
    'yaml',          // same
    'table',         // tabular data; renders as DataTable
    'checklist',     // interactive steps with persistent state
    'image',         // raster image
    'diagram',       // mermaid/plantuml/etc.
    'chart',         // data viz spec (vega-lite-ish, deferred)
    'config',        // config file with copy + "apply to workspace"
    'link-list',     // curated list of links
    'file',          // opaque blob / binary fallback
] as const

export type WorkKind = typeof WORK_KINDS[number]

/** Map of file extension (no dot, lowercase) → { kind, language? }. */
const EXT_MAP: Record<string, { kind: WorkKind, language?: string }> = {
    // docs
    md: { kind: 'markdown' },
    markdown: { kind: 'markdown' },
    mdx: { kind: 'markdown' },
    txt: { kind: 'markdown' },
    // structured
    json: { kind: 'json' },
    yaml: { kind: 'yaml' },
    yml: { kind: 'yaml' },
    // code
    ts: { kind: 'code', language: 'typescript' },
    tsx: { kind: 'code', language: 'tsx' },
    js: { kind: 'code', language: 'javascript' },
    jsx: { kind: 'code', language: 'jsx' },
    mjs: { kind: 'code', language: 'javascript' },
    cjs: { kind: 'code', language: 'javascript' },
    py: { kind: 'code', language: 'python' },
    rb: { kind: 'code', language: 'ruby' },
    go: { kind: 'code', language: 'go' },
    rs: { kind: 'code', language: 'rust' },
    java: { kind: 'code', language: 'java' },
    kt: { kind: 'code', language: 'kotlin' },
    swift: { kind: 'code', language: 'swift' },
    c: { kind: 'code', language: 'c' },
    h: { kind: 'code', language: 'c' },
    cpp: { kind: 'code', language: 'cpp' },
    hpp: { kind: 'code', language: 'cpp' },
    cs: { kind: 'code', language: 'csharp' },
    php: { kind: 'code', language: 'php' },
    sh: { kind: 'code', language: 'bash' },
    bash: { kind: 'code', language: 'bash' },
    zsh: { kind: 'code', language: 'bash' },
    sql: { kind: 'code', language: 'sql' },
    // web
    html: { kind: 'html' },
    htm: { kind: 'html' },
    // tabular
    csv: { kind: 'table' },
    tsv: { kind: 'table' },
    // config
    toml: { kind: 'config', language: 'toml' },
    ini: { kind: 'config', language: 'ini' },
    env: { kind: 'config', language: 'dotenv' },
    conf: { kind: 'config', language: 'ini' },
    // images
    png: { kind: 'image' },
    jpg: { kind: 'image' },
    jpeg: { kind: 'image' },
    gif: { kind: 'image' },
    webp: { kind: 'image' },
    svg: { kind: 'image' },
    // diagrams
    mmd: { kind: 'diagram', language: 'mermaid' },
    mermaid: { kind: 'diagram', language: 'mermaid' },
    puml: { kind: 'diagram', language: 'plantuml' },
}

/** Dockerfile, Makefile, etc. — match on bare filename. */
const FILENAME_MAP: Record<string, { kind: WorkKind, language?: string }> = {
    dockerfile: { kind: 'config', language: 'dockerfile' },
    makefile: { kind: 'code', language: 'makefile' },
    '.gitignore': { kind: 'config' },
    '.env': { kind: 'config', language: 'dotenv' },
}

export interface InferKindResult {
    kind: WorkKind
    language?: string
}

/**
 * Infer WorkKind + optional language hint from filename + (optional) content.
 *
 * Falls back to `markdown` for unknown text-ish extensions, `file` otherwise.
 *
 * Content hints:
 *   - A `.md` file whose content looks like numbered steps is promoted to
 *     `instructions`.
 *   - A `.md` file whose content is a bullet list of URLs is promoted to
 *     `link-list`.
 */
export function inferKind(filename: string, content?: string): InferKindResult {
    const base = filename.split('/').pop() || filename
    const lower = base.toLowerCase()

    // Bare-filename match first (Dockerfile, Makefile, .env, ...)
    if (FILENAME_MAP[lower]) return { ...FILENAME_MAP[lower]! }

    const dotIdx = lower.lastIndexOf('.')
    const ext = dotIdx >= 0 ? lower.slice(dotIdx + 1) : ''
    const byExt = EXT_MAP[ext]

    if (byExt) {
        // Content-aware promotion for markdown-ish files.
        if (byExt.kind === 'markdown' && content) {
            if (looksLikeInstructions(content)) return { kind: 'instructions' }
            if (looksLikeLinkList(content)) return { kind: 'link-list' }
        }
        return { ...byExt }
    }

    // Unknown extension: if content looks text-ish, treat as markdown;
    // otherwise fall through to opaque file.
    if (content && content.length > 0) return { kind: 'markdown' }
    return { kind: 'file' }
}

function looksLikeInstructions(content: string): boolean {
    // "1. Do a thing" on at least 3 lines, or "Step N:" pattern.
    const numbered = content.match(/^\s*\d+\.\s+\S/gm)
    if (numbered && numbered.length >= 3) return true
    if (/^\s*Step\s+\d+[:.]/mi.test(content)) return true
    return false
}

function looksLikeLinkList(content: string): boolean {
    const bulletLines = content.split('\n').filter(l => /^\s*[-*]\s/.test(l))
    if (bulletLines.length < 3) return false
    const linkish = bulletLines.filter(l => /\bhttps?:\/\//.test(l) || /\]\(\S+\)/.test(l))
    return linkish.length / bulletLines.length >= 0.7
}

/**
 * Derive a best-effort `artifacts.type` value from a WorkKind, for writing
 * the legacy column while still supporting the new taxonomy. The legacy
 * column is still NOT NULL in the DB.
 */
export function kindToLegacyType(kind: WorkKind): string {
    switch (kind) {
        case 'markdown':
        case 'instructions':
        case 'checklist':
        case 'link-list':
            return 'markdown'
        case 'code':
        case 'config':
            return 'code'
        case 'html':
        case 'mockup':
            return 'html'
        case 'diagram':
            return 'diagram'
        case 'image':
            return 'image'
        case 'json':
        case 'yaml':
        case 'table':
        case 'chart':
            return 'file'
        case 'file':
        default:
            return 'file'
    }
}
