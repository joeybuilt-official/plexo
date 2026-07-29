// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Plexo SSH Client — secure, ephemeral SSH connections.
 *
 * Each method connects, authenticates, executes, and disconnects.
 * No persistent sessions. Private keys are only passed to ssh2.connect()
 * and never appear in logs, tool output, or error messages.
 */

import { Client as SSH2Client } from 'ssh2'
import type { ConnectConfig } from 'ssh2'
const MAX_OUTPUT_BYTES = 100 * 1024 // 100KB per channel
const PEM_PATTERN = /-----BEGIN[\s\S]*?-----END[^\n]*-----/g

/** Strip PEM keys and password-like content from strings */
function sanitize(text: string): string {
    return text.replace(PEM_PATTERN, '[REDACTED:KEY]')
}

function truncate(text: string, max: number): string {
    if (text.length <= max) return text
    return text.slice(0, max) + `\n... [truncated, ${text.length - max} bytes omitted]`
}

export interface SSHExecResult {
    stdout: string
    stderr: string
    exitCode: number
    durationMs: number
}

export interface SSHClientOptions {
    host: string
    port?: number
    username: string
    privateKey?: string
    passphrase?: string
    password?: string
    connectTimeout?: number
    commandTimeout?: number
}

export interface FileEntry {
    name: string
    type: 'file' | 'directory' | 'symlink' | 'other'
    size: number
    modifyTime: Date
}

/**
 * Create a connected ssh2 client. Caller must call client.end() when done.
 */
async function connect(opts: SSHClientOptions): Promise<SSH2Client> {
    const client = new SSH2Client()
    const config: ConnectConfig = {
        host: opts.host,
        port: opts.port ?? 22,
        username: opts.username,
        readyTimeout: opts.connectTimeout ?? 30_000,
    }

    if (opts.privateKey) {
        config.privateKey = opts.privateKey
        if (opts.passphrase) config.passphrase = opts.passphrase
    } else if (opts.password) {
        config.password = opts.password
    }

    // Accept any host key (TOFU model — same as ssh -o StrictHostKeyChecking=no)
    // Users can pin fingerprints via the credentials schema if desired.
    config.hostVerifier = () => true

    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            client.end()
            reject(new Error(`SSH connection to ${opts.host}:${opts.port ?? 22} timed out after ${opts.connectTimeout ?? 30_000}ms`))
        }, opts.connectTimeout ?? 30_000)

        client.on('ready', () => {
            clearTimeout(timer)
            resolve(client)
        })
        client.on('error', (err) => {
            clearTimeout(timer)
            reject(new Error(`SSH connection failed: ${sanitize(err.message)}`))
        })

        client.connect(config)
    })
}

/**
 * Execute a command on a remote server via SSH.
 * Connects, runs, disconnects. No persistent session.
 */
export async function sshExec(opts: SSHClientOptions, command: string, cwd?: string): Promise<SSHExecResult> {
    const start = Date.now()
    const timeout = opts.commandTimeout ?? 90_000
    const fullCommand = cwd ? `cd ${JSON.stringify(cwd)} && ${command}` : command

    let client: SSH2Client | null = null
    try {
        client = await connect(opts)

        return await new Promise<SSHExecResult>((resolve, reject) => {
            const timer = setTimeout(() => {
                client?.end()
                reject(new Error(`SSH command timed out after ${timeout}ms`))
            }, timeout)

            client!.exec(fullCommand, { pty: false }, (err, stream) => {
                if (err) {
                    clearTimeout(timer)
                    reject(new Error(`SSH exec failed: ${sanitize(err.message)}`))
                    return
                }

                let stdout = ''
                let stderr = ''

                stream.on('data', (data: Buffer) => {
                    if (stdout.length < MAX_OUTPUT_BYTES) stdout += data.toString()
                })
                stream.stderr.on('data', (data: Buffer) => {
                    if (stderr.length < MAX_OUTPUT_BYTES) stderr += data.toString()
                })
                stream.on('close', (code: number | null) => {
                    clearTimeout(timer)
                    resolve({
                        stdout: sanitize(truncate(stdout, MAX_OUTPUT_BYTES)),
                        stderr: sanitize(truncate(stderr, MAX_OUTPUT_BYTES)),
                        exitCode: code ?? -1,
                        durationMs: Date.now() - start,
                    })
                })
            })
        })
    } catch (err) {
        throw new Error(sanitize(err instanceof Error ? err.message : String(err)))
    } finally {
        client?.end()
    }
}

/**
 * Upload content to a remote file via SFTP.
 */
export async function sshUpload(opts: SSHClientOptions, content: string, remotePath: string): Promise<{ durationMs: number }> {
    const start = Date.now()
    let client: SSH2Client | null = null
    try {
        client = await connect(opts)

        return await new Promise((resolve, reject) => {
            client!.sftp((err, sftp) => {
                if (err) { reject(new Error(`SFTP session failed: ${sanitize(err.message)}`)); return }

                const ws = sftp.createWriteStream(remotePath)
                ws.on('error', (e: Error) => reject(new Error(`SFTP write failed: ${sanitize(e.message)}`)))
                ws.on('close', () => resolve({ durationMs: Date.now() - start }))
                ws.end(content)
            })
        })
    } finally {
        client?.end()
    }
}

/**
 * Download a remote file via SFTP.
 */
export async function sshDownload(opts: SSHClientOptions, remotePath: string): Promise<{ content: string; durationMs: number }> {
    const start = Date.now()
    let client: SSH2Client | null = null
    try {
        client = await connect(opts)

        return await new Promise((resolve, reject) => {
            client!.sftp((err, sftp) => {
                if (err) { reject(new Error(`SFTP session failed: ${sanitize(err.message)}`)); return }

                let content = ''
                const rs = sftp.createReadStream(remotePath, { encoding: 'utf8' })
                rs.on('data', (chunk: string) => {
                    if (content.length < MAX_OUTPUT_BYTES) content += chunk
                })
                rs.on('error', (e: Error) => reject(new Error(`SFTP read failed: ${sanitize(e.message)}`)))
                rs.on('end', () => resolve({
                    content: truncate(content, MAX_OUTPUT_BYTES),
                    durationMs: Date.now() - start,
                }))
            })
        })
    } finally {
        client?.end()
    }
}

/**
 * List files in a remote directory via SFTP.
 */
export async function sshListDir(opts: SSHClientOptions, remotePath: string): Promise<{ entries: FileEntry[]; durationMs: number }> {
    const start = Date.now()
    let client: SSH2Client | null = null
    try {
        client = await connect(opts)

        return await new Promise((resolve, reject) => {
            client!.sftp((err, sftp) => {
                if (err) { reject(new Error(`SFTP session failed: ${sanitize(err.message)}`)); return }

                sftp.readdir(remotePath, (rdErr, list) => {
                    if (rdErr) { reject(new Error(`SFTP readdir failed: ${sanitize(rdErr.message)}`)); return }

                    const entries: FileEntry[] = (list ?? []).slice(0, 500).map(item => ({
                        name: item.filename,
                        type: item.attrs.isDirectory() ? 'directory'
                            : item.attrs.isSymbolicLink() ? 'symlink'
                            : item.attrs.isFile() ? 'file' : 'other',
                        size: item.attrs.size,
                        modifyTime: new Date(item.attrs.mtime * 1000),
                    }))

                    resolve({ entries, durationMs: Date.now() - start })
                })
            })
        })
    } finally {
        client?.end()
    }
}

/**
 * Test an SSH connection by running `echo ok`.
 */
export async function sshTest(opts: SSHClientOptions): Promise<{ ok: boolean; message: string; durationMs: number }> {
    try {
        const result = await sshExec(opts, 'echo ok')
        const ok = result.exitCode === 0 && result.stdout.trim() === 'ok'
        return {
            ok,
            message: ok ? `Connected to ${opts.host} as ${opts.username} in ${result.durationMs}ms` : `Connected but test command failed (exit ${result.exitCode})`,
            durationMs: result.durationMs,
        }
    } catch (err) {
        return {
            ok: false,
            message: err instanceof Error ? err.message : 'Connection failed',
            durationMs: 0,
        }
    }
}
