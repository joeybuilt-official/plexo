// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism'

import type { WorkRendererProps } from '../types'
import { inferKindClient } from '../infer-kind-client'

/**
 * CodeRenderer — syntax-highlighted source. Language picked from
 * `meta.language` if the agent declared it, otherwise inferred from the
 * filename extension. Copy / Download are provided by the panel header.
 */
export function CodeRenderer({ work }: WorkRendererProps) {
    if (!work.content) return null

    const metaLang = (work.meta?.language as string | undefined) || undefined
    const language = metaLang ?? inferKindClient(work.filename, work.content).language ?? 'text'

    return (
        <SyntaxHighlighter
            language={language}
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- react-syntax-highlighter style types are broken upstream
            style={vscDarkPlus as any}
            customStyle={{
                margin: 0,
                borderRadius: 0,
                padding: '1.25rem',
                fontSize: '13px',
                minHeight: '100%',
                backgroundColor: '#0d0d0d',
            }}
            showLineNumbers
        >
            {work.content}
        </SyntaxHighlighter>
    )
}
