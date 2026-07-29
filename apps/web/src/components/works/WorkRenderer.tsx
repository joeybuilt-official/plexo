// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { Pin } from 'lucide-react'

import type { WorkRendererProps, WorkKind, WorkAction } from './types'
import { resolveKindFromWork } from './infer-kind-client'

import { MarkdownRenderer } from './renderers/MarkdownRenderer'
import { InstructionsRenderer } from './renderers/InstructionsRenderer'
import { CodeRenderer } from './renderers/CodeRenderer'
import { HtmlRenderer } from './renderers/HtmlRenderer'
import { MockupRenderer } from './renderers/MockupRenderer'
import { JsonRenderer } from './renderers/JsonRenderer'
import { YamlRenderer } from './renderers/YamlRenderer'
import { TableRenderer } from './renderers/TableRenderer'
import { ChecklistRenderer } from './renderers/ChecklistRenderer'
import { ImageRenderer } from './renderers/ImageRenderer'
import { DiagramRenderer } from './renderers/DiagramRenderer'
import { ChartRenderer } from './renderers/ChartRenderer'
import { ConfigRenderer } from './renderers/ConfigRenderer'
import { LinkListRenderer } from './renderers/LinkListRenderer'
import { FileRenderer } from './renderers/FileRenderer'

/**
 * Resolve the WorkKind to use for rendering. Thin re-export of the pure
 * helper in `./infer-kind-client`.
 */
export function resolveKind(work: { kind?: WorkKind, filename: string, content?: string | null }): WorkKind {
    return resolveKindFromWork(work)
}

/**
 * WorkRendererBody — renders the correct typed component without the
 * workbench handoff chrome. Exposed for callers that already supply
 * their own chrome (e.g. the workbench pane itself, which would
 * otherwise recursively render its own "send to workbench" button).
 */
export function WorkRendererBody(props: WorkRendererProps) {
    const kind = resolveKind(props.work)
    switch (kind) {
        case 'markdown':     return <MarkdownRenderer     {...props} />
        case 'instructions': return <InstructionsRenderer {...props} />
        case 'code':         return <CodeRenderer         {...props} />
        case 'html':         return <HtmlRenderer         {...props} />
        case 'mockup':       return <MockupRenderer       {...props} />
        case 'json':         return <JsonRenderer         {...props} />
        case 'yaml':         return <YamlRenderer         {...props} />
        case 'table':        return <TableRenderer        {...props} />
        case 'checklist':    return <ChecklistRenderer    {...props} />
        case 'image':        return <ImageRenderer        {...props} />
        case 'diagram':      return <DiagramRenderer      {...props} />
        case 'chart':        return <ChartRenderer        {...props} />
        case 'config':       return <ConfigRenderer       {...props} />
        case 'link-list':    return <LinkListRenderer     {...props} />
        case 'file':
        default:             return <FileRenderer         {...props} />
    }
}

/**
 * WorkRenderer — the one dispatcher `ArtifactPanel` and the task
 * detail page should use. Phase 7 adds an always-present "Send to
 * workbench" pill in the top-right corner, emitted as a
 * `{ type: 'workbench' }` action. Pass `chrome={false}` to suppress
 * the pill (e.g. when the workbench itself is rendering a pinned
 * work).
 */
export function WorkRenderer(props: WorkRendererProps & { chrome?: boolean }) {
    const { chrome = true, ...inner } = props
    const kind = resolveKind(props.work)

    if (!chrome) return <WorkRendererBody {...inner} />

    return (
        <div className="relative h-full w-full">
            <div className="absolute top-2 right-2 z-20">
                <button
                    type="button"
                    onClick={() => {
                        const action: WorkAction = {
                            type: 'workbench',
                            workId: props.work.artifactId ?? props.work.filename,
                            kind,
                            title: props.work.filename,
                        }
                        inner.onAction?.(action)
                    }}
                    className="flex items-center gap-1 rounded-md bg-surface-1/90 border border-border px-2 py-1 text-[10px] font-medium text-text-muted hover:text-text-primary hover:bg-surface-1 transition-colors "
                    title="Pin to workbench"
                >
                    <Pin className="h-3 w-3" />
                    Workbench
                </button>
            </div>
            <WorkRendererBody {...inner} />
        </div>
    )
}
