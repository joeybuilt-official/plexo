// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Pure helpers for the code-editing toolset (edit_file, grep, glob).
 * Kept framework-free and side-effect-light so they can be unit-tested
 * without driving the full executor, and reused by both the in-process
 * dispatcher and the ToolWorker (tool-runner.ts).
 */

import { readFileSync, readdirSync } from 'node:fs'
import { basename, join, relative } from 'node:path'

// ── edit_file: unified-diff/patch application ──────────────────────────────

export interface PatchResult {
    result: string
    bytesChanged: number
}

export class PatchError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'PatchError'
    }
}

interface Hunk {
    oldStart: number
    oldLen: number
    newStart: number
    newLen: number
    body: string[]
}

function parseHunks(patch: string): Hunk[] {
    const patchLines = patch.split('\n')
    const hunks: Hunk[] = []
    let i = 0
    // Skip file header lines (--- / +++) until the first hunk
    while (i < patchLines.length && !patchLines[i]!.startsWith('@@')) i++
    while (i < patchLines.length) {
        const line = patchLines[i]!
        const m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/)
        if (!m) throw new PatchError(`Malformed hunk header: ${line}`)
        const oldStart = Number(m[1])
        const oldLen = m[2] !== undefined ? Number(m[2]) : 1
        const newStart = Number(m[3])
        const newLen = m[4] !== undefined ? Number(m[4]) : 1
        const body: string[] = []
        i++
        while (i < patchLines.length && !patchLines[i]!.startsWith('@@')) {
            body.push(patchLines[i]!)
            i++
        }
        hunks.push({ oldStart, oldLen, newStart, newLen, body })
    }
    if (hunks.length === 0) throw new PatchError('No hunks found in patch')
    return hunks
}

/**
 * Apply a unified-diff patch to `content`. Verifies every context line
 * matches at the hunk's stated position. Throws PatchError on any
 * mismatch — never writes a partial result.
 */
export function applyUnifiedPatch(content: string, patch: string): PatchResult {
    const lines = content.split('\n')
    const hunks = parseHunks(patch)
    const out = [...lines]
    let offset = 0

    for (const h of hunks) {
        const expectOld: string[] = []
        const newLines: string[] = []
        for (const b of h.body) {
            if (b === '' ) {
                // Editor-stripped context blank line
                expectOld.push('')
                newLines.push('')
            } else if (b.startsWith(' ')) {
                expectOld.push(b.slice(1))
                newLines.push(b.slice(1))
            } else if (b.startsWith('-')) {
                expectOld.push(b.slice(1))
            } else if (b.startsWith('+')) {
                newLines.push(b.slice(1))
            } else if (b.startsWith('\\')) {
                // "\\ No newline at end of file" marker — ignore
                continue
            } else {
                throw new PatchError(`Invalid patch line prefix: ${JSON.stringify(b)}`)
            }
        }

        const startIdx = Math.max(0, h.oldStart - 1) + offset
        for (let j = 0; j < expectOld.length; j++) {
            const actual = out[startIdx + j]
            if (actual === undefined) {
                throw new PatchError(
                    `Hunk at line ${h.oldStart} exceeds file length (expected ${expectOld.length} old lines, file ended at ${out.length})`,
                )
            }
            if (actual !== expectOld[j]) {
                throw new PatchError(
                    `Context mismatch at line ${h.oldStart + j}: expected ${JSON.stringify(expectOld[j])}, got ${JSON.stringify(actual)}`,
                )
            }
        }
        out.splice(startIdx, expectOld.length, ...newLines)
        offset += newLines.length - expectOld.length
    }

    const result = out.join('\n')
    const bytesChanged = Buffer.byteLength(result, 'utf8') - Buffer.byteLength(content, 'utf8')
    return { result, bytesChanged }
}

// ── glob → RegExp (minimal picomatch-style: *, **, ?, {a,b}) ────────────────

/** Convert a picomatch-style pattern to a RegExp matching a relative path. */
export function globToRegExp(pattern: string): RegExp {
    let i = 0
    let out = ''
    while (i < pattern.length) {
        const c = pattern[i]!
        if (c === '*') {
            if (pattern[i + 1] === '*') {
                i += 2
                if (pattern[i] === '/') i++ // consume trailing slash → ** matches across segments
                out += '.*'
            } else {
                out += '[^/]*'
                i++
            }
        } else if (c === '?') {
            out += '[^/]'
            i++
        } else if (c === '{') {
            const end = pattern.indexOf('}', i)
            if (end === -1) { out += '\\{'; i++; continue }
            const alts = pattern.slice(i + 1, end).split(',').map(escapeRegexSegment)
            out += `(?:${alts.join('|')})`
            i = end + 1
        } else if (c === '[') {
            const end = pattern.indexOf(']', i)
            if (end === -1) { out += '\\['; i++; continue }
            out += pattern.slice(i, end + 1)
            i = end + 1
        } else {
            out += escapeRegexChar(c)
            i++
        }
    }
    return new RegExp(`^${out}$`)
}

function escapeRegexChar(c: string): string {
    return /[.*+?^${}()|[\]\\]/.test(c) ? '\\' + c : c
}

function escapeRegexSegment(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ── directory walk (skips node_modules, .git, binary files) ─────────────────

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage'])

function isBinary(buf: Buffer): boolean {
    for (let i = 0; i < Math.min(buf.length, 4096); i++) {
        if (buf[i] === 0) return true
    }
    return false
}

export interface WalkEntry {
    absPath: string
    relPath: string
    isDir: boolean
}

/** Recursive walk — depth-first, yields files (and dirs when includeDirs). */
export function walkDir(
    root: string,
    opts: { includeDirs?: boolean } = {},
): WalkEntry[] {
    const out: WalkEntry[] = []
    const visit = (dir: string): void => {
        let entries: import('node:fs').Dirent[]
        try { entries = readdirSync(dir, { withFileTypes: true, encoding: 'utf8' }) as import('node:fs').Dirent[] }
        catch { return }
        for (const ent of entries) {
            if (ent.isDirectory()) {
                if (SKIP_DIRS.has(ent.name)) continue
                const abs = join(dir, ent.name)
                if (opts.includeDirs) out.push({ absPath: abs, relPath: relative(root, abs), isDir: true })
                visit(abs)
            } else if (ent.isFile()) {
                const abs = join(dir, ent.name)
                out.push({ absPath: abs, relPath: relative(root, abs), isDir: false })
            }
        }
    }
    visit(root)
    return out
}

// ── grep ────────────────────────────────────────────────────────────────────

export interface GrepOptions {
    root: string
    pattern: string
    glob?: string
    ignoreCase?: boolean
    maxResults?: number
}

export interface GrepRow {
    file: string
    line: number
    match: string
}

export function grepSearchSync(opts: GrepOptions): GrepRow[] {
    const max = opts.maxResults ?? 200
    const flags = opts.ignoreCase ? 'i' : ''
    let re: RegExp
    try {
        re = new RegExp(opts.pattern, flags)
    } catch {
        re = new RegExp(escapeRegexSegment(opts.pattern), flags)
    }
    const globRe = opts.glob ? globToRegExp(opts.glob) : null
    const rows: GrepRow[] = []
    for (const e of walkDir(opts.root)) {
        if (rows.length >= max) break
        if (e.isDir) continue
        if (globRe && !globRe.test(e.relPath) && !globRe.test(basename(e.relPath))) continue
        let buf: Buffer
        try { buf = readFileSync(e.absPath) }
        catch { continue }
        if (isBinary(buf)) continue
        const text = buf.toString('utf8')
        const parts = text.split('\n')
        for (let i = 0; i < parts.length && rows.length < max; i++) {
            if (re.test(parts[i]!)) {
                rows.push({ file: e.relPath, line: i + 1, match: parts[i]!.slice(0, 500) })
            }
        }
    }
    return rows
}

// ── glob ────────────────────────────────────────────────────────────────────

export interface GlobOptions {
    root: string
    pattern: string
    limit?: number
}

export function globSearchSync(opts: GlobOptions): string[] {
    const limit = opts.limit ?? 200
    const re = globToRegExp(opts.pattern)
    const out: string[] = []
    for (const e of walkDir(opts.root, { includeDirs: false })) {
        if (out.length >= limit) break
        if (re.test(e.relPath) || re.test(basename(e.relPath))) out.push(e.relPath)
    }
    return out
}

/** Format grep rows as `file:line: match` lines for tool output. */
export function formatGrepRows(rows: GrepRow[]): string {
    if (rows.length === 0) return '(no matches)'
    return rows.map(r => `${r.file}:${r.line}: ${r.match}`).join('\n')
}