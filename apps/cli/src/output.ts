// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Terminal output utilities — colors, spinners, tables, formatters.
 * Auto-disables color/spinners when output is piped (non-TTY).
 */
import chalk from 'chalk'
import Table from 'cli-table3'
import ora from 'ora'

export const isTTY = process.stdout.isTTY ?? false

// ── Colors (no-op when not TTY) ───────────────────────────────────────────────

export const c = {
    dim: (s: string) => isTTY ? chalk.dim(s) : s,
    bold: (s: string) => isTTY ? chalk.bold(s) : s,
    green: (s: string) => isTTY ? chalk.green(s) : s,
    yellow: (s: string) => isTTY ? chalk.yellow(s) : s,
    red: (s: string) => isTTY ? chalk.red(s) : s,
    cyan: (s: string) => isTTY ? chalk.cyan(s) : s,
    blue: (s: string) => isTTY ? chalk.blue(s) : s,
    magenta: (s: string) => isTTY ? chalk.magenta(s) : s,
    gray: (s: string) => isTTY ? chalk.gray(s) : s,
}

// ── Status badges ─────────────────────────────────────────────────────────────

export function statusBadge(status: string): string {
    const map: Record<string, (s: string) => string> = {
        queued: c.gray,
        pending: c.gray,
        running: c.cyan,
        complete: c.green,
        completed: c.green,
        failed: c.red,
        blocked: c.yellow,
        cancelled: c.dim,
        ok: c.green,
        error: c.red,
        degraded: c.yellow,
    }
    return (map[status] ?? c.dim)(status)
}

// ── Spinner ───────────────────────────────────────────────────────────────────

type SpinnerHandle = {
    success(opts?: string | { text?: string }): void
    error(opts?: string | { text?: string }): void
    stop(): void
}

export function spinner(text: string): SpinnerHandle {
    const resolve = (opts?: string | { text?: string }): string =>
        typeof opts === 'string' ? opts : (opts?.text ?? '')
    if (!isTTY) {
        process.stderr.write(`${text}...\n`)
        return {
            success: (opts?) => process.stderr.write(`✓ ${resolve(opts)}\n`),
            error: (opts?) => process.stderr.write(`✗ ${resolve(opts)}\n`),
            stop: () => { },
        }
    }
    const sp = ora({ text, stream: process.stderr }).start()
    return {
        success: (opts?) => { sp.succeed(resolve(opts) || undefined) },
        error: (opts?) => { sp.fail(resolve(opts) || undefined) },
        stop: () => sp.stop(),
    }
}

// ── Table ─────────────────────────────────────────────────────────────────────

export function table(head: string[], rows: string[][]): string {
    if (!isTTY) {
        // Plain text for pipes
        const widths = head.map((h, i) => Math.max(h.length, ...rows.map(r => (r[i] ?? '').length)))
        const fmt = (row: string[]) => row.map((cell, i) => (cell ?? '').padEnd(widths[i]!)).join('  ')
        return [fmt(head), fmt(head.map(() => '-'.repeat(8))), ...rows.map(fmt)].join('\n')
    }
    const t = new Table({ head: head.map(h => c.bold(h)), style: { compact: true } })
    rows.forEach(r => t.push(r))
    return t.toString()
}

// ── Output router ─────────────────────────────────────────────────────────────

export type OutputFormat = 'table' | 'json' | 'csv'

export function output<T extends object>(
    format: OutputFormat,
    head: string[],
    rows: T[],
    rowFn: (item: T) => string[],
): void {
    if (format === 'json') {
        console.log(JSON.stringify(rows, null, 2))
    } else if (format === 'csv') {
        console.log(head.map(h => `"${h}"`).join(','))
        rows.forEach(r => console.log(rowFn(r).map(v => `"${v}"`).join(',')))
    } else {
        console.log(table(head, rows.map(rowFn)))
    }
}

// ── Error handler ─────────────────────────────────────────────────────────────

export function fatal(err: unknown, exitCode = 1): never {
    if (err instanceof Error) {
        process.stderr.write(`${c.red('Error:')} ${err.message}\n`)
    } else {
        process.stderr.write(`${c.red('Error:')} ${String(err)}\n`)
    }
    process.exit(exitCode)
}
