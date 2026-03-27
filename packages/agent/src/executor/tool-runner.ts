// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Worker thread entry point for isolated tool execution.
 * Receives tool calls via parentPort messages, executes them,
 * and sends results back. Runs in a separate thread so hangs
 * or crashes don't affect the main agent process.
 */

import { parentPort, workerData } from 'node:worker_threads'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, resolve, isAbsolute } from 'node:path'
import { spawnSync } from 'node:child_process'

const workDir: string = workerData?.workDir ?? process.cwd()

// Switch to the task's working directory
try { process.chdir(workDir) } catch { /* fallback to cwd */ }

interface ToolMessage {
    id: string
    tool: string
    input: Record<string, unknown>
}

interface ToolResult {
    id: string
    output: string
    error?: string
}

parentPort?.on('message', (msg: ToolMessage) => {
    try {
        const output = executeTool(msg.tool, msg.input)
        parentPort?.postMessage({ id: msg.id, output } satisfies ToolResult)
    } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        parentPort?.postMessage({ id: msg.id, output: `ERROR: ${error}`, error } satisfies ToolResult)
    }
})

/**
 * Validate that a resolved path stays within the task working directory.
 * Prevents path traversal attacks (e.g. ../../etc/passwd).
 */
function assertContained(p: string): void {
    const resolved = resolve(p)
    const base = resolve(workDir)
    if (!resolved.startsWith(base + '/') && resolved !== base) {
        throw new Error(`Path traversal blocked: "${p}" escapes work directory`)
    }
}

function executeTool(name: string, input: Record<string, unknown>): string {
    switch (name) {
        case 'read_file': {
            const rawPath = input.path as string
            const p = isAbsolute(rawPath) ? rawPath : resolve(workDir, rawPath)
            assertContained(p)
            return readFileSync(p, 'utf8')
        }

        case 'write_file': {
            const rawPath = input.path as string
            const p = isAbsolute(rawPath) ? rawPath : resolve(workDir, rawPath)
            assertContained(p)
            mkdirSync(dirname(p), { recursive: true })
            const content = input.content as string
            writeFileSync(p, content, 'utf8')
            return `OK: wrote ${content.length} bytes to ${p}`
        }

        case 'shell': {
            const command = input.command as string
            const cwd = (input.cwd as string | undefined) ?? workDir

            // Allowlist safe env vars — never leak secrets
            const SAFE_ENV_KEYS = new Set([
                'PATH', 'HOME', 'USER', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE',
                'NODE_ENV', 'NODE_PATH', 'TMPDIR', 'TMP', 'TEMP',
                'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL',
                'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL',
                'PNPM_HOME', 'npm_config_cache',
                'GITHUB_TOKEN', 'GITHUB_PERSONAL_ACCESS_TOKEN',
                'GITLAB_PERSONAL_ACCESS_TOKEN', 'GITLAB_TOKEN',
                'NPM_TOKEN', 'VERCEL_TOKEN', 'NETLIFY_AUTH_TOKEN',
                'PLEXO_WORKSPACE_ID',
            ])
            const safeEnv: Record<string, string> = {}
            for (const [k, v] of Object.entries(process.env)) {
                if (v !== undefined && SAFE_ENV_KEYS.has(k)) safeEnv[k] = v
            }
            safeEnv.PATH = process.env.PATH ?? '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'

            const result = spawnSync('sh', ['-c', command], {
                cwd,
                timeout: 60_000,
                maxBuffer: 2 * 1024 * 1024,
                encoding: 'utf8',
                env: safeEnv,
            })

            const combined = [
                result.stdout?.trim() ?? '',
                result.stderr?.trim() ?? '',
            ].filter(Boolean).join('\n')

            return combined || '(no output)'
        }

        default:
            return `ERROR: Unknown tool "${name}" in worker`
    }
}
