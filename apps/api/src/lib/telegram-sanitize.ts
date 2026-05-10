// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Outbound message sanitizers for chat channels.
 *
 * The model regularly emits Markdown (`**bold**`, triple-backtick code
 * fences, bulleted lists) even when instructed not to. Telegram rejects
 * malformed markup with HTTP 400 `Can't parse entities`. Slack/Discord
 * accept markdown but use different dialects, so stray formatting from
 * the model leaks asterisks and underscores into the final rendered
 * message.
 *
 * This module centralizes the cleanup. Each channel adapter must funnel
 * outbound text through its corresponding sanitizer before sending.
 *
 * Design goals:
 * - Safe by default — Telegram mode strips formatting to plain text
 *   (cannot fail the parser, matches user preference for no emoji/no
 *   markdown in conversational replies).
 * - Preserve triple-backtick code blocks as plain indented text so code
 *   the user explicitly asked for still reads correctly.
 * - Emoji pass through unchanged for Slack/Discord; stripped for
 *   Telegram (user said "no emoji in every response").
 * - No network, no async, no external deps.
 */

export type TelegramSanitizeMode = 'plain' | 'html' | 'markdownv2'

/**
 * Extract fenced code blocks, replacing them with placeholders. Returns
 * the rewritten text plus the captured blocks in order. Caller re-inserts
 * them after the rest of the text has been sanitized.
 */
function extractCodeBlocks(text: string): { body: string; blocks: string[] } {
    const blocks: string[] = []
    const body = text.replace(/```[a-zA-Z0-9_-]*\n?([\s\S]*?)```/g, (_match, code: string) => {
        blocks.push(code.replace(/\n+$/, ''))
        return `\u0000CODEBLOCK_${blocks.length - 1}\u0000`
    })
    return { body, blocks }
}

/** Unicode emoji ranges. Covers the vast majority of emoji codepoints. */
const EMOJI_REGEX = /[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{2300}-\u{23FF}\u{2B00}-\u{2BFF}\u{1F1E6}-\u{1F1FF}\u{FE0F}\u{200D}]/gu

function stripEmoji(text: string): string {
    return text.replace(EMOJI_REGEX, '').replace(/[ \t]{2,}/g, ' ')
}

/**
 * Strip all markdown syntax from text, leaving readable plain text.
 *
 * Handles:
 * - **bold** / __bold__ → bold
 * - *italic* / _italic_ → italic
 * - ~~strike~~ → strike
 * - `inline code` → inline code
 * - [label](url) → "label (url)"
 * - headers (# ## ###) → plain line
 * - bullets (- * +) and numbered lists → kept as plain lines
 * - horizontal rules (---, ***) → removed
 * - blockquotes (>) → plain line
 */
function stripMarkdown(text: string): string {
    let out = text

    // Links: [label](url) → "label (url)" (when both present and different)
    out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label: string, url: string) => {
        const trimmedLabel = label.trim()
        const trimmedUrl = url.trim()
        if (!trimmedLabel) return trimmedUrl
        if (trimmedLabel === trimmedUrl) return trimmedUrl
        return `${trimmedLabel} (${trimmedUrl})`
    })

    // Images: ![alt](url) → "alt (url)"
    out = out.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_m, alt: string, url: string) => {
        const trimmedAlt = alt.trim()
        const trimmedUrl = url.trim()
        if (!trimmedAlt) return trimmedUrl
        return `${trimmedAlt} (${trimmedUrl})`
    })

    // Inline code: `code` → code (unwrap backticks)
    out = out.replace(/`([^`\n]+)`/g, '$1')

    // Bold: **text** or __text__ → text
    out = out.replace(/\*\*([^*\n]+?)\*\*/g, '$1')
    out = out.replace(/__([^_\n]+?)__/g, '$1')

    // Italic: *text* or _text_ → text
    // (run after bold so we don't strip single asterisks from leftover **)
    out = out.replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, '$1$2')
    out = out.replace(/(^|[^_])_([^_\n]+?)_(?!_)/g, '$1$2')

    // Strikethrough: ~~text~~ → text
    out = out.replace(/~~([^~\n]+?)~~/g, '$1')

    // Headers: leading #, ##, ### → remove the marker
    out = out.replace(/^#{1,6}\s+/gm, '')

    // Horizontal rules: lines of --- or *** → remove the line
    out = out.replace(/^\s*([-*_])\1{2,}\s*$/gm, '')

    // Blockquotes: leading > → remove
    out = out.replace(/^>\s?/gm, '')

    // Bullet lists: leading -, *, + → dash prefix (readable plain text)
    out = out.replace(/^[ \t]*[-*+][ \t]+/gm, '- ')

    // Numbered lists: leave as-is (already readable)

    // Collapse 3+ newlines to 2
    out = out.replace(/\n{3,}/g, '\n\n')

    return out.trim()
}

/**
 * Sanitize outbound text for Telegram. Default mode is `plain` — strips
 * all markdown and emoji, preserves code blocks as indented text. This
 * is the only mode the Telegram adapter should use in production; the
 * other modes exist for future flexibility and testing.
 *
 * @param text  Raw model output
 * @param mode  'plain' (default, recommended), 'html', or 'markdownv2'
 */
export function sanitizeForTelegram(text: string, mode: TelegramSanitizeMode = 'plain'): string {
    if (!text) return ''

    // Extract code blocks first so stripMarkdown doesn't mangle them
    const { body, blocks } = extractCodeBlocks(text)

    let sanitized: string
    switch (mode) {
        case 'html':
            sanitized = toTelegramHtml(body)
            break
        case 'markdownv2':
            sanitized = toTelegramMarkdownV2(body)
            break
        case 'plain':
        default:
            sanitized = stripEmoji(stripMarkdown(body))
            break
    }

    // Re-insert code blocks as plain-text (indented 4 spaces so they
    // visually separate from surrounding text without any formatting).
    sanitized = sanitized.replace(/\u0000CODEBLOCK_(\d+)\u0000/g, (_m, idx: string) => {
        const code = blocks[Number(idx)] ?? ''
        if (!code) return ''
        if (mode === 'html') {
            return `\n<pre>${escapeHtml(code)}</pre>\n`
        }
        return '\n' + code.split('\n').map((ln) => '    ' + ln).join('\n') + '\n'
    })

    // Final cleanup: collapse excessive whitespace without touching
    // intentional line breaks
    sanitized = sanitized.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()

    return sanitized
}

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
}

/**
 * Convert text to Telegram HTML mode. Escapes HTML special chars, then
 * rewrites basic markdown into the Telegram HTML subset (bold, italic,
 * code, links). Unsupported markdown (headers, lists, tables) is
 * flattened to plain text.
 */
function toTelegramHtml(text: string): string {
    // Escape HTML specials first — we'll inject tags after
    let out = escapeHtml(text)

    // Links: [label](url) → <a href="url">label</a>
    out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label: string, url: string) => {
        const safeUrl = url.replace(/"/g, '&quot;')
        return `<a href="${safeUrl}">${label}</a>`
    })

    // Bold: **text** → <b>text</b>
    out = out.replace(/\*\*([^*\n]+?)\*\*/g, '<b>$1</b>')
    out = out.replace(/__([^_\n]+?)__/g, '<b>$1</b>')

    // Italic: *text* or _text_ → <i>text</i>
    out = out.replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, '$1<i>$2</i>')
    out = out.replace(/(^|[^_])_([^_\n]+?)_(?!_)/g, '$1<i>$2</i>')

    // Strikethrough: ~~text~~ → <s>text</s>
    out = out.replace(/~~([^~\n]+?)~~/g, '<s>$1</s>')

    // Inline code: `text` → <code>text</code>
    out = out.replace(/`([^`\n]+)`/g, '<code>$1</code>')

    // Headers: # text → <b>text</b>
    out = out.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>')

    // Blockquotes and horizontal rules: flatten to plain
    out = out.replace(/^>\s?/gm, '')
    out = out.replace(/^\s*([-*_])\1{2,}\s*$/gm, '')

    // Bullet lists: unify to "• "
    out = out.replace(/^[ \t]*[-*+][ \t]+/gm, '• ')

    return out
}

/**
 * Convert text to Telegram MarkdownV2 mode. Requires aggressive escaping
 * of: _ * [ ] ( ) ~ ` > # + - = | { } . !
 * Provided for completeness but not currently used by the adapter.
 */
function toTelegramMarkdownV2(text: string): string {
    const MDV2_SPECIALS = /([_*\[\]()~`>#+\-=|{}.!\\])/g
    // Pull out bold/code first so we can preserve them. Placeholders use
    // ASCII letters only (A-Z + digits) so the later escape pass can't
    // mangle them.
    const bolds: string[] = []
    let out = text.replace(/\*\*([^*\n]+?)\*\*/g, (_m, inner: string) => {
        bolds.push(inner)
        return `\u0001BB${bolds.length - 1}ZZ\u0001`
    })
    const codes: string[] = []
    out = out.replace(/`([^`\n]+)`/g, (_m, inner: string) => {
        codes.push(inner)
        return `\u0001CC${codes.length - 1}ZZ\u0001`
    })

    // Escape everything
    out = out.replace(MDV2_SPECIALS, '\\$1')

    // Reinsert bolds with proper MDv2 markers
    out = out.replace(/\u0001BB(\d+)ZZ\u0001/g, (_m, idx: string) => {
        const inner = (bolds[Number(idx)] ?? '').replace(MDV2_SPECIALS, '\\$1')
        return `*${inner}*`
    })
    out = out.replace(/\u0001CC(\d+)ZZ\u0001/g, (_m, idx: string) => {
        const inner = (codes[Number(idx)] ?? '').replace(/([`\\])/g, '\\$1')
        return `\`${inner}\``
    })

    return out
}

/**
 * Sanitize outbound text for Slack. Slack uses its own "mrkdwn" dialect
 * (single `*` for bold, `_` for italic). The model emits standard
 * Markdown, so we rewrite to Slack's format and strip constructs Slack
 * doesn't support (headers, tables). Emoji pass through.
 */
export function sanitizeForSlack(text: string): string {
    if (!text) return ''

    const { body, blocks } = extractCodeBlocks(text)
    let out = body

    // Links: [label](url) → <url|label>
    out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label: string, url: string) => {
        return `<${url.trim()}|${label.trim()}>`
    })

    // Bold: **text** → *text*   (but not single * italic markers)
    out = out.replace(/\*\*([^*\n]+?)\*\*/g, '*$1*')
    out = out.replace(/__([^_\n]+?)__/g, '*$1*')

    // Italic: *text* → _text_   (must run after bold rewrite to avoid clobbering)
    //   Edge case: we already converted **x** to *x*, which is Slack bold.
    //   Single-asterisk italic from the model is rare; leave *…* alone.
    //   _text_ stays as italic (already Slack-compatible).

    // Strikethrough: ~~text~~ → ~text~
    out = out.replace(/~~([^~\n]+?)~~/g, '~$1~')

    // Headers: strip marker, make bold (Slack has no native header)
    out = out.replace(/^#{1,6}\s+(.+)$/gm, '*$1*')

    // Horizontal rules → drop
    out = out.replace(/^\s*([-*_])\1{2,}\s*$/gm, '')

    // Bullet lists: normalize to "• "
    out = out.replace(/^[ \t]*[-+][ \t]+/gm, '• ')

    // Re-insert code blocks as triple backticks (Slack supports them)
    out = out.replace(/\u0000CODEBLOCK_(\d+)\u0000/g, (_m, idx: string) => {
        const code = blocks[Number(idx)] ?? ''
        return '```\n' + code + '\n```'
    })

    return out.replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * Sanitize outbound text for Discord. Discord uses standard Markdown
 * with a few extras. Most inputs already work; we normalize headers
 * (Discord supports `#` headers since 2023 but safer to keep plain bold)
 * and drop horizontal rules. Triple-backtick code blocks pass through
 * unchanged. Emoji pass through.
 */
export function sanitizeForDiscord(text: string): string {
    if (!text) return ''

    const { body, blocks } = extractCodeBlocks(text)
    let out = body

    // Headers → bold (safer across clients)
    out = out.replace(/^#{1,6}\s+(.+)$/gm, '**$1**')

    // Horizontal rules → drop
    out = out.replace(/^\s*([-*_])\1{2,}\s*$/gm, '')

    // Links: [label](url) — Discord supports this natively, leave alone.

    // Re-insert code blocks unchanged
    out = out.replace(/\u0000CODEBLOCK_(\d+)\u0000/g, (_m, idx: string) => {
        const code = blocks[Number(idx)] ?? ''
        return '```\n' + code + '\n```'
    })

    return out.replace(/\n{3,}/g, '\n\n').trim()
}
