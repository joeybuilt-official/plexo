import { X, Copy, Check, Download, FileDown, ChevronDown, Loader2, History, AlertTriangle, Share2, Link2, Unlink } from 'lucide-react'
import { toast } from 'sonner'
import { useState, useEffect, useRef } from 'react'
import { useFocusTrap } from '@web/hooks/use-focus-trap'

import type { TaskAsset } from '@web/app/app/chat/_components/types'
import { WorkRenderer, resolveKind } from '@web/components/works/WorkRenderer'
import type { WorkAction } from '@web/components/works/types'
import { KindBadge } from '@web/components/works/KindBadge'
export type { TaskAsset }

interface ArtifactVersion {
    version: number
    changeDescription: string
    createdAt: string
}

export function ArtifactPanel({
    asset,
    taskId,
    workspaceId,
    onClose,
    mode = 'overlay'
}: {
    asset: TaskAsset | null
    taskId?: string | null
    workspaceId?: string | null
    onClose: () => void
    mode?: 'overlay' | 'docked'
}) {
    const [copied, setCopied] = useState(false)
    const [open, setOpen] = useState(false)
    const [exporting, setExporting] = useState<'pdf' | 'docx' | null>(null)
    const [showExportMenu, setShowExportMenu] = useState(false)
    const [versions, setVersions] = useState<ArtifactVersion[]>([])
    const [showVersionMenu, setShowVersionMenu] = useState(false)
    const [fetchingVersion, setFetchingVersion] = useState(false)
    const [currentAsset, setCurrentAsset] = useState<TaskAsset | null>(asset)
    const [confirmApply, setConfirmApply] = useState<Extract<WorkAction, { type: 'apply' }> | null>(null)
    const [actionRunning, setActionRunning] = useState(false)
    const confirmTrapRef = useFocusTrap<HTMLDivElement>(confirmApply !== null)
    const [shareUrl, setShareUrl] = useState<string | null>(null)
    const [shareLoading, setShareLoading] = useState(false)
    const [showSharePopover, setShowSharePopover] = useState(false)
    const [shareCopied, setShareCopied] = useState(false)

    // Fetch existing share info when artifact changes
    useEffect(() => {
        if (!asset?.artifactId) { setShareUrl(null); return }
        fetch(`/api/v1/shares/${asset.artifactId}`, { credentials: 'include' })
            .then(res => res.json())
            .then(data => {
                if (data.share?.url) setShareUrl(data.share.url)
                else setShareUrl(null)
            })
            .catch(() => setShareUrl(null))
    }, [asset?.artifactId])

    async function createShare() {
        if (!currentAsset?.artifactId) return
        setShareLoading(true)
        try {
            const res = await fetch(`/api/v1/shares/${currentAsset.artifactId}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({}),
            })
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            const data = await res.json()
            setShareUrl(data.url)
            navigator.clipboard.writeText(data.url).then(() => {
                setShareCopied(true)
                setTimeout(() => setShareCopied(false), 2000)
                toast.success('Share link copied to clipboard')
            })
        } catch (err) {
            toast.error(`Failed to create share: ${(err as Error).message}`)
        } finally {
            setShareLoading(false)
        }
    }

    async function revokeShare() {
        if (!currentAsset?.artifactId) return
        setShareLoading(true)
        try {
            const res = await fetch(`/api/v1/shares/${currentAsset.artifactId}`, {
                method: 'DELETE',
                credentials: 'include',
            })
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            setShareUrl(null)
            setShowSharePopover(false)
            toast.success('Share link revoked')
        } catch (err) {
            toast.error(`Failed to revoke: ${(err as Error).message}`)
        } finally {
            setShareLoading(false)
        }
    }

    useEffect(() => {
        if (asset) {
            setCurrentAsset(asset)
            // Small delay to ensure CSS transition works when mounting
            requestAnimationFrame(() => setOpen(true))

            // Fetch version history if it's a DB-backed artifact
            if (asset.artifactId && taskId) {
                fetch(`/api/v1/tasks/${taskId}/artifacts/${asset.artifactId}/versions`)
                    .then(res => res.json())
                    .then(data => {
                        if (data.versions) setVersions(data.versions)
                    })
                    .catch(err => console.error('Failed to fetch versions:', err))
            } else {
                setVersions([])
            }
        } else {
            setOpen(false)
            setVersions([])
        }
    }, [asset, taskId])

    if (!asset && !open) return null

    const sizeLabel = asset?.bytes 
        ? asset.bytes < 1024 ? `${asset.bytes}B` : asset.bytes < 1024 * 1024 ? `${(asset.bytes / 1024).toFixed(1)}KB` : `${(asset.bytes / (1024 * 1024)).toFixed(1)}MB`
        : ''

    function copyContent() {
        if (!asset?.content) return
        navigator.clipboard.writeText(asset.content).then(() => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
        })
    }

    function downloadFile() {
        if (!asset?.content) return
        const blob = new Blob([asset.content], { type: 'text/plain' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = asset.filename
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        URL.revokeObjectURL(url)
    }

    async function switchVersion(v: number) {
        if (!currentAsset?.artifactId || !taskId) return
        setFetchingVersion(true)
        setShowVersionMenu(false)
        try {
            const res = await fetch(`/api/v1/tasks/${taskId}/artifacts/${currentAsset.artifactId}/versions/${v}`)
            if (!res.ok) throw new Error('Failed to fetch version')
            const data = await res.json()
            if (data.version) {
                setCurrentAsset({
                    ...currentAsset,
                    content: data.version.content,
                    version: data.version.version,
                    updatedAt: data.version.createdAt,
                    bytes: (data.version.content || '').length,
                })
            }
        } catch (err) {
            console.error(err)
            toast.error('Failed to load version')
        } finally {
            setFetchingVersion(false)
        }
    }

    async function exportAsset(format: 'pdf' | 'docx') {
        if (!currentAsset || !taskId) return
        setExporting(format)
        setShowExportMenu(false)
        try {
            const res = await fetch(`/api/v1/tasks/${taskId}/assets/export`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ filename: currentAsset.filename, format })
            })
            if (!res.ok) throw new Error('Export failed')
            
            const blob = await res.blob()
            const url = URL.createObjectURL(blob)
            const a = document.createElement('a')
            a.href = url
            a.download = `${currentAsset.filename.replace(/\.[^/.]+$/, "")}.${format}`
            document.body.appendChild(a)
            a.click()
            document.body.removeChild(a)
            URL.revokeObjectURL(url)
            toast.success(`Exported as ${format.toUpperCase()}`)
        } catch (err) {
            console.error(err)
            toast.error(`Failed to export as ${format.toUpperCase()}`)
        } finally {
            setExporting(null)
        }
    }

    const resolvedKind = currentAsset ? resolveKind(currentAsset) : null
    const canExport = resolvedKind === 'markdown' || resolvedKind === 'instructions' || resolvedKind === 'checklist' || resolvedKind === 'link-list'

    async function doInstall(action: Extract<WorkAction, { type: 'install' }>) {
        if (!workspaceId) { toast.error('No workspace in scope for install'); return }
        setActionRunning(true)
        try {
            const res = await fetch(`/api/v1/extensions/install`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ workspaceId, ref: action.id, kind: action.kind }),
            })
            if (res.status === 404) {
                toast.error(`Extension "${action.id}" was not found. Browse the Hub to install it.`, {
                    action: { label: 'Browse Hub', onClick: () => { window.location.href = '/app/hub' } },
                })
                return
            }
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            toast.success(`Installing ${action.id}…`)
        } catch (err) {
            toast.error(`Install failed: ${(err as Error).message}`)
        } finally {
            setActionRunning(false)
        }
    }

    async function doRun(action: Extract<WorkAction, { type: 'run' }>) {
        if (!workspaceId) { toast.error('No workspace in scope for run'); return }
        setActionRunning(true)
        try {
            const res = await fetch(`/api/v1/tools/invoke`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ workspaceId, toolName: action.command, args: {} }),
            })
            if (!res.ok) {
                const data = await res.json().catch(() => ({}))
                throw new Error(data?.error?.message || `HTTP ${res.status}`)
            }
            toast.success(`Dispatched ${action.command}`)
        } catch (err) {
            toast.error(`Run failed: ${(err as Error).message}`)
        } finally {
            setActionRunning(false)
        }
    }

    async function doApply(action: Extract<WorkAction, { type: 'apply' }>) {
        setActionRunning(true)
        try {
            const payload = action.payload as { filename?: string, content?: string } | null
            if (payload?.content) {
                await navigator.clipboard.writeText(payload.content)
                toast.success(`Copied ${payload.filename ?? 'content'} to clipboard for apply`)
            } else {
                toast.info('Apply acknowledged')
            }
        } catch (err) {
            toast.error(`Apply failed: ${(err as Error).message}`)
        } finally {
            setActionRunning(false)
            setConfirmApply(null)
        }
    }

    async function doWorkbench(action: Extract<WorkAction, { type: 'workbench' }>) {
        if (!workspaceId) { toast.error('No workspace in scope for workbench'); return }
        if (!currentAsset?.artifactId) {
            toast.error('Cannot pin a filesystem-only work; save it first.')
            return
        }
        setActionRunning(true)
        try {
            const res = await fetch(`/api/v1/workbench/pins`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ workspaceId, workId: currentAsset.artifactId }),
            })
            if (!res.ok) {
                const data = await res.json().catch(() => ({}))
                throw new Error(data?.error?.message || `HTTP ${res.status}`)
            }
            toast.success(`Pinned "${action.title}" to workbench`, {
                action: { label: 'Open', onClick: () => { window.location.href = '/app/workbench' } },
            })
        } catch (err) {
            toast.error(`Pin failed: ${(err as Error).message}`)
        } finally {
            setActionRunning(false)
        }
    }

    return (
        <>
            {/* Backdrop - only in overlay mode */}
            {mode === 'overlay' && (
                <div 
                    className={`absolute inset-0 z-40 bg-canvas/40 backdrop-blur-sm transition-opacity duration-300 ${open ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
                    onClick={() => {
                        setOpen(false)
                        setTimeout(onClose, 300)
                    }}
                />
            )}
            {/* Panel */}
            <div 
                className={`
                    ${mode === 'overlay' 
                        ? 'absolute z-50 top-4 bottom-4 right-4 w-full max-w-lg md:max-w-[45vw] rounded-[24px] shadow-2xl transition-transform duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] bg-surface-1' 
                        : 'relative flex-1 h-full rounded-none border-l border-border/40 bg-canvas/40 backdrop-blur-xl'
                    } 
                    flex flex-col overflow-hidden 
                    ${mode === 'overlay' ? (open ? 'translate-x-0' : 'translate-x-[110%]') : ''}
                `}
            >
                {/* Header */}
                <div className="flex items-center justify-between p-4 border-b border-border/60 bg-surface-2/30">
                    <div className="flex items-center gap-3 min-w-0">
                        <div className="flex flex-col min-w-0">
                            <div className="flex items-center gap-2 min-w-0">
                                <span className="text-sm font-semibold text-text-primary font-mono truncate">{currentAsset?.filename}</span>
                                {resolvedKind && <KindBadge kind={resolvedKind} />}
                            </div>
                            <span className="text-[11px] text-text-muted">{sizeLabel} • {currentAsset?.isText ? 'Text Document' : 'Binary File'}</span>
                        </div>

                        {versions.length > 1 && (
                            <div className="relative">
                                <button 
                                    onClick={() => setShowVersionMenu(!showVersionMenu)}
                                    className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-surface-2/50 border border-border/40 text-[11px] font-medium text-text-secondary hover:text-text-primary hover:bg-surface-2 transition-colors"
                                >
                                    <History className="h-3 w-3" />
                                    v{currentAsset?.version}
                                    <ChevronDown className={`h-2.5 w-2.5 opacity-50 transition-transform ${showVersionMenu ? 'rotate-180' : ''}`} />
                                </button>

                                {showVersionMenu && (
                                    <div className="absolute left-0 top-full mt-1.5 w-48 bg-surface-1 border border-border shadow-2xl rounded-xl overflow-hidden z-[60] py-1">
                                        {versions.map((v) => (
                                            <button
                                                key={v.version}
                                                onClick={() => switchVersion(v.version)}
                                                className={`w-full text-left px-3 py-2 text-[11px] transition-colors flex flex-col gap-0.5 ${currentAsset?.version === v.version ? 'bg-azure/5 text-azure' : 'text-text-secondary hover:bg-surface-2 hover:text-text-primary'}`}
                                            >
                                                <div className="flex items-center justify-between">
                                                    <span className="font-semibold">Version {v.version}</span>
                                                    <span className="text-[10px] opacity-60">{new Date(v.createdAt).toLocaleDateString()}</span>
                                                </div>
                                                <span className="text-[10px] opacity-70 truncate">{v.changeDescription}</span>
                                            </button>
                                        ))}
                                    </div>
                                )}
                            </div>
                        )}
                    </div>

                    <div className="flex items-center gap-1.5 shrink-0 ml-4">
                        {currentAsset?.isText && currentAsset?.content && (
                            <>
                                <button
                                    onClick={copyContent}
                                    className="rounded-lg bg-surface-2 border border-border/60 p-1.5 text-text-secondary hover:text-text-primary hover:bg-surface-3 transition-colors"
                                    title="Copy content"
                                    aria-label="Copy to clipboard"
                                >
                                    {copied ? <Check className="h-4 w-4 text-azure" /> : <Copy className="h-4 w-4" />}
                                </button>
                                <button
                                    onClick={downloadFile}
                                    className="rounded-lg bg-surface-2 border border-border/60 p-1.5 text-text-secondary hover:text-text-primary hover:bg-surface-3 transition-colors"
                                    title="Download file"
                                    aria-label="Download file"
                                >
                                    <Download className="h-4 w-4" />
                                </button>

                                {/* Export Menu */}
                                {canExport ? (
                                    <div className="relative">
                                        <button
                                            onClick={() => setShowExportMenu(!showExportMenu)}
                                            className="rounded-lg bg-azure/10 border border-azure/30 px-2 py-1.5 text-xs font-medium text-azure hover:bg-azure/20 transition-colors flex items-center gap-1"
                                            title="Export as..."
                                        >
                                            {exporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileDown className="h-3.5 w-3.5" />}
                                            Export
                                            <ChevronDown className={`h-3 w-3 transition-transform ${showExportMenu ? 'rotate-180' : ''}`} />
                                        </button>
                                        
                                        {showExportMenu && (
                                            <div className="absolute right-0 mt-2 w-32 bg-surface-1 border border-border shadow-xl rounded-xl overflow-hidden z-[60]">
                                                <button
                                                    onClick={() => exportAsset('pdf')}
                                                    className="w-full text-left px-4 py-2 text-[11px] text-text-secondary hover:bg-surface-2 hover:text-text-primary transition-colors flex items-center gap-2"
                                                >
                                                    <div className="w-1.5 h-1.5 rounded-full bg-red" />
                                                    PDF Document
                                                </button>
                                                <button
                                                    onClick={() => exportAsset('docx')}
                                                    className="w-full text-left px-4 py-2 text-[11px] text-text-secondary hover:bg-surface-2 hover:text-text-primary transition-colors flex items-center gap-2"
                                                >
                                                    <div className="w-1.5 h-1.5 rounded-full bg-azure" />
                                                    Word (DOCX)
                                                </button>
                                            </div>
                                        )}
                                    </div>
                                ) : null}
                            </>
                        )}
                        {/* Share button */}
                        {currentAsset?.artifactId && (
                            <div className="relative">
                                <button
                                    onClick={() => {
                                        if (shareUrl) {
                                            setShowSharePopover(!showSharePopover)
                                        } else {
                                            createShare()
                                        }
                                    }}
                                    disabled={shareLoading}
                                    className={`rounded-lg border p-1.5 transition-colors ${
                                        shareUrl
                                            ? 'bg-azure/10 border-azure/30 text-azure hover:bg-azure/20'
                                            : 'bg-surface-2 border-border/60 text-text-secondary hover:text-text-primary hover:bg-surface-3'
                                    }`}
                                    title={shareUrl ? 'Manage share link' : 'Create share link'}
                                    aria-label={shareUrl ? 'Manage share link' : 'Share'}
                                >
                                    {shareLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Share2 className="h-4 w-4" />}
                                </button>

                                {showSharePopover && shareUrl && (
                                    <div className="absolute right-0 top-full mt-2 w-72 bg-surface-1 border border-border shadow-2xl rounded-xl overflow-hidden z-[60] p-3">
                                        <div className="text-[11px] font-medium text-text-muted mb-2">Share Link</div>
                                        <div className="flex items-center gap-1.5">
                                            <input
                                                type="text"
                                                readOnly
                                                value={shareUrl}
                                                className="flex-1 text-[11px] font-mono bg-surface-2 border border-border/40 rounded-md px-2 py-1.5 text-text-secondary truncate"
                                                onClick={(e) => (e.target as HTMLInputElement).select()}
                                            />
                                            <button
                                                onClick={() => {
                                                    navigator.clipboard.writeText(shareUrl).then(() => {
                                                        setShareCopied(true)
                                                        setTimeout(() => setShareCopied(false), 2000)
                                                        toast.success('Copied')
                                                    })
                                                }}
                                                className="rounded-md bg-surface-2 border border-border/40 p-1.5 text-text-secondary hover:text-text-primary transition-colors shrink-0"
                                                title="Copy link"
                                                aria-label="Copy share link"
                                            >
                                                {shareCopied ? <Check className="h-3.5 w-3.5 text-azure" /> : <Link2 className="h-3.5 w-3.5" />}
                                            </button>
                                        </div>
                                        <button
                                            onClick={revokeShare}
                                            disabled={shareLoading}
                                            className="mt-2 w-full flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-[11px] text-red hover:bg-red/10 transition-colors"
                                        >
                                            <Unlink className="h-3 w-3" />
                                            Revoke Link
                                        </button>
                                    </div>
                                )}
                            </div>
                        )}

                        <div className="w-px h-5 bg-border/60 mx-1" />
                        <button
                            onClick={() => {
                                setOpen(false)
                                setShowSharePopover(false)
                                setTimeout(onClose, 300)
                            }}
                            className="rounded-lg bg-surface-2 border border-border/60 p-1.5 text-text-secondary hover:text-text-primary hover:bg-surface-3 hover:text-red transition-colors"
                            title="Close"
                            aria-label="Close"
                        >
                            <X className="h-4 w-4" />
                        </button>
                    </div>
                </div>

                {/* Content Area */}
                <div className="flex-1 overflow-hidden relative">
                    {fetchingVersion && (
                        <div className="absolute inset-0 z-10 bg-surface-1/50 backdrop-blur-[2px] flex items-center justify-center">
                            <Loader2 className="h-8 w-8 animate-spin text-azure" />
                        </div>
                    )}
                    {currentAsset ? (
                        <WorkRenderer
                            work={currentAsset}
                            onAction={(action) => {
                                if (action.type === 'apply') {
                                    // Interactive checklist toggles dispatch apply
                                    // with target='checklist-item' — that's not a
                                    // full apply, skip the confirm modal for those.
                                    if (action.target === 'checklist-item') return
                                    setConfirmApply(action)
                                } else if (action.type === 'install') {
                                    doInstall(action)
                                } else if (action.type === 'run') {
                                    doRun(action)
                                } else if (action.type === 'workbench') {
                                    doWorkbench(action)
                                } else if (action.type === 'navigate') {
                                    if (action.internal) {
                                        window.location.href = action.href
                                    } else {
                                        window.open(action.href, '_blank', 'noopener,noreferrer')
                                    }
                                } else if (action.type === 'copy') {
                                    navigator.clipboard.writeText(action.content).then(() => toast.success('Copied'))
                                }
                            }}
                        />
                    ) : null}
                </div>
            </div>

            {confirmApply && (
                <div
                    ref={confirmTrapRef}
                    className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm"
                    onClick={() => setConfirmApply(null)}
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="confirm-apply-title"
                >
                    <div className="max-w-md w-full mx-4 rounded-2xl bg-surface-1 border border-border shadow-2xl p-6" onClick={e => e.stopPropagation()}>
                        <div className="flex items-start gap-3 mb-4">
                            <AlertTriangle className="h-5 w-5 text-azure shrink-0 mt-0.5" />
                            <div>
                                <h3 id="confirm-apply-title" className="text-base font-semibold text-text-primary mb-1">Apply to workspace?</h3>
                                <p className="text-xs text-text-muted">
                                    This will copy the content to your clipboard so you can paste it into the
                                    target. Review the file before you apply it.
                                </p>
                            </div>
                        </div>
                        <div className="flex justify-end gap-2">
                            <button
                                onClick={() => setConfirmApply(null)}
                                className="rounded-md px-3 py-1.5 text-[11px] text-text-muted hover:text-text-primary"
                            >
                                Cancel
                            </button>
                            <button
                                disabled={actionRunning}
                                onClick={() => confirmApply && doApply(confirmApply)}
                                className="rounded-md bg-azure/10 border border-azure/30 px-3 py-1.5 text-[11px] font-medium text-azure hover:bg-azure/20 disabled:opacity-50"
                            >
                                {actionRunning ? 'Applying…' : 'Apply'}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </>
    )
}
