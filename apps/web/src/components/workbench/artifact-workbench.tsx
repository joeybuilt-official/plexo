// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import {
    Terminal, GitBranch, TestTube, FileText, Settings2,
    Activity, X, ChevronLeft, ChevronRight, Layers, Split, Code2, Monitor, Pin, PinOff,
    Globe, RefreshCcw, ExternalLink, Image as ImageIcon,
} from 'lucide-react'
import { useCodeStream, type StepShellLineEvent, type StepFileWriteEvent, type StepTestResultEvent, type StepScreenshotEvent } from './use-code-stream'
import { TerminalPanel } from './terminal-panel'
import { TestResultsPanel } from './test-results-panel'
import { FileTree } from './file-tree'
import { DiffViewer } from './diff-viewer'
import { RepoPicker, type RepoSelection } from './repo-picker'
import { PreviewPanel } from './preview-panel'

// ── Types ─────────────────────────────────────────────────────────────────────

interface FileNode {
    path: string
    name: string
    size: number
    mtime: number
    ext: string
}

export interface WorkbenchContext {
    repo?: string
    branch?: string
    taskId?: string
    isNew?: boolean
}

interface ArtifactWorkbenchProps {
    workspaceId: string
    taskId?: string
    isTaskRunning: boolean
    context: WorkbenchContext
    onRepoSelect: (sel: RepoSelection) => void
    onRerunTest: (testNames: string[]) => void
    onClose: () => void
    isPinned: boolean
    onTogglePin: () => void

    // Optional tab state overrides
    activeTab?: 'terminal' | 'tests' | 'diff' | 'preview' | 'browser'
    setActiveTab?: (tab: 'terminal' | 'tests' | 'diff' | 'preview' | 'browser') => void
    showBottom?: boolean
    setShowBottom?: (show: boolean) => void
    previewPath?: string
    setPreviewPath?: (path: string) => void
}

type WorkbenchTab = 'terminal' | 'tests' | 'diff' | 'preview' | 'browser'

// ── Fetch helpers ─────────────────────────────────────────────────────────────

async function fetchFileTree(workspaceId: string, taskId: string): Promise<FileNode[]> {
    const res = await fetch(`/api/v1/code/tree?workspaceId=${workspaceId}&taskId=${taskId}`)
    if (!res.ok) return []
    const data = await res.json() as { files?: FileNode[] }
    return data.files ?? []
}

async function fetchFileContent(workspaceId: string, taskId: string, path: string): Promise<string | null> {
    const res = await fetch(
        `/api/v1/code/file?workspaceId=${workspaceId}&taskId=${taskId}&path=${encodeURIComponent(path)}`
    )
    if (!res.ok) return null
    const data = await res.json() as { content?: string }
    return data.content ?? null
}

// ── Browser screenshot feed ───────────────────────────────────────────────────

function BrowserPanel({ screenshots, isRunning }: { screenshots: StepScreenshotEvent[]; isRunning: boolean }) {
    const lastScreenshot = screenshots[screenshots.length - 1]
    const [selected, setSelected] = useState<number | null>(null)
    const displayIdx = selected ?? (screenshots.length - 1)
    const display = screenshots[displayIdx] ?? null

    // Auto-scroll to bottom when new screenshot arrives
    const listRef = useRef<HTMLDivElement>(null)
    useEffect(() => {
        if (selected === null && listRef.current) {
            listRef.current.scrollTop = listRef.current.scrollHeight
        }
    }, [screenshots.length, selected])

    if (screenshots.length === 0) {
        return (
            <div className="flex flex-col items-center justify-center h-full text-text-muted gap-3">
                <Globe className="h-10 w-10 opacity-15" />
                <div className="text-center">
                    <p className="text-sm font-medium text-text-secondary mb-1">Browser Preview</p>
                    <p className="text-xs text-text-muted leading-relaxed max-w-[220px]">
                        {isRunning
                            ? 'Waiting for the agent to open a browser…'
                            : 'The agent will show live browser screenshots here when using web automation.'}
                    </p>
                </div>
            </div>
        )
    }

    return (
        <div className="flex flex-col h-full overflow-hidden">
            {/* Main screenshot viewer */}
            <div className="flex-1 relative overflow-hidden bg-zinc-950/60 flex items-center justify-center min-h-0">
                {display && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                        src={display.dataUrl}
                        alt={display.label}
                        className="max-w-full max-h-full object-contain"
                        style={{ imageRendering: 'crisp-edges' }}
                    />
                )}
                {/* Label overlay */}
                {display && (
                    <div className="absolute bottom-2 left-2 right-2 flex items-center justify-between">
                        <span className="text-[10px] font-mono bg-zinc-900/80 text-text-muted px-2 py-0.5 rounded backdrop-blur-sm truncate max-w-[70%]">
                            {display.label}
                        </span>
                        <span className="text-[9px] text-text-muted bg-zinc-900/80 px-1.5 py-0.5 rounded backdrop-blur-sm">
                            {displayIdx + 1}/{screenshots.length}
                        </span>
                    </div>
                )}
                {/* Live indicator */}
                {isRunning && selected === null && (
                    <div className="absolute top-2 right-2 flex items-center gap-1.5 bg-zinc-900/80 px-2 py-1 rounded-full backdrop-blur-sm">
                        <span className="h-1.5 w-1.5 rounded-full bg-azure animate-pulse" />
                        <span className="text-[9px] font-medium text-azure uppercase tracking-wider">Live</span>
                    </div>
                )}
            </div>

            {/* Filmstrip */}
            {screenshots.length > 1 && (
                <div
                    ref={listRef}
                    className="flex gap-1.5 p-2 bg-zinc-900/40 border-t border-border/30 overflow-x-auto scrollbar-none flex-shrink-0"
                    style={{ maxHeight: '72px' }}
                >
                    {screenshots.map((s, i) => (
                        <button
                            key={s.ts}
                            onClick={() => setSelected(i === screenshots.length - 1 ? null : i)}
                            className={`shrink-0 relative rounded overflow-hidden transition-all ${
                                displayIdx === i
                                    ? 'ring-2 ring-azure'
                                    : 'opacity-50 hover:opacity-80'
                            }`}
                            style={{ width: 80, height: 52 }}
                        >
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={s.dataUrl} alt={s.label} className="w-full h-full object-cover" />
                        </button>
                    ))}
                </div>
            )}
        </div>
    )
}

// ── Main component ────────────────────────────────────────────────────────────

export function ArtifactWorkbench({
    workspaceId,
    taskId,
    isTaskRunning,
    context,
    onRepoSelect,
    onRerunTest,
    onClose,
    isPinned,
    onTogglePin,
    activeTab: externalTab,
    setActiveTab: setExternalTab,
    showBottom: externalShowBottom,
    setShowBottom: setExternalShowBottom,
    previewPath: externalPreviewPath,
    setPreviewPath: setExternalPreviewPath,
}: ArtifactWorkbenchProps) {
    // ── Stream state ──────────────────────────────────────────────────────────
    const [shellLines, setShellLines] = useState<StepShellLineEvent[]>([])
    const [fileWrites, setFileWrites] = useState<StepFileWriteEvent[]>([])
    const [testResults, setTestResults] = useState<StepTestResultEvent[]>([])
    const [screenshots, setScreenshots] = useState<StepScreenshotEvent[]>([])

    const modifiedPaths = useMemo(
        () => new Set(fileWrites.map((e) => e.path)),
        [fileWrites]
    )

    useCodeStream({
        workspaceId,
        taskId,
        onShellLine: useCallback((e: StepShellLineEvent) => setShellLines((p) => [...p, e]), []),
        onFileWrite: useCallback((e: StepFileWriteEvent) => {
            setFileWrites((p) => [...p, e])
            if (taskId) loadTree()
        }, [taskId]),
        onTestResult: useCallback((e: StepTestResultEvent) => setTestResults((p) => [...p, e]), []),
        onScreenshot: useCallback((e: StepScreenshotEvent) => {
            setScreenshots((p) => [...p, e])
            // Auto-switch to browser tab when screenshots start coming in
            setActiveTab('browser')
        }, []),
    })

    // ── File tree ─────────────────────────────────────────────────────────────
    const [files, setFiles] = useState<FileNode[]>([])
    const [selectedFile, setSelectedFile] = useState<string | undefined>()
    const [fileContent, setFileContent] = useState<string | null>(null)
    const [isLoadingFile, setIsLoadingFile] = useState(false)

    const loadTree = useCallback(async () => {
        if (!taskId) return
        const f = await fetchFileTree(workspaceId, taskId)
        setFiles(f)
    }, [workspaceId, taskId])

    useEffect(() => { loadTree() }, [loadTree])

    useEffect(() => {
        if (!isTaskRunning || !taskId) return
        const timer = setInterval(loadTree, 10_000)
        return () => clearInterval(timer)
    }, [isTaskRunning, taskId, loadTree])

    async function openFile(path: string) {
        if (!taskId) return
        setSelectedFile(path)
        setIsLoadingFile(true)
        const content = await fetchFileContent(workspaceId, taskId, path)
        setFileContent(content)
        setIsLoadingFile(false)
    }

    useEffect(() => {
        if (!selectedFile) return
        const last = fileWrites[fileWrites.length - 1]
        if (last && last.path === selectedFile) {
            openFile(selectedFile)
        }
    }, [fileWrites.length])

    // ── Layout ────────────────────────────────────────────────────────────────
    const [localTab, setLocalTab] = useState<WorkbenchTab>('terminal')
    const [showSidebar, setShowSidebar] = useState(true)
    const [localShowBottom, setLocalShowBottom] = useState(true)
    const [localPreviewPath, setLocalPreviewPath] = useState('index.html')

    const activeTab = externalTab ?? localTab
    const setActiveTab = setExternalTab ?? setLocalTab
    const showBottom = externalShowBottom ?? localShowBottom
    const setShowBottom = setExternalShowBottom ?? setLocalShowBottom
    const previewPath = externalPreviewPath ?? localPreviewPath
    const setPreviewPath = setExternalPreviewPath ?? setLocalPreviewPath

    // ── Clear state when task changes ─────────────────────────────────────────
    const prevTaskId = useRef(taskId)
    useEffect(() => {
        if (taskId !== prevTaskId.current) {
            setShellLines([])
            setFileWrites([])
            setTestResults([])
            setFiles([])
            setSelectedFile(undefined)
            setFileContent(null)
            setScreenshots([])
            prevTaskId.current = taskId
        }
    }, [taskId])

    const hasRepo = !!context.repo
    const [repoModalOpen, setRepoModalOpen] = useState(!hasRepo)

    function handleRepoSelect(sel: RepoSelection) {
        setRepoModalOpen(false)
        onRepoSelect(sel)
    }

    // Tab config
    const tabs: { id: WorkbenchTab; Icon: React.ElementType; label: string }[] = [
        { id: 'terminal', Icon: Terminal, label: 'Terminal' },
        { id: 'tests', Icon: TestTube, label: 'Tests' },
        { id: 'diff', Icon: FileText, label: 'Diff' },
        { id: 'preview', Icon: Monitor, label: 'Preview' },
        { id: 'browser', Icon: Globe, label: 'Browser' },
    ]

    return (
        <div
            className={`flex flex-col h-full overflow-hidden transition-all duration-500 ease-in-out ${
                isPinned
                    ? 'border-l border-border/40 bg-zinc-900/60 backdrop-blur-md'
                    : 'absolute right-0 top-0 bottom-0 w-[600px] max-w-[calc(100vw-340px)] z-30 rounded-none border-l border-border/40 bg-zinc-900/90 backdrop-blur-xl shadow-2xl'
            }`}
        >
            {/* ── Toolbar ─────────────────────────────────────────────────── */}
            <div className="flex items-center gap-1 px-3 h-12 bg-surface-1/40 border-b border-border/40 flex-shrink-0">
                <div className="flex items-center gap-3 mr-4">
                    <div className={`w-2 h-2 rounded-full ${isTaskRunning ? 'bg-azure animate-pulse' : 'bg-zinc-700'}`} />
                    <span className="text-xs font-semibold uppercase tracking-wider text-text-muted">Workbench</span>
                </div>

                {hasRepo && (
                    <button
                        onClick={() => setShowSidebar((v) => !v)}
                        className="p-1.5 rounded-lg hover:bg-surface-2 text-text-muted hover:text-text-primary transition-colors"
                    >
                        <Layers className="w-3.5 h-3.5" />
                    </button>
                )}

                {context.repo ? (
                    <button
                        onClick={() => setRepoModalOpen(true)}
                        className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-mono bg-zinc-800 hover:bg-zinc-700 text-text-secondary transition-colors"
                    >
                        <GitBranch className="w-3.5 h-3.5 text-azure" />
                        <span>{context.repo}</span>
                    </button>
                ) : (
                    <button
                        onClick={() => setRepoModalOpen(true)}
                        className="flex items-center gap-1.5 px-3 py-1 rounded-lg bg-azure/10 hover:bg-azure/20 border border-azure/30 text-xs font-medium text-azure transition-all"
                    >
                        Connect Repository
                    </button>
                )}

                <div className="flex-1" />

                {/* Tab controls */}
                <div className="flex items-center bg-zinc-800/50 p-1 rounded-lg mr-2">
                    {tabs.map(({ id, Icon }) => {
                        const active = activeTab === id
                        // Show badge on browser tab if there are screenshots
                        const hasBadge = id === 'browser' && screenshots.length > 0
                        return (
                            <button
                                key={id}
                                onClick={() => { setActiveTab(id); setShowBottom(true) }}
                                className={`relative p-1.5 rounded-md transition-all ${
                                    active ? 'bg-zinc-700 text-text-primary shadow-sm' : 'text-text-muted hover:text-text-secondary'
                                }`}
                                title={id}
                            >
                                <Icon className="w-3.5 h-3.5" />
                                {hasBadge && (
                                    <span className="absolute top-0.5 right-0.5 h-1.5 w-1.5 rounded-full bg-azure" />
                                )}
                            </button>
                        )
                    })}
                </div>

                <div className="w-px h-6 bg-border/40 mx-1" />

                {/* Pin toggle */}
                <button
                    onClick={onTogglePin}
                    className="p-2 rounded-lg hover:bg-surface-2 text-text-muted hover:text-text-primary transition-colors"
                    title={isPinned ? 'Unpin' : 'Pin side-by-side'}
                >
                    {isPinned ? <PinOff className="w-3.5 h-3.5" /> : <Pin className="w-3.5 h-3.5" />}
                </button>

                {/* Close */}
                <button
                    onClick={onClose}
                    className="p-2 rounded-lg hover:bg-surface-2 text-text-muted hover:text-red transition-colors"
                >
                    <X className="w-4 h-4" />
                </button>
            </div>

            {/* ── Repo picker modal ───────────────────────────────────── */}
            {repoModalOpen && (
                <div className="absolute inset-0 z-50 flex items-center justify-center bg-zinc-950/40 backdrop-blur-md">
                    <RepoPicker workspaceId={workspaceId} onSelect={handleRepoSelect} onClose={() => setRepoModalOpen(false)} />
                </div>
            )}

            {/* ── Main content ────────────────────────────────────────────── */}
            <div className="flex flex-1 overflow-hidden">
                {hasRepo && showSidebar && (
                    <div className="w-[220px] border-r border-border/40 bg-zinc-950/20 backdrop-blur-sm">
                        <FileTree
                            files={files}
                            modifiedPaths={modifiedPaths}
                            selectedPath={selectedFile}
                            onSelect={openFile}
                            className="flex-1"
                        />
                    </div>
                )}

                <div className="flex flex-col flex-1 overflow-hidden">
                    {/* File view */}
                    {selectedFile && (
                        <div className="flex flex-col h-1/2 border-b border-border/40">
                             <div className="flex items-center gap-2 px-3 h-10 bg-zinc-900/40 border-b border-border/20 text-xs font-mono">
                                <Code2 className="w-3.5 h-3.5 text-azure" />
                                <span className="text-text-secondary flex-1 truncate">{selectedFile}</span>
                                <button onClick={() => { setSelectedFile(undefined); setFileContent(null) }} className="hover:text-red">
                                    <X className="w-3.5 h-3.5" />
                                </button>
                            </div>
                            <div className="flex-1 overflow-auto p-4 bg-zinc-950/40">
                                {isLoadingFile
                                    ? <div className="animate-pulse flex space-y-2 flex-col"><div className="h-2 bg-zinc-800 rounded w-3/4"></div><div className="h-2 bg-zinc-800 rounded w-1/2"></div></div>
                                    : fileContent !== null
                                    ? <pre className="text-xs font-mono text-text-secondary leading-relaxed">{fileContent}</pre>
                                    : <div className="text-xs text-text-muted">Empty file</div>
                                }
                            </div>
                        </div>
                    )}

                    {/* Active tab content */}
                    <div className="flex-1 overflow-hidden flex flex-col">
                        {activeTab === 'terminal' && <TerminalPanel lines={shellLines} className="flex-1" />}
                        {activeTab === 'tests' && <TestResultsPanel results={testResults} onRerun={onRerunTest} className="flex-1" />}
                        {activeTab === 'diff' && <DiffViewer events={fileWrites} className="flex-1" />}
                        {activeTab === 'preview' && <PreviewPanel workspaceId={workspaceId} taskId={taskId} path={previewPath} className="flex-1" />}
                        {activeTab === 'browser' && <BrowserPanel screenshots={screenshots} isRunning={isTaskRunning} />}
                    </div>
                </div>
            </div>

            {/* ── Footer ─────────────────────────────────────────────────── */}
            <div className="flex items-center h-8 px-4 bg-zinc-950/40 border-t border-border/20 text-[10px] font-mono text-text-muted">
                <Activity className="w-3 h-3 mr-2" />
                <span>{shellLines.length} events • {fileWrites.length} writes</span>
                {screenshots.length > 0 && (
                    <span className="ml-2 text-azure/60">• {screenshots.length} browser frames</span>
                )}
                {taskId && <span className="ml-auto opacity-50">{taskId.slice(0, 8)}</span>}
            </div>
        </div>
    )
}
