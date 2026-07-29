// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * SSH tool factory — produces agent-callable tools from an installed SSH connection.
 *
 * Tools: ssh__exec, ssh__upload, ssh__download, ssh__list_dir
 * Credentials are decrypted by the bridge and passed directly to this factory.
 * Private key material is only used inside ssh2.connect() — never in tool output.
 */

import { tool } from 'ai'
import { z } from 'zod'
import { sshExec, sshUpload, sshDownload, sshListDir, type SSHClientOptions } from '../../ssh/client.js'
import type { ConnectionCredentials, ToolSet } from '../bridge.js'
import pino from 'pino'

const logger = pino({ name: 'ssh:tools' })

function parseSSHCredentials(creds: ConnectionCredentials): SSHClientOptions & { mode: string } {
    return {
        host: (creds.host as string) ?? '',
        port: Number(creds.port ?? 22),
        username: (creds.username as string) ?? 'root',
        privateKey: creds.private_key as string | undefined,
        passphrase: creds.passphrase as string | undefined,
        password: creds.password as string | undefined,
        mode: (creds.mode as string) ?? 'full',
    }
}

export const SSH_TOOLS = (creds: ConnectionCredentials, opts: { connectionId: string; workspaceId: string }): ToolSet => {
    const config = parseSSHCredentials(creds)
    const hostLabel = `${config.username}@${config.host}:${config.port}`
    const denylist = (creds.denylist as string[] | undefined) ?? []
    const maxCalls = Number(creds.maxCallsPerTask ?? 50)
    let callCount = 0

    function checkRateLimit(): string | null {
        callCount++
        if (callCount > maxCalls) return `SSH call limit reached (${maxCalls} per task). Cannot execute more commands.`
        return null
    }

    function checkDenylist(command: string): string | null {
        for (const pattern of denylist) {
            if (command.includes(pattern)) return `Command blocked by denylist: contains "${pattern}"`
        }
        return null
    }

    function auditLog(toolName: string, detail: Record<string, unknown>) {
        logger.info({
            type: 'ssh_tool_call',
            toolName,
            connectionId: opts.connectionId,
            workspaceId: opts.workspaceId,
            host: config.host,
            username: config.username,
            ...detail,
        }, `SSH tool: ${toolName}`)
    }

    const tools: ToolSet = {
        ssh__exec: tool({
            description: `Execute a shell command on the remote server (${hostLabel}). Returns stdout, stderr, and exit code.`,
            inputSchema: z.object({
                command: z.string().describe('Shell command to execute on the remote server'),
                cwd: z.string().optional().describe('Working directory on the remote server'),
            }),
            execute: async ({ command, cwd }) => {
                const rateErr = checkRateLimit()
                if (rateErr) return rateErr
                const denyErr = checkDenylist(command)
                if (denyErr) return denyErr

                try {
                    const result = await sshExec(config, command, cwd)
                    auditLog('ssh__exec', {
                        command: command.slice(0, 500),
                        exitCode: result.exitCode,
                        outputBytes: result.stdout.length + result.stderr.length,
                        durationMs: result.durationMs,
                    })

                    const parts = []
                    if (result.stdout) parts.push(`stdout:\n${result.stdout}`)
                    if (result.stderr) parts.push(`stderr:\n${result.stderr}`)
                    parts.push(`exit code: ${result.exitCode} (${result.durationMs}ms)`)
                    return parts.join('\n\n')
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err)
                    auditLog('ssh__exec', { command: command.slice(0, 500), error: msg })
                    return `SSH exec failed: ${msg}`
                }
            },
        }),

        ssh__list_dir: tool({
            description: `List files and directories on the remote server (${hostLabel}).`,
            inputSchema: z.object({
                path: z.string().describe('Absolute directory path on the remote server'),
            }),
            execute: async ({ path }) => {
                const rateErr = checkRateLimit()
                if (rateErr) return rateErr

                try {
                    const result = await sshListDir(config, path)
                    auditLog('ssh__list_dir', { path, entries: result.entries.length, durationMs: result.durationMs })

                    if (result.entries.length === 0) return `Empty directory: ${path}`
                    const lines = result.entries.map(e => {
                        const type = e.type === 'directory' ? 'd' : e.type === 'symlink' ? 'l' : '-'
                        const size = e.size > 1024 * 1024 ? `${(e.size / 1024 / 1024).toFixed(1)}M` : e.size > 1024 ? `${(e.size / 1024).toFixed(0)}K` : `${e.size}B`
                        return `${type} ${size.padStart(8)} ${e.name}`
                    })
                    return lines.join('\n')
                } catch (err) {
                    return `SSH list_dir failed: ${err instanceof Error ? err.message : String(err)}`
                }
            },
        }),

        ssh__download: tool({
            description: `Download a file from the remote server (${hostLabel}) via SFTP.`,
            inputSchema: z.object({
                remotePath: z.string().describe('Absolute file path on the remote server'),
            }),
            execute: async ({ remotePath }) => {
                const rateErr = checkRateLimit()
                if (rateErr) return rateErr

                try {
                    const result = await sshDownload(config, remotePath)
                    auditLog('ssh__download', { remotePath, contentBytes: result.content.length, durationMs: result.durationMs })
                    return result.content
                } catch (err) {
                    return `SSH download failed: ${err instanceof Error ? err.message : String(err)}`
                }
            },
        }),
    }

    // Upload only in full-access mode
    if (config.mode !== 'readonly' && config.mode !== 'Read Only') {
        tools.ssh__upload = tool({
            description: `Upload content to a file on the remote server (${hostLabel}) via SFTP.`,
            inputSchema: z.object({
                content: z.string().describe('File content to write'),
                remotePath: z.string().describe('Absolute file path on the remote server'),
            }),
            execute: async ({ content, remotePath }) => {
                const rateErr = checkRateLimit()
                if (rateErr) return rateErr

                try {
                    const result = await sshUpload(config, content, remotePath)
                    auditLog('ssh__upload', { remotePath, contentBytes: content.length, durationMs: result.durationMs })
                    return `Uploaded ${content.length} bytes to ${remotePath} (${result.durationMs}ms)`
                } catch (err) {
                    return `SSH upload failed: ${err instanceof Error ? err.message : String(err)}`
                }
            },
        })
    }

    return tools
}
