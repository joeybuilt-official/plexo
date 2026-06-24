// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

const EXT_LANG_MAP: Record<string, string> = {
    ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx',
    py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java',
    c: 'c', cpp: 'cpp', cs: 'csharp', php: 'php', swift: 'swift',
    kt: 'kotlin', sh: 'bash', bash: 'bash', zsh: 'bash',
    sql: 'sql', html: 'html', css: 'css', scss: 'scss',
    json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml',
    xml: 'xml', md: 'markdown', dockerfile: 'docker',
}

function inferLanguage(filename: string): string {
    const ext = filename.split('.').pop()?.toLowerCase() ?? ''
    const base = filename.toLowerCase()
    if (base === 'dockerfile') return 'docker'
    if (base === 'makefile') return 'makefile'
    return EXT_LANG_MAP[ext] ?? 'text'
}

interface ShareContentProps {
    content: string
    filename: string
    kind: string
    meta?: Record<string, unknown> | null
}

export function ShareContent({ content, filename, kind, meta }: ShareContentProps) {
    const normalizedKind = kind?.toLowerCase() ?? 'file'

    // Markdown
    if (normalizedKind === 'markdown' || normalizedKind === 'instructions') {
        return (
            <div className="prose prose-invert max-w-none text-text-primary [&_h1]:text-text-primary [&_h2]:text-text-primary [&_h3]:text-text-primary [&_p]:text-text-secondary [&_li]:text-text-secondary [&_a]:text-azure [&_code]:bg-surface [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-sm [&_pre]:bg-surface-code [&_pre]:rounded-lg [&_blockquote]:border-border [&_blockquote]:text-text-muted [&_hr]:border-border">
                <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={{
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        code({ className, children, ...props }: any) {
                            const match = /language-(\w+)/.exec(className || '')
                            const inline = !match
                            if (inline) {
                                return <code className={className} {...props}>{children}</code>
                            }
                            return (
                                <SyntaxHighlighter
                                    language={match[1]}
                                    style={vscDarkPlus as any}
                                    customStyle={{ margin: 0, borderRadius: '0.5rem', fontSize: '13px', backgroundColor: '#0d0d0d' }}
                                    showLineNumbers
                                >
                                    {String(children).replace(/\n$/, '')}
                                </SyntaxHighlighter>
                            )
                        },
                    }}
                >
                    {content}
                </ReactMarkdown>
            </div>
        )
    }

    // Code
    if (normalizedKind === 'code' || normalizedKind === 'json' || normalizedKind === 'yaml' || normalizedKind === 'config') {
        const language = (meta?.language as string) ?? inferLanguage(filename)
        return (
            <SyntaxHighlighter
                language={language}
                style={vscDarkPlus as any}
                customStyle={{ margin: 0, borderRadius: '0.75rem', padding: '1.25rem', fontSize: '13px', backgroundColor: '#0d0d0d' }}
                showLineNumbers
            >
                {content}
            </SyntaxHighlighter>
        )
    }

    // HTML — sandbox disallows scripts on public share pages to prevent XSS via shared content
    if (normalizedKind === 'html' || normalizedKind === 'mockup') {
        return (
            <div className="rounded border border-border overflow-hidden">
                <iframe
                    srcDoc={content}
                    className="w-full min-h-[400px] bg-white"
                    sandbox="allow-same-origin"
                    title={filename}
                />
            </div>
        )
    }

    // Plain text / file / anything else
    return (
        <pre className="whitespace-pre-wrap break-words text-sm text-text-secondary font-mono leading-relaxed">
            {content}
        </pre>
    )
}
