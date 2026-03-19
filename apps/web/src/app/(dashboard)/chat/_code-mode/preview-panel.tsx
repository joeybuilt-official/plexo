// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { useState, useEffect, useRef } from 'react'
import { Loader2, ExternalLink, Smartphone, Monitor, RotateCcw } from 'lucide-react'

interface PreviewPanelProps {
    workspaceId: string
    taskId?: string
    /** Optional specific file path to preview (e.g. index.html) */
    path?: string
    className?: string
}

export function PreviewPanel({ workspaceId, taskId, path = 'index.html', className = '' }: PreviewPanelProps) {
    const [content, setContent] = useState<string | null>(null)
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [viewMode, setViewMode] = useState<'desktop' | 'mobile'>('desktop')
    const [refreshKey, setRefreshKey] = useState(0)
    const iframeRef = useRef<HTMLIFrameElement>(null)

    useEffect(() => {
        if (!taskId) return

        async function loadPreview() {
            setLoading(true)
            setError(null)
            try {
                const res = await fetch(
                    `/api/v1/code/file?workspaceId=${workspaceId}&taskId=${taskId}&path=${encodeURIComponent(path)}`
                )
                if (!res.ok) {
                    // Try to list files to see if index.html exists or find another html file
                    if (path === 'index.html') {
                        const treeRes = await fetch(`/api/v1/code/tree?workspaceId=${workspaceId}&taskId=${taskId}`)
                        if (treeRes.ok) {
                            const treeData = await treeRes.json() as { files?: { path: string }[] }
                            const htmlFile = treeData.files?.find(f => f.path.endsWith('.html'))
                            if (htmlFile && htmlFile.path !== 'index.html') {
                                // Found another HTML file, try loading that
                                const nextRes = await fetch(
                                    `/api/v1/code/file?workspaceId=${workspaceId}&taskId=${taskId}&path=${encodeURIComponent(htmlFile.path)}`
                                )
                                if (nextRes.ok) {
                                    const nextData = await nextRes.json() as { content?: string }
                                    setContent(nextData.content ?? '')
                                    setLoading(false)
                                    return
                                }
                            }
                        }
                    }
                    throw new Error(`Could not find ${path} to preview.`)
                }
                const data = await res.json() as { content?: string }
                setContent(data.content ?? '')
            } catch (err) {
                setError(err instanceof Error ? err.message : 'Failed to load preview')
            } finally {
                setLoading(false)
            }
        }

        void loadPreview()
    }, [workspaceId, taskId, path, refreshKey])

    // Update iframe content when content state changes
    useEffect(() => {
        if (!iframeRef.current || !content) return

        const iframe = iframeRef.current
        const doc = iframe.contentDocument || iframe.contentWindow?.document
        if (!doc) return

        doc.open()
        doc.write(content)
        doc.close()
    }, [content])

    if (!taskId) {
        return (
            <div className={`flex flex-col items-center justify-center h-full text-text-muted gap-2 bg-canvas ${className}`}>
                <Monitor className="h-8 w-8 opacity-20" />
                <span className="text-sm">Connect a repo and start an agent to see a preview</span>
            </div>
        )
    }

    return (
        <div className={`flex flex-col h-full bg-canvas/40 overflow-hidden ${className}`}>
            {/* Toolbar */}
            <div className="flex items-center gap-2 px-3 h-9 border-b border-border bg-surface-1/40 flex-shrink-0">
                <div className="flex bg-zinc-800/50 rounded-md p-0.5">
                    <button
                        onClick={() => setViewMode('desktop')}
                        className={`p-1 rounded transition-colors ${viewMode === 'desktop' ? 'bg-zinc-700 text-azure shadow-sm' : 'text-text-muted hover:text-text-secondary'}`}
                        title="Desktop view"
                    >
                        <Monitor className="h-3.5 w-3.5" />
                    </button>
                    <button
                        onClick={() => setViewMode('mobile')}
                        className={`p-1 rounded transition-colors ${viewMode === 'mobile' ? 'bg-zinc-700 text-azure shadow-sm' : 'text-text-muted hover:text-text-secondary'}`}
                        title="Mobile view"
                    >
                        <Smartphone className="h-3.5 w-3.5" />
                    </button>
                </div>
                
                <div className="w-px h-3 bg-zinc-700/50 mx-1" />
                
                <button
                    onClick={() => setRefreshKey(k => k + 1)}
                    className="p-1.5 rounded text-text-muted hover:text-text-primary hover:bg-zinc-800/50 transition-colors"
                    title="Refresh preview"
                >
                    <RotateCcw className="h-3.5 w-3.5" />
                </button>

                <div className="flex-1" />
                
                <span className="text-[10px] font-mono text-text-muted truncate max-w-[150px]">
                    {path}
                </span>

                <button
                    className="p-1.5 rounded text-text-muted hover:text-text-primary hover:bg-zinc-800/50 transition-colors"
                    title="Open in new tab"
                >
                    <ExternalLink className="h-3.5 w-3.5" />
                </button>
            </div>

            {/* Preview area */}
            <div className="flex-1 bg-[radial-gradient(circle_at_center,_var(--color-border-subtle)_1px,_transparent_1px)] bg-[size:20px_20px] relative overflow-hidden flex items-center justify-center p-4">
                {loading && (
                    <div className="absolute inset-0 z-10 flex items-center justify-center bg-canvas/40 backdrop-blur-[1px]">
                        <Loader2 className="h-6 w-6 animate-spin text-azure" />
                    </div>
                )}
                
                {error ? (
                    <div className="text-center p-6 bg-surface-1 rounded-xl border border-border shadow-sm max-w-sm">
                        <Smartphone className="h-8 w-8 text-text-muted mx-auto mb-3 opacity-20" />
                        <h3 className="text-sm font-medium text-text-primary mb-1">No preview available yet</h3>
                        <p className="text-xs text-text-muted mb-4 leading-relaxed">
                            {error === 'Could not find index.html to preview.' 
                                ? 'I couldn\'t find an index.html file to show yet. Ask me to build a page or app!' 
                                : error}
                        </p>
                    </div>
                ) : (
                    <div 
                        className={`bg-white border border-border shadow-2xl transition-all duration-300 origin-center ${
                            viewMode === 'mobile' ? 'w-[375px] h-[667px]' : 'w-full h-full'
                        }`}
                        style={{ borderRadius: viewMode === 'mobile' ? '24px' : '0px', overflow: 'hidden' }}
                    >
                        <iframe
                            ref={iframeRef}
                            title="Preview"
                            className="w-full h-full border-0"
                            sandbox="allow-scripts allow-same-origin"
                        />
                    </div>
                )}
            </div>
        </div>
    )
}
