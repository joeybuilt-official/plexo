// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC
//
// Phase 3 — client-side kind inference fallback.
//
// Used only for works that arrive without a `kind` field (legacy rows or
// filesystem-fallback responses). Mirrors the subset of
// `packages/db/src/work-kind.ts` needed for rendering dispatch. Importing
// `@plexo/db` directly from the browser bundle is avoided because that
// package pulls in `pg` / server deps.

// Local copy of the WorkKind union. Duplicates the definition in
// `apps/web/src/app/app/chat/_components/types.ts` so this module can be
// unit-tested under the repo-root vitest config (which does not alias
// `@web`). The union is kept in sync with `packages/db/src/work-kind.ts`.
export type WorkKind =
    | 'markdown'
    | 'instructions'
    | 'code'
    | 'html'
    | 'mockup'
    | 'json'
    | 'yaml'
    | 'table'
    | 'checklist'
    | 'image'
    | 'diagram'
    | 'chart'
    | 'config'
    | 'link-list'
    | 'file'

/**
 * Pure dispatch helper — no JSX, safe to import from tests. Prefers an
 * explicit `kind` on the work; falls back to extension/content inference.
 */
export function resolveKindFromWork(work: { kind?: WorkKind, filename: string, content?: string | null }): WorkKind {
    return work.kind ?? inferKindClient(work.filename, work.content).kind
}

const EXT_MAP: Record<string, { kind: WorkKind, language?: string }> = {
    md: { kind: 'markdown' },
    markdown: { kind: 'markdown' },
    mdx: { kind: 'markdown' },
    txt: { kind: 'markdown' },
    json: { kind: 'json' },
    yaml: { kind: 'yaml' },
    yml: { kind: 'yaml' },
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
    html: { kind: 'html' },
    htm: { kind: 'html' },
    csv: { kind: 'table' },
    tsv: { kind: 'table' },
    toml: { kind: 'config', language: 'toml' },
    ini: { kind: 'config', language: 'ini' },
    env: { kind: 'config', language: 'dotenv' },
    conf: { kind: 'config', language: 'ini' },
    png: { kind: 'image' },
    jpg: { kind: 'image' },
    jpeg: { kind: 'image' },
    gif: { kind: 'image' },
    webp: { kind: 'image' },
    svg: { kind: 'image' },
    mmd: { kind: 'diagram', language: 'mermaid' },
    mermaid: { kind: 'diagram', language: 'mermaid' },
    puml: { kind: 'diagram', language: 'plantuml' },
}

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

export function inferKindClient(filename: string, content?: string | null): InferKindResult {
    const base = (filename || '').split('/').pop() || filename || ''
    const lower = base.toLowerCase()

    if (FILENAME_MAP[lower]) return { ...FILENAME_MAP[lower]! }

    const dotIdx = lower.lastIndexOf('.')
    const ext = dotIdx >= 0 ? lower.slice(dotIdx + 1) : ''
    const byExt = EXT_MAP[ext]

    if (byExt) {
        if (byExt.kind === 'markdown' && content) {
            if (looksLikeInstructions(content)) return { kind: 'instructions' }
            if (looksLikeLinkList(content)) return { kind: 'link-list' }
        }
        return { ...byExt }
    }

    if (content && content.length > 0) return { kind: 'markdown' }
    return { kind: 'file' }
}

function looksLikeInstructions(content: string): boolean {
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
