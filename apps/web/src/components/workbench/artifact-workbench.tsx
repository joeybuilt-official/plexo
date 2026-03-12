// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import {
    Terminal, GitBranch, TestTube, FileText, Settings2,
    Activity, X, ChevronLeft, ChevronRight, Layers, Split, Code2, Monitor, Pin, PinOff
} from 'lucide-react'
import { useCodeStream, type StepShellLineEvent, type StepFileWriteEvent, type StepTestResultEvent } from './use-code-stream'
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
    activeTab?: 'terminal' | 'tests' | 'diff' | 'preview'
    setActiveTab?: (tab: 'terminal' | 'tests' | 'diff' | 'preview') => void
    showBottom?: boolean
    setShowBottom?: (show: boolean) => void
    previewPath?: string
    setPreviewPath?: (path: string) => void
}

type WorkbenchTab = 'terminal' | 'tests' | 'diff' | 'preview'

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
            prevTaskId.current = taskId
        }
    }, [taskId])

    const hasRepo = !!context.repo
    const [repoModalOpen, setRepoModalOpen] = useState(!hasRepo)

    function handleRepoSelect(sel: RepoSelection) {
        setRepoModalOpen(false)
        onRepoSelect(sel)
    }

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
                    {(['terminal', 'tests', 'diff', 'preview'] as WorkbenchTab[]).map((tab) => {
                        const icons = { terminal: Terminal, tests: TestTube, diff: FileText, preview: Monitor }
                        const Icon = icons[tab]
                        const active = activeTab === tab
                        return (
                            <button
                                key={tab}
                                onClick={() => { setActiveTab(tab); setShowBottom(true) }}
                                className={`p-1.5 rounded-md transition-all ${
                                    active ? 'bg-zinc-700 text-text-primary shadow-sm' : 'text-text-muted hover:text-text-secondary'
                                }`}
                                title={tab}
                            >
                                <Icon className="w-3.5 h-3.5" />
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
                    </div>
                </div>
            </div>
            
            {/* ── Footer ─────────────────────────────────────────────────── */}
            <div className="flex items-center h-8 px-4 bg-zinc-950/40 border-t border-border/20 text-[10px] font-mono text-text-muted">
                <Activity className="w-3 h-3 mr-2" />
                <span>{shellLines.length} events • {fileWrites.length} writes</span>
                {taskId && <span className="ml-auto opacity-50">{taskId.slice(0, 8)}</span>}
            </div>
        </div>
    )
}
