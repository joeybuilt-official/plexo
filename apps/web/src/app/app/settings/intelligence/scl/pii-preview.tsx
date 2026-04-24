// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

/**
 * PII preview — Phase 3a.
 *
 * Read-only panel showing what the live PII scrub pipeline would strip
 * from a sample input. Helps users verify nothing useful is being
 * scrubbed away. Pulls the latest log shape (input + output patterns)
 * from the API so users see what already ran.
 */

import { useSclPiiPreview } from '@web/lib/scl-client'
import { Eye, EyeOff } from 'lucide-react'

interface PiiPreviewProps {
    workspaceId: string
}

export function PiiPreview({ workspaceId }: PiiPreviewProps) {
    const { data, isLoading } = useSclPiiPreview(workspaceId)

    if (isLoading) {
        return (
            <div className="rounded-xl border border-border bg-surface-1 p-3 text-xs text-text-muted">
                Loading PII preview…
            </div>
        )
    }

    if (!data?.available) {
        return (
            <div className="rounded-xl border border-border bg-surface-1 p-3">
                <div className="flex items-center gap-2 text-xs text-text-muted">
                    <EyeOff className="h-3 w-3" />
                    {data?.reason ?? 'No PII preview yet for this workspace.'}
                </div>
            </div>
        )
    }

    return (
        <div className="space-y-3">
            <div className="rounded-xl border border-border bg-surface-1 p-3">
                <div className="flex items-center gap-2">
                    <Eye className="h-3 w-3 text-text-muted" />
                    <h3 className="text-sm font-medium text-text-primary">PII scrub preview</h3>
                </div>
                <p className="mt-1 text-[11px] text-text-muted">
                    The same regex pipeline that runs on every inference log. Sample below shows the before/after.
                </p>
                <div className="mt-3 space-y-2">
                    <div>
                        <div className="text-[11px] uppercase tracking-wide text-text-muted">Sample input</div>
                        <pre className="mt-1 whitespace-pre-wrap rounded-md border border-border bg-surface-1 p-2 text-[11px] text-text-primary">
{data.sample?.original}
                        </pre>
                    </div>
                    <div>
                        <div className="text-[11px] uppercase tracking-wide text-text-muted">After scrub</div>
                        <pre className="mt-1 whitespace-pre-wrap rounded-md border border-border bg-surface-1 p-2 text-[11px] text-text-primary">
{data.sample?.scrubbed}
                        </pre>
                    </div>
                </div>
            </div>

            {data.latest && (
                <div className="rounded-xl border border-border bg-surface-1 p-3">
                    <h3 className="text-sm font-medium text-text-primary">Latest scrubbed log</h3>
                    <div className="mt-2 space-y-1 text-[11px] text-text-muted">
                        <div>id: <span className="text-text-primary">{data.latest.id}</span></div>
                        <div>model: <span className="text-text-primary">{data.latest.model}</span></div>
                        <div>created: <span className="text-text-primary">{new Date(data.latest.createdAt).toLocaleString()}</span></div>
                        {data.latest.inputPattern && (
                            <div>
                                input pattern:{' '}
                                <code className="text-text-primary">{data.latest.inputPattern}</code>
                            </div>
                        )}
                        {data.latest.outputPattern && (
                            <div>
                                output pattern:{' '}
                                <code className="text-text-primary">{data.latest.outputPattern}</code>
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    )
}
