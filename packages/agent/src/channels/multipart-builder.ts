// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Pure RFC 2822 / RFC 2045 MIME builder for outbound channel sends.
 *
 * Per ADR 0013 §D3 + pre-mortem #2: when attachments are present we emit
 * `multipart/mixed` directly with a single `text/plain` body part — we do
 * NOT wrap a single body in `multipart/alternative` (that envelope adds
 * nothing without a second alternative format and confuses some clients).
 *
 * No-attachments path collapses to single-part `text/plain`, byte-shape
 * compatible with the prior `buildRfc2822` for regression-free sends.
 */

import { randomUUID } from 'node:crypto'

export interface MimePart {
    headers: Record<string, string>
    body: Buffer
    encoding: '7bit' | '8bit' | 'base64'
}

export interface BuildMimeAttachment {
    filename: string
    mimeType: string
    bytes: Buffer
}

export interface BuildMimeParams {
    from: string
    to: string
    subject: string
    inReplyTo?: string
    bodyText: string
    attachments?: BuildMimeAttachment[]
}

export interface BuildMimeResult {
    raw: string
    boundary: string | null
    bytesTotal: number
}

const CRLF = '\r\n'
const SAFE_FILENAME = /^[a-zA-Z0-9._-]+$/

function chunk(s: string, n: number): string[] {
    const out: string[] = []
    for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n))
    return out
}

function wrapBase64(bytes: Buffer): string {
    return chunk(bytes.toString('base64'), 76).join(CRLF)
}

function filenameParam(name: string, filename: string): string {
    if (SAFE_FILENAME.test(filename)) return `${name}="${filename}"`
    const encoded = encodeURIComponent(filename)
    return `${name}*=UTF-8''${encoded}`
}

function generateBoundary(): string {
    return `=_Part_${randomUUID()}`
}

function bodyContainsBoundary(parts: BuildMimeAttachment[], bodyText: string, boundary: string): boolean {
    if (bodyText.includes(boundary)) return true
    for (const a of parts) {
        if (a.bytes.includes(boundary)) return true
    }
    return false
}

function pickBoundary(parts: BuildMimeAttachment[], bodyText: string): string {
    for (let i = 0; i < 3; i++) {
        const b = generateBoundary()
        if (!bodyContainsBoundary(parts, bodyText, b)) return b
    }
    throw new Error('boundary collision')
}

function topHeaders(params: BuildMimeParams): string[] {
    const h = [
        `From: ${params.from}`,
        `To: ${params.to}`,
        `Subject: ${params.subject}`,
        'MIME-Version: 1.0',
    ]
    if (params.inReplyTo) {
        const mid = params.inReplyTo.startsWith('<') ? params.inReplyTo : `<${params.inReplyTo}>`
        h.push(`In-Reply-To: ${mid}`)
        h.push(`References: ${mid}`)
    }
    return h
}

function singlePart(params: BuildMimeParams): BuildMimeResult {
    const headers = [
        ...topHeaders(params),
        'Content-Type: text/plain; charset=utf-8',
    ]
    const raw = [...headers, '', params.bodyText].join(CRLF)
    return { raw, boundary: null, bytesTotal: Buffer.byteLength(raw, 'utf8') }
}

function attachmentBlock(att: BuildMimeAttachment): string {
    const ctName = filenameParam('name', att.filename)
    const cdName = filenameParam('filename', att.filename)
    const lines = [
        `Content-Type: ${att.mimeType}; ${ctName}`,
        `Content-Disposition: attachment; ${cdName}`,
        'Content-Transfer-Encoding: base64',
        '',
        wrapBase64(att.bytes),
    ]
    return lines.join(CRLF)
}

export function buildMime(params: BuildMimeParams): BuildMimeResult {
    const attachments = params.attachments ?? []
    if (attachments.length === 0) return singlePart(params)

    const boundary = pickBoundary(attachments, params.bodyText)
    const headers = [
        ...topHeaders(params),
        `Content-Type: multipart/mixed; boundary="${boundary}"`,
    ]

    const bodyPart = [
        'Content-Type: text/plain; charset=utf-8',
        'Content-Transfer-Encoding: 7bit',
        '',
        params.bodyText,
    ].join(CRLF)

    const sections: string[] = []
    sections.push(`--${boundary}`)
    sections.push(bodyPart)
    for (const att of attachments) {
        sections.push(`--${boundary}`)
        sections.push(attachmentBlock(att))
    }
    sections.push(`--${boundary}--`)

    const raw = [...headers, '', sections.join(CRLF)].join(CRLF)
    return { raw, boundary, bytesTotal: Buffer.byteLength(raw, 'utf8') }
}

