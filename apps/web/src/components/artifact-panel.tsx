import { X, Copy, Check, Download, Monitor, FileText, Code, FileDown, ChevronDown, Loader2, History } from 'lucide-react'
import { toast } from 'sonner'
import { useState, useEffect } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeRaw from 'rehype-raw'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism'
import mermaid from 'mermaid'

export interface TaskAsset {
    artifactId?: string
    filename: string
    bytes: number
    isText: boolean
    content: string | null
    version?: number
    updatedAt?: string | Date
}

interface ArtifactVersion {
    version: number
    changeDescription: string
    createdAt: string
}

function MermaidChart({ chart }: { chart: string }) {
    const [svg, setSvg] = useState<string>('')
    const [id] = useState(`mermaid-${Math.random().toString(36).substr(2, 9)}`)

    useEffect(() => {
        mermaid.initialize({ startOnLoad: false, theme: 'dark' })
        mermaid.render(id, chart).then(({ svg }) => {
            setSvg(svg)
        }).catch((e) => {
            setSvg(`<pre class="text-red-500">${e.message}</pre>`)
        })
    }, [chart, id])

    return (
        <div dangerouslySetInnerHTML={{ __html: svg }} className="mermaid flex justify-center w-full" />
    )
}

function ArtifactRenderer({ asset, viewMode }: { asset: TaskAsset, viewMode: 'preview' | 'code' }) {
    if (!asset.content) return null
    const ext = asset.filename.split('.').pop()?.toLowerCase() || ''

    if (viewMode === 'code') {
        return (
            <SyntaxHighlighter
                language={ext === 'js' ? 'javascript' : ext === 'ts' ? 'typescript' : ext}
                style={vscDarkPlus as any}
                customStyle={{ margin: 0, borderRadius: 0, padding: '1.25rem', fontSize: '13px', minHeight: '100%', backgroundColor: '#0d0d0d' }}
                showLineNumbers
            >
                {asset.content}
            </SyntaxHighlighter>
        )
    }

    if (ext === 'html') {
        return (
            <iframe
                srcDoc={asset.content}
                className="w-full h-full bg-white border-0"
                sandbox="allow-scripts allow-forms allow-popups"
            />
        )
    }

    if (ext === 'svg') {
        const encoded = encodeURIComponent(asset.content)
        return (
            <div className="w-full h-full bg-surface-1 flex items-center justify-center p-8 overflow-auto">
                <img src={`data:image/svg+xml;utf8,${encoded}`} alt={asset.filename} className="max-w-full max-h-full" />
            </div>
        )
    }

    if (ext === 'md' || ext === 'markdown' || ext === 'mdx') {
        return (
            <div className="prose prose-invert prose-sm max-w-none p-6 mx-auto w-full">
                <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    rehypePlugins={[rehypeRaw]}
                    components={{
                        code({ className, children, ...rest }) {
                            const match = /language-(\w+)/.exec(className || '')
                            if (match && match[1] === 'mermaid') {
                                return <MermaidChart chart={String(children).replace(/\n$/, '')} />
                            }
                            return match ? (
                                <SyntaxHighlighter
                                    {...(rest as any)}
                                    PreTag="div"
                                    children={String(children).replace(/\n$/, '')}
                                    language={match[1]}
                                    style={vscDarkPlus as any}
                                    customStyle={{ margin: 0, borderRadius: '8px', fontSize: '12px' }}
                                />
                            ) : (
                                <code {...rest} className={className}>
                                    {children}
                                </code>
                            )
                        }
                    }}
                >
                    {asset.content}
                </ReactMarkdown>
            </div>
        )
    }

    if (ext === 'mermaid' || ext === 'mmd') {
        return (
            <div className="w-full h-full bg-surface-1 flex items-center justify-center p-8 overflow-auto">
                <MermaidChart chart={asset.content} />
            </div>
        )
    }

    // Default source code view
    return (
        <SyntaxHighlighter
            language={ext === 'js' ? 'javascript' : ext === 'ts' ? 'typescript' : ext}
            style={vscDarkPlus as any}
            customStyle={{ margin: 0, borderRadius: 0, padding: '1.25rem', fontSize: '13px', minHeight: '100%', backgroundColor: '#0d0d0d' }}
            showLineNumbers
        >
            {asset.content}
        </SyntaxHighlighter>
    )
}

export function ArtifactPanel({
    asset,
    taskId,
    onClose,
    mode = 'overlay'
}: {
    asset: TaskAsset | null
    taskId?: string | null
    onClose: () => void
    mode?: 'overlay' | 'docked'
}) {
    const [copied, setCopied] = useState(false)
    const [open, setOpen] = useState(false)
    const [viewMode, setViewMode] = useState<'preview' | 'code'>('preview')
    const [exporting, setExporting] = useState<'pdf' | 'docx' | null>(null)
    const [showExportMenu, setShowExportMenu] = useState(false)
    const [versions, setVersions] = useState<ArtifactVersion[]>([])
    const [showVersionMenu, setShowVersionMenu] = useState(false)
    const [fetchingVersion, setFetchingVersion] = useState(false)
    const [currentAsset, setCurrentAsset] = useState<TaskAsset | null>(asset)

    useEffect(() => {
        if (asset) {
            setCurrentAsset(asset)
            setViewMode('preview')
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

    const ext = asset?.filename.split('.').pop()?.toLowerCase() || ''
    const hasPreview = ['md', 'markdown', 'mdx', 'html', 'svg', 'mermaid', 'mmd'].includes(ext)

    return (
        <>
            {/* Backdrop - only in overlay mode */}
            {mode === 'overlay' && (
                <div 
                    className={`absolute inset-0 z-40 bg-background/40 backdrop-blur-sm transition-opacity duration-300 ${open ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
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
                            <span className="text-sm font-semibold text-text-primary font-mono truncate">{currentAsset?.filename}</span>
                            <span className="text-[11px] text-text-muted">{sizeLabel} • {currentAsset?.isText ? 'Text Document' : 'Binary File'}</span>
                        </div>

                        {versions.length > 1 && (
                            <div className="relative">
                                <button 
                                    onClick={() => setShowVersionMenu(!showVersionMenu)}
                                    className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-zinc-800/50 border border-border/40 text-[10px] font-medium text-text-secondary hover:text-text-primary hover:bg-zinc-800 transition-colors"
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
                                                    <span className="text-[9px] opacity-60">{new Date(v.createdAt).toLocaleDateString()}</span>
                                                </div>
                                                <span className="text-[9px] opacity-70 truncate">{v.changeDescription}</span>
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
                                {hasPreview && (
                                    <div className="flex bg-surface-2/60 border border-border/60 rounded-lg p-0.5 mr-2">
                                        <button
                                            onClick={() => setViewMode('preview')}
                                            className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors flex items-center gap-1.5 ${viewMode === 'preview' ? 'bg-zinc-700/80 text-text-primary shadow-sm' : 'text-text-muted hover:text-text-secondary'}`}
                                        >
                                            <Monitor className="h-3 w-3" />
                                            Preview
                                        </button>
                                        <button
                                            onClick={() => setViewMode('code')}
                                            className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors flex items-center gap-1.5 ${viewMode === 'code' ? 'bg-zinc-700/80 text-text-primary shadow-sm' : 'text-text-muted hover:text-text-secondary'}`}
                                        >
                                            <Code className="h-3 w-3" />
                                            Code
                                        </button>
                                    </div>
                                )}

                                <button
                                    onClick={copyContent}
                                    className="rounded-lg bg-surface-2 border border-border/60 p-1.5 text-text-secondary hover:text-text-primary hover:bg-surface-3 transition-colors"
                                    title="Copy content"
                                >
                                    {copied ? <Check className="h-4 w-4 text-azure" /> : <Copy className="h-4 w-4" />}
                                </button>
                                <button
                                    onClick={downloadFile}
                                    className="rounded-lg bg-surface-2 border border-border/60 p-1.5 text-text-secondary hover:text-text-primary hover:bg-surface-3 transition-colors"
                                    title="Download file"
                                >
                                    <Download className="h-4 w-4" />
                                </button>

                                {/* Export Menu */}
                                {ext === 'md' || ext === 'markdown' ? (
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
                        <div className="w-px h-5 bg-border/60 mx-1" />
                        <button
                            onClick={() => {
                                setOpen(false)
                                setTimeout(onClose, 300)
                            }}
                            className="rounded-lg bg-surface-2 border border-border/60 p-1.5 text-text-secondary hover:text-text-primary hover:bg-surface-3 hover:text-red transition-colors"
                            title="Close"
                        >
                            <X className="h-4 w-4" />
                        </button>
                    </div>
                </div>

                {/* Content Area */}
                <div className={`flex-1 overflow-auto relative ${currentAsset?.isText && viewMode === 'code' ? 'bg-[#0d0d0d]' : ''}`}>
                    {fetchingVersion && (
                        <div className="absolute inset-0 z-10 bg-surface-1/50 backdrop-blur-[2px] flex items-center justify-center">
                            <Loader2 className="h-8 w-8 animate-spin text-azure" />
                        </div>
                    )}
                    {currentAsset?.isText && currentAsset.content ? (
                        <ArtifactRenderer asset={currentAsset} viewMode={viewMode} />
                    ) : currentAsset ? (
                        <div className="h-full flex flex-col items-center justify-center text-text-muted gap-3 p-8 text-center bg-[#0d0d0d]">
                            <FileText className="h-10 w-10 text-text-muted/50" />
                            <div>
                                <h3 className="text-text-secondary font-medium mb-1">Binary File</h3>
                                <p className="text-sm">Preview isn&apos;t available for this file type.</p>
                                <p className="text-xs mt-2">Download it from the Tasks page to view.</p>
                            </div>
                        </div>
                    ) : null}
                </div>
            </div>
        </>
    )
}
