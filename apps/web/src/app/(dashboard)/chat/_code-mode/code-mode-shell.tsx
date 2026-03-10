// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import {
    Terminal, GitBranch, TestTube, FileText, Settings2,
    Activity, X, ChevronLeft, ChevronRight, Layers, Split, Code2
} from 'lucide-react'
import { useCodeStream, type StepShellLineEvent, type StepFileWriteEvent, type StepTestResultEvent } from './use-code-stream'
import { TerminalPanel } from './terminal-panel'
import { TestResultsPanel } from './test-results-panel'
import { FileTree } from './file-tree'
import { DiffViewer } from './diff-viewer'
import { RepoPicker, type RepoSelection } from './repo-picker'


// ── Types ─────────────────────────────────────────────────────────────────────

interface FileNode {
    path: string
    name: string
    size: number
    mtime: number
    ext: string
}

export interface CodeModeContext {
    repo?: string
    branch?: string
    taskId?: string
    isNew?: boolean
}

interface CodeModeShellProps {
    workspaceId: string
    taskId?: string
    isTaskRunning: boolean
    context: CodeModeContext
    onRepoSelect: (sel: RepoSelection) => void
    onRerunTest: (testNames: string[]) => void
    onClose: () => void
    /** Pass-through of the main chat panel */
    children: React.ReactNode
}

// ── Bottom tab types ──────────────────────────────────────────────────────────

type BottomTab = 'terminal' | 'tests' | 'diff'

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

// ── Status bar ────────────────────────────────────────────────────────────────

function AgentStatusBar({
    taskId,
    repo,
    branch,
    isRunning,
    shellLines,
    fileWriteCount,
    testResults,
}: {
    taskId?: string
    repo?: string
    branch?: string
    isRunning: boolean
    shellLines: number
    fileWriteCount: number
    testResults: StepTestResultEvent[]
}) {
    const passed = testResults.filter((r) => r.pass).length
    const failed = testResults.filter((r) => !r.pass).length

    return (
        <div className="flex items-center gap-4 px-3 h-8 bg-canvas border-t border-border text-xs font-mono text-text-muted flex-shrink-0">
            {/* Agent pulse */}
            <div className="flex items-center gap-1.5">
                <div className={`w-1.5 h-1.5 rounded-full ${isRunning ? 'bg-azure animate-pulse' : 'bg-surface-3'}`} />
                <span className={isRunning ? 'text-azure' : 'text-text-muted'}>
                    {isRunning ? 'agent active' : 'idle'}
                </span>
            </div>
            <span className="text-zinc-700">|</span>
            {/* Repo */}
            {repo && (
                <>
                    <div className="flex items-center gap-1">
                        <GitBranch className="w-3 h-3" />
                        <span className="text-text-secondary">{repo}</span>
                        {branch && <span className="text-text-muted">• {branch}</span>}
                    </div>
                    <span className="text-zinc-700">|</span>
                </>
            )}
            {/* Counters */}
            <span>{shellLines} lines</span>
            <span>{fileWriteCount} writes</span>
            {testResults.length > 0 && (
                <>
                    <span className="text-zinc-700">|</span>
                    <span className="text-azure">{passed}✓</span>
                    {failed > 0 && <span className="text-red">{failed}✗</span>}
                </>
            )}
            {/* Task ID */}
            {taskId && (
                <>
                    <span className="text-zinc-700 ml-auto">|</span>
                    <span className="text-zinc-700">{taskId.slice(0, 8)}</span>
                </>
            )}
        </div>
    )
}

// ── Main shell ────────────────────────────────────────────────────────────────

export function CodeModeShell({
    workspaceId,
    taskId,
    isTaskRunning,
    context,
    onRepoSelect,
    onRerunTest,
    onClose,
    children,
}: CodeModeShellProps) {
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
            // Refresh file tree when agent writes
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

    // Reload tree periodically while task is running
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

    // Reload selected file when it changes on disk (agent write event)
    useEffect(() => {
        if (!selectedFile) return
        const last = fileWrites[fileWrites.length - 1]
        if (last && last.path === selectedFile) {
            openFile(selectedFile)
        }
    }, [fileWrites.length])

    // ── Layout ────────────────────────────────────────────────────────────────
    const [bottomTab, setBottomTab] = useState<BottomTab>('terminal')
    const [sidebarWidth, setSidebarWidth] = useState(220)
    const [bottomHeight, setBottomHeight] = useState(220)
    const [showSidebar, setShowSidebar] = useState(true)
    const [showBottom, setShowBottom] = useState(true)

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
        <div className="flex flex-col h-full bg-surface-1 text-text-primary overflow-hidden relative">
            {/* ── Toolbar ─────────────────────────────────────────────────── */}
            <div className="flex items-center gap-1 px-2 h-9 bg-surface-1 border-b border-border flex-shrink-0">
                {/* Sidebar toggle — only relevant once a repo is connected */}
                {hasRepo && (
                <button
                    onClick={() => setShowSidebar((v) => !v)}
                    title="Toggle file tree"
                    className="p-1.5 rounded hover:bg-surface-2 text-text-muted hover:text-text-primary transition-colors"
                >
                    <Layers className="w-3.5 h-3.5" />
                </button>
                )}

                {/* Repo badge / connect button */}
                {context.repo ? (
                    <button
                        onClick={() => setRepoModalOpen(true)}
                        className="flex items-center gap-1 px-2 py-0.5 rounded text-xs font-mono bg-surface-2 hover:bg-surface-3 text-text-secondary ml-1 transition-colors"
                        title="Change repository"
                    >
                        <GitBranch className="w-3 h-3" />
                        <span>{context.repo}</span>
                        {context.branch && <span className="text-text-muted">@{context.branch}</span>}
                    </button>
                ) : (
                    <button
                        onClick={() => setRepoModalOpen(true)}
                        className="flex items-center gap-1.5 px-2.5 py-1 ml-1 rounded-md bg-azure/10 hover:bg-azure/20 border border-azure/30 hover:border-azure/50 text-xs font-medium text-azure transition-all"
                    >
                        <GitBranch className="w-3 h-3" />
                        Connect repository
                    </button>
                )}

                <div className="flex-1" />

                {/* Bottom panel toggle buttons */}
                {(['terminal', 'tests', 'diff'] as BottomTab[]).map((tab) => {
                    const icons = {
                        terminal: Terminal,
                        tests: TestTube,
                        diff: FileText,
                    }
                    const Icon = icons[tab]
                    const labels = { terminal: 'Terminal', tests: 'Tests', diff: 'Changes' }
                    const counts = {
                        terminal: shellLines.length || undefined,
                        tests: testResults.length || undefined,
                        diff: fileWrites.length || undefined,
                    }
                    return (
                        <button
                            key={tab}
                            onClick={() => {
                                if (showBottom && bottomTab === tab) {
                                    setShowBottom(false)
                                } else {
                                    setBottomTab(tab)
                                    setShowBottom(true)
                                }
                            }}
                            className={`flex items-center gap-1 px-2 py-1 rounded text-xs transition-colors ${
                                showBottom && bottomTab === tab
                                    ? 'bg-zinc-700 text-text-primary'
                                    : 'text-text-muted hover:text-text-primary hover:bg-surface-2'
                            }`}
                        >
                            <Icon className="w-3 h-3" />
                            <span>{labels[tab]}</span>
                            {counts[tab] !== undefined && (
                                <span className={`px-1 rounded text-xs ${
                                    tab === 'tests' && testResults.filter((r) => !r.pass).length > 0
                                        ? 'bg-red-900/50 text-red'
                                        : 'bg-zinc-700 text-text-secondary'
                                }`}>
                                    {counts[tab]}
                                </span>
                            )}
                        </button>
                    )
                })}

                <div className="w-px h-4 bg-surface-2 mx-1" />

                {/* Close code mode */}
                <button
                    onClick={onClose}
                    title="Exit code mode"
                    className="p-1.5 rounded hover:bg-surface-2 text-text-muted hover:text-red transition-colors"
                >
                    <X className="w-3.5 h-3.5" />
                </button>
            </div>
            {/* ── Repo picker modal ───────────────────────────────────── */}
            {repoModalOpen && (
                <div
                    className="absolute inset-0 z-50 flex items-center justify-center bg-canvas/70 backdrop-blur-sm"
                    onClick={(e) => { if (e.target === e.currentTarget) setRepoModalOpen(false) }}
                    onKeyDown={(e) => { if (e.key === 'Escape') setRepoModalOpen(false) }}
                >
                    <RepoPicker workspaceId={workspaceId} onSelect={handleRepoSelect} onClose={() => setRepoModalOpen(false)} />
                </div>
            )}

            {/* ── Main area ───────────────────────────────────────────────── */}
            <div className="flex flex-1 overflow-hidden">
                {/* File tree sidebar — only shown once a repo is set */}
                {hasRepo && showSidebar && (
                    <div
                        className="flex flex-col border-r border-border bg-canvas flex-shrink-0"
                        style={{ width: sidebarWidth }}
                    >
                        <FileTree
                            files={files}
                            modifiedPaths={modifiedPaths}
                            selectedPath={selectedFile}
                            onSelect={openFile}
                            className="flex-1"
                        />
                    </div>
                )}

                {/* Content area: editor + chat always visible */}
                <div className="flex flex-col flex-1 overflow-hidden">
                    {/* File editor (shown when a file is selected) */}
                    {selectedFile && (
                        <div className="border-b border-border bg-canvas overflow-hidden flex flex-col" style={{ height: 300 }}>
                            {/* Tab bar */}
                            <div className="flex items-center gap-1 px-2 h-8 border-b border-border bg-surface-1 text-xs font-mono">
                                <Code2 className="w-3 h-3 text-text-muted" />
                                <span className="text-text-secondary flex-1 truncate">{selectedFile}</span>
                                {modifiedPaths.has(selectedFile) && (
                                    <span className="w-1.5 h-1.5 rounded-full bg-amber" title="Modified by agent" />
                                )}
                                <button onClick={() => { setSelectedFile(undefined); setFileContent(null) }} className="p-0.5 hover:text-text-primary">
                                    <X className="w-3 h-3" />
                                </button>
                            </div>
                            {/* Content */}
                            <div className="flex-1 overflow-auto bg-canvas p-3">
                                {isLoadingFile
                                    ? <span className="text-xs text-text-muted font-mono animate-pulse">loading…</span>
                                    : fileContent !== null
                                    ? <pre className="text-xs font-mono text-text-secondary whitespace-pre leading-relaxed">{fileContent}</pre>
                                    : <span className="text-xs text-text-muted font-mono">File not available</span>
                                }
                            </div>
                        </div>
                    )}

                    {/* Chat panel */}
                    <div className="flex-1 overflow-hidden flex flex-col">
                        {children}
                    </div>
                </div>
            </div>

            {/* ── Bottom panel ────────────────────────────────────────────── */}
            {showBottom && (
                <div
                    className="border-t border-border bg-canvas flex-shrink-0 flex flex-col overflow-hidden"
                    style={{ height: bottomHeight }}
                >
                    {bottomTab === 'terminal' && (
                        <TerminalPanel lines={shellLines} className="flex-1" />
                    )}
                    {bottomTab === 'tests' && (
                        <TestResultsPanel
                            results={testResults}
                            onRerun={onRerunTest}
                            className="flex-1"
                        />
                    )}
                    {bottomTab === 'diff' && (
                        <DiffViewer events={fileWrites} className="flex-1" />
                    )}
                </div>
            )}

            {/* ── Status bar ──────────────────────────────────────────────── */}
            <AgentStatusBar
                taskId={taskId}
                repo={context.repo}
                branch={context.branch}
                isRunning={isTaskRunning}
                shellLines={shellLines.length}
                fileWriteCount={fileWrites.length}
                testResults={testResults}
            />
        </div>
    )
}
