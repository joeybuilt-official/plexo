// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Embeddable Plexo panel — renders settings surfaces inside iframes
 * for cross-app integration (Fylo, Levio, etc.)
 *
 * URL: /embed/{type}?workspaceId=...&token=...
 * Types: intelligence, connections, agent, progress
 *
 * Host app loads this in an iframe and communicates via postMessage.
 */

'use client'

export const dynamic = 'force-dynamic'

import { Suspense } from 'react'
import { useParams, useSearchParams } from 'next/navigation'
import { WorkspaceProvider } from '@web/context/workspace'

// Lazy imports for each panel type
import dynamic_ from 'next/dynamic'

// The intelligence root is a server-side redirect; for the embed flow
// we want the actual providers surface inline.
const AIModelsPage = dynamic_(() => import('../../app/settings/intelligence/providers/page'), { ssr: false })
const ConnectionsPanel = dynamic_(() => import('./connections-panel'), { ssr: false })

export default function EmbedPage() {
    return (
        <Suspense>
            <EmbedContent />
        </Suspense>
    )
}

function EmbedContent() {
    const params = useParams()
    const searchParams = useSearchParams()
    const type = params.type as string
    const workspaceId = searchParams.get('workspaceId') ?? ''

    if (!workspaceId) {
        return <div className="p-4 text-text-muted text-sm">Missing workspaceId parameter.</div>
    }

    return (
        <div className="min-h-screen bg-canvas text-text-primary p-4">
            <WorkspaceProvider initialId={workspaceId}>
                {type === 'intelligence' && <AIModelsPage />}
                {type === 'connections' && <ConnectionsPanel />}
                {!['intelligence', 'connections'].includes(type) && (
                    <div className="text-text-muted text-sm">Unknown panel type: {type}</div>
                )}
            </WorkspaceProvider>
        </div>
    )
}
