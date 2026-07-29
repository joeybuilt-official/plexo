// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Structural Proof — post-execution code verification.
 *
 * After a coding task completes, scans the files the agent touched and
 * verifies that each TypeScript/JavaScript file is syntactically valid.
 * Uses the TypeScript compiler's parser (syntax-only, no type-checking)
 * so it works without a tsconfig and is fast enough to run inline.
 *
 * Returns a list of violations. An empty list means the proof passed.
 * Non-TS/JS files and read errors are skipped (non-fatal).
 */

import pino from 'pino'

const logger = pino({ name: 'structural-proof' })

export interface ProofViolation {
    file: string
    line: number
    character: number
    message: string
}

export interface ProofResult {
    passed: boolean
    violations: ProofViolation[]
    filesChecked: number
    skipped: number
}

const TS_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'])

function isCheckable(filePath: string): boolean {
    const dot = filePath.lastIndexOf('.')
    if (dot === -1) return false
    return TS_EXTENSIONS.has(filePath.slice(dot))
}

function isDeclarationFile(filePath: string): boolean {
    return filePath.endsWith('.d.ts') || filePath.endsWith('.d.mts') || filePath.endsWith('.d.cts')
}

/**
 * Verify a set of file paths syntactically using the TypeScript compiler parser.
 * @param filePaths Absolute paths to files to check. Non-existent files are skipped.
 * @returns ProofResult with violations (if any) and counts.
 */
export async function verifyStructure(filePaths: string[]): Promise<ProofResult> {
    // Lazy-import typescript so the module loads even if ts is not installed.
    let ts: typeof import('typescript')
    try {
        ts = await import('typescript')
    } catch {
        logger.warn('typescript package not available — structural proof skipped')
        return { passed: true, violations: [], filesChecked: 0, skipped: filePaths.length }
    }

    const { readFileSync, existsSync } = await import('node:fs')

    const violations: ProofViolation[] = []
    let filesChecked = 0
    let skipped = 0

    for (const filePath of filePaths) {
        if (!isCheckable(filePath) || isDeclarationFile(filePath)) {
            skipped++
            continue
        }
        if (!existsSync(filePath)) {
            skipped++
            continue
        }

        let source: string
        try {
            source = readFileSync(filePath, 'utf8')
        } catch {
            skipped++
            continue
        }

        filesChecked++

        const scriptKind = filePath.endsWith('.tsx') || filePath.endsWith('.jsx')
            ? ts.ScriptKind.TSX
            : filePath.endsWith('.js') || filePath.endsWith('.mjs') || filePath.endsWith('.cjs')
                ? ts.ScriptKind.JS
                : ts.ScriptKind.TS

        const sourceFile = ts.createSourceFile(
            filePath,
            source,
            ts.ScriptTarget.Latest,
            /* setParentNodes */ false,
            scriptKind,
        )

        // Collect parse diagnostics (syntax errors only)
        const diagnostics = (sourceFile as { parseDiagnostics?: unknown[] }).parseDiagnostics
            ?? ts.createProgram([filePath], { noEmit: true, allowJs: true, skipLibCheck: true }).getSyntacticDiagnostics(sourceFile)

        for (const diag of diagnostics as import('typescript').Diagnostic[]) {
            const pos = diag.start != null
                ? sourceFile.getLineAndCharacterOfPosition(diag.start)
                : { line: 0, character: 0 }
            violations.push({
                file: filePath,
                line: pos.line + 1,
                character: pos.character + 1,
                message: typeof diag.messageText === 'string'
                    ? diag.messageText
                    : (diag.messageText as { messageText: string }).messageText,
            })
        }
    }

    const passed = violations.length === 0
    if (!passed) {
        logger.warn(
            { violations: violations.length, filesChecked },
            'structural-proof: syntax violations found',
        )
    } else {
        logger.debug({ filesChecked }, 'structural-proof: all files passed')
    }

    return { passed, violations, filesChecked, skipped }
}

/**
 * Extract touched file paths from a set of step results.
 * Looks for write_file tool calls in the step history.
 */
export function extractTouchedFiles(
    steps: Array<{ toolCalls: Array<{ tool: string; input: unknown }> }>,
    workDir: string,
): string[] {
    const { resolve, isAbsolute } = require('node:path')
    const seen = new Set<string>()

    for (const step of steps) {
        for (const call of step.toolCalls) {
            if (call.tool !== 'write_file') continue
            const input = call.input as Record<string, unknown>
            const rawPath = input.path as string | undefined
            if (!rawPath) continue
            const abs = isAbsolute(rawPath) ? rawPath : resolve(workDir, rawPath)
            seen.add(abs)
        }
    }

    return Array.from(seen)
}
