// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Injection port for the repo-map file scan (B4).
 *
 * Clean Architecture: the symbol extraction + ranking + formatting logic in
 * `repomap.ts` is pure. Reading the working directory is the adapter's job —
 * this module. The executor calls `getRepoMapPort().scanRepo(workDir)` and
 * never imports `node:fs`/`node:child_process` for the map itself.
 *
 * Default adapter prefers `git ls-files` (exact `.gitignore` semantics, since
 * `sprintWorkDir` is a pre-cloned repo) and falls back to a manual recursive
 * walk over an allowlisted set of code extensions when `git` is absent or
 * fails. Either way it bounds the scan: a max file count and per-file byte cap,
 * skipping binary and unsupported files.
 *
 * Unset (unit tests) → default Node adapter; `setRepoMapPort(null)` restores it.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { SUPPORTED_EXTENSIONS, type RepoMapSource } from './repomap.js'

const MAX_FILES = 400
const MAX_FILE_BYTES = 100 * 1024
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage', '.turbo', 'out', 'target'])

export interface RepoMapPort {
    scanRepo(workDir: string): Promise<RepoMapSource[]>
}

function isBinary(buf: Buffer): boolean {
    for (let i = 0; i < Math.min(buf.length, 4096); i++) {
        if (buf[i] === 0) return true
    }
    return false
}

function normalize(relPath: string): string {
    return relPath.replace(/\\/g, '/')
}

function safeRelPath(relPath: string): boolean {
    const p = normalize(relPath).trim()
    if (!p) return false
    if (p.startsWith('/') || p.startsWith('../') || p.includes('/../')) return false
    const idx = p.lastIndexOf('.')
    if (idx < 0) return false
    return SUPPORTED_EXTENSIONS.has(p.slice(idx + 1).toLowerCase())
}

function listRepoFiles(workDir: string): string[] {
    try {
        const out = execFileSync('git', ['-C', workDir, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
            encoding: 'utf8',
            maxBuffer: 16 * 1024 * 1024,
            stdio: ['ignore', 'pipe', 'ignore'],
        })
        return out.split('\0').map(normalize).filter(safeRelPath)
    } catch {
        return manualWalk(workDir)
    }
}

function manualWalk(workDir: string): string[] {
    const out: string[] = []
    const visit = (dir: string): void => {
        let entries: import('node:fs').Dirent[]
        try {
            entries = readdirSync(dir, { withFileTypes: true, encoding: 'utf8' }) as import('node:fs').Dirent[]
        } catch {
            return
        }
        for (const ent of entries) {
            if (ent.isDirectory()) {
                if (SKIP_DIRS.has(ent.name)) continue
                visit(join(dir, ent.name))
            } else if (ent.isFile()) {
                const rel = normalize(relative(workDir, join(dir, ent.name)))
                if (safeRelPath(rel)) out.push(rel)
            }
        }
    }
    visit(workDir)
    return out
}

class NodeRepoMapAdapter implements RepoMapPort {
    async scanRepo(workDir: string): Promise<RepoMapSource[]> {
        const relPaths = listRepoFiles(workDir)
        const out: RepoMapSource[] = []
        for (const relPath of relPaths) {
            if (out.length >= MAX_FILES) break
            const abs = join(workDir, relPath)
            let stat: import('node:fs').Stats
            try {
                stat = statSync(abs)
            } catch {
                continue
            }
            if (!stat.isFile() || stat.size === 0 || stat.size > MAX_FILE_BYTES) continue
            let buf: Buffer
            try {
                buf = readFileSync(abs)
            } catch {
                continue
            }
            if (isBinary(buf)) continue
            out.push({ relPath, source: buf.toString('utf8') })
        }
        return out
    }
}

let port: RepoMapPort = new NodeRepoMapAdapter()

export function setRepoMapPort(p: RepoMapPort | null): void {
    port = p ?? new NodeRepoMapAdapter()
}

export function getRepoMapPort(): RepoMapPort {
    return port
}