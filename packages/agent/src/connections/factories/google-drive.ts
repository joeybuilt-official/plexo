// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Google Drive tool factory — produces agent-callable tools from an installed Google Drive connection.
 *
 * Tools: gdrive__search, gdrive__get_file, gdrive__create_file, gdrive__list_folders
 *
 * Auth: OAuth2 access_token (Google Drive API scopes).
 */

import { tool } from 'ai'
import { z } from 'zod'
import type { ConnectionCredentials, ToolSet } from '../bridge.js'
import pino from 'pino'

const logger = pino({ name: 'gdrive:tools' })

const API_BASE = 'https://www.googleapis.com/drive/v3'
const UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3'

function buildHeaders(creds: ConnectionCredentials): Record<string, string> {
    const token = (creds.access_token as string) ?? (creds.token as string) ?? (creds.api_key as string) ?? ''
    return {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
    }
}

function audit(toolName: string, detail: Record<string, unknown>, opts: { connectionId: string; workspaceId: string }) {
    logger.info({
        type: 'gdrive_tool_call',
        toolName,
        connectionId: opts.connectionId,
        workspaceId: opts.workspaceId,
        ...detail,
    }, `Google Drive tool: ${toolName}`)
}

export const GOOGLE_DRIVE_TOOLS = (creds: ConnectionCredentials, opts: { connectionId: string; workspaceId: string }): ToolSet => {
    const headers = buildHeaders(creds)

    return {
        gdrive__search: tool({
            description: 'Search Google Drive for files by name or content. Returns file IDs, names, types, and web URLs.',
            inputSchema: z.object({
                query: z.string().describe('Search text — matches file names and full-text content'),
                mimeType: z.string().optional().describe('Optional MIME type filter like "application/vnd.google-apps.document"'),
                limit: z.number().optional().default(20),
            }),
            execute: async ({ query, mimeType, limit = 20 }) => {
                try {
                    const qParts = [`(name contains '${query.replace(/'/g, "\\'")}' or fullText contains '${query.replace(/'/g, "\\'")}')`, 'trashed = false']
                    if (mimeType) qParts.push(`mimeType = '${mimeType}'`)
                    const q = qParts.join(' and ')
                    const url = `${API_BASE}/files?q=${encodeURIComponent(q)}&pageSize=${Math.min(limit, 100)}&fields=files(id,name,mimeType,webViewLink,modifiedTime)`
                    const res = await fetch(url, { headers })
                    if (!res.ok) return `Google Drive error ${res.status}: ${(await res.text()).slice(0, 200)}`
                    const data = await res.json() as {
                        files: Array<{ id: string; name: string; mimeType: string; webViewLink?: string; modifiedTime?: string }>
                    }
                    audit('gdrive__search', { query, count: data.files.length }, opts)
                    if (!data.files.length) return 'No files found.'
                    return data.files.map((f) => `${f.name} [${f.mimeType}] — ${f.id}${f.webViewLink ? ` — ${f.webViewLink}` : ''}`).join('\n')
                } catch (err) {
                    return `Google Drive search failed: ${err instanceof Error ? err.message : String(err)}`
                }
            },
        }),

        gdrive__get_file: tool({
            description: 'Get Google Drive file metadata, or export the content of a Google Doc/Sheet/Slide as text. For native Drive files (not Google Workspace), returns metadata only.',
            inputSchema: z.object({
                fileId: z.string().describe('Google Drive file ID'),
            }),
            execute: async ({ fileId }) => {
                try {
                    const metaRes = await fetch(`${API_BASE}/files/${fileId}?fields=id,name,mimeType,webViewLink,modifiedTime,size`, { headers })
                    if (!metaRes.ok) return `Google Drive error ${metaRes.status}: ${(await metaRes.text()).slice(0, 200)}`
                    const meta = await metaRes.json() as { id: string; name: string; mimeType: string; webViewLink?: string; modifiedTime?: string; size?: string }

                    // Export Google Workspace docs
                    let content = ''
                    if (meta.mimeType === 'application/vnd.google-apps.document') {
                        const exportRes = await fetch(`${API_BASE}/files/${fileId}/export?mimeType=text/plain`, { headers: { Authorization: headers.Authorization! } })
                        if (exportRes.ok) content = (await exportRes.text()).slice(0, 5000)
                    } else if (meta.mimeType === 'application/vnd.google-apps.spreadsheet') {
                        const exportRes = await fetch(`${API_BASE}/files/${fileId}/export?mimeType=text/csv`, { headers: { Authorization: headers.Authorization! } })
                        if (exportRes.ok) content = (await exportRes.text()).slice(0, 5000)
                    }

                    audit('gdrive__get_file', { fileId, mimeType: meta.mimeType }, opts)
                    const metaLines = [
                        `Name: ${meta.name}`,
                        `Type: ${meta.mimeType}`,
                        meta.size ? `Size: ${meta.size} bytes` : '',
                        meta.modifiedTime ? `Modified: ${meta.modifiedTime}` : '',
                        meta.webViewLink ? `URL: ${meta.webViewLink}` : '',
                    ].filter(Boolean)
                    return content ? `${metaLines.join('\n')}\n\n--- Content ---\n${content}` : metaLines.join('\n')
                } catch (err) {
                    return `Google Drive get_file failed: ${err instanceof Error ? err.message : String(err)}`
                }
            },
        }),

        gdrive__create_file: tool({
            description: 'Create a new text file or Google Doc in Google Drive. Use mimeType "application/vnd.google-apps.document" to create a Google Doc.',
            inputSchema: z.object({
                name: z.string().describe('File name'),
                content: z.string().describe('File contents (text)'),
                mimeType: z.string().optional().default('text/plain').describe('MIME type. Use "application/vnd.google-apps.document" for Google Doc.'),
                parentFolderId: z.string().optional().describe('Parent folder ID (omit for root)'),
            }),
            execute: async ({ name, content, mimeType = 'text/plain', parentFolderId }) => {
                try {
                    const metadata: Record<string, unknown> = { name, mimeType }
                    if (parentFolderId) metadata.parents = [parentFolderId]

                    const boundary = '-------plexo-boundary-' + Math.random().toString(36).slice(2)
                    const delimiter = `\r\n--${boundary}\r\n`
                    const closeDelim = `\r\n--${boundary}--`
                    const body =
                        delimiter +
                        'Content-Type: application/json\r\n\r\n' +
                        JSON.stringify(metadata) +
                        delimiter +
                        `Content-Type: ${mimeType === 'application/vnd.google-apps.document' ? 'text/plain' : mimeType}\r\n\r\n` +
                        content +
                        closeDelim

                    const res = await fetch(`${UPLOAD_BASE}/files?uploadType=multipart&fields=id,name,webViewLink`, {
                        method: 'POST',
                        headers: {
                            Authorization: headers.Authorization!,
                            'Content-Type': `multipart/related; boundary=${boundary}`,
                        },
                        body,
                    })
                    if (!res.ok) return `Google Drive error ${res.status}: ${(await res.text()).slice(0, 200)}`
                    const data = await res.json() as { id: string; name: string; webViewLink?: string }
                    audit('gdrive__create_file', { fileId: data.id, mimeType }, opts)
                    return `Created file "${data.name}" — ${data.id}${data.webViewLink ? ` — ${data.webViewLink}` : ''}`
                } catch (err) {
                    return `Google Drive create_file failed: ${err instanceof Error ? err.message : String(err)}`
                }
            },
        }),

        gdrive__list_folders: tool({
            description: 'List folders in Google Drive, optionally under a specific parent folder.',
            inputSchema: z.object({
                parentId: z.string().optional().describe('Parent folder ID (omit for root)'),
                limit: z.number().optional().default(20),
            }),
            execute: async ({ parentId, limit = 20 }) => {
                try {
                    const qParts = [`mimeType = 'application/vnd.google-apps.folder'`, 'trashed = false']
                    if (parentId) qParts.push(`'${parentId}' in parents`)
                    const q = qParts.join(' and ')
                    const url = `${API_BASE}/files?q=${encodeURIComponent(q)}&pageSize=${Math.min(limit, 100)}&fields=files(id,name,webViewLink)`
                    const res = await fetch(url, { headers })
                    if (!res.ok) return `Google Drive error ${res.status}: ${(await res.text()).slice(0, 200)}`
                    const data = await res.json() as { files: Array<{ id: string; name: string; webViewLink?: string }> }
                    audit('gdrive__list_folders', { parentId, count: data.files.length }, opts)
                    if (!data.files.length) return 'No folders found.'
                    return data.files.map((f) => `${f.name} — ${f.id}${f.webViewLink ? ` — ${f.webViewLink}` : ''}`).join('\n')
                } catch (err) {
                    return `Google Drive list_folders failed: ${err instanceof Error ? err.message : String(err)}`
                }
            },
        }),
    }
}
