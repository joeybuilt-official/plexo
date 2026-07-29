// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import React from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism'

import type { WorkRendererProps } from '../types'
import { EnrichedText } from '../enrichment/EnrichedText'
import { CopyableCode } from '../enrichment/CopyableCode'

/**
 * MarkdownRenderer — default text-first renderer.
 *
 * Renders markdown documents with explicit per-element Tailwind styling
 * tied to the canonical token system. We do NOT rely on
 * `@tailwindcss/typography` (`prose` classes) — that plugin is not
 * installed in this app; without these per-element overrides, bold /
 * headings / lists / task-boxes fall back to browser defaults and
 * markdown docs look like flat text with literal asterisks.
 *
 * Phase 4: link enrichment is ON by default. Plain text nodes are
 * passed through `EnrichedText` which detects Plexo paths, API-key
 * provider URLs, generic URLs, tool mentions, and install-action
 * phrases, and replaces them with inline components. Pass
 * `enrich={false}` via props meta to disable for raw markdown where
 * the original wording should not be rewritten.
 */
export function MarkdownRenderer(props: WorkRendererProps) {
    const { work, onAction } = props
    const enrich = shouldEnrich(props)
    if (!work.content) return null
    return (
        <div className="h-full w-full overflow-auto bg-surface-1">
            <div className="mx-auto max-w-3xl w-full px-8 py-8 text-[13.5px] leading-7 text-text-primary">
                <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={buildComponents({ enrich, onAction })}
                >
                    {work.content}
                </ReactMarkdown>
            </div>
        </div>
    )
}

function shouldEnrich(props: WorkRendererProps): boolean {
    const meta = (props.work.meta ?? {}) as Record<string, unknown>
    if (meta.enrich === false) return false
    return true
}

interface BuildOpts {
    enrich: boolean
    onAction?: WorkRendererProps['onAction']
}

// Loose prop bag used for the ReactMarkdown `components` overrides.
// react-markdown's own typings for these callbacks are unstable across
// versions, so we accept a structural superset and narrow inside each
// override.
type MdProps = {
    children?: React.ReactNode
    className?: string
    href?: string
    src?: string
    alt?: string
    type?: string
    checked?: boolean
    disabled?: boolean
    inline?: boolean
    [key: string]: unknown
}

type MdComponent = (props: MdProps) => React.ReactNode

/**
 * Build the ReactMarkdown component overrides. Exported for reuse by
 * `InstructionsRenderer`, which wraps `MarkdownRenderer` output in
 * Phase-3 chrome but shares the same enrichment pipeline.
 *
 * Every block / inline element gets explicit Tailwind classes using
 * canonical tokens (`text-text-primary`, `text-text-muted`,
 * `bg-surface-2`, `border-border`, `text-azure`). No `prose` /
 * `foreground` / unprefixed `surface` classes.
 */
export function buildComponents({ enrich, onAction }: BuildOpts): Record<string, MdComponent> {
    const enrichChildren = (children: React.ReactNode): React.ReactNode => {
        if (!enrich) return children
        return React.Children.map(children, (child) => {
            if (typeof child === 'string') {
                return <EnrichedText value={child} onAction={onAction} />
            }
            return child
        })
    }

    const styledHeading = (Tag: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6', className: string): MdComponent =>
        function StyledHeading({ children, ...rest }) {
            return React.createElement(Tag, { ...rest, className }, enrichChildren(children))
        }

    const components: Record<string, MdComponent> = {
        // ── Headings ────────────────────────────────────────────────────
        h1: styledHeading('h1', 'text-2xl font-semibold text-text-primary mt-8 mb-4 pb-2 border-b border-border/60 first:mt-0'),
        h2: styledHeading('h2', 'text-xl font-semibold text-text-primary mt-7 mb-3 first:mt-0'),
        h3: styledHeading('h3', 'text-base font-semibold text-text-primary mt-6 mb-2 first:mt-0'),
        h4: styledHeading('h4', 'text-sm font-semibold uppercase tracking-wider text-text-secondary mt-5 mb-2 first:mt-0'),
        h5: styledHeading('h5', 'text-xs font-semibold uppercase tracking-wider text-text-secondary mt-4 mb-2 first:mt-0'),
        h6: styledHeading('h6', 'text-xs font-semibold uppercase tracking-wider text-text-muted mt-4 mb-2 first:mt-0'),

        // ── Paragraphs & inline text ────────────────────────────────────
        p: function StyledP({ children, ...rest }) {
            return (
                <p {...rest} className="my-3 text-text-primary leading-7">
                    {enrichChildren(children)}
                </p>
            )
        },
        strong: function StyledStrong({ children, ...rest }) {
            return (
                <strong {...rest} className="font-semibold text-text-primary">
                    {enrichChildren(children)}
                </strong>
            )
        },
        em: function StyledEm({ children, ...rest }) {
            return (
                <em {...rest} className="italic text-text-primary">
                    {enrichChildren(children)}
                </em>
            )
        },
        del: function StyledDel({ children, ...rest }) {
            return (
                <del {...rest} className="line-through text-text-muted">
                    {children}
                </del>
            )
        },

        // ── Links ───────────────────────────────────────────────────────
        a: function StyledA({ children, href, ...rest }) {
            return (
                <a
                    {...rest}
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-azure underline decoration-azure/40 underline-offset-2 hover:decoration-azure transition-colors"
                >
                    {children}
                </a>
            )
        },

        // ── Lists ───────────────────────────────────────────────────────
        ul: function StyledUl({ children, ...rest }) {
            return (
                <ul
                    {...rest}
                    className="my-3 ml-5 list-disc marker:text-text-muted space-y-1 text-text-primary"
                >
                    {children}
                </ul>
            )
        },
        ol: function StyledOl({ children }) {
            return (
                <ol className="my-3 ml-5 list-decimal marker:text-text-muted space-y-1 text-text-primary">
                    {children}
                </ol>
            )
        },
        li: function StyledLi({ children, className, ...rest }) {
            // GFM task list items arrive with className="task-list-item"
            // and a checkbox as the first child. Strip the marker by
            // rendering them as an unstyled flex row with a styled box.
            if (typeof className === 'string' && className.includes('task-list-item')) {
                return (
                    <li
                        {...rest}
                        className="list-none -ml-5 flex items-start gap-2 text-text-primary"
                    >
                        {enrichChildren(children)}
                    </li>
                )
            }
            return (
                <li {...rest} className="text-text-primary">
                    {enrichChildren(children)}
                </li>
            )
        },
        // Task checkbox emitted inside a task-list-item <li>. We style
        // it as a small square that matches the surface tokens.
        input: function StyledInput({ type, checked, disabled }) {
            if (type !== 'checkbox') {
                // Non-checkbox <input> nodes are rare inside markdown;
                // render a bare element to keep semantic output.
                return <input type={type} />
            }
            return (
                <input
                    type="checkbox"
                    checked={!!checked}
                    disabled={!!disabled}
                    readOnly
                    className="mt-1.5 h-3.5 w-3.5 shrink-0 rounded-sm border border-border bg-surface-2 accent-azure"
                />
            )
        },

        // ── Blockquotes ─────────────────────────────────────────────────
        blockquote: function StyledBlockquote({ children, ...rest }) {
            return (
                <blockquote
                    {...rest}
                    className="my-4 pl-4 border-l-2 border-azure/60 text-text-secondary italic"
                >
                    {children}
                </blockquote>
            )
        },

        // ── Horizontal rule ─────────────────────────────────────────────
        hr: function StyledHr(rest) {
            return <hr {...rest} className="my-6 border-0 border-t border-border/60" />
        },

        // ── Code ────────────────────────────────────────────────────────
        code: function StyledCode(codeProps) {
            const { inline, className, children } = codeProps
            const match = /language-(\w+)/.exec(className || '')
            if (!inline && match) {
                return (
                    <SyntaxHighlighter
                        PreTag="div"
                        language={match[1]}
                        style={vscDarkPlus as Record<string, React.CSSProperties>}
                        customStyle={{
                            margin: '1rem 0',
                            borderRadius: '8px',
                            fontSize: '12.5px',
                            padding: '14px 16px',
                        }}
                    >
                        {String(children).replace(/\n$/, '')}
                    </SyntaxHighlighter>
                )
            }
            // Inline code: add a copy button on hover when enriched.
            if (enrich) {
                return <CopyableCode className={className}>{children}</CopyableCode>
            }
            return (
                <code className="rounded px-1.5 py-0.5 bg-surface-2 border border-border/60 font-mono text-[0.85em] text-text-primary">
                    {children}
                </code>
            )
        },
        pre: function StyledPre({ children, ...rest }) {
            // When a <pre> contains a SyntaxHighlighter wrapper we keep
            // it transparent — the highlighter supplies its own chrome.
            // For plain <pre> blocks we add surface styling.
            return (
                <pre
                    {...rest}
                    className="my-4 rounded bg-surface-2 border border-border/60 p-4 overflow-x-auto font-mono text-xs text-text-primary"
                >
                    {children}
                </pre>
            )
        },

        // ── Tables ──────────────────────────────────────────────────────
        table: function StyledTable({ children, ...rest }) {
            return (
                <div className="my-4 overflow-x-auto rounded border border-border/60">
                    <table {...rest} className="w-full text-xs text-left text-text-primary">
                        {children}
                    </table>
                </div>
            )
        },
        thead: function StyledThead({ children, ...rest }) {
            return (
                <thead {...rest} className="bg-surface-2 text-text-secondary uppercase text-[10px] tracking-wider">
                    {children}
                </thead>
            )
        },
        tbody: function StyledTbody({ children, ...rest }) {
            return (
                <tbody {...rest} className="divide-y divide-border/60">
                    {children}
                </tbody>
            )
        },
        tr: function StyledTr({ children, ...rest }) {
            return (
                <tr {...rest} className="hover:bg-surface-2/40 transition-colors">
                    {children}
                </tr>
            )
        },
        th: function StyledTh({ children, ...rest }) {
            return (
                <th {...rest} className="px-3 py-2 font-semibold text-text-secondary">
                    {enrichChildren(children)}
                </th>
            )
        },
        td: function StyledTd({ children, ...rest }) {
            return (
                <td {...rest} className="px-3 py-2 align-top text-text-primary">
                    {enrichChildren(children)}
                </td>
            )
        },

        // ── Images ──────────────────────────────────────────────────────
        img: function StyledImg({ alt, src }) {
            return (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                    src={src}
                    alt={alt ?? ''}
                    className="my-4 max-w-full rounded border border-border/60"
                />
            )
        },
    }

    return components
}
