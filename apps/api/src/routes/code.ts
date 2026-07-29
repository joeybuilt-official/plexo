// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Code Mode API — serves file tree and file content for active sprint working dirs.
 *
 * Security:
 *  - All paths are containment-checked against the task's sprintWorkDir.
 *  - workspaceId must match the task's workspace_id (prevent cross-workspace reads).
 *  - Only active tasks (status != 'complete'/'cancelled') expose a tree/file.
 *  - Max 2000 files returned in /tree to bound response size.
 */

import { Router, type Router as RouterType } from 'express'
import { join, resolve, relative, basename, extname } from 'node:path'
import { stat as statAsync, readFile as readFileAsync, readdir as readdirAsync } from 'node:fs/promises'
import * as tasksRepo from '../repositories/tasks.repository.js'
import { UUID_RE } from '../validation.js'
import { logger } from '../logger.js'

export const codeRouter: RouterType = Router()


// ── In-memory task context store (populated by agent-loop when a task starts) ──
// The agent-loop calls registerCodeContext() when it sets up sprintWorkDir.
// Keyed taskId → { workspaceId, sprintWorkDir }

const codeContexts = new Map<string, { workspaceId: string; sprintWorkDir: string }>()

export function registerCodeContext(taskId: string, workspaceId: string, sprintWorkDir: string): void {
    codeContexts.set(taskId, { workspaceId, sprintWorkDir })
}

export function unregisterCodeContext(taskId: string): void {
    codeContexts.delete(taskId)
}

// Expose registered contexts so SSE/Code Mode UIs can discover active task dirs
export function listCodeContexts(workspaceId: string): Array<{ taskId: string; sprintWorkDir: string }> {
    const result: Array<{ taskId: string; sprintWorkDir: string }> = []
    for (const [taskId, ctx] of codeContexts) {
        if (ctx.workspaceId === workspaceId) {
            result.push({ taskId, sprintWorkDir: ctx.sprintWorkDir })
        }
    }
    return result
}

// Directories to skip entirely (noise / security boundary)
const SKIP_DIRS = new Set(['.git', 'node_modules', '.pnpm', 'dist', '.next', '__pycache__', '.venv', 'venv'])

interface FileNode {
    path: string       // relative to sprintWorkDir
    name: string       // basename
    size: number       // bytes
    mtime: number      // unix ms
    ext: string        // e.g. '.ts'
}

async function walkDir(dir: string, base: string, results: FileNode[], limit: number): Promise<void> {
    if (results.length >= limit) return
    let entries: string[]
    try { entries = await readdirAsync(dir) } catch { return }

    for (const entry of entries) {
        if (results.length >= limit) return
        if (entry.startsWith('.') && entry !== '.env.example') continue // skip dotfiles except example
        const abs = join(dir, entry)
        let s
        try { s = await statAsync(abs) } catch { continue }
        if (s.isDirectory()) {
            if (SKIP_DIRS.has(entry)) continue
            await walkDir(abs, base, results, limit)
        } else {
            results.push({
                path: relative(base, abs),
                name: basename(abs),
                size: s.size,
                mtime: s.mtimeMs,
                ext: extname(abs),
            })
        }
    }
}

// ── GET /code/contexts — list active sprint contexts for a workspace ──────────
codeRouter.get('/contexts', (req, res) => {
    const workspaceId = req.query.workspaceId as string
    if (!workspaceId || !UUID_RE.test(workspaceId)) {
        return void res.status(400).json({ error: 'Invalid workspaceId' })
    }
    const contexts = listCodeContexts(workspaceId)
    return void res.json({ contexts })
})

// ── GET /code/tree — flat file listing for active task sprintWorkDir ──────────
codeRouter.get('/tree', async (req, res) => {
    const workspaceId = req.query.workspaceId as string
    const taskId = req.query.taskId as string

    if (!workspaceId || !UUID_RE.test(workspaceId)) return void res.status(400).json({ error: 'Invalid workspaceId' })
    if (!taskId || !UUID_RE.test(taskId)) return void res.status(400).json({ error: 'Invalid taskId' })

    // Check in-memory context first (fastest path)
    const ctx = codeContexts.get(taskId)
    let sprintWorkDir: string | undefined = ctx?.workspaceId === workspaceId ? ctx.sprintWorkDir : undefined

    // Fallback: look up from DB (e.g. after an API restart during active task)
    if (!sprintWorkDir) {
        try {
            const task = await tasksRepo.getTaskWorkspaceContextScoped(taskId, workspaceId)
            if (!task) return void res.status(404).json({ error: 'Task not found' })
            const ctx2 = task.context as Record<string, unknown>
            sprintWorkDir = typeof ctx2.sprintWorkDir === 'string' ? ctx2.sprintWorkDir : undefined
        } catch (err) {
            logger.error({ err, taskId, workspaceId }, 'GET /code/tree: DB lookup failed')
            return void res.status(500).json({ error: 'DB error' })
        }
    }

    if (!sprintWorkDir) return void res.status(404).json({ error: 'No active code context for this task' })

    // Verify dir exists and is accessible
    try { await statAsync(sprintWorkDir) } catch (err) {
        logger.warn({ err, taskId, sprintWorkDir }, 'GET /code/tree: sprint work directory not found')
        return void res.status(404).json({ error: 'Sprint work directory not found' })
    }

    const files: FileNode[] = []
    await walkDir(sprintWorkDir, sprintWorkDir, files, 2000)
    files.sort((a, b) => a.path.localeCompare(b.path))

    return void res.json({ sprintWorkDir, files })
})

// ── GET /code/file — content of a single file in the sprint workdir ───────────
codeRouter.get('/file', async (req, res) => {
    const workspaceId = req.query.workspaceId as string
    const taskId = req.query.taskId as string
    const filePath = req.query.path as string

    if (!workspaceId || !UUID_RE.test(workspaceId)) return void res.status(400).json({ error: 'Invalid workspaceId' })
    if (!taskId || !UUID_RE.test(taskId)) return void res.status(400).json({ error: 'Invalid taskId' })
    if (!filePath || typeof filePath !== 'string') return void res.status(400).json({ error: 'Missing path' })

    const ctx = codeContexts.get(taskId)
    let sprintWorkDir: string | undefined = ctx?.workspaceId === workspaceId ? ctx.sprintWorkDir : undefined

    if (!sprintWorkDir) {
        try {
            const task = await tasksRepo.getTaskWorkspaceContextScoped(taskId, workspaceId)
            if (!task) return void res.status(404).json({ error: 'Task not found' })
            const ctx2 = task.context as Record<string, unknown>
            sprintWorkDir = typeof ctx2.sprintWorkDir === 'string' ? ctx2.sprintWorkDir : undefined
        } catch (err) {
            logger.error({ err, taskId, workspaceId }, 'GET /code/file: DB lookup failed')
            return void res.status(500).json({ error: 'DB error' })
        }
    }

    if (!sprintWorkDir) return void res.status(404).json({ error: 'No active code context for this task' })

    // ── Path traversal protection ─────────────────────────────────────────────
    const absPath = resolve(sprintWorkDir, filePath)
    if (!absPath.startsWith(resolve(sprintWorkDir) + '/') && absPath !== resolve(sprintWorkDir)) {
        return void res.status(400).json({ error: 'Path traversal not allowed' })
    }

    try {
        const s = await statAsync(absPath)
        if (!s.isFile()) return void res.status(400).json({ error: 'Not a file' })
        if (s.size > 1024 * 1024) return void res.status(413).json({ error: 'File too large (>1MB)' })

        const content = await readFileAsync(absPath, 'utf8')
        return void res.json({ path: filePath, content, size: s.size, mtime: s.mtimeMs })
    } catch (err) {
        logger.warn({ err, taskId, filePath }, 'GET /code/file: file read failed')
        return void res.status(404).json({ error: 'File not found' })
    }
})
