// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import { generateText, tool, type ModelMessage } from 'ai'
import { z } from 'zod'
import { sql, eq, and } from 'drizzle-orm'
import { db } from '@plexo/db'
import { tasks, taskSteps, artifacts, artifactVersions, installedConnections, WORK_KINDS, inferKind, kindToLegacyType, type WorkKind } from '@plexo/db'
import { ulid } from 'ulid'
import { buildModel, PROVIDER_DEFAULT_MODELS } from '../providers/registry.js'
import { routeAndBuild, routeAndCall, RouterV2CallError } from '../providers/router-v2/index.js'
import type { ResolvedModelMeta } from '../providers/router.js'
import { modelSupportsVision, findVisionCapableModel } from '../providers/vision.js'
import { assertAgentCostCeilingOk, CostCeilingExceededError } from '../cost-gate.js'
import { toMicro, addMicro, cmpMicro, fmtMicroUsd } from '../money.js'
import { ensureArtifactShareUrl } from '../tasks/artifact-share.js'
import { getResumeStep, buildResumeMessages, hasTaskComplete } from './step-builder.js'
import { SAFETY_LIMITS } from '../constants.js'
import { PlexoError } from '../errors.js'
import { loadConnectionTools } from '../connections/bridge.js'
import { encrypt, decrypt as decryptCred } from '../connections/crypto-util.js'
import { loadPluginTools, loadExtensionIdentities } from '../plugins/bridge.js'
import { getCachedToolSet } from '../tool-set-cache.js'
import { assignVariant, recordVariantOutcome } from '../memory/ab-variants.js'
import { getPromptOverrides } from '../memory/prompt-improvement.js'
import { requestApproval, waitForDecision } from '../one-way-door.js'
import { logAuditEntry, logToolCalls } from '../audit.js'
import { searchMemory } from '../memory/store.js'
import { buildCapabilityManifest, manifestToPromptBlock } from '../capabilities/manifest.js'
import { ToolWorker } from './tool-worker.js'

function stripNullBytes<T>(value: T): T {
    if (value == null) return value
    if (typeof value === 'string') return value.replace(/\u0000/g, '') as T
    if (Array.isArray(value)) return value.map((v) => stripNullBytes(v)) as T
    if (typeof value === 'object') {
        const out: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            out[k] = stripNullBytes(v)
        }
        return out as T
    }
    return value
}

import pino from 'pino'
import type { ExecutionContext, ExecutionPlan, ExecutionResult, StepResult } from '../types.js'
import type { WorkspaceAISettings } from '../providers/registry.js'
import { judgeQuality } from './quality-judge.js'
import type { JudgeMeta } from './quality-judge.js'
import { classifyCapabilityGap } from '../tasks/classify-capability-gap.js'
import { buildWebTools } from '../tools/web-tools.js'
import { buildConversationalTaskPrompt, buildTaskPrompt } from '../prompts/build-system-prompt.js'
import { resolveUserTimezone } from '../user-timezone-port.js'

import { compactStaleToolResults, compactStaleAssistantMessages } from './context-projector.js'
export { compactStaleToolResults, compactStaleAssistantMessages }
import { describeToolCall } from '../progress/tool-translations.js'
import {
    resolveOutputCeiling,
    detectTruncatedToolCall,
    hashToolCallArgs,
    type ToolCallSignature,
} from './output-ceiling.js'

const logger = pino({ name: 'executor' })

// ── Quality-judge off-hot-path lifecycle (Phase M / ADR 0002) ──────────────
// The quality judge is an LLM ensemble call. Running it inline before the
// executor returns delays user-visible task completion. We detach it: the
// executor returns qualityScore=null (pending) and the judge + its downstream
// consumers run in a tracked background promise that patches the real score
// onto the task row. The tracked set lets a graceful shutdown drain in-flight
// judges; `judge_dropped` counts judges that threw (escalate to a durable job
// per Phase F if this rate climbs).
const _pendingJudges = new Set<Promise<void>>()
let _judgeDropped = 0

function trackJudge(p: Promise<void>): void {
    _pendingJudges.add(p)
    void p.finally(() => _pendingJudges.delete(p))
}

/** Await all in-flight detached judges. Call before worker/process teardown. */
export async function drainPendingJudges(): Promise<void> {
    await Promise.allSettled([..._pendingJudges])
}

/** Count of detached judges that threw (telemetry / Phase F escalation gate). */
export function getJudgeDroppedCount(): number {
    return _judgeDropped
}

// ── Test output parser ────────────────────────────────────────

interface ParsedTestResult {
    pass: boolean
    name: string
    detail: string
}

/**
 * Extracts structured pass/fail info from common test runner output.
 * Handles: vitest, jest, mocha, TAP.
 * Returns an empty array if no test result lines are found.
 */
function parseTestOutput(output: string): ParsedTestResult[] {
    const results: ParsedTestResult[] = []
    const lines = output.split('\n')

    // Collect 2-line context for detail
    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i]
        if (raw === undefined) continue
        const line = raw.replace(/\x1b\[[0-9;]*m/g, '').trim() // strip ANSI

        // vitest / jest individual test lines: ✓ or × or ✕
        // e.g. "  ✓ should return 200 (15ms)"
        //      "  × should parse JSON"
        const vitestMatch = line.match(/^[✓✔]\s+(.+?)(?:\s+\(\d+ms\))?$/)
        if (vitestMatch?.[1]) {
            results.push({ pass: true, name: vitestMatch[1].trim(), detail: '' })
            continue
        }
        const vitestFail = line.match(/^[×✕✗]\s+(.+?)(?:\s+\(\d+ms\))?$/)
        if (vitestFail?.[1]) {
            const detail = lines.slice(i + 1, i + 4).map(l => (l ?? '').replace(/\x1b\[[0-9;]*m/g, '').trim()).filter(Boolean).join('\n')
            results.push({ pass: false, name: vitestFail[1].trim(), detail })
            continue
        }

        // TAP: ok 1 - test name / not ok 1 - test name
        const tapOk = line.match(/^ok\s+\d+\s+-?\s*(.+)$/)
        if (tapOk?.[1]) {
            results.push({ pass: true, name: tapOk[1].trim(), detail: '' })
            continue
        }
        const tapFail = line.match(/^not ok\s+\d+\s+-?\s*(.+)$/)
        if (tapFail?.[1]) {
            results.push({ pass: false, name: tapFail[1].trim(), detail: '' })
            continue
        }

        // Jest file-level PASS/FAIL (used as synthetic result when no individual lines follow)
        // "PASS src/foo.test.ts" or "FAIL src/foo.test.ts"
        const jestFile = line.match(/^(PASS|FAIL)\s+(.+\.(?:test|spec)\.[jt]sx?)$/)
        if (jestFile?.[1] && jestFile[2] && results.length === 0) {
            // Only add file-level result when no fine-grained results were found
            results.push({
                pass: jestFile[1] === 'PASS',
                name: jestFile[2].trim(),
                detail: jestFile[1] === 'FAIL' ? 'See terminal output for details' : '',
            })
        }
    }

    return results
}

// ── AI SDK step shape (runtime type for raw generateText steps) ───────────
interface AiSdkToolCall {
    toolName: string
    toolCallId?: string
    args?: Record<string, unknown>
    input?: unknown
    invalid?: boolean
    error?: unknown
}
interface AiSdkToolResult { toolCallId?: string; output?: unknown }
interface AiSdkStep { toolCalls?: AiSdkToolCall[]; toolResults?: AiSdkToolResult[] }

// Structural type for generateText result — only the fields we access
interface GenerateResult {
    text: string
    steps: AiSdkStep[]
    usage: { inputTokens?: number; outputTokens?: number }
    response?: { messages?: unknown[] }
    finishReason?: string
}

// ── Tool isolation flag ───────────────────────────────────────
const TOOL_ISOLATION = process.env.PLEXO_TOOL_ISOLATION === '1'

/** Tools eligible for worker-thread isolation */
const WORKER_ELIGIBLE_TOOLS = new Set(['read_file', 'write_file', 'shell'])

/**
 * Promote write_file outputs to works (DB + /tmp/plexo-assets).
 *
 * Called during forced termination (budget exceeded, step limit) so that
 * files the agent wrote via write_file are still retrievable through the
 * /tasks/:id/assets API. Without this, early-termination means the user
 * sees "1 deliverable(s) produced" but nothing to download/preview.
 */
async function promoteWriteFilesToWorks(
    accumulatedSteps: unknown[],
    ctx: { taskId: string; workspaceId: string; sprintId?: string | null; sprintWorkDir?: string },
): Promise<string[]> {
    const { readFileSync, existsSync, mkdirSync, writeFileSync } = await import('node:fs')
    const { basename, resolve, isAbsolute, join } = await import('node:path')
    const workDir = (ctx.sprintWorkDir as string | undefined) ?? process.cwd()
    const assetDir = `/tmp/plexo-assets/${ctx.taskId}`
    const promoted: string[] = []

    for (const s of accumulatedSteps as AiSdkStep[]) {
        for (const tc of (s.toolCalls ?? [])) {
            if (tc.toolName !== 'write_file') continue
            const args = tc.args as { path?: string } | undefined
            if (!args?.path) continue
            const absPath = isAbsolute(args.path) ? args.path : resolve(workDir, args.path)
            if (!existsSync(absPath)) continue
            const content = readFileSync(absPath, 'utf8')
            const filename = basename(absPath)
            if (promoted.includes(filename)) continue // skip dupes
            // Write to /tmp so the filesystem fallback in the assets API works
            mkdirSync(assetDir, { recursive: true })
            writeFileSync(join(assetDir, filename), content, 'utf8')
            // Persist to DB
            try {
                const inferred = inferKind(filename, content)
                const kind: WorkKind = inferred.kind
                const type = kindToLegacyType(kind)
                const meta: Record<string, unknown> = inferred.language ? { language: inferred.language } : {}
                const artifactId = ulid()
                await db.transaction(async (tx) => {
                    const [existing] = await tx.execute<{ id: string; current_version: number }>(sql`
                        SELECT id, current_version FROM artifacts
                        WHERE workspace_id = ${ctx.workspaceId} AND task_id = ${ctx.taskId} AND filename = ${filename}
                        LIMIT 1 FOR UPDATE
                    `)
                    if (!existing) {
                        await tx.insert(artifacts).values({
                            id: artifactId, workspaceId: ctx.workspaceId, taskId: ctx.taskId,
                            projectId: ctx.sprintId ?? null, filename, type, kind, meta, currentVersion: 1,
                        })
                        await tx.insert(artifactVersions).values({
                            artifactId, version: 1, content, changeDescription: 'Promoted from write_file on forced termination',
                        })
                    }
                })
            } catch (dbErr) {
                console.warn('[promoteWriteFilesToWorks] DB persist failed for', filename, ctx.taskId, dbErr instanceof Error ? dbErr.message : dbErr)
            }
            promoted.push(filename)
        }
    }
    return promoted
}

// ── Tool dispatcher ───────────────────────────────────────────

async function dispatchTool(
    name: string,
    input: Record<string, unknown>,
    ctx: ExecutionContext,
    worker?: ToolWorker | null,
): Promise<string> {
    // Route eligible tools through the ToolWorker when isolation is active.
    // task_complete and other non-IO tools always run inline (they need DB access).
    if (worker && WORKER_ELIGIBLE_TOOLS.has(name)) {
        try {
            return await worker.execute(ulid(), name, input)
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            // TOOL_TIMEOUT: step continues with an error string, executor does NOT crash
            if (msg.startsWith('TOOL_TIMEOUT:')) {
                return `ERROR: ${msg} — tool killed after timeout`
            }
            // WORKER_CRASH / WORKER_TERMINATED: also non-fatal to the executor
            if (msg.startsWith('WORKER_CRASH:') || msg === 'WORKER_TERMINATED') {
                return `ERROR: ${msg}`
            }
            return `ERROR: ${msg}`
        }
    }
    const { readFileSync, writeFileSync, mkdirSync, existsSync } = await import('node:fs')
    const { dirname, resolve, isAbsolute, relative } = await import('node:path')

    // defaultCwd: for sprint coding tasks this is the cloned repo working dir
    const defaultCwd = (ctx.sprintWorkDir as string | undefined) ?? process.cwd()
    const emit = ctx.emitStepEvent

    switch (name) {
        case 'read_file': {
            try {
                const rawPath = input.path as string
                const p = isAbsolute(rawPath) ? rawPath : resolve(defaultCwd, rawPath)
                // Path containment: reject reads outside the workdir to prevent arbitrary file access
                const realResolved = resolve(p)
                const realCwd = resolve(defaultCwd)
                if (!realResolved.startsWith(realCwd) && !realResolved.startsWith('/tmp/plexo-')) {
                    return `ERROR: Path "${rawPath}" is outside the working directory`
                }
                return readFileSync(p, 'utf8')
            } catch (e) {
                return `ERROR: ${(e as Error).message}`
            }
        }

        case 'write_file': {
            try {
                const rawPath = input.path as string
                const p = isAbsolute(rawPath) ? rawPath : resolve(defaultCwd, rawPath)
                // Path containment: reject writes outside the workdir
                const realResolved = resolve(p)
                const realCwd = resolve(defaultCwd)
                if (!realResolved.startsWith(realCwd) && !realResolved.startsWith('/tmp/plexo-')) {
                    return `ERROR: Path "${rawPath}" is outside the working directory`
                }
                mkdirSync(dirname(p), { recursive: true })

                // Capture old content for diff (Code Mode)
                let oldContent = ''
                try { oldContent = readFileSync(p, 'utf8') } catch { /* new file */ }

                const newContent = input.content as string
                writeFileSync(p, newContent, 'utf8')

                // Emit file write event with unified diff
                if (emit) {
                    let patch = ''
                    try {
                        const { createPatch } = await import('diff')
                        const relPath = defaultCwd ? relative(defaultCwd, p) : p
                        patch = createPatch(relPath, oldContent, newContent, '', '')
                    } catch { /* diff not available — emit empty patch */ }
                    const relPath = defaultCwd ? relative(defaultCwd, p) : p
                    emit({
                        type: 'step.file_write',
                        taskId: ctx.taskId,
                        workspaceId: ctx.workspaceId,
                        path: relPath,
                        patch,
                        ts: Date.now(),
                    })
                }

                return `OK: wrote ${newContent.length} bytes to ${p}`
            } catch (e) {
                return `ERROR: ${(e as Error).message}`
            }
        }

        case 'shell': {
            try {
                const { spawn } = await import('node:child_process')
                const cwd = (input.cwd as string | undefined) ?? defaultCwd
                // Path containment: reject cwd outside the workdir (matches read_file/write_file)
                const realShellCwd = resolve(cwd)
                const realDefaultCwd = resolve(defaultCwd)
                if (!realShellCwd.startsWith(realDefaultCwd) && !realShellCwd.startsWith('/tmp/plexo-')) {
                    return `ERROR: Working directory "${cwd}" is outside the allowed workspace`
                }
                const command = input.command as string
                const TOOL_TIMEOUT_MS = 90_000

                // Detect label from command content for better UI grouping
                const label = /ssh\s/.test(command)
                    ? 'ssh'
                    : /playwright|vitest|jest|mocha/.test(command)
                        ? 'test'
                        : 'shell'

                // Allowlist — never spread process.env into the subshell.
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

                // Async spawn with process group isolation + timeout kill.
                // The child runs in its own process group (detached) so we can
                // kill the entire tree on timeout without affecting the agent.
                const combined = await new Promise<string>((resolve, reject) => {
                    const child = spawn('sh', ['-c', command], {
                        cwd,
                        env: safeEnv,
                        stdio: ['ignore', 'pipe', 'pipe'],
                        detached: true,
                    })

                    let stdout = ''
                    let stderr = ''
                    let killed = false

                    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString() })
                    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })

                    const timer = setTimeout(() => {
                        killed = true
                        try { process.kill(-child.pid!, 'SIGKILL') } catch { /* already exited */ }
                        reject(new Error(`TOOL_TIMEOUT:shell (${TOOL_TIMEOUT_MS}ms)`))
                    }, TOOL_TIMEOUT_MS)

                    child.on('close', (code) => {
                        clearTimeout(timer)
                        if (killed) return
                        const out = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n')
                        if (code !== 0) {
                            resolve(`ERROR: ${(out || `exit code ${code}`).slice(0, 2000)}`)
                        } else {
                            resolve(out || '(no output)')
                        }
                    })

                    child.on('error', (err) => {
                        clearTimeout(timer)
                        if (!killed) reject(err)
                    })
                })

                // Emit each line as a streaming SSE event
                if (emit && combined && !combined.startsWith('ERROR:')) {
                    for (const line of combined.split('\n')) {
                        if (line) {
                            emit({
                                type: 'step.shell_line',
                                taskId: ctx.taskId,
                                workspaceId: ctx.workspaceId,
                                label,
                                line,
                                ts: Date.now(),
                            })
                        }
                    }

                    if (label === 'test') {
                        for (const { pass, name, detail } of parseTestOutput(combined)) {
                            emit({
                                type: 'step.test_result',
                                taskId: ctx.taskId,
                                workspaceId: ctx.workspaceId,
                                pass,
                                name,
                                detail,
                                ts: Date.now(),
                            })
                        }
                    }
                }

                return combined
            } catch (e) {
                const msg = e instanceof Error ? e.message : String(e)
                if (msg.startsWith('TOOL_TIMEOUT:')) {
                    return `ERROR: ${msg} — shell command killed after timeout`
                }
                return `ERROR: ${msg.slice(0, 2000)}`
            }
        }


        case 'task_complete': {
            // Build deliverable from all provided fields
            const rawSummary = ((input.summary as string) ?? '').trim()
            const deliverable = {
                summary: rawSummary || 'Task completed (no summary provided by agent).',
                outcome: (input.outcome as string) ?? 'completed',
                works: (input.works as unknown[]) ?? [],
                verificationSteps: (input.verificationSteps as string[]) ?? [],
            }
            // Persist deliverable to DB
            try {
                await db.update(tasks)
                    .set({ deliverable })
                    .where(eq(tasks.id, ctx.taskId))
            } catch (err) {
                logger.error({ err, taskId: ctx.taskId }, 'CRITICAL: task_complete deliverable DB persist failed')
            }
            // Emit deliverable via SSE so the UI updates in real time
            if (emit) {
                emit({
                    type: 'task_resumed' as const,
                    taskId: ctx.taskId,
                    workspaceId: ctx.workspaceId,
                    deliverable,
                    ts: Date.now(),
                })
            }
            return JSON.stringify({ done: true, summary: input.summary, qualityScore: input.qualityScore })
        }

        default:
            return `ERROR: Unknown tool "${name}"`
    }
}

// ── Vercel AI SDK tool definitions (AI SDK v6 format) ────────────────────────
// Tool.inputSchema replaces "parameters" from earlier SDK versions.

function buildTools(ctx: ExecutionContext, worker?: ToolWorker | null) {
    return {
        read_file: tool({
            description: 'Read the contents of a file at the given path.',
            inputSchema: z.object({
                path: z.string().describe('Absolute or repo-relative path to read'),
            }),
            execute: async (input) => dispatchTool('read_file', input as Record<string, unknown>, ctx, worker),
        }),
        write_file: tool({
            description: 'Write content to a file on disk. For CODE tasks (git repos) only. For user-facing deliverables (reports, docs, scripts, HTML), use write_asset instead — write_file outputs are NOT visible in the dashboard.',
            inputSchema: z.object({
                path: z.string().describe('Path to write to'),
                content: z.string().describe('Full file content to write'),
            }),
            execute: async (input) => dispatchTool('write_file', input as Record<string, unknown>, ctx, worker),
        }),
        shell: tool({
            description: 'Run a shell command. Avoid destructive operations; prefer reads first.',
            inputSchema: z.object({
                command: z.string().describe('Shell command to execute'),
                cwd: z.string().optional().describe('Working directory (optional)'),
            }),
            execute: async (input) => dispatchTool('shell', input as Record<string, unknown>, ctx, worker),
        }),
        task_complete: tool({
            description: 'REQUIRED — call this to finish the task. Every task MUST end with this tool call. For conversational messages, call immediately with your reply in the summary. For multi-step tasks, call after completing all steps. Include works and verificationSteps when applicable.',
            inputSchema: z.object({
                summary: z.string().min(1, 'Summary cannot be empty').describe('What was accomplished'),
                qualityScore: z.number().min(0).max(1).describe('0.0–1.0 self-assessment score'),
                outcome: z.enum(['completed', 'partial', 'blocked', 'failed']).optional().default('completed').describe('Overall outcome'),
                works: z.array(z.object({
                    type: z.enum(['file', 'diff', 'url', 'data', 'command']).describe('Type of work product'),
                    label: z.string().describe('Short label for this work product'),
                    content: z.string().describe('Path, URL, command, or inline content'),
                })).optional().describe('Typed outputs — files changed, URLs created, data produced'),
                verificationSteps: z.array(z.string()).optional().describe('Steps the user can take to verify the work'),
            }),
            execute: async (input) =>
                dispatchTool('task_complete', input as Record<string, unknown>, ctx),
        }),
        // write_asset — writes to /tmp (always) and uploads to S3/MinIO when STORAGE_* is configured.
        // The tasks/:id/assets API reads from /tmp; S3 URL is returned so the agent can surface it.
        //
        // Phase 2: `kind` + `meta` let the agent declare how the work should render.
        // If `kind` is missing, it is inferred from filename + content.
        write_asset: tool({
            description: `Save a completed deliverable (document, script, HTML, email copy, etc.) as a named asset file. Use this for any output the user should receive.

Declare a "kind" so the user gets the right renderer:
  - instructions: step-by-step guide (links auto-linkified)
  - code:         source code (set meta.language, e.g. "typescript")
  - html:         HTML fragment with live preview
  - mockup:       full-page visual UI design
  - json / yaml:  structured data (collapsible tree)
  - table:        tabular data (DataTable)
  - checklist:    interactive to-do list (persistent state)
  - config:       config file (apply/download actions)
  - diagram:      mermaid / plantuml / etc.
  - image:        raster image
  - link-list:    curated list of external/internal links
  - markdown:     generic formatted text (default)
  - file:         opaque/binary fallback

"meta" is a free-form object for renderer hints. Examples:
  { language: "typescript" }         // code/config
  { previewMode: "preview" }         // html
  { columns: ["name", "status"] }    // table`,
            inputSchema: z.object({
                filename: z.string().describe('Filename with extension, e.g. email-sequence.md'),
                content: z.string().describe('Full file content'),
                kind: z.enum(WORK_KINDS as unknown as [WorkKind, ...WorkKind[]]).optional().describe('WorkKind — how this should render'),
                meta: z.record(z.unknown()).optional().describe('Renderer-specific hints (language, columns, previewMode, ...)'),
                mimeType: z.string().optional().default('text/plain').describe('MIME type'),
            }),
            execute: async (input) => {
                const { mkdirSync, writeFileSync } = await import('node:fs')
                const { join } = await import('node:path')
                // Always write to /tmp (tasks/:id/assets API reads from here)
                const dir = `/tmp/plexo-assets/${ctx.taskId}`
                mkdirSync(dir, { recursive: true })
                const filePath = join(dir, input.filename as string)
                writeFileSync(filePath, input.content as string, 'utf8')
                // Upload to S3/MinIO when configured (opportunistic — never blocks on failure)
                let storageUrl: string | null = null
                const storageEndpoint = process.env.STORAGE_ENDPOINT
                const storageKey = process.env.STORAGE_ACCESS_KEY
                const storageSecret = process.env.STORAGE_SECRET_KEY
                if (storageEndpoint && storageKey && storageSecret) {
                    try {
                        const { uploadContent } = await import('@plexo/storage')
                        const result = await uploadContent({
                            taskId: ctx.taskId,
                            filename: input.filename as string,
                            content: input.content as string,
                            contentType: input.mimeType as string,
                        })
                        storageUrl = result.url
                    } catch (storageErr) {
                        console.warn('[write_asset] S3/MinIO upload failed (falling back to /tmp)', ctx.taskId, input.filename, storageErr instanceof Error ? storageErr.message : storageErr)
                    }
                }
                // Persist to DB (Phase 4 + Phase 2 works taxonomy)
                let shareUrlNote = ''
                try {
                    // Phase 2: prefer explicit `kind` from the agent; fall back to inference.
                    const inferred = inferKind(input.filename as string, input.content as string)
                    const kind: WorkKind = (input.kind as WorkKind | undefined) ?? inferred.kind
                    // Legacy `artifacts.type` column is NOT NULL — derive from kind.
                    const type = kindToLegacyType(kind)
                    // Merge inferred language hint (if any) into caller-supplied meta.
                    const meta: Record<string, unknown> = {
                        ...(inferred.language ? { language: inferred.language } : {}),
                        ...((input.meta as Record<string, unknown> | undefined) ?? {}),
                    }

                    // FUN-036: Content size guard — cap at 10MB
                    const MAX_ARTIFACT_CONTENT_BYTES = 10 * 1024 * 1024
                    let artifactContent = input.content as string
                    if (artifactContent && Buffer.byteLength(artifactContent, 'utf-8') > MAX_ARTIFACT_CONTENT_BYTES) {
                        console.warn(`[artifact] Content exceeds 10MB for ${input.filename} in task ${ctx.taskId} — truncating`)
                        artifactContent = artifactContent.slice(0, MAX_ARTIFACT_CONTENT_BYTES)
                    }

                    // FUN-035: Atomic SELECT FOR UPDATE inside transaction to prevent TOCTOU race
                    let savedArtifactId: string | null = null
                    await db.transaction(async (tx) => {
                        const [existing] = await tx.execute<{
                            id: string
                            current_version: number
                        }>(sql`
                            SELECT id, current_version
                            FROM artifacts
                            WHERE workspace_id = ${ctx.workspaceId}
                              AND ${ctx.sprintId ? sql`project_id = ${ctx.sprintId}` : sql`task_id = ${ctx.taskId}`}
                              AND filename = ${input.filename as string}
                            LIMIT 1
                            FOR UPDATE
                        `)

                        if (existing) {
                            savedArtifactId = existing.id
                            const newVersion = existing.current_version + 1
                            await tx.update(artifacts)
                                .set({ currentVersion: newVersion, updatedAt: new Date(), kind, meta })
                                .where(eq(artifacts.id, existing.id))

                            await tx.insert(artifactVersions).values({
                                artifactId: existing.id,
                                version: newVersion,
                                content: artifactContent,
                                changeDescription: 'Updated by agent',
                            })
                        } else {
                            const artifactId = ulid()
                            savedArtifactId = artifactId
                            await tx.insert(artifacts).values({
                                id: artifactId,
                                workspaceId: ctx.workspaceId,
                                taskId: ctx.taskId,
                                projectId: ctx.sprintId ?? null,
                                filename: input.filename as string,
                                type,
                                kind,
                                meta,
                                currentVersion: 1,
                            })

                            await tx.insert(artifactVersions).values({
                                artifactId,
                                version: 1,
                                content: artifactContent,
                                changeDescription: 'Initial creation',
                            })
                        }
                    })

                    // Surface a shareable "play it" URL for self-contained playable
                    // HTML (games/apps). Unlisted link-only; best-effort.
                    const isPlayableHtml = (kind === 'html' || kind === 'mockup')
                        && /<!doctype html|<html[\s>]/i.test(artifactContent ?? '')
                    if (isPlayableHtml && savedArtifactId) {
                        const shareUrl = await ensureArtifactShareUrl(savedArtifactId, ctx.workspaceId)
                        if (shareUrl) shareUrlNote = ` | Play/share: ${shareUrl}`
                    }
                } catch (dbErr) {
                    console.error('Failed to persist artifact to DB:', dbErr)
                }

                const note = storageUrl ? ` | S3: ${storageUrl}` : ''
                return `Asset saved: ${filePath} (${(input.content as string).length} bytes)${note}${shareUrlNote}`
            },
        }),
        // ── Consolidated web tools (search, fetch, read_page) ─────────────────
        // Single source of truth lives in packages/agent/src/tools/web-tools.ts.
        // Provider priority: Tavily > Brave > DuckDuckGo HTML scrape (no key needed).
        ...buildWebTools({
            tavilyApiKey: ctx.tavilyApiKey ?? process.env.TAVILY_API_KEY ?? null,
            braveApiKey: ctx.braveSearchApiKey ?? process.env.BRAVE_SEARCH_API_KEY ?? null,
        }),
        self_reflect: tool({
            description: 'Query your own runtime state. Returns your active model, installed connections, available tools, memory statistics, cost position, and safety limits. Call this when asked about your capabilities, identity, architecture, or configuration, or when you need to verify what tools/connections are available before attempting a task.',
            inputSchema: z.object({
                focus: z.enum(['all', 'identity', 'tools', 'connections', 'memory', 'cost', 'safety'])
                    .optional()
                    .default('all')
                    .describe('Which section to return. Use "identity" for model/provider info, "tools" for available tools, "connections" for installed integrations, "memory" for memory stats, "cost" for usage/budget, "safety" for safety limits, "all" for everything.'),
            }),
            execute: async ({ focus }) => {
                const { buildIntrospectionSnapshot, toConversationSnapshot } = await import('../introspection/index.js')
                const snapshot = await buildIntrospectionSnapshot(
                    ctx.workspaceId,
                    ctx.activeProvider,
                    ctx.activeModel,
                )
                const safe = toConversationSnapshot(snapshot)
                const sections = {
                    identity: {
                        agentName: snapshot.agentName,
                        agentPersona: snapshot.agentPersona,
                        agentTagline: snapshot.agentTagline,
                        activeProvider: snapshot.activeProvider,
                        activeModel: snapshot.activeModel,
                        primaryProvider: snapshot.primaryProvider,
                        fallbackChain: snapshot.fallbackChain,
                    },
                    tools: {
                        builtinTools: snapshot.builtinTools,
                        connectionTools: snapshot.connections.flatMap((c) => c.tools),
                        pluginTools: snapshot.plugins.flatMap((p) => p.tools),
                        all: [
                            ...snapshot.builtinTools,
                            ...snapshot.connections.flatMap((c) => c.tools),
                            ...snapshot.plugins.flatMap((p) => p.tools),
                        ],
                    },
                    connections: snapshot.connections,
                    memory: safe.memory,
                }
                if (focus === 'all') return JSON.stringify(safe, null, 2)
                const section = sections[focus as keyof typeof sections]
                return section ? JSON.stringify(section, null, 2) : JSON.stringify(safe, null, 2)
            },
        }),
        update_connection: tool({
            description: 'Update the API credentials for an existing installed connection. Use this when the user provides a new API key or token for a service that is already connected (e.g. "here is my new Deepgram key"). Takes the registryId (e.g. "deepgram", "openai") and the new credentials.',
            inputSchema: z.object({
                registryId: z.string().describe('The registry ID of the connection to update (e.g. "deepgram", "openai", "github")'),
                apiKey: z.string().describe('The new API key or token'),
                url: z.string().optional().describe('The API base URL (optional — uses existing value if omitted)'),
            }),
            execute: async ({ registryId, apiKey, url }) => {
                const [existing] = await db
                    .select({ id: installedConnections.id, name: installedConnections.name, credentials: installedConnections.credentials })
                    .from(installedConnections)
                    .where(and(
                        eq(installedConnections.workspaceId, ctx.workspaceId),
                        eq(installedConnections.registryId, registryId),
                    ))
                    .limit(1)

                if (!existing) {
                    return `No installed connection found for registryId "${registryId}" in this workspace. Use the credential install flow to add it first.`
                }

                const existingUrl = url ?? (() => {
                    try {
                        const enc = existing.credentials as { encrypted?: string } | null
                        if (!enc?.encrypted) return ''
                        const raw = enc.encrypted.startsWith('enc:') ? enc.encrypted.slice(4) : enc.encrypted
                        const parsed = JSON.parse(decryptCred(raw, ctx.workspaceId)) as { url?: string }
                        return parsed.url ?? ''
                    } catch { return '' }
                })()

                const encryptedCreds = { encrypted: encrypt(JSON.stringify({ api_key: apiKey, url: existingUrl }), ctx.workspaceId) }

                await db.update(installedConnections)
                    .set({ credentials: encryptedCreds, status: 'active' })
                    .where(eq(installedConnections.id, existing.id))

                return `Updated credentials for ${existing.name ?? registryId}. The new API key is now active.`
            },
        }),
        delegate_to_agent: tool({
            description: 'Delegate a sub-task to a specialist agent. Creates a child task that runs in the queue with parentId set to this task. Use when part of the work requires a different capability, agent, or persona. Waits up to 5 minutes for the child to complete and returns its output.',
            inputSchema: z.object({
                instructions: z.string().min(1).describe('What the sub-agent should do'),
                agentId: z.string().optional().describe('Specific agent extension ID (omit for default agent)'),
                context: z.record(z.unknown()).optional().describe('Extra context key-value pairs for the sub-agent'),
            }),
            execute: async ({ instructions, agentId, context }) => {
                const { push } = await import('@plexo/queue')
                const { tasks: tasksTable } = await import('@plexo/db')

                const childId = await push({
                    workspaceId: ctx.workspaceId,
                    type: 'general',
                    source: 'a2a',
                    context: {
                        description: instructions,
                        agentId: agentId ?? null,
                        ...context,
                    },
                    parentId: ctx.taskId,
                })

                // Poll for child completion (5 min ceiling)
                const deadline = Date.now() + 5 * 60 * 1000
                while (Date.now() < deadline) {
                    await new Promise(r => setTimeout(r, 5000))
                    const [row] = await db
                        .select({ status: tasksTable.status, outcomeSummary: tasksTable.outcomeSummary })
                        .from(tasksTable)
                        .where(eq(tasksTable.id, childId))
                        .limit(1)
                    if (!row) return `Child task ${childId} not found`
                    if (row.status === 'complete') return row.outcomeSummary ?? `Child task ${childId} completed`
                    if (row.status === 'blocked' || row.status === 'cancelled') {
                        return `Child task ${childId} ended with status: ${row.status}`
                    }
                }
                return `Child task ${childId} still running after 5m — check /tasks/${childId} for status`
            },
        }),
    }
}

// ── Default workspace AI settings (legacy / no-config mode) ─────────────────

function defaultSettings(): WorkspaceAISettings {
    return {
        primaryProvider: 'anthropic',
        fallbackChain: [],
        providers: {
            anthropic: { provider: 'anthropic' },
        },
    }
}

// ── Conversational-task detection (exported for tests) ─────────────────────
// The same predicate runs twice in executeTask — once hoisted to skip
// expensive DB fetches, once in-place alongside the tool-set build. Both
// call sites delegate to this function so the rules stay in one place.
// Keep it pure: no DB, no I/O, no imports.
const OPS_VERB_RE = /\b(deploy|build|create|write|fix|update|install|configure|set up|implement|migrate|generate|run|execute|send|push|pull|merge|commit|delete|remove|add|connect|integrate|schedule|monitor|restart|rebuild|analyze|audit|scan|test|optimize|refactor|list|show|get|fetch|check|read|search|find|lookup|query|trigger|enable|disable|toggle|open|close|merge|resolve|purge|redeploy)\b/

export function detectConversationalTask(plan: ExecutionPlan): boolean {
    if (plan.steps.length !== 1) return false
    if (plan.steps[0]!.toolsRequired.length !== 0) return false
    if (plan.goal.length >= 200) return false
    if (OPS_VERB_RE.test(plan.goal.toLowerCase())) return false
    return true
}

/** Pure tier selector — exported so tests can verify routing without driving the full executor. */
export function selectExecutorTaskTier(plan: ExecutionPlan): import('../providers/registry.js').TaskType {
    return detectConversationalTask(plan) ? 'conversation' : 'codeGeneration'
}

// ── Executor ──────────────────────────────────────────────────────────────────

/** Has this task produced a persisted deliverable (an artifact row)? */
async function taskHasDeliverable(taskId: string): Promise<boolean> {
    try {
        const rows = await db.select({ id: artifacts.id })
            .from(artifacts).where(eq(artifacts.taskId, taskId)).limit(1)
        return rows.length > 0
    } catch (err) {
        logger.warn({ err, taskId }, 'taskHasDeliverable check failed — treating as no deliverable')
        return false
    }
}

/** Honest user-facing note for a capability-limited completion (Phase N). */
export function buildCapabilityLimitationSummary(message: string): string {
    const detail = message.replace(/\s+/g, ' ').trim().slice(0, 200)
    return (
        'Completed with a limitation. I produced the deliverable for this task, but I ' +
        'could not perform the requested step because that capability is not available ' +
        'to me (e.g. deploying or hosting to a live URL). The generated files are saved ' +
        'to this task — you can download them or use the share link to run them.' +
        (detail ? ` (Detail: ${detail})` : '')
    )
}

/**
 * Pure decision for the {@link executeTask} catch handler: given the thrown
 * error message and whether a deliverable was persisted, decide whether to
 * complete gracefully with a limitation (Phase N) or re-throw (→ agent-loop
 * fail). Extracted so the wired decision is unit-testable without driving the
 * full executor / db.
 */
export function decideCapabilityGapOutcome(
    message: string,
    hasDeliverable: boolean,
): 'complete_with_limitation' | 'rethrow' {
    return classifyCapabilityGap(message) && hasDeliverable
        ? 'complete_with_limitation'
        : 'rethrow'
}

/**
 * Phase N (operator-approved: complete+marker): a capability gap — the agent was
 * asked to use a tool/capability that does not exist (deploy, host, a missing
 * integration) — is not a crash. When the run still produced a deliverable,
 * complete the task gracefully with an honest limitation note rather than
 * failing; the user got real work, just not the unavailable capability.
 * Genuinely-empty impossible asks (no deliverable) and real tool crashes still
 * propagate to agent-loop → fail. A `context._capabilityLimitation` marker is
 * written so the UI/analytics can distinguish this from a clean success.
 */
export async function executeTask(
    ctx: ExecutionContext,
    plan: ExecutionPlan,
    aiSettings?: WorkspaceAISettings,
): Promise<ExecutionResult> {
    const wrapperStart = Date.now()
    try {
        return await executeTaskInner(ctx, plan, aiSettings)
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        if (decideCapabilityGapOutcome(message, await taskHasDeliverable(ctx.taskId)) === 'complete_with_limitation') {
            logger.info(
                { taskId: ctx.taskId, detail: message.slice(0, 200) },
                'capability gap with deliverable present — completing with limitation (Phase N)',
            )
            await db.update(tasks).set({
                context: sql`COALESCE(context, '{}'::jsonb) || ${JSON.stringify({
                    _capabilityLimitation: { reason: 'capability_unavailable', detail: message.slice(0, 500) },
                })}::jsonb`,
            }).where(eq(tasks.id, ctx.taskId))
                .catch((e) => logger.warn({ err: e, taskId: ctx.taskId }, 'capability-limitation marker patch failed (non-fatal)'))
            return {
                taskId: ctx.taskId,
                ok: true,
                steps: [],
                outcomeSummary: buildCapabilityLimitationSummary(message),
                qualityScore: null,
                totalTokensIn: 0,
                totalTokensOut: 0,
                totalCostUsd: 0,
                totalDurationMs: Date.now() - wrapperStart,
            }
        }
        throw err
    }
}

async function executeTaskInner(
    ctx: ExecutionContext,
    plan: ExecutionPlan,
    aiSettings?: WorkspaceAISettings,
): Promise<ExecutionResult> {
    const settings = aiSettings ?? defaultSettings()
    const startTime = Date.now()
    const stepResults: StepResult[] = []

    let totalTokensIn = 0
    let totalTokensOut = 0
    let totalCost = 0
    // A6 cutover: parallel integer-cents accumulator for the cost-ceiling gate.
    // Float totalCost stays the canonical return value (dual-written into
    // api_cost_tracking via SQL cast in agent-loop). Compares use this micro
    // accumulator so edge-of-ceiling decisions don't drift on roundoff.
    let totalCostMicro: bigint = 0n
    let finalSummary = ''
    let finalQuality = 0.5

    // ── One-Way Door gate (§8.4 approval protocol) ───────────────────────────
    // If the plan flags irreversible operations, request approval before running.
    const owdList = plan.oneWayDoors ?? []
    if (owdList.length > 0) {
        try {
            const owdDescriptions = owdList.map((d) => `• [${d.type}] ${d.description}`).join('\n')
            const approval = await requestApproval({
                taskId: ctx.taskId,
                workspaceId: ctx.workspaceId,
                operation: owdList[0]?.type ?? 'unknown',
                description: `This task requires approval for ${owdList.length} irreversible operation(s):\n${owdDescriptions}`,
                riskLevel: owdList.some((d) => d.type === 'data_write' || d.type === 'schema_migration') ? 'high' : 'medium',
            })

            // Pause — notify via SSE will come from the SSE route watching Redis
            const decision = await waitForDecision(approval.id, 30 * 60 * 1000) // 30 min

            // Audit: log escalation outcome
            void logAuditEntry({
                workspaceId: ctx.workspaceId,
                extensionId: 'system',
                sessionId: ctx.taskId,
                action: decision === 'approved' ? 'escalation_approve' : decision === 'rejected' ? 'escalation_reject' : 'escalation_timeout',
                target: owdList[0]?.type ?? 'unknown',
                payload: { owdId: approval.id, doorCount: owdList.length },
                outcome: decision === 'approved' ? 'success' : 'denied',
                escalationOutcome: decision,
            })

            if (decision === 'rejected') {
                return {
                    taskId: ctx.taskId,
                    ok: false,
                    error: 'Task rejected by operator (one-way door gate)',
                    errorCode: 'OWD_REJECTED',
                    steps: [],
                    outcomeSummary: '',
                    qualityScore: 0,
                    totalDurationMs: Date.now() - startTime,
                    totalTokensIn: 0,
                    totalTokensOut: 0,
                    totalCostUsd: 0,
                }
            }

            if (decision === 'timeout') {
                return {
                    taskId: ctx.taskId,
                    ok: false,
                    error: 'Task approval timed out (one-way door gate) — resubmit to retry',
                    errorCode: 'OWD_TIMEOUT',
                    steps: [],
                    outcomeSummary: '',
                    qualityScore: 0,
                    totalDurationMs: Date.now() - startTime,
                    totalTokensIn: 0,
                    totalTokensOut: 0,
                    totalCostUsd: 0,
                }
            }
            // approved — fall through to execution
        } catch (owdErr) {
            // OWD service unavailable — log and continue (non-blocking in dev)
            import('pino').then(({ default: pino }) =>
                pino({ name: 'executor' }).warn({ err: owdErr }, 'OWD gate failed non-fatally — proceeding'),
            ).catch((logErr: unknown) => { console.error('[executor] OWD gate logging failed:', logErr instanceof Error ? logErr.message : logErr) })
        }
    }

    // ── Cost ceiling gate (Phase 2a of intelligence overhaul) ────────────────
    // Check the workspace's monthly cost ceiling BEFORE any model work runs.
    // Hard ceilings throw CostCeilingExceededError → bubbled up to the API
    // layer as a 402. Soft ceilings emit a warn event at 80% and 100% so
    // the UI can render a banner, but never block.
    try {
        await assertAgentCostCeilingOk(ctx.workspaceId, (warn) => {
            ctx.emitStepEvent?.({
                type: 'cost_ceiling_warn',
                taskId: ctx.taskId,
                workspaceId: ctx.workspaceId,
                ts: Date.now(),
                threshold: warn.reason === 'soft_warn_100' ? '100' : '80',
                usagePct: warn.usagePct,
                spentUsd: warn.spend.pricedUsd,
                ceilingUsd: warn.ceilingUsd,
            })
        })
    } catch (gateErr) {
        if (gateErr instanceof CostCeilingExceededError) {
            return {
                taskId: ctx.taskId,
                ok: false,
                error: gateErr.message,
                errorCode: 'COST_CEILING_EXCEEDED',
                steps: [],
                outcomeSummary: '',
                qualityScore: 0,
                totalDurationMs: Date.now() - startTime,
                totalTokensIn: 0,
                totalTokensOut: 0,
                totalCostUsd: 0,
            }
        }
        // Non-ceiling error during the gate is non-fatal — log and continue.
        // The executor still has its own per-call cost accounting downstream.
        import('pino').then(({ default: pino }) =>
            pino({ name: 'executor' }).warn({ err: gateErr }, 'cost gate failed non-fatally — proceeding'),
        ).catch((logErr: unknown) => { console.error('[executor] cost gate logging failed:', logErr instanceof Error ? logErr.message : logErr) })
    }

    // ── Phase A: Use context already loaded by agent-loop ────────────────────────
    // agent-loop.ts loads these from DB before building ExecutionContext.
    // We only fall back to DB here if fields are missing (direct executor calls in tests).
    let agentName = ctx.agentName ?? 'Plexo'
    let personaPrefix = ctx.agentPersona ? ctx.agentPersona + '\n\n' : ''
    let systemPromptExtra = ''
    if (!ctx.agentName) {
        // Direct call path (tests/sprint runner) — load from DB as before
        try {
            const { workspaces } = await import('@plexo/db')
            const { db: dbInst } = await import('@plexo/db')
            const { eq: eqFn } = await import('drizzle-orm')
            const [ws] = await dbInst.select({ settings: workspaces.settings }).from(workspaces)
                .where(eqFn(workspaces.id, ctx.workspaceId)).limit(1)
            if (ws?.settings) {
                const s = ws.settings as Record<string, unknown>
                if (typeof s.agentName === 'string' && s.agentName) agentName = s.agentName
                if (typeof s.agentPersona === 'string' && s.agentPersona) personaPrefix = s.agentPersona + '\n\n'
                if (typeof s.systemPromptExtra === 'string' && s.systemPromptExtra) systemPromptExtra = '\n\n' + s.systemPromptExtra
            }
        } catch { /* non-fatal */ }
    }

    // ── Conversational-task fast path flag (hoisted) ─────────────────────
    // Computed early via the shared `detectConversationalTask` predicate so
    // the expensive prompt-data blocks below (memory recall, capability
    // manifest, extension prompts/context, SCL context) can be SKIPPED when
    // they'd be thrown away anyway. The later `isConversational` alias is
    // just an alias — see below.
    const isConversationalFast = detectConversationalTask(plan)

    // ── Phase B: Read prior memory + apply user preferences ──────────────────
    // Memory recall is skipped for conversational tasks — it's a big input-token
    // hit and the reply is coming out of model knowledge anyway.
    let memoryBlock = ''
    let preferencesBlock = ''
    // Domain mastery: context hash for credit assignment (populated by resolveBehavior)
    let resolvedContextHash: string | null = null
    let resolvedContextRuleKeys: string[] = []
    if (!isConversationalFast) {
        try {
            const priorMemory = await searchMemory({
                workspaceId: ctx.workspaceId,
                query: plan.goal,
                limit: 3,
            })
            if (priorMemory.length > 0) {
                const entries = priorMemory
                    .map((m) => `- ${m.shorthand || m.content.split('\n').slice(0, 3).join(' | ')}`)
                    .join('\n')
                memoryBlock = `\n\nPRIOR WORK CONTEXT (from memory):\n${entries}`
            }
        } catch { /* non-fatal */ }
    }

    try {
        const { resolveBehavior } = await import('../behavior/resolver.js')
        const { compileBehavior } = await import('../behavior/compiler.js')

        // resolveBehavior handles workspace + optional project inheritance
        const resolvedRules = await resolveBehavior(ctx.workspaceId)
        const compiledRules = compileBehavior(resolvedRules.rules)

        // Domain mastery: capture context hash for credit assignment (ADR-003)
        resolvedContextHash = resolvedRules.contextHash ?? null
        resolvedContextRuleKeys = resolvedRules.contextRuleKeys ?? []

        if (compiledRules) {
            preferencesBlock = `\n\nWORKSPACE RULES (always follow these):\n${compiledRules}`
        }
    } catch { /* non-fatal */ }

    // ── Phase D: Capability manifest in executor prompt ──────────────────
    // Also skipped for conversational tasks — the manifest alone is ~1-2k
    // tokens and the agent doesn't need it to answer "what time is it".
    let capabilityBlock = ''
    if (!isConversationalFast) {
        try {
            const manifest = await buildCapabilityManifest(ctx.workspaceId)
            capabilityBlock = '\n\n' + manifestToPromptBlock(manifest)
        } catch { /* non-fatal */ }
    }

    // ── Phase E: Tool prompts + context (PEX §7.6/§7.7) ─────────
    // Skipped for conversational tasks — by definition they don't plan to
    // use any extension tool, so the per-extension prompt/context blocks
    // just pad the prompt without changing the reply.
    let extensionPromptsBlock = ''
    let extensionContextBlock = ''
    if (!isConversationalFast) try {
        const { extensionPrompts: epTable, extensionContexts: ecTable } = await import('@plexo/db')
        const { db: dbInst } = await import('@plexo/db')
        const { eq: eqFn, and: andFn, isNull: isNullFn } = await import('drizzle-orm')

        // §7.6: Load enabled extension prompts and resolve variables
        const enabledPrompts = await dbInst
            .select()
            .from(epTable)
            .where(andFn(
                eqFn(epTable.workspaceId, ctx.workspaceId),
                eqFn(epTable.enabled, true),
                isNullFn(epTable.deletedAt),
            ))
            .orderBy(epTable.priority, epTable.extensionName)

        if (enabledPrompts.length > 0) {
            const resolved = enabledPrompts.map((p) => {
                const defaults = (p.variableDefaults ?? {}) as Record<string, unknown>
                const schema = (p.variables ?? []) as Array<{ name: string; default?: unknown }>
                let text = p.template
                for (const v of schema) {
                    const val = String(defaults[v.name] ?? v.default ?? '')
                    text = text.replaceAll(`{{${v.name}}}`, val)
                }
                return `[Prompt from ${p.extensionName}: ${p.name}]\n${text}`
            })
            extensionPromptsBlock = `\n\nTOOL PROMPTS:\n${resolved.join('\n\n')}`
        }

        // §7.7: Load active context blocks (not expired, enabled, sorted by priority)
        const contextRows = await dbInst
            .select()
            .from(ecTable)
            .where(andFn(
                eqFn(ecTable.workspaceId, ctx.workspaceId),
                eqFn(ecTable.enabled, true),
                isNullFn(ecTable.deletedAt),
            ))
            .orderBy(ecTable.priority, ecTable.extensionName)

        if (contextRows.length > 0) {
            const now = Date.now()
            // Filter expired, apply token budget (40% of 128k = ~51,200 tokens for extensions)
            const TOKEN_BUDGET = 51200
            const PER_EXT_CAP = TOKEN_BUDGET * 0.25
            let totalTokens = 0
            const extTokens: Record<string, number> = {}
            const blocks: string[] = []

            for (const c of contextRows) {
                // TTL check
                if (c.ttl != null && c.lastRefreshedAt != null) {
                    const age = (now - new Date(c.lastRefreshedAt).getTime()) / 1000
                    if (age > c.ttl) continue // expired
                }
                const tokens = c.estimatedTokens ?? Math.ceil(c.content.length / 4)
                const extKey = c.extensionName
                extTokens[extKey] = (extTokens[extKey] ?? 0) + tokens
                // Per-tool cap
                if (extTokens[extKey]! > PER_EXT_CAP) {
                    blocks.push(`[Context evicted: ${c.name} — per-tool token cap exceeded]`)
                    continue
                }
                // Total budget check
                if (totalTokens + tokens > TOKEN_BUDGET) {
                    blocks.push(`[Context evicted: ${c.name} — token budget exceeded]`)
                    continue
                }
                totalTokens += tokens
                const contextLabel = c.extensionName === '_user'
                    ? `[User Context: ${c.name}]`
                    : `[Context from ${c.extensionName}: ${c.name}]`
                blocks.push(`${contextLabel}\n${c.content}`)
            }

            if (blocks.length > 0) {
                extensionContextBlock = `\n\nTOOL CONTEXT:\n${blocks.join('\n\n')}`
            }
        }
    } catch { /* non-fatal — extension prompts/context are additive only */ }

    // A/B variant assignment — assigns control (A) or challenger (B) prompt
    // so the self-improvement loop can measure the effect of prompt patches.
    let variantAssignment: Awaited<ReturnType<typeof assignVariant>> = {
        variant: 'A',
        challengerId: null,
        overrides: {},
    }
    try {
        variantAssignment = await assignVariant(ctx.workspaceId)
    } catch { /* non-fatal */ }

    const variantExtra = Object.entries(variantAssignment.overrides)
        .map(([k, v]) => `\n\n[${k.replace(/_/g, ' ')}]\n${v}`)
        .join('')

    const sprintCodingBlock = ctx.sprintWorkDir
        ? `

SPRINT CODING CONTEXT:
- Repository: ${ctx.sprintRepo ?? 'unknown'}
- Branch: ${ctx.sprintBranch ?? 'unknown'}
- Working directory (pre-cloned): ${ctx.sprintWorkDir}

MANDATORY WORKFLOW — follow this exactly:
1. Read relevant files with read_file or shell("cat <path>") to understand the codebase.
2. Make changes with write_file. Follow all WORKSPACE RULES exactly.
3. Run \`pnpm typecheck\` (or the repo's lint/test command) with shell() to verify correctness.
4. Configure git identity:
   shell("git config user.email 'agent@plexo.ai' && git config user.name 'Plexo Agent'")
5. Stage, commit, and push your changes:
   shell("git add -A && git commit -m '<concise description>' && git push origin ${ctx.sprintBranch ?? 'HEAD'}")
6. ONLY THEN call task_complete.

CRITICAL: You MUST push at least one commit before calling task_complete.
If you call task_complete without pushing, no PR can be opened and your work is lost.
If typecheck fails, fix the errors before pushing — do not push broken code.
Do NOT push to main. Your branch is: ${ctx.sprintBranch ?? 'your assigned branch'}.`
        : ''

    // ── Phase C: Execution Priming — pre-loaded scope files ─────────────────
    let scopePrimingBlock = ''
    if (ctx.scopeFiles && ctx.scopeFiles.length > 0) {
        const fileBlocks = ctx.scopeFiles
            .map((f) => `### ${f.path}\n\`\`\`\n${f.content}\n\`\`\``)
            .join('\n\n')
        scopePrimingBlock = `\n\nPRIMED FILE CONTEXT (pre-loaded — no need to re-read these):\n${fileBlocks}`
    }

    // identityLine is built after router resolution (below) so it reflects the actual model used.

    const planSummary = plan.steps
        .map((s) => `Step ${s.stepNumber}: ${s.description}`)
        .join('\n')

    // ── Conversational task detection ──────────────────────────────────────
    // Alias for the earlier `isConversationalFast` flag computed up at the top
    // of executeTask (before expensive prompt-data blocks run). The two MUST
    // stay in sync — change one, change the other. Keeping the later name
    // means the rest of the function can keep reading `isConversational`.
    const isConversational = isConversationalFast

    const userMessage = isConversational
        ? `The user said: "${plan.goal}"\n\nYou MUST call the task_complete tool now. Put your natural reply to the user in the "summary" field, set qualityScore to 0.9, and set outcome to "completed". Do NOT call any other tool — ONLY task_complete.`
        : `Execute this plan:\n\n${planSummary}\n\nBegin with step 1.`

    if (ctx.signal.aborted) {
        throw new PlexoError('Task cancelled', 'TASK_CANCELLED', 'user', 499)
    }

    const stepStart = Date.now()

    // ── Tool isolation: create a ToolWorker when opt-in via env var ─────────
    const workDir = (ctx.sprintWorkDir as string | undefined) ?? process.cwd()
    const toolWorker = TOOL_ISOLATION ? new ToolWorker(workDir) : null

    // Phase X — cache the hot loaders per workspace for TOOL_SET_TTL_MS.
    // Extensions / connections routes call invalidateToolSet() on mutation
    // so the cache busts immediately when the user adds/removes tools.
    // When ctx.connectorIds is set (routine with connector allowlist), use a
    // scoped cache key so different scoping configs don't pollute each other.
    const connectorScopeKey = ctx.connectorIds === undefined
        ? ''                                                               // allow-all (interactive)
        : ctx.connectorIds.length === 0
            ? ':deny-all'                                                  // automated, no allowlist → no connectors
            : `:scoped:${[...ctx.connectorIds].sort().join(',')}`          // explicit allowlist
    // Profile enforcement (ADR 0001 §3) is per-app, so different apps must not
    // share a cached tool set for the same workspace.
    const appScopeKey = ctx.appId ? `:app:${ctx.appId}` : ''
    const connectionToolsRaw = await getCachedToolSet(
        `connections:${ctx.workspaceId}${connectorScopeKey}${appScopeKey}`,
        () => loadConnectionTools(ctx.workspaceId, ctx.connectorIds, ctx.appId),
    )
    // L5b (ADR 0006 §D5): wrap each outbound connection tool with an
    // executor-side approval guard. Plan.oneWayDoors[] coverage is checked
    // at execute-time so a mid-task replan that adds covering OWDs is
    // respected on subsequent tool calls. Tools NOT matching the outbound
    // predicate pass through unchanged. Counter is incremented through the
    // ctx.onOutboundUncovered callback wired by agent-loop (layering: agent
    // package never imports apps/api metrics).
    const { wrapOutboundToolsWithApprovalGuard } = await import('../connections/approval-guard.js')
    const connectionTools = wrapOutboundToolsWithApprovalGuard(connectionToolsRaw, {
        plan,
        taskId: ctx.taskId,
        workspaceId: ctx.workspaceId,
        onUncovered: ctx.onOutboundUncovered,
        onDenialLoop: ctx.onOutboundDenialLoop,
    })
    const pluginTools = await getCachedToolSet(
        `plugins:${ctx.workspaceId}${appScopeKey}`,
        () => loadPluginTools(ctx.workspaceId, ctx.appId),
    )
    // Phase 7 — per-extension identity for audit enrichment.
    const extensionIdentities = await getCachedToolSet(
        `identities:${ctx.workspaceId}`,
        () => loadExtensionIdentities(ctx.workspaceId),
    )
    const baseTools = buildTools(ctx, toolWorker)

    // Phase 3 — self-knowledge tools (live introspection at call time).
    // Reads CONNECTION_REGISTRY + installed_connections directly so the agent
    // always gets a fresh answer to "what can I do right now".
    const { buildSelfKnowledgeTools } = await import('../tools/self-knowledge-tools.js')
    const selfKnowledgeTools = buildSelfKnowledgeTools(ctx.workspaceId, {
        includeExecutionTools: !isConversational,
    })

    // Environment awareness tools — static/env introspection (runtime, infra,
    // repo, deploy context, self-modification scope). Read-only, safe in both
    // conversational and task paths.
    const { buildEnvironmentTools } = await import('../tools/environment-tools.js')
    const environmentTools = buildEnvironmentTools()

    // Corpus migration introspection — workspace-scoped read-only query against
    // corpus_migration_log. Safe in both conversational and task paths.
    const { buildMigrationTools } = await import('../tools/migration-tools.js')
    const migrationTools = buildMigrationTools(ctx.workspaceId)

    // For conversational tasks, restrict to task_complete + connections + plugins + self-knowledge + env.
    // Connection tools (e.g. an installed email/calendar connector's list tools) are included so
    // the agent can answer data questions ("what's on my calendar?") inline without spawning a
    // full task. Plugin tools are included because bridge extensions supersede factory connection
    // tools via the dedup map — excluding pluginTools would leave those connections with zero
    // callable tools in conversational mode.
    // Base task-management tools remain off for conversational mode.
    const allTools = isConversational
        ? { task_complete: baseTools.task_complete, ...connectionTools, ...pluginTools, ...selfKnowledgeTools, ...environmentTools, ...migrationTools }
        : { ...baseTools, ...connectionTools, ...pluginTools, ...selfKnowledgeTools, ...environmentTools, ...migrationTools }

    // Append plugin tool names to the capability block so the model knows the
    // plugin__ call format for each loaded extension. The capability block was
    // built before plugin workers activated; this is the first safe point to
    // enumerate them. Only for non-conversational tasks where plugin tools load.
    if (!isConversational && capabilityBlock) {
        const pluginKeys = Object.keys(pluginTools)
        if (pluginKeys.length > 0) {
            const byExt = new Map<string, string[]>()
            for (const key of pluginKeys) {
                if (!key.startsWith('plugin__')) continue
                const body = key.slice('plugin__'.length)
                const sep = body.indexOf('__')
                if (sep === -1) continue
                const extKey = body.slice(0, sep)
                const toolName = body.slice(sep + 2)
                const list = byExt.get(extKey) ?? []
                list.push(toolName)
                byExt.set(extKey, list)
            }
            const toolLines = Array.from(byExt.entries())
                .map(([ext, tools]) => `    - plugin__${ext}__* → ${tools.join(', ')}`)
                .join('\n')
            capabilityBlock += `\n  Active extension tools (call as plugin__ext__toolname):\n${toolLines}`
        }
    }

    // Per-task pre-flight: block if already at task ceiling from prior retries
    if (ctx.taskCostCeilingUsd != null && cmpMicro(totalCostMicro, toMicro(ctx.taskCostCeilingUsd)) >= 0) {
        throw new PlexoError(
            `Task cost ceiling reached: $${fmtMicroUsd(totalCostMicro, 4)} >= $${fmtMicroUsd(toMicro(ctx.taskCostCeilingUsd), 4)}`,
            'TASK_COST_CEILING',
            'system',
            429,
        )
    }

    // ── Model resolution via IntelligentRouter ──────────────────────────────────
    // Tier routing: conversational tasks (short tool-free replies routed through
    // the task pipeline — e.g. "tell me the time", "what can you do") MUST NOT
    // hit the reasoning tier. deepseek-reasoner spends 30-90s on hidden CoT for
    // every reply, which makes chat feel broken. Route them through the
    // `conversation` tier instead, which is pinned to a fast chat model in
    // DEFAULT_MODEL_ROUTING + auto-swaps reasoner → chat in buildModel().
    //
    // Multi-step / code-generation tasks continue to use `codeGeneration` so
    // the reasoner option (when the workspace opts into it) still applies to
    // actual code work.
    const taskTier: import('../providers/registry.js').TaskType = isConversational
        ? 'conversation'
        : 'codeGeneration'

    // Inject per-task model override if specified in execution context
    const effectiveSettings: WorkspaceAISettings = ctx.modelOverrideId
        ? {
            ...settings,
            inferenceMode: 'override',
            modelOverrides: {
                ...(settings.modelOverrides ?? {}),
                // Apply to the actual task type being executed
                codeGeneration: ctx.modelOverrideId,
                planning: ctx.modelOverrideId,
                verification: ctx.modelOverrideId,
                summarization: ctx.modelOverrideId,
                classification: ctx.modelOverrideId,
                conversation: ctx.modelOverrideId,
                logAnalysis: ctx.modelOverrideId,
                extraction: ctx.modelOverrideId,
            }
        }
        : settings

    let routingFallbackUsed = false
    let routingFallbackReason: string | undefined
    // eslint-disable-next-line prefer-const -- resolvedModel may be swapped below for a vision-capable fallback
    let resolvedModel: import('../providers/registry.js').AnyLanguageModel
    // eslint-disable-next-line prefer-const -- resolvedMeta is only updated alongside resolvedModel
    let resolvedMeta: ResolvedModelMeta
    ;({ model: resolvedModel, meta: resolvedMeta } = await routeAndBuild({
        workspaceId: ctx.workspaceId,
        taskType: taskTier,
        settings: effectiveSettings,
    }).catch(async (err) => {
        // Router failure (e.g. empty models_knowledge table) — fall back to
        // BYOK via routeAndCall's own selector + cascade. The actual
        // generateText step further down is ALSO wrapped via routeAndCall
        // (~line 1745) — that's where 402 / 5xx / 429 from the resolved
        // provider triggers chain advancement during execution.
        routingFallbackUsed = true
        routingFallbackReason = err instanceof Error ? err.message : String(err)
        const fallbackModel = await routeAndCall({
            workspaceId: ctx.workspaceId,
            taskType: taskTier,
            settings,
            doCall: async (m) => m,
        })
        return { model: fallbackModel, meta: { id: 'unknown', provider: settings.primaryProvider as import('../providers/registry.js').ProviderKey, mode: 'byok' as import('../providers/router.js').InferenceMode, costPerMIn: 3, costPerMOut: 15 } }
    }))

    // ── Vision gate: swap to a vision-capable model when user attached images ──
    // When the task was invoked with image attachments (from any channel) and
    // the resolved model is text-only, look for a vision-capable fallback in
    // the workspace fallback chain and swap the model for this task. If no
    // vision model is available at all, we log a warn and degrade — the
    // executor's first user message will include a "vision unavailable" note.
    let visionDegradedNote: string | null = null
    let visionFallbackLabel: string | null = null
    if (ctx.inputImageUrls && ctx.inputImageUrls.length > 0) {
        const primarySupportsVision = modelSupportsVision(resolvedMeta.id, resolvedMeta.provider)
        if (!primarySupportsVision) {
            const visionAlt = findVisionCapableModel(effectiveSettings, PROVIDER_DEFAULT_MODELS, resolvedMeta.provider)
            if (visionAlt) {
                const altConfig = effectiveSettings.providers[visionAlt.providerKey as keyof typeof effectiveSettings.providers]
                if (altConfig) {
                    try {
                        const altModel = buildModel(visionAlt.providerKey as import('../providers/registry.js').ProviderKey, altConfig, taskTier, effectiveSettings)
                        resolvedModel = altModel
                        resolvedMeta = {
                            ...resolvedMeta,
                            id: visionAlt.modelId,
                            provider: visionAlt.providerKey as import('../providers/registry.js').ProviderKey,
                        }
                        visionFallbackLabel = `${visionAlt.providerKey}/${visionAlt.modelId}`
                        const pinoMod = await import('pino')
                        pinoMod.default({ name: 'executor' }).info(
                            { workspaceId: ctx.workspaceId, taskId: ctx.taskId, primaryProvider: resolvedMeta.provider, fallback: visionFallbackLabel, images: ctx.inputImageUrls.length },
                            'Vision gate: routing task to vision-capable fallback model',
                        )
                    } catch (err) {
                        const pinoMod = await import('pino')
                        pinoMod.default({ name: 'executor' }).warn(
                            { err, workspaceId: ctx.workspaceId, taskId: ctx.taskId },
                            'Vision gate: failed to build fallback vision model — degrading to text',
                        )
                        visionDegradedNote = '[image recognition unavailable: the configured vision model could not be built]'
                    }
                }
            } else {
                visionDegradedNote = '[image recognition unavailable: no vision-capable model is configured. Add a free Groq API key in Settings → AI Providers to enable vision.]'
                const pinoMod = await import('pino')
                pinoMod.default({ name: 'executor' }).warn(
                    { workspaceId: ctx.workspaceId, taskId: ctx.taskId, model: resolvedMeta.id, provider: resolvedMeta.provider, images: ctx.inputImageUrls.length },
                    'Vision gate: no vision-capable model available, degrading to text placeholder',
                )
            }
        }
    }

    // Emit routing fallback event if primary routing failed
    if (routingFallbackUsed) {
        ctx.emitStepEvent?.({
            type: 'routing_fallback',
            taskId: ctx.taskId,
            workspaceId: ctx.workspaceId,
            actual: `${resolvedMeta.provider}/${resolvedMeta.id}`,
            reason: routingFallbackReason,
            ts: Date.now(),
        })
    }

    if (ctx.sprintId) {
        import('../sprint/logger.js').then(({ logSprintEvent }) => {
            logSprintEvent({
                sprintId: ctx.sprintId!,
                level: 'info',
                event: 'routing_trace',
                message: `Task routed to ${resolvedMeta.provider}/${resolvedMeta.id} (mode: ${resolvedMeta.mode})`,
                metadata: {
                    taskType: taskTier,
                    mode: resolvedMeta.mode,
                    provider: resolvedMeta.provider,
                    modelId: resolvedMeta.id,
                    costPerMIn: resolvedMeta.costPerMIn,
                    costPerMOut: resolvedMeta.costPerMOut,
                }
            }).catch((err: unknown) => { logger.warn({ err, sprintId: ctx.sprintId }, 'logSprintEvent failed') })
        }).catch((err: unknown) => { logger.warn({ err, sprintId: ctx.sprintId }, 'sprint logger import failed') })
    }

    const identityLine = `Identity: running on ${resolvedMeta.provider} / ${resolvedMeta.id}. If asked what model, provider, or system you are, call self_reflect({focus:"identity"}) to get the accurate, live answer rather than guessing.`

    const browsingBlock = `
WEB TOOLS (read-only access to the public web):
You have exactly three web tools. No other search or browse tool exists.
- web_search(query, maxResults?) — search the web and get titles+URLs+snippets. Uses Tavily if configured, else Brave, else DuckDuckGo (free, no key). Use for factual lookups, current events, or finding documentation URLs.
- web_read_page(url) — fetch a URL and return its main readable text (HTML stripped). Use this to read articles, blog posts, docs, or any human-readable page.
- web_fetch(url, method?, body?, headers?) — raw HTTP fetch returning the unmodified response body. Use for JSON APIs or when you need raw HTML/content.
Internal and private-network IPs are blocked on all three. These tools cannot execute JavaScript or interact with pages (no clicking, no forms). If a task truly requires filling a form or clicking a button, say so and the operator will handle it or install a browser automation skill.`

    const selfExtensionBlock = `

SELF-EXTENSION CAPABILITY:
When you lack a capability needed for a task, follow this order:
1. Search the Hub first: call browse_hub to look for an existing extension that provides the missing capability.
2. If a relevant extension exists, suggest installing it: tell the user what you found and offer to install it with install_extension.
3. Only if nothing suitable exists in the Hub, fall back to synthesize_extension to generate a new skill on the fly.

Call synthesize_extension when:
- No Hub extension covers the service or capability the user needs
- The user explicitly asks you to "build a tool for X" or "integrate with X"
The tool handles everything: API research, code generation, disk storage, integration
registration, and auto-activation. After a successful synthesis, tell the user:
"[Service] skill is now active. Go to Integrations → [Service] to enter your API key."
Never attempt to synthesize for already-installed services — check self_reflect first.`

    // Phase 3 — compact live capability summary. Historically this was built
    // for the conversational prompt, but Phase-6 latency work dropped it from
    // the conversational-task branch entirely (it was ~400 tokens of text the
    // model didn't need to answer "what time is it"). Keep it around as an
    // empty string so existing template refs still compile.
    const compactCapabilityBlock = ''

    // ── Phase 6: Delegate to unified prompt builder ────────────────────────
    // All prompt text lives in packages/agent/src/prompts/build-system-prompt.ts.
    // We still assemble the conditional data blocks here (they depend on
    // runtime state the builder can't see), then hand them off as opaque
    // strings. Output is identical to the pre-Phase-6 inline templates.

    const infrastructureBlock = ['ops', 'automation'].includes(ctx.taskType) && process.env.DOCKER_SOCKET_ENABLED === 'true'
        ? `

INFRASTRUCTURE CONTEXT:
- You are running inside a Docker container with access to the Docker socket.
- Use the shell tool to run docker commands: docker ps, docker logs, docker compose, etc.
- The compose project is "${process.env.COMPOSE_PROJECT_NAME ?? 'plexo'}" at ${process.env.COMPOSE_DIR ?? '/opt/app/infra'}/
- Compose files: docker-compose.yml + docker-compose.prod.yml
- To restart a service: docker compose -f docker-compose.yml -f docker-compose.prod.yml restart <service>
- To rebuild a service: docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build --no-deps <service>
- To view logs: docker logs <container-name> --tail 50
- Reverse proxy: Caddy (config at ${process.env.COMPOSE_DIR ?? '/opt/app/infra'}/Caddyfile.prod)
- Database: PostgreSQL at postgres:5432, Valkey at valkey:6379
- IMPORTANT: For destructive operations (restart, rebuild, down), always confirm what you're doing before executing.`
        : ''

    const mandatoryAssetBlock = !ctx.sprintWorkDir && ['research', 'writing', 'ops', 'data', 'marketing', 'general', 'automation', 'report'].includes(ctx.taskType)
        ? `

MANDATORY OUTPUT REQUIREMENT — READ CAREFULLY:
You MUST call write_asset (NOT write_file) at least once before calling task_complete.
- write_asset saves deliverables so the user can view/download them. write_file is for intermediate scratch files ONLY.
- If you use write_file for your final output instead of write_asset, THE USER WILL NOT SEE YOUR WORK.
- Every significant output (report, plan, analysis, document, script, email copy, etc.) MUST be saved using write_asset.
- Pass a "kind" that reflects how the user should consume the output (instructions | code | html | mockup | json | yaml | table | checklist | config | diagram | link-list | markdown) so the UI picks the right renderer.
- Do NOT put your primary work only in the task_complete summary — the summary is a 1-3 sentence description, not the actual output.
- Only call task_complete AFTER you have called write_asset at least once with the actual work.
- WRONG: write_file("report.md", content) → user cannot see it
- RIGHT: write_asset("report.md", content, kind="markdown") → user sees it in dashboard
- If a write_asset result includes a "Play/share:" URL (auto-generated for playable HTML games/apps), INCLUDE that exact URL in your final reply so the user can open and play/share it.`
        : ''

    // SCL context is a workspace-memory expansion that helps multi-step tasks
    // reason about recent patterns. Conversational tasks skip it — they don't
    // need it and it can be hundreds of tokens.
    const sclContextBlock = !isConversationalFast && ctx.sclContext && ctx.sclContext.tokenCount > 0
        ? `\n\nWORKSPACE MEMORY (SCL):
Domain regions: ${ctx.sclContext.sourceRegions.join(', ')}
${ctx.sclContext.relevantPatterns.length > 0 ? `Relevant patterns: ${ctx.sclContext.relevantPatterns.join('; ')}` : ''}
${ctx.sclContext.suggestedTools.length > 0 ? `Suggested tools: ${ctx.sclContext.suggestedTools.join(', ')}` : ''}
${ctx.sclContext.domainKnowledge.length > 0 ? `Domain knowledge: ${ctx.sclContext.domainKnowledge.join('; ')}` : ''}`
        : ''

    // Timezone injection — surface the user's IANA timezone in the system
    // prompt so the model interprets and reports times in their local zone.
    // The source is app-supplied via the user-timezone port (ADR 0001); silent
    // no-op when no resolver is wired or no timezone is available.
    const userTimezone = (await resolveUserTimezone(ctx.workspaceId)) ?? undefined

    const systemPrompt = isConversational
        ? buildConversationalTaskPrompt({
            taskType: 'conversational-task',
            agentName,
            agentPersona: personaPrefix ? personaPrefix.replace(/\n\n$/, '') : undefined,
            identityLine,
            workspaceName: ctx.workspaceName,
            compactCapabilityBlock,
            preferencesBlock,
            memoryBlock,
            systemPromptExtra,
            userTimezone,
        })
        : buildTaskPrompt({
            taskType: 'task',
            agentName,
            agentPersona: personaPrefix ? personaPrefix.replace(/\n\n$/, '') : undefined,
            identityLine,
            workspaceName: ctx.workspaceName,
            workspaceSummary: ctx.workspaceSummary,
            primaryRepo: ctx.primaryRepo,
            sprintGoal: ctx.sprintGoal,
            sprintCodingBlock,
            scopePrimingBlock,
            taskGoal: plan.goal,
            taskSource: ctx.taskSource,
            plannedSteps: plan.steps.length,
            infrastructureBlock,
            mandatoryAssetBlock,
            sclContextBlock,
            capabilityBlock,
            browsingBlock,
            selfExtensionBlock,
            preferencesBlock,
            extensionPromptsBlock,
            memoryBlock,
            extensionContextBlock,
            systemPromptExtra,
            variantExtra,
            userTimezone,
        })

    // ── Checkpoint-aware execution loop ─────────────────────────────────
    // Check if we're resuming from a previous checkpoint.
    // FUN-014: Also check context.resumeFromTaskId — set by the retry handler
    // when re-queuing a blocked/failed task. This lets us rebuild message
    // history from the ORIGINAL task's persisted steps even though this is
    // a new task ID.
    const resumeFromTaskId = ctx.resumeFromTaskId
    const resumeStep = resumeFromTaskId
        ? await getResumeStep(resumeFromTaskId)
        : await getResumeStep(ctx.taskId)
    let isResuming = resumeStep > 0

    const genResult = await (async () => {
        let messages: ModelMessage[]
        let stepNum: number

        if (isResuming) {
            // Resume: rebuild messages from persisted step states of the source task
            const sourceTaskId = resumeFromTaskId ?? ctx.taskId
            const resume = await buildResumeMessages(sourceTaskId, systemPrompt, userMessage)
            messages = resume.messages as ModelMessage[]
            stepNum = resume.resumeFromStep
            // Emit resume event so the UI shows "Resumed from step N"
            ctx.emitStepEvent?.({ type: 'task_resumed', taskId: ctx.taskId, workspaceId: ctx.workspaceId, fromStep: stepNum, ts: Date.now() })
        } else {
            // Build the first user message. When the task arrived with image
            // attachments AND we have a vision-capable model in play, emit a
            // multimodal content array (text + image parts) so the LLM can
            // actually see the images. Otherwise fall back to plain text
            // (with a clear "vision unavailable" note when applicable).
            const hasUsableImages = ctx.inputImageUrls && ctx.inputImageUrls.length > 0 && visionDegradedNote === null
            if (hasUsableImages) {
                const parts: Array<{ type: 'text'; text: string } | { type: 'image'; image: URL }> = [
                    { type: 'text', text: userMessage },
                ]
                for (const rawUrl of ctx.inputImageUrls!) {
                    try {
                        parts.push({ type: 'image', image: new URL(rawUrl) })
                    } catch { /* skip invalid URLs silently */ }
                }
                messages = [{ role: 'user', content: parts }]
            } else if (ctx.inputImageUrls && ctx.inputImageUrls.length > 0 && visionDegradedNote) {
                messages = [{ role: 'user', content: `${userMessage}\n\n${visionDegradedNote} (${ctx.inputImageUrls.length} image${ctx.inputImageUrls.length > 1 ? 's' : ''} attached)` }]
            } else {
                messages = [{ role: 'user', content: userMessage }]
            }
            stepNum = 0
        }

        // No hard step limit. Tasks run until task_complete, a loop is
        // detected, the cost ceiling is reached, the wall-clock ceiling is
        // reached, or stall detection fires (no progress for 10 min).
        let accumulatedUsage = { inputTokens: 0, outputTokens: 0 }
        let accumulatedSteps: AiSdkStep[] = []
        let lastResult: GenerateResult | undefined

        // Stall detection state
        let lastProgressToolCount = 0
        let lastProgressTime = Date.now()
        let consecutiveNoToolCalls = 0

        // Repeated-tool stall detection: if the model calls the exact same
        // tool with the exact same args 3 times in a row, it's stuck in a
        // loop — stop the loop regardless of step budget.
        let lastRepeatedToolKey: string | null = null
        let repeatedToolCount = 0

        // Fix A+B tracking: count deliverables produced (write_file, write_asset)
        let deliverablesProduced = 0

        // Consecutive tool failure tracking: if ALL tool results start with
        // "ERROR:" for 3+ consecutive steps, inject a bail-out system message.
        let consecutiveAllToolErrorSteps = 0

        // Truncation-loop detection state.
        // Tracks the last tool call signature the model emitted. If the SAME
        // tool + SAME args produce a truncated / failed output twice in a
        // row, we bail rather than loop forever. Also primes a "be concise"
        // hint for the next step when we see the first truncation.
        let lastToolCallSignature: ToolCallSignature | null = null
        let pendingTruncationHint: string | null = null

        // Synthetic termination summary — set when loop detection bails out.
        // Propagated out via the IIFE return so the post-loop finalSummary
        // assignment prefers it over genResult.text.
        let syntheticStepLimitSummary: string | null = null

        while (true) {
            if (ctx.signal.aborted) break

            // Fix B: gate self_reflect — only available after at least one
            // deliverable (write_file/write_asset) has been produced. Prevents
            // wasting step 0 on introspection before any work is done.
            const stepTools = deliverablesProduced > 0
                ? allTools
                : Object.fromEntries(
                    Object.entries(allTools).filter(([k]) => k !== 'self_reflect')
                ) as typeof allTools

            // Wall-clock start for this step — stamped into stepState below so
            // the chat thinking panel can show a non-zero duration per step
            // (previously every step was rendered as "0ms" because startedAt
            // and completedAt used the same row.createdAt value).
            const stepWallStart = Date.now()
            ctx.emitStepEvent?.({
                type: 'agent_step',
                taskId: ctx.taskId,
                workspaceId: ctx.workspaceId,
                step: stepNum,
                ts: stepWallStart,
            })

            // ── Pre-step lifecycle row (Phase 2) ──────────────────────────
            // Insert a `state='running'` placeholder so the row exists if
            // we throw mid-step. The end-of-step UPDATE flips it to
            // `completed` or `failed`. If pre-insert fails, we fall back
            // to the historical "single insert at end" path (see below).
            let stepRowId: string | null = null
            try {
                const inserted = await db.insert(taskSteps).values({
                    taskId: ctx.taskId,
                    stepNumber: stepNum,
                    state: 'running',
                    startedAt: new Date(stepWallStart),
                    attempts: 1,
                    // Sub-phase marker so the chat SSE projector can stream
                    // "Generating (model)" while a single long step is in
                    // flight. Reflects the primary provider pre-fallback —
                    // a progress hint, not authoritative attribution.
                    stepState: {
                        phase: 'generating',
                        model: `${resolvedMeta.provider}/${resolvedMeta.id}`,
                        startedAt: stepWallStart,
                    },
                }).returning({ id: taskSteps.id })
                stepRowId = inserted[0]?.id ?? null
            } catch (preErr) {
                const pinoMod = await import('pino')
                pinoMod.default({ name: 'executor' }).warn({ err: preErr, taskId: ctx.taskId, stepNum }, 'Step pre-insert failed — will fall back to end-of-step insert')
            }

            // Compose the task-level signal with a per-step wall-clock timeout
            // so a hung model (e.g. deepseek-reasoner stuck 90s+ on chain-of-
            // thought) cannot wedge the executor indefinitely. Env-gated
            // default 180s. AbortSignal.any is Node 20.3+; compose runs Node 22.
            //
            // NOTE: Phase 3 of hardening intentionally does NOT migrate this
            // call site to `callModel`. The executor needs `result.steps` +
            // `result.toolCalls` + the full generateText return shape, and
            // callModel currently returns only `{text, usage}`. Migrating
            // here would require widening callModel's return type, which is
            // a Phase 4 / future-phase concern. For now the executor keeps
            // the direct generateText call with Phase 2's wall-clock timeout
            // unchanged.
            const STEP_TIMEOUT_MS = Number(process.env.EXECUTOR_STEP_TIMEOUT_MS) || 180_000
            const stepSignal = AbortSignal.any([ctx.signal, AbortSignal.timeout(STEP_TIMEOUT_MS)])

            // Compact stale tool results before handing messages to the model.
            // Keeps the most recent tool result at full fidelity, replaces older
            // large payloads (e.g. web_read_page HTML text, web_fetch bodies)
            // with short abstracts so input tokens don't grow unboundedly with
            // step count. No-op for tasks that haven't made any tool calls yet.
            compactStaleToolResults(messages)
            // FUN-016: Compact old assistant text messages to prevent unbounded growth.
            compactStaleAssistantMessages(messages)

            // If the previous step was truncated, prepend a one-shot "be
            // concise / finish the previous write" user turn before calling
            // the model again. We inject it here so it lands AFTER
            // compactStaleToolResults and immediately BEFORE generateText.
            if (pendingTruncationHint) {
                messages.push({ role: 'user', content: pendingTruncationHint })
                pendingTruncationHint = null
            }

            // Resolve output-token ceiling:
            //   1. explicit per-task tokenBudget > 0 wins (workspace/sprint setting)
            //   2. EXECUTOR_MAX_OUTPUT_TOKENS env override wins over model defaults
            //   3. per-model natural max (e.g. deepseek 8192, gpt-4o 16K, claude 8192+)
            //   4. fallback 8192 — well above the 4096 deepseek-chat SDK default
            // This prevents the "model writes half an HTML file then the SDK
            // caps at 4096, truncates the tool call mid-JSON-string, tool
            // never runs, executor loops forever" failure mode.
            const resolvedCeiling = (ctx.tokenBudget && ctx.tokenBudget > 0)
                ? ctx.tokenBudget
                : resolveOutputCeiling(resolvedMeta.provider, resolvedMeta.id)

            // Step-level retry for transient model timeouts. A single
            // AbortSignal timeout (180s default) shouldn't permanently block
            // the task — retry once with backoff before letting it propagate
            // to agent-loop.ts which would call blockTask().
            const STEP_RETRY_BACKOFF_MS = 30_000
            const MAX_STEP_RETRIES = 2
            let stepRetries = 0
            let result: GenerateResult

            try {
                // eslint-disable-next-line no-constant-condition
                while (true) {
                    try {
                        // Re-create the step signal on retry since the previous
                        // one may already be in aborted state from the timeout.
                        const currentStepSignal = stepRetries > 0
                            ? AbortSignal.any([ctx.signal, AbortSignal.timeout(STEP_TIMEOUT_MS)])
                            : stepSignal

                        // routeAndCall handles cascade fallback across providers:
                        // auth, rate-limit, quota, transient-5xx, network, and
                        // parse-malformed errors all advance to the next candidate.
                        // onFallbackEngaged fires when the first provider fails so
                        // resolvedMeta, cost attribution, and step events stay in sync
                        // with the provider that actually served the step.
                        result = await routeAndCall({
                            workspaceId: ctx.workspaceId,
                            taskId: ctx.taskId,
                            taskType: taskTier,
                            settings: effectiveSettings,
                            doCall: async (model) => {
                                const stepResult = await generateText({
                                    model,
                                    system: systemPrompt,
                                    messages,
                                    tools: stepTools,
                                    maxOutputTokens: resolvedCeiling,
                                    // stopWhen defaults to stepCountIs(1) — one tool call per outer iteration.
                                    // Each iteration is checkpointed to DB so crashes lose at most 1 step.
                                    abortSignal: currentStepSignal,
                                })
                                return stepResult
                            },
                            opts: {
                                workspaceId: ctx.workspaceId,
                                onFallbackEngaged: (info) => {
                                    // Update resolvedMeta so downstream
                                    // (cost attribution, step events,
                                    // identity line) reflect the provider
                                    // that actually served this step.
                                    const newProvider = info.used as import('../providers/registry.js').ProviderKey
                                    const newConfig = effectiveSettings.providers[newProvider]
                                    const newModelId = effectiveSettings.modelOverrides?.[taskTier]
                                        ?? newConfig?.model
                                        ?? PROVIDER_DEFAULT_MODELS[newProvider]
                                        ?? resolvedMeta.id
                                    resolvedMeta = {
                                        ...resolvedMeta,
                                        provider: newProvider,
                                        id: newModelId,
                                    }
                                    ctx.emitStepEvent?.({
                                        type: 'provider_fallback_engaged',
                                        taskId: ctx.taskId,
                                        workspaceId: ctx.workspaceId,
                                        primary: info.primary,
                                        used: info.used,
                                        skipped: info.skipped,
                                        lastError: info.lastError,
                                        ts: Date.now(),
                                    })
                                },
                            },
                        })
                        break // success — exit retry loop
                    } catch (stepErr) {
                        // Unwrap RouterV2CallError so abort/timeout checks below
                        // see the root cause (e.g. AbortError from the step signal).
                        const rootErr = stepErr instanceof RouterV2CallError ? stepErr.cause : stepErr
                        // Only retry abort/timeout errors, not task-level cancellation
                        const isTimeout = rootErr instanceof Error && (
                            rootErr.name === 'AbortError'
                            || rootErr.name === 'TimeoutError'
                            || rootErr.message.includes('aborted')
                            || rootErr.message.includes('timeout')
                        )
                        // Tool validation errors (Zod schema failures) should not
                        // block the task — the AI SDK normally handles these
                        // internally but edge cases can throw. Retry so the model
                        // gets another chance with different arguments.
                        const isToolValidation = rootErr instanceof Error && (
                            rootErr.name === 'AI_InvalidToolInputError'
                            || rootErr.message.includes('invalid_union')
                            || rootErr.message.includes('Invalid input for tool')
                            || rootErr.message.includes('TypeValidationError')
                        )
                        // If the task-level signal was aborted (user cancel), don't retry
                        const isTaskCancelled = ctx.signal.aborted

                        if ((isTimeout || isToolValidation) && !isTaskCancelled && stepRetries < MAX_STEP_RETRIES) {
                            stepRetries++
                            try {
                                const pinoMod = await import('pino')
                                pinoMod.default({ name: 'executor' }).warn({
                                    taskId: ctx.taskId,
                                    workspaceId: ctx.workspaceId,
                                    stepNum,
                                    retryAttempt: stepRetries,
                                    backoffMs: STEP_RETRY_BACKOFF_MS,
                                    provider: resolvedMeta.provider,
                                    modelId: resolvedMeta.id,
                                }, 'executor.step_timeout — retrying after backoff')
                            } catch { /* non-fatal logging */ }
                            await new Promise((r) => setTimeout(r, STEP_RETRY_BACKOFF_MS))
                            continue // retry the step
                        }
                        throw stepErr // exhausted retries or non-timeout error
                    }
                }
            } catch (modelErr) {
                // Mark the running step row as failed before bubbling up to
                // executeTask's caller (agent-loop.ts), which will then call
                // markTaskFailed for the task as a whole.
                if (stepRowId) {
                    try {
                        await db.update(taskSteps)
                            .set({
                                state: 'failed',
                                completedAt: new Date(),
                                error: modelErr instanceof Error ? modelErr.message : String(modelErr),
                                attempts: stepRetries + 1,
                            })
                            .where(eq(taskSteps.id, stepRowId))
                    } catch { /* swallow — caller will surface the original error */ }
                }
                throw modelErr
            }

            // ── Truncation-loop detection ──────────────────────────────
            // If the model hit `finishReason: length` AND produced an empty/
            // missing tool-call output, that's the classic "truncated mid-
            // JSON-string" signature. Log it, and:
            //   - first occurrence → stash a hint for the next step asking
            //     the model to produce a more concise version
            //   - second occurrence with the SAME tool+args → bail with a
            //     terminal error. The model can't fit this output in its
            //     ceiling; looping won't help.
            const trunc = detectTruncatedToolCall(result)
            if (trunc.truncated) {
                const firstToolCall = (result.steps ?? [])
                    .flatMap((s: AiSdkStep) => s.toolCalls ?? [])[0]
                const toolName = firstToolCall?.toolName ?? trunc.toolName ?? '(none)'
                const toolInput = firstToolCall?.input
                const argsHash = hashToolCallArgs(toolInput)
                const signature: ToolCallSignature = { toolName, argsHash, failed: true }

                try {
                    const pinoMod = await import('pino')
                    pinoMod.default({ name: 'executor' }).warn({
                        taskId: ctx.taskId,
                        workspaceId: ctx.workspaceId,
                        stepNum,
                        toolName,
                        outputTokens: result.usage.outputTokens,
                        ceiling: resolvedCeiling,
                        provider: resolvedMeta.provider,
                        modelId: resolvedMeta.id,
                    }, 'executor.output_truncated')
                } catch { /* non-fatal logging */ }

                if (
                    lastToolCallSignature?.failed
                    && lastToolCallSignature.toolName === signature.toolName
                    && lastToolCallSignature.argsHash === signature.argsHash
                ) {
                    // Same call, same args, same failure → infinite loop
                    // guaranteed. Bail with a user-visible terminal error.
                    throw new PlexoError(
                        `Model output exceeded ${resolvedCeiling} tokens and truncated the \`${toolName}\` tool call twice in a row (${resolvedMeta.provider}/${resolvedMeta.id}). The single-shot output for this task is too large for the current model's output window. Try breaking the work into smaller files, or route to a model with a larger output ceiling (set EXECUTOR_MAX_OUTPUT_TOKENS or switch model).`,
                        'OUTPUT_TRUNCATION_LOOP',
                        'system',
                        500,
                    )
                }

                lastToolCallSignature = signature
                pendingTruncationHint = `Your previous \`${toolName}\` tool call was truncated at the ${resolvedCeiling}-token output limit before the tool ran, so no change was made. Produce a more concise version on this retry: minify whitespace, drop comments, inline only what's essential, and prioritise completing the full tool call within the output budget. If the content truly cannot fit, split it across multiple smaller tool calls.`
            } else {
                // Successful step — reset the truncation loop tracker so
                // the next (different) truncation isn't mistakenly counted
                // as a repeat.
                lastToolCallSignature = null
            }

            const inToks = result.usage.inputTokens ?? 0
            const outToks = result.usage.outputTokens ?? 0
            accumulatedUsage.inputTokens += inToks
            accumulatedUsage.outputTokens += outToks
            accumulatedSteps = accumulatedSteps.concat(result.steps)

            // Re-emit agent_step with the tool name that was just called so
            // channel adapters (Telegram, SMS, webchat) can render a plain-
            // English progress line instead of "Step N…". Only emit when we
            // actually have a tool — task_complete is suppressed because the
            // "Done." terminal message will replace the progress message next.
            const firstStepToolCall = (result.steps ?? [])
                .flatMap((s: AiSdkStep) => s.toolCalls ?? [])[0]
            if (firstStepToolCall?.toolName && firstStepToolCall.toolName !== 'task_complete') {
                ctx.emitStepEvent?.({
                    type: 'agent_step',
                    taskId: ctx.taskId,
                    workspaceId: ctx.workspaceId,
                    step: stepNum,
                    tool: firstStepToolCall.toolName,
                    description: describeToolCall(firstStepToolCall.toolName),
                    ts: Date.now(),
                })
            }

            let isTerminal = hasTaskComplete(result)

            // ── Auto-complete for conversational tasks when model refuses to call tools ──
            // Some models (e.g. deepseek-reasoner) respond with text but never call
            // task_complete, causing the loop to spin indefinitely. For conversational
            // tasks, if the model produced text but zero tool calls, treat the text
            // response as the summary and synthetically complete the task.
            const stepHasToolCalls = result.steps.some((s: AiSdkStep) => (s.toolCalls?.length ?? 0) > 0)
            if (isConversational && !isTerminal && !stepHasToolCalls && result.text) {
                // Synthetically invoke task_complete with the model's text response
                await dispatchTool('task_complete', {
                    summary: result.text,
                    qualityScore: 0.9,
                    outcome: 'completed',
                }, ctx)
                isTerminal = true
            }

            // ── Checkpoint: persist step state to DB ──────────────────────
            try {
                const stepToolCalls = result.steps.flatMap((s: AiSdkStep) =>
                    (s.toolCalls ?? []).map((tc: AiSdkToolCall) => {
                        const toolResult = s.toolResults?.find(r => r.toolCallId === tc.toolCallId)
                        return {
                            tool: tc.toolName,
                            input: tc.input ?? {},
                            output: toolResult ? String(toolResult.output ?? '') : '',
                        }
                    })
                )
                const stepWallEnd = Date.now()
                const stepHadToolCall = stepToolCalls.length > 0
                const checkpointPayload = {
                    model: `${resolvedMeta.provider}/${resolvedMeta.id}`,
                    tokensIn: inToks,
                    tokensOut: outToks,
                    toolCalls: stripNullBytes(stepToolCalls),
                    outcome: isTerminal ? 'complete' : 'running',
                    stepState: stripNullBytes({
                        responseMessages: result.response?.messages,
                        // Wall-clock step timing — used by the chat SSE
                        // projector to render per-step durations in the UI.
                        startedAt: stepWallStart,
                        completedAt: stepWallEnd,
                        durationMs: stepWallEnd - stepWallStart,
                        ...(routingFallbackUsed && stepNum === 0 ? {
                            routingFallback: true,
                            routingFallbackReason: routingFallbackReason,
                        } : {}),
                    }),
                    isTerminal,
                    // Phase 2 lifecycle columns: the step's model iteration
                    // returned successfully — flip state to 'completed'. The
                    // catch arm of the model-call try block above handles
                    // the 'failed' branch separately.
                    state: 'completed' as const,
                    completedAt: new Date(stepWallEnd),
                    attempts: stepRetries + 1,
                    stepType: (stepHadToolCall ? 'tool_call' : 'llm_generation') as 'tool_call' | 'llm_generation',
                }
                if (stepRowId) {
                    await db.update(taskSteps)
                        .set(checkpointPayload)
                        .where(eq(taskSteps.id, stepRowId))
                } else {
                    // Pre-insert failed earlier — fall back to a single insert
                    // with started_at populated from the in-memory wall-clock.
                    await db.insert(taskSteps).values({
                        taskId: ctx.taskId,
                        stepNumber: stepNum,
                        startedAt: new Date(stepWallStart),
                        ...checkpointPayload,
                    })
                }
                stepNum++
            } catch (checkpointErr) {
                // Non-fatal — missing checkpoint means no resume on crash, but task continues
                const pinoMod = await import('pino')
                pinoMod.default({ name: 'executor' }).warn({ err: checkpointErr, taskId: ctx.taskId, stepNum }, 'Step checkpoint failed')
            }

            // Fix A+B: track deliverables produced this step
            for (const s of result.steps as AiSdkStep[]) {
                for (const tc of (s.toolCalls ?? [])) {
                    if (tc.toolName === 'write_file' || tc.toolName === 'write_asset') {
                        deliverablesProduced++
                    }
                }
            }

            // ── Repeated-tool loop detection ──────────────────────────────
            // If the model calls the exact same tool+args 3 times in a row,
            // it's stuck in a loop. Bail and report partial progress.
            if (stepHasToolCalls && !isTerminal) {
                const repeatedToolNames = result.steps
                    .flatMap((s: AiSdkStep) => (s.toolCalls ?? []))
                    .map((tc: AiSdkToolCall) => tc.toolName)
                    .join(', ')
                const stepToolKey = result.steps
                    .flatMap((s: AiSdkStep) => (s.toolCalls ?? []))
                    .map((tc: AiSdkToolCall) => `${tc.toolName}:${JSON.stringify(tc.args ?? tc.input ?? {})}`)
                    .join('|')
                if (stepToolKey && stepToolKey === lastRepeatedToolKey) {
                    repeatedToolCount++
                } else {
                    lastRepeatedToolKey = stepToolKey
                    repeatedToolCount = 1
                }

                if (repeatedToolCount >= 3) {
                    try {
                        const pinoMod = await import('pino')
                        pinoMod.default({ name: 'executor' }).warn({
                            taskId: ctx.taskId,
                            workspaceId: ctx.workspaceId,
                            stepNum,
                            toolKey: stepToolKey,
                        }, 'executor.repeated_tool_stall — same tool call 3x in a row, stopping loop')
                    } catch { /* non-fatal logging */ }
                    const loopSummary = `I got stuck in a loop calling \`${repeatedToolNames}\` ${repeatedToolCount} times with identical arguments without making progress. So far I've produced ${deliverablesProduced} deliverable(s). Want me to try a different approach?`
                    await dispatchTool('task_complete', {
                        summary: loopSummary,
                        qualityScore: deliverablesProduced > 0 ? 0.5 : 0.3,
                        outcome: deliverablesProduced > 0 ? 'partial' : 'blocked',
                    }, ctx)
                    syntheticStepLimitSummary = loopSummary
                    lastResult = result
                    break
                }
            }

            // ── Invalid tool call detection (Zod validation errors) ─────────
            // AI SDK v6 marks tool calls with `invalid: true` when Zod schema
            // validation fails (e.g. `invalid_union` from bad enum values or
            // null where undefined/value expected). The SDK feeds the raw Zod
            // error back via tool-error but the message is cryptic. Detect
            // these and inject a clear retry hint so the model self-corrects
            // instead of spinning until loop detection fires.
            const invalidToolCalls = result.steps.flatMap((s: AiSdkStep) =>
                (s.toolCalls ?? []).filter(tc => tc.invalid === true)
            )
            // Build details string now (used for message injection after
            // response.messages are appended — see below).
            let invalidToolCallHint: string | null = null
            if (invalidToolCalls.length > 0 && !isTerminal) {
                const details = invalidToolCalls.map((tc: AiSdkToolCall) => {
                    const errMsg = tc.error instanceof Error ? tc.error.message : String(tc.error ?? 'unknown')
                    return `Tool "${tc.toolName}": ${errMsg}`
                }).join('\n')

                try {
                    const pinoMod = await import('pino')
                    pinoMod.default({ name: 'executor' }).warn({
                        taskId: ctx.taskId,
                        workspaceId: ctx.workspaceId,
                        stepNum,
                        invalidTools: invalidToolCalls.map((tc: AiSdkToolCall) => tc.toolName),
                    }, 'executor.invalid_tool_args — injecting retry hint')
                } catch { /* non-fatal logging */ }

                invalidToolCallHint = `Your previous tool call(s) failed schema validation and were NOT executed:\n${details}\n\nCommon causes: sending null instead of omitting optional fields, wrong enum value, wrong argument type. Fix the arguments and retry. If you cannot fix it, call task_complete with outcome "blocked" and explain the issue.`
            }

            // ── Consecutive tool failure detection ──────────────────────────
            // If every tool result in this step starts with "ERROR:" OR every
            // tool call was invalid (Zod validation failure), increment the
            // consecutive failure counter. After 3+ such steps, bail out and
            // report what went wrong.
            if (stepHasToolCalls) {
                const allToolResults = result.steps.flatMap((s: AiSdkStep) =>
                    (s.toolResults ?? []).map(r => String(r.output ?? ''))
                )
                const allFailed = (allToolResults.length > 0 && allToolResults.every((o: string) => o.startsWith('ERROR:')))
                    || (invalidToolCalls.length > 0 && allToolResults.length === 0)
                if (allFailed) {
                    consecutiveAllToolErrorSteps++
                } else {
                    consecutiveAllToolErrorSteps = 0
                }

                if (consecutiveAllToolErrorSteps >= 3 && !isTerminal) {
                    const lastError = allToolResults[allToolResults.length - 1]
                        ?? (invalidToolCalls[0]?.error instanceof Error ? invalidToolCalls[0].error.message : String(invalidToolCalls[0]?.error ?? 'unknown'))
                    try {
                        const pinoMod = await import('pino')
                        pinoMod.default({ name: 'executor' }).warn({
                            taskId: ctx.taskId,
                            workspaceId: ctx.workspaceId,
                            consecutiveAllToolErrorSteps,
                            stepNum,
                            lastError: lastError.slice(0, 200),
                        }, 'executor.consecutive_tool_failures — bailing out')
                    } catch { /* non-fatal logging */ }
                    const failureSummary = `I kept hitting the same error after ${consecutiveAllToolErrorSteps} consecutive failed tool calls and stopped to avoid wasting effort. Last error: ${lastError.slice(0, 500)}. So far I've produced ${deliverablesProduced} deliverable(s). Want me to try a different approach?`
                    await dispatchTool('task_complete', {
                        summary: failureSummary,
                        qualityScore: deliverablesProduced > 0 ? 0.5 : 0.3,
                        outcome: deliverablesProduced > 0 ? 'partial' : 'blocked',
                    }, ctx)
                    syntheticStepLimitSummary = failureSummary
                    lastResult = result
                    break
                }
            }

            // Fix A: terminal step detection — nudge model to call task_complete
            // when plan steps are exhausted and deliverables exist.
            if (
                !isTerminal
                && !isConversational
                && deliverablesProduced > 0
                && stepNum >= plan.steps.length
            ) {
                messages.push({
                    role: 'user',
                    content: 'You have completed all planned steps and produced deliverables. Call task_complete now with a summary of what was delivered.',
                })
            }

            // Progress tracking: count total meaningful tool calls (exclude no-ops)
            const totalToolCalls = accumulatedSteps.reduce(
                (n: number, s: AiSdkStep) => n + (s.toolCalls?.length ?? 0), 0
            )

            if (totalToolCalls > lastProgressToolCount) {
                lastProgressToolCount = totalToolCalls
                lastProgressTime = Date.now()
            }

            // Stall detection: no new tool calls produced in stallWindowMs → likely stuck
            const stallDuration = Date.now() - lastProgressTime
            if (stallDuration > SAFETY_LIMITS.stallWindowMs) {
                throw new PlexoError(
                    `Task stalled: no progress for ${Math.round(stallDuration / 60_000)} minutes (${totalToolCalls} total tool calls). Goal: ${plan.goal}`,
                    'TASK_STALLED',
                    'system',
                    500,
                )
            }

            // Absolute ceiling — catch-all for runaway tasks
            if (Date.now() - startTime > SAFETY_LIMITS.maxWallClockMs) {
                throw new PlexoError(
                    `Absolute time ceiling reached (${Math.round(SAFETY_LIMITS.maxWallClockMs / 3_600_000)}h). Task was making progress but exceeded maximum allowed duration.`,
                    'WALL_CLOCK_EXCEEDED',
                    'system',
                    500,
                )
            }

            if (isTerminal) {
                // Promote write_file outputs to works on normal completion too —
                // not just forced termination. If the model used write_file instead
                // of write_asset, files exist on disk but aren't in the assets DB.
                if (deliverablesProduced > 0) {
                    try {
                        const promoted = await promoteWriteFilesToWorks(accumulatedSteps, ctx)
                        if (promoted.length > 0) {
                            const pinoMod = await import('pino')
                            pinoMod.default({ name: 'executor' }).info({ taskId: ctx.taskId, promoted }, 'executor.normal_complete_promote — promoted write_file outputs to works')
                        }
                    } catch (promoteErr) {
                        const pinoMod = await import('pino')
                        pinoMod.default({ name: 'executor' }).warn({ err: promoteErr, taskId: ctx.taskId }, 'executor.normal_complete_promote failed')
                    }
                }
                lastResult = result
                break
            }

            // Track consecutive iterations with no tool calls (model producing only text).
            // After 2 such iterations, inject a nudge. After 5, bail with the
            // accumulated text — the model is stuck producing prose instead of
            // calling task_complete.
            if (!stepHasToolCalls) {
                consecutiveNoToolCalls++
            } else {
                consecutiveNoToolCalls = 0
            }

            if (consecutiveNoToolCalls >= 5) {
                const recentText = (result.text || '').trim()
                const bailSummary = recentText.length > 0
                    ? recentText
                    : `I got stuck producing text without calling any tools after ${consecutiveNoToolCalls} attempts. So far I've produced ${deliverablesProduced} deliverable(s). Want me to try a different approach?`
                try {
                    const pinoMod = await import('pino')
                    pinoMod.default({ name: 'executor' }).warn({
                        taskId: ctx.taskId,
                        workspaceId: ctx.workspaceId,
                        consecutiveNoToolCalls,
                        stepNum,
                    }, 'executor.no_tool_calls_loop — bailing out')
                } catch { /* non-fatal logging */ }
                await dispatchTool('task_complete', {
                    summary: bailSummary,
                    qualityScore: deliverablesProduced > 0 ? 0.5 : 0.3,
                    outcome: deliverablesProduced > 0 ? 'partial' : 'blocked',
                }, ctx)
                syntheticStepLimitSummary = bailSummary
                lastResult = result
                break
            }

            // Append step messages for context continuity
            messages = messages.concat((result.response?.messages ?? []) as ModelMessage[])

            // Inject invalid-tool-call retry hint AFTER response.messages so
            // the model sees: assistant(tool_call) → tool(error) → user(hint).
            if (invalidToolCallHint) {
                messages.push({ role: 'user', content: invalidToolCallHint })
            }

            // Nudge: if the model has gone 2+ iterations without calling any tools,
            // inject a user-role reminder to call task_complete.
            if (consecutiveNoToolCalls >= 2) {
                messages.push({
                    role: 'user',
                    content: 'You have not called any tools in your last 2 responses. You MUST call task_complete now to finish this task. Put your final answer in the summary field.',
                })
            }
        }

        return {
            ...lastResult,
            usage: accumulatedUsage,
            steps: accumulatedSteps,
            text: lastResult?.text ?? '',
            syntheticStepLimitSummary,
        }
    })()

    // AI SDK v6: usage.inputTokens / usage.outputTokens
    const tokensIn = genResult.usage.inputTokens ?? 0
    const tokensOut = genResult.usage.outputTokens ?? 0

    // Cost calculation: use real pricing from router meta. When metadata is
    // missing (e.g. ollama_cloud or a model not yet in the knowledge table)
    // we record $0 rather than fabricating Sonnet rates — fabricated prices
    // tripped the workspace ceiling on free/cheap models. Provider-side caps
    // are the safety net when in-app pricing is unknown.
    const costPerMIn = resolvedMeta.costPerMIn > 0 ? resolvedMeta.costPerMIn : 0
    const costPerMOut = resolvedMeta.costPerMOut > 0 ? resolvedMeta.costPerMOut : 0
    if (costPerMIn === 0 && costPerMOut === 0 && (tokensIn > 0 || tokensOut > 0)) {
        logger.warn({ provider: resolvedMeta.provider, modelId: resolvedMeta.id, tokensIn, tokensOut }, 'cost: model has no pricing in router meta, recording $0')
    }
    const costUsd = (tokensIn / 1_000_000) * costPerMIn + (tokensOut / 1_000_000) * costPerMOut
    totalTokensIn += tokensIn
    totalTokensOut += tokensOut
    totalCost += costUsd
    totalCostMicro = addMicro(totalCostMicro, toMicro(costUsd))

    // Per-task cost ceiling check (mid-run, after accumulation).
    // A6 cutover: compare via integer micro-USD so edge-of-ceiling is exact.
    if (ctx.taskCostCeilingUsd != null && cmpMicro(totalCostMicro, toMicro(ctx.taskCostCeilingUsd)) >= 0) {
        throw new PlexoError(
            `Task cost ceiling reached: $${fmtMicroUsd(totalCostMicro, 4)} >= $${fmtMicroUsd(toMicro(ctx.taskCostCeilingUsd), 4)}`,
            'TASK_COST_CEILING',
            'system',
            429,
        )
    }

    // Workspace aggregate ceiling check — re-evaluate against the real
    // workspace spend from inference_logs (same query as the pre-run gate)
    // instead of comparing only this task's local totalCost.
    try {
        await assertAgentCostCeilingOk(ctx.workspaceId)
    } catch (gateErr) {
        if (gateErr instanceof CostCeilingExceededError) {
            throw new PlexoError(
                `Workspace cost ceiling reached: spent $${gateErr.spentUsd.toFixed(4)} of $${gateErr.ceilingUsd.toFixed(2)} ceiling`,
                'COST_CEILING_REACHED',
                'system',
                429,
            )
        }
        // Non-fatal — don't kill a running task over a transient DB error
        logger.warn({ err: gateErr }, 'Mid-run cost ceiling check failed (non-fatal)')
    }

    // AI SDK v6: toolCalls[].input (not .args), toolResults[].output (not .result)
    const toolCallRecords: StepResult['toolCalls'] = []
    for (const step of genResult.steps) {
        for (const tc of (step.toolCalls ?? [])) {
            // TypedToolCall has .input in v6; DynamicToolCall also has .input
            const input = (tc as { input: unknown }).input as Record<string, unknown>
            const toolResult = (step.toolResults ?? []).find((r: AiSdkToolResult) => r.toolCallId === tc.toolCallId)
            // TypedToolResult / DynamicToolResult have .output in v6
            const output = toolResult
                ? String((toolResult as { output: unknown }).output ?? '')
                : ''

            toolCallRecords.push({
                tool: tc.toolName,
                input,
                output,
            })

            if (tc.toolName === 'task_complete') {
                try {
                    const parsed = JSON.parse(output) as { summary: string; qualityScore: number }
                    finalSummary = parsed.summary
                    finalQuality = Math.min(1, Math.max(0, parsed.qualityScore))
                } catch {
                    finalSummary = output
                }
            }
        }
    }

    // Audit: log all tool invocations from this execution.
    // Phase 7 — pass extension identity map so per-extension tool calls
    // carry display name and version in the audit trail.
    void logToolCalls({
        workspaceId: ctx.workspaceId,
        sessionId: ctx.taskId,
        modelId: resolvedMeta.id,
        modelProvider: resolvedMeta.provider,
        extensionIdentities,
        toolCalls: toolCallRecords.map((tc) => ({
            tool: tc.tool,
            input: tc.input,
            output: String(tc.output ?? ''),
        })),
    }).catch((err: unknown) => { logger.error({ err, workspaceId: ctx.workspaceId, taskId: ctx.taskId }, 'logToolCalls failed') })

    if (!finalSummary) {
        // Prefer the synthetic termination summary when the loop bailed out
        // (loop detection, repeated tool failures) without a real task_complete.
        finalSummary = (genResult as { syntheticStepLimitSummary?: string | null }).syntheticStepLimitSummary
            || genResult.text
            || 'Agent stopped without calling task_complete'
    }

    const stepDurationMs = Date.now() - stepStart

    // Step records are now checkpointed inside the loop (Phase 2).
    // No additional insert needed here.

    stepResults.push({
        stepNumber: 1,
        ok: true,
        output: finalSummary,
        toolCalls: toolCallRecords,
        tokensIn,
        tokensOut,
        costUsd,
        durationMs: stepDurationMs,
    })

    // Phase M (ADR 0002): build the result with qualityScore=null (pending) and
    // return it WITHOUT waiting on the quality judge. The judge is an LLM
    // ensemble call; running it inline delayed user-visible completion. It now
    // runs in a tracked detached promise that patches the real score onto the
    // task row. completeTask (agent-loop) persists status=complete with a null
    // score and will not clobber the judge's patched value (see queue complete()).
    const executionResult: ExecutionResult = {
        taskId: ctx.taskId,
        ok: true,
        steps: stepResults,
        outcomeSummary: finalSummary,
        qualityScore: null,
        totalTokensIn,
        totalTokensOut,
        totalCostUsd: totalCost,
        totalDurationMs: Date.now() - startTime,
    }


    // NOTE: api_cost_tracking is written ONLY by agent-loop.ts after completeTask().
    // Do NOT write it here — doing so would double-count every task's spend.

    const toolsUsed = stepResults.flatMap((s) => s.toolCalls.map((t) => t.tool))
    const filesWritten = stepResults.flatMap((s) =>
        s.toolCalls
            .filter((t) => t.tool === 'write_file' || t.tool === 'create_file')
            .map((t) => String((t.input as Record<string, unknown>)?.path ?? ''))
            .filter(Boolean),
    )

    // ── Structural Proof: syntax-check written files (coding tasks only) ──────
    // Independent of the judge; stays a plain fire-and-forget (non-fatal: a
    // proof failure is logged but does not change ok:true — the work shipped).
    if (ctx.sprintWorkDir && filesWritten.length > 0) {
        void import('./structural-proof.js').then(async ({ verifyStructure }) => {
            const workDir = ctx.sprintWorkDir!
            const { resolve, isAbsolute } = await import('node:path')
            const absPaths = filesWritten.map((p) => isAbsolute(p) ? p : resolve(workDir, p))
            const proof = await verifyStructure(absPaths).catch(() => null)
            if (proof && !proof.passed) {
                const pinoMod = await import('pino')
                pinoMod.default({ name: 'executor.proof' }).warn(
                    { violations: proof.violations.length, filesChecked: proof.filesChecked },
                    'structural-proof: syntax violations detected post-execution',
                )
            }
        }).catch((err) => console.warn('[executor] structural-proof import/run failed (non-fatal)', err instanceof Error ? err.message : String(err)))
    }

    // Clean up tool worker thread — independent of the judge; do it before return.
    if (toolWorker) {
        await toolWorker.destroy().catch((err: unknown) => { logger.warn({ err }, 'toolWorker.destroy failed') })
    }

    // ── Detached quality judge + score-dependent consumers (Phase M) ──────────
    // Everything below previously ran inline before the return. It now runs off
    // the hot path: the judge settles the real verified score, patches it onto
    // the task row, and the memory/reflection/credit/variant consumers receive
    // that real score (never the self-reported one). Tracked so a graceful
    // shutdown can drain in-flight judges; a throw bumps `judge_dropped` and
    // leaves the score pending rather than fabricating one.
    trackJudge((async () => {
        // Independent quality judge — decoupled from self-assessment to prevent
        // reward hacking. Falls back to the self-reported score on any failure.
        const judgeResult = await judgeQuality({
            taskType: ctx.taskType ?? 'coding',
            goal: plan.goal,
            deliverableSummary: finalSummary,
            toolsUsed: toolCallRecords.map((t) => t.tool),
            selfScore: finalQuality,
            aiSettings,
            userRequest: plan.goal,
        }).catch((err) => {
            console.warn('[executor] quality judge failed, falling back to self-score', err instanceof Error ? err.message : String(err))
            return { score: finalQuality, meta: { mode: 'fallback' as const, selfScore: finalQuality, judgeCount: 0, dissenters: [], models: [] } }
        })

        const verifiedQuality = judgeResult.score
        const judgeMeta: JudgeMeta = judgeResult.meta

        // Patch the settled score + judge metadata onto the task row. Uses
        // COALESCE so a concurrent completeTask with a pending(null) score can't
        // null this out; the jsonb merge mirrors what agent-loop did inline.
        await db.update(tasks).set({
            qualityScore: verifiedQuality,
            // Round-5 Phase 3: denormalize the provider/model that actually
            // served the final step (resolvedMeta tracks fallback) so the
            // routing scorecard can join model → qualityScore without a
            // routing_events join. Write-once here alongside the settled score.
            routedProvider: resolvedMeta.provider,
            routedModel: resolvedMeta.id,
            context: sql`COALESCE(context, '{}'::jsonb) || ${JSON.stringify({ _judge: judgeMeta })}::jsonb`,
        }).where(eq(tasks.id, ctx.taskId))
            .catch((err) => logger.warn({ err, taskId: ctx.taskId }, 'judge score/meta patch failed (non-fatal)'))

        const memOutcome: 'success' | 'partial' | 'failure' = executionResult.ok
            ? verifiedQuality >= 0.7
                ? 'success'
                : 'partial'
            : 'failure'

        // Memory writes are non-blocking but we log failures so they're diagnosable.
        const pinoMod = await import('pino')
        const memLogger = pinoMod.default({ name: 'executor.memory' })

        void import('../memory/store.js').then(({ recordTaskMemory }) =>
            recordTaskMemory({
                workspaceId: ctx.workspaceId,
                taskId: ctx.taskId,
                description: plan.goal,
                outcome: memOutcome,
                toolsUsed,
                qualityScore: verifiedQuality,
                durationMs: executionResult.totalDurationMs,
                aiSettings: settings,
            })
        ).catch((err) => memLogger.warn({ err, taskId: ctx.taskId }, 'recordTaskMemory failed'))

        void import('../memory/preferences.js').then(({ inferFromTaskOutcome }) =>
            inferFromTaskOutcome({
                workspaceId: ctx.workspaceId,
                toolsUsed,
                filesWritten,
                qualityScore: verifiedQuality,
                outcome: memOutcome,
            })
        ).catch((err) => memLogger.warn({ err, taskId: ctx.taskId }, 'inferFromTaskOutcome failed'))

        void import('../behavior/reflect.js').then(({ reflectAndPromote }) =>
            reflectAndPromote({
                workspaceId: ctx.workspaceId,
                taskId: ctx.taskId,
                goal: plan.goal,
                taskType: ctx.taskType ?? 'general',
                toolsUsed,
                qualityScore: verifiedQuality,
                outcomeSummary: executionResult.outcomeSummary ?? '',
                stepCount: stepResults.length,
                durationMs: executionResult.totalDurationMs,
            })
        ).catch((err) => memLogger.warn({ err, taskId: ctx.taskId }, 'reflectAndPromote failed'))

        // Domain mastery: infer domain_tag (ADR-001, zero-cost heuristic)
        const { inferDomainTag } = await import('../domain-mastery/index.js')
        const domainTag = inferDomainTag(ctx.taskType ?? 'general', plan.goal ?? '')

        // A6 cutover: dual-write cost_usd (real) + cost_usd_numeric (numeric).
        // Old col stays in lockstep until the Phase 4 contract drops/renames.
        void db.execute(sql`
            INSERT INTO work_ledger
                (id, workspace_id, task_id, type, source, tokens_in, tokens_out, cost_usd,
                 cost_usd_numeric,
                 quality_score, deliverables, wall_clock_ms, domain_tag, context_hash,
                 context_rule_keys, completed_at)
            VALUES
                (gen_random_uuid(), ${ctx.workspaceId}::uuid, ${ctx.taskId},
                 ${ctx.taskType ?? 'automation'}, ${'agent'},
                 ${executionResult.totalTokensIn}, ${executionResult.totalTokensOut},
                 ${executionResult.totalCostUsd},
                 ${executionResult.totalCostUsd}::numeric,
                 ${verifiedQuality},
                 ${JSON.stringify(filesWritten)}::jsonb, ${executionResult.totalDurationMs},
                 ${domainTag}, ${resolvedContextHash},
                 ${resolvedContextRuleKeys.length > 0 ? JSON.stringify(resolvedContextRuleKeys) : null}::jsonb,
                 now())
        `).catch((err) => memLogger.warn({ err, taskId: ctx.taskId }, 'work_ledger insert failed — check schema or migration'))

        // Domain mastery Phase 3: credit assignment (fire-and-forget)
        void import('../domain-mastery/credit-assignment.js').then(({ recordCredit }) =>
            recordCredit({
                workspaceId: ctx.workspaceId,
                contextHash: resolvedContextHash,
                contextRuleKeys: resolvedContextRuleKeys,
                qualityScore: verifiedQuality,
                domainTag,
            })
        ).catch((err) => memLogger.warn({ err, taskId: ctx.taskId }, 'Credit assignment failed'))

        // Phase 15 — record which prompt variant was used and evaluate auto-promotion
        void recordVariantOutcome({
            workspaceId: ctx.workspaceId,
            taskId: ctx.taskId,
            variant: variantAssignment.variant,
            challengerId: variantAssignment.challengerId,
            qualityScore: verifiedQuality,
        }).catch((err) => memLogger.warn({ err, taskId: ctx.taskId }, 'recordVariantOutcome failed'))
    })().catch((err) => {
        _judgeDropped++
        logger.warn({ err, taskId: ctx.taskId }, 'detached judge block threw — score left pending (judge_dropped)')
    }))

    return executionResult
}
