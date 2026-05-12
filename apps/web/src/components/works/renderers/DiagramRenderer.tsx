// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { useEffect, useState } from 'react'
import DOMPurify from 'dompurify'

import type { WorkRendererProps } from '../types'

/**
 * DiagramRenderer — renders `kind: 'diagram'` Mermaid source. Phase 6
 * lazy-loads the `mermaid` package on first render via dynamic import
 * so the ~500KB bundle stays out of the main chunk. Non-mermaid
 * languages (plantuml, dot) fall back to source view.
 */
export function DiagramRenderer({ work }: WorkRendererProps) {
    const [svg, setSvg] = useState<string>('')
    const [err, setErr] = useState<string | null>(null)
    const [loading, setLoading] = useState(true)
    const lang = (work.meta?.language as string | undefined) || 'mermaid'

    useEffect(() => {
        let cancelled = false
        if (!work.content || lang !== 'mermaid') {
            setLoading(false)
            return
        }
        setLoading(true)
        ;(async () => {
            try {
                const { default: mermaid } = await import('mermaid')
                mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'strict' })
                const id = `mermaid-${Math.random().toString(36).slice(2, 11)}`
                const { svg: rendered } = await mermaid.render(id, work.content!)
                const sanitized = DOMPurify.sanitize(rendered, {
                    USE_PROFILES: { svg: true, svgFilters: true },
                    ADD_TAGS: ['style'],
                    FORBID_ATTR: ['onload', 'onerror', 'onclick', 'onmouseover', 'onfocus', 'onblur'],
                })
                if (!cancelled) { setSvg(sanitized); setErr(null) }
            } catch (e) {
                if (!cancelled) { setErr((e as Error)?.message ?? 'Render failed'); setSvg('') }
            } finally {
                if (!cancelled) setLoading(false)
            }
        })()
        return () => { cancelled = true }
    }, [work.content, lang])

    if (lang !== 'mermaid') {
        return (
            <div className="h-full flex flex-col items-center justify-center gap-2 p-8 text-center text-text-muted">
                <div className="text-sm font-medium text-text-primary">Diagram source ({lang})</div>
                <p className="text-xs max-w-md">
                    Non-mermaid diagram languages render as source in-panel. Use the Workbench button above
                    to open in an editor.
                </p>
                <pre className="mt-4 w-full max-w-2xl text-left text-[11px] font-mono text-text-primary/80 bg-surface-1/40 p-3 rounded overflow-auto">{work.content}</pre>
            </div>
        )
    }

    if (loading) {
        return (
            <div className="h-full flex items-center justify-center text-xs text-text-muted">
                Loading diagram…
            </div>
        )
    }

    if (err) {
        return (
            <div className="p-6 font-mono text-xs text-red-400 whitespace-pre-wrap">
                Mermaid render failed: {err}
            </div>
        )
    }

    return (
        <div className="w-full h-full bg-surface-1 flex items-center justify-center p-8 overflow-auto">
            <div className="mermaid flex justify-center w-full" dangerouslySetInnerHTML={{ __html: svg }} />
        </div>
    )
}
