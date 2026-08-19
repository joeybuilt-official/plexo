// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Injection port for filesystem + path operations used by the executor loop.
 *
 * ADR-0045 (Clean Architecture): the inner-ring executor must not import
 * `node:fs` / `node:path` directly. Loop-level file ops (e.g. promoting
 * write_file outputs to works on forced termination, post-execution
 * structural-proof path resolution) go through this port so IO is reachable
 * via an adapter the composition root can swap.
 *
 * Tool definitions (read_file / write_file / edit_file / write_asset) are
 * adapters themselves and keep their own `node:fs` usage — only loop-level
 * call sites route here.
 *
 * Unset (unit tests) → falls back to the default Node adapter, which wraps
 * the sync `node:fs` functions the loop originally used (behavior-preserving).
 */

export interface FilesystemPort {
    readFile(path: string, encoding: BufferEncoding): string
    exists(path: string): boolean
    mkdir(path: string, opts: { recursive: boolean }): void
    writeFile(path: string, content: string, encoding: BufferEncoding): void
    basename(path: string): string
    resolve(...paths: string[]): string
    isAbsolute(path: string): boolean
    join(...paths: string[]): string
}

class NodeFilesystemAdapter implements FilesystemPort {
    readFile(path: string, encoding: BufferEncoding): string {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { readFileSync } = require('node:fs') as typeof import('node:fs')
        return readFileSync(path, encoding)
    }
    exists(path: string): boolean {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { existsSync } = require('node:fs') as typeof import('node:fs')
        return existsSync(path)
    }
    mkdir(path: string, opts: { recursive: boolean }): void {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { mkdirSync } = require('node:fs') as typeof import('node:fs')
        mkdirSync(path, opts)
    }
    writeFile(path: string, content: string, encoding: BufferEncoding): void {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { writeFileSync } = require('node:fs') as typeof import('node:fs')
        writeFileSync(path, content, encoding)
    }
    basename(path: string): string {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { basename } = require('node:path') as typeof import('node:path')
        return basename(path)
    }
    resolve(...paths: string[]): string {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { resolve } = require('node:path') as typeof import('node:path')
        return resolve(...paths)
    }
    isAbsolute(path: string): boolean {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { isAbsolute } = require('node:path') as typeof import('node:path')
        return isAbsolute(path)
    }
    join(...paths: string[]): string {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { join } = require('node:path') as typeof import('node:path')
        return join(...paths)
    }
}

let port: FilesystemPort = new NodeFilesystemAdapter()

export function setFilesystemPort(p: FilesystemPort | null): void {
    port = p ?? new NodeFilesystemAdapter()
}

export function getFilesystemPort(): FilesystemPort {
    return port
}