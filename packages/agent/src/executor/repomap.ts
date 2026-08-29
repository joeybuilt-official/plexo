// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Repo-map (B4): a pure, dependency-free symbol map of a working directory.
 *
 * The executor injects a compact, relevance-ranked list of file paths + their
 * top-level symbols into the cached stable prefix of the system prompt, so the
 * model gets global code awareness without shipping file bodies; it then
 * requests specific files via read_file on demand.
 *
 * This module is deliberately PURPOSED as the "business rule" half of the
 * feature: no `node:*` imports, no config, no IO. Where the files come from is
 * the adapter's job (`repomap-port.ts`). Symbol extraction is a heuristic
 * lexer (operator decision, 2026-08-28) — a future tree-sitter adapter can
 * swap in behind the same `RepoMapPort` without touching this ranking/format
 * logic.
 *
 * Design constraints:
 *  - Only top-level (column-0) symbols are extracted, so function-local
 *    `const`/`let`/`def` do not flood the map.
 *  - Symbols carry name + kind + line only — never signatures or literal
 *    values — so the map cannot leak secrets embedded in source (e.g. a
 *    hardcoded `const apiKey = '…'` contributes the name `apiKey`, never the
 *    value).
 */

// ── Types ───────────────────────────────────────────────────────────────────

export type Language =
    | 'typescript'
    | 'javascript'
    | 'python'
    | 'go'
    | 'rust'
    | 'c'
    | 'cpp'
    | 'java'
    | 'kotlin'
    | 'swift'
    | 'ruby'
    | 'php'
    | 'shell'
    | 'unknown'

export interface RepoSymbol {
    name: string
    kind: string
    line: number
}

export interface RepoMapSource {
    /** Path relative to the workdir, '/'-separated. */
    relPath: string
    source: string
}

export interface RepoMapOptions {
    /** Free-text relevance signals (goal + SCL context). Ranked lexically. */
    query?: string[]
    maxFiles?: number
    maxSymbolsPerFile?: number
    maxOutputChars?: number
}

// ── Language detection ─────────────────────────────────────────────────────

const EXTENSION_LANGUAGE: Record<string, Language> = {
    ts: 'typescript',
    tsx: 'typescript',
    mts: 'typescript',
    cts: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    py: 'python',
    go: 'go',
    rs: 'rust',
    c: 'c',
    h: 'c',
    cpp: 'cpp',
    cc: 'cpp',
    cxx: 'cpp',
    hpp: 'cpp',
    hh: 'cpp',
    java: 'java',
    kt: 'kotlin',
    kts: 'kotlin',
    swift: 'swift',
    rb: 'ruby',
    php: 'php',
    sh: 'shell',
    bash: 'shell',
    zsh: 'shell',
}

/** Extensions the repo-map reads at all. Single source of truth for the adapter filter. */
export const SUPPORTED_EXTENSIONS = new Set(Object.keys(EXTENSION_LANGUAGE))

export function languageForPath(relPath: string): Language {
    const idx = relPath.lastIndexOf('.')
    if (idx < 0) return 'unknown'
    const ext = relPath.slice(idx + 1).toLowerCase()
    return EXTENSION_LANGUAGE[ext] ?? 'unknown'
}

// ── Symbol extractors (heuristic, column-0 only) ───────────────────────────

interface Pattern {
    re: RegExp
    kind: string
}

const TS_PATTERNS: Pattern[] = [
    { re: /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/, kind: 'function' },
    { re: /^(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: 'class' },
    { re: /^(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/, kind: 'interface' },
    { re: /^(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/, kind: 'type' },
    { re: /^(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/, kind: 'enum' },
    { re: /^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)(?=\s*[:=])/, kind: 'const' },
    { re: /^(?:export\s+)?let\s+([A-Za-z_$][\w$]*)(?=\s*[:=])/, kind: 'let' },
    { re: /^(?:export\s+)?var\s+([A-Za-z_$][\w$]*)(?=\s*[:=])/, kind: 'var' },
]

const PY_PATTERNS: Pattern[] = [
    { re: /^(?:async\s+)?def\s+([A-Za-z_]\w*)/, kind: 'function' },
    { re: /^class\s+([A-Za-z_]\w*)/, kind: 'class' },
    { re: /^([A-Z_a-z][A-Za-z_0-9]*)\s*=(?!=)/, kind: 'const' },
]

const GO_PATTERNS: Pattern[] = [
    { re: /^func\s+(?:\([^)]*\)\s+)?([A-Za-z_]\w*)\s*\(/, kind: 'function' },
    { re: /^type\s+([A-Za-z_]\w*)/, kind: 'type' },
    { re: /^(?:var|const)\s+([A-Za-z_]\w*)/, kind: 'const' },
]

const RUST_PATTERNS: Pattern[] = [
    { re: /^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+|unsafe\s+|const\s+)?fn\s+([A-Za-z_]\w*)/, kind: 'function' },
    { re: /^(?:pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z_]\w*)/, kind: 'struct' },
    { re: /^(?:pub(?:\([^)]*\))?\s+)?enum\s+([A-Za-z_]\w*)/, kind: 'enum' },
    { re: /^(?:pub(?:\([^)]*\))?\s+)?trait\s+([A-Za-z_]\w*)/, kind: 'trait' },
    { re: /^(?:pub(?:\([^)]*\))?\s+)?impl(?:\s*<[^>]*>)?\s+(?:[A-Za-z_]\w*\s+for\s+)?([A-Za-z_]\w*)/, kind: 'impl' },
    { re: /^(?:pub(?:\([^)]*\))?\s+)?(?:type|const|static)\s+([A-Za-z_]\w*)/, kind: 'const' },
]

const C_PATTERNS: Pattern[] = [
    { re: /^\s*(?:typedef\s+)?(?:struct|union|enum|class)\s+([A-Za-z_]\w*)/, kind: 'type' },
]

const JAVA_KOTLIN_PATTERNS: Pattern[] = [
    { re: /^\s*(?:public\s+|private\s+|protected\s+|static\s+|final\s+|abstract\s+|open\s+|data\s+|sealed\s+|internal\s+)*(?:class|interface|enum|object)\s+([A-Za-z_]\w*)/, kind: 'type' },
]

const SWIFT_PATTERNS: Pattern[] = [
    { re: /^\s*(?:public\s+|private\s+|internal\s+|open\s+|final\s+)*(?:class|struct|enum|protocol)\s+([A-Za-z_]\w*)/, kind: 'type' },
    { re: /^\s*(?:public\s+|private\s+|internal\s+|open\s+)?func\s+([A-Za-z_]\w*)/, kind: 'function' },
]

const RUBY_PATTERNS: Pattern[] = [
    { re: /^\s*(?:class|module)\s+([A-Za-z_]\w*)/, kind: 'type' },
    { re: /^\s*def\s+([A-Za-z_]\w*)/, kind: 'function' },
]

const PHP_PATTERNS: Pattern[] = [
    { re: /^\s*(?:abstract\s+)?(?:class|interface|trait)\s+([A-Za-z_]\w*)/, kind: 'type' },
    { re: /^\s*(?:public\s+|protected\s+|private\s+|static\s+)*function\s+([A-Za-z_]\w*)/, kind: 'function' },
]

const SHELL_PATTERNS: Pattern[] = [
    { re: /^\s*([A-Za-z_][A-Za-z0-9_-]*)\s*\(\s*\)\s*\{/, kind: 'function' },
]

const EMPTY_PATTERNS: Pattern[] = []

const PATTERNS_BY_LANGUAGE: Record<Language, Pattern[]> = {
    typescript: TS_PATTERNS,
    javascript: TS_PATTERNS,
    python: PY_PATTERNS,
    go: GO_PATTERNS,
    rust: RUST_PATTERNS,
    c: C_PATTERNS,
    cpp: C_PATTERNS,
    java: JAVA_KOTLIN_PATTERNS,
    kotlin: JAVA_KOTLIN_PATTERNS,
    swift: SWIFT_PATTERNS,
    ruby: RUBY_PATTERNS,
    php: PHP_PATTERNS,
    shell: SHELL_PATTERNS,
    unknown: EMPTY_PATTERNS,
}

export function extractSymbols(relPath: string, source: string): RepoSymbol[] {
    const lang = languageForPath(relPath)
    if (lang === 'unknown') return []
    const patterns = PATTERNS_BY_LANGUAGE[lang]
    const lines = source.split('\n')
    const out: RepoSymbol[] = []
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!
        for (const p of patterns) {
            const m = p.re.exec(line)
            if (m && m[1]) {
                out.push({ name: m[1], kind: p.kind, line: i + 1 })
                break
            }
        }
    }
    return out
}

// ── Relevance ranking ──────────────────────────────────────────────────────

const STOPWORDS = new Set([
    'the', 'and', 'for', 'with', 'this', 'that', 'from', 'into', 'over', 'under',
    'your', 'you', 'are', 'was', 'were', 'have', 'has', 'had', 'not', 'will',
    'would', 'should', 'could', 'can', 'may', 'but', 'all', 'any', 'each', 'some',
    'its', 'our', 'out', 'off', 'then', 'than', 'them', 'their', 'what', 'when',
    'how', 'why', 'who', 'which', 'where', 'does', 'doing', 'make', 'makes', 'made',
    'just', 'very', 'also', 'only', 'about', 'there', 'here', 'need', 'needs',
])

function tokenizeQuery(text: string): string[] {
    return (text.toLowerCase().match(/[a-z0-9_$]+/g) ?? [])
        .filter((t) => t.length >= 3 && !STOPWORDS.has(t))
}

function pathSegments(relPath: string): string[] {
    return relPath.replace(/\\/g, '/').split('/').filter(Boolean)
}

function scoreFile(relPath: string, symbols: RepoSymbol[], tokens: string[]): number {
    if (tokens.length === 0) return 0
    const segs = pathSegments(relPath)
    const baseNoExt = (segs[segs.length - 1] ?? '').replace(/\.[^.]+$/, '').toLowerCase()
    const segNames = segs.map((s) => s.toLowerCase())
    const symbolNames = symbols.map((s) => s.name.toLowerCase())
    let score = 0
    for (const t of tokens) {
        if (baseNoExt.includes(t)) score += 4
        else if (segNames.some((s) => s.includes(t))) score += 3
        const symHits = symbolNames.filter((n) => n.includes(t) || t.includes(n)).length
        score += Math.min(symHits, 5)
    }
    return score
}

// ── Map builder ────────────────────────────────────────────────────────────

export function buildRepoMap(files: RepoMapSource[], opts: RepoMapOptions = {}): string {
    const maxFiles = opts.maxFiles ?? 200
    const maxSymbolsPerFile = opts.maxSymbolsPerFile ?? 60
    const maxOutputChars = opts.maxOutputChars ?? 12_000

    const tokens = [...new Set((opts.query ?? []).flatMap(tokenizeQuery))]

    const entries: Array<{ relPath: string; symbols: RepoSymbol[]; score: number; depth: number }> = []
    for (const f of files) {
        const symbols = extractSymbols(f.relPath, f.source)
        if (symbols.length === 0) continue
        symbols.sort((a, b) => a.line - b.line)
        entries.push({
            relPath: pathSegments(f.relPath).join('/'),
            symbols,
            score: scoreFile(f.relPath, symbols, tokens),
            depth: pathSegments(f.relPath).length,
        })
    }

    entries.sort((a, b) =>
        (b.score - a.score)
        || (a.depth - b.depth)
        || (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0),
    )

    const title = 'REPOSITORY MAP (top-level symbols; read_file any path for full detail):'
    const lines: string[] = [title]
    let used = title.length + 1
    let fileCount = 0

    for (const entry of entries) {
        if (fileCount >= maxFiles) break
        if (used + entry.relPath.length + 1 > maxOutputChars) break
        lines.push(entry.relPath)
        used += entry.relPath.length + 1
        fileCount++
        let symbolCount = 0
        for (const s of entry.symbols) {
            if (symbolCount >= maxSymbolsPerFile) break
            const line = `  ${s.kind} ${s.name} :${s.line}`
            if (used + line.length + 1 > maxOutputChars) break
            lines.push(line)
            used += line.length + 1
            symbolCount++
        }
    }

    if (lines.length <= 1) return ''
    return lines.join('\n')
}