// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync as fsWriteFileSync, readFileSync as fsReadFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getFilesystemPort, setFilesystemPort, type FilesystemPort } from './filesystem-port.js'

// Characterization test for the default NodeFilesystemAdapter. Pins the
// round-trip behavior the executor loop relied on via inline `node:fs` /
// `node:path` so the port extraction is provably behavior-preserving.

describe('FilesystemPort default adapter', () => {
    let dir: string
    let port: FilesystemPort

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'plexo-fsport-'))
        port = getFilesystemPort()
    })

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true })
        setFilesystemPort(null) // reset to a fresh default adapter
        port = getFilesystemPort()
    })

    it('writes then reads back content round-trip', () => {
        const p = join(dir, 'note.txt')
        port.writeFile(p, 'hello plexo', 'utf8')
        expect(port.readFile(p, 'utf8')).toBe('hello plexo')
    })

    it('matches node:fs byte-for-byte on a utf8 write', () => {
        const p = join(dir, 'ref.txt')
        port.writeFile(p, 'multi\nline\nutf8 — ✓', 'utf8')
        expect(fsReadFileSync(p, 'utf8')).toBe('multi\nline\nutf8 — ✓')
    })

    it('matches a node:fs write when read through the port', () => {
        const p = join(dir, 'ext.txt')
        fsWriteFileSync(p, 'written externally', 'utf8')
        expect(port.readFile(p, 'utf8')).toBe('written externally')
    })

    it('reports exists=false for missing paths and true after write', () => {
        const p = join(dir, 'maybe.txt')
        expect(port.exists(p)).toBe(false)
        port.writeFile(p, 'x', 'utf8')
        expect(port.exists(p)).toBe(true)
    })

    it('mkdir recursive creates nested dirs', () => {
        const nested = join(dir, 'a', 'b', 'c')
        port.mkdir(nested, { recursive: true })
        expect(port.exists(nested)).toBe(true)
        // writing into the created dir succeeds
        port.writeFile(join(nested, 'f.txt'), 'ok', 'utf8')
        expect(port.readFile(join(nested, 'f.txt'), 'utf8')).toBe('ok')
    })

    it('basename / join / resolve / isAbsolute mirror node:path', () => {
        expect(port.basename('/a/b/c.txt')).toBe('c.txt')
        expect(port.join('a', 'b', 'c')).toBe(join('a', 'b', 'c'))
        expect(port.isAbsolute('/x')).toBe(true)
        expect(port.isAbsolute('rel/x')).toBe(false)
        // resolve normalizes — at minimum must equal node:path resolve
        const rel = 'b/c'
        const expected = dir + '/' + rel
        expect(port.resolve(dir, rel)).toBe(expected)
    })

    it('setFilesystemPort(null) restores a working default adapter', () => {
        const stub: FilesystemPort = {
            readFile: () => 'stub',
            exists: () => true,
            mkdir: () => {},
            writeFile: () => {},
            basename: () => 'stub.txt',
            resolve: () => '/stub',
            isAbsolute: () => true,
            join: () => '/stub/join',
        }
        setFilesystemPort(stub)
        expect(getFilesystemPort().readFile('/any', 'utf8')).toBe('stub')
        setFilesystemPort(null)
        const restored = getFilesystemPort()
        const p = join(dir, 'after-reset.txt')
        restored.writeFile(p, 'real', 'utf8')
        expect(restored.readFile(p, 'utf8')).toBe('real')
    })
})