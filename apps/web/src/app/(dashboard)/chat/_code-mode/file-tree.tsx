// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { useState, useMemo } from 'react'
import { FileText, Search, ChevronRight, ChevronDown } from 'lucide-react'
import type { StepFileWriteEvent } from './use-code-stream'

interface FileNode {
    path: string
    name: string
    size: number
    mtime: number
    ext: string
}

interface FileTreeProps {
    files: FileNode[]
    modifiedPaths: Set<string>   // paths written by agent this session
    selectedPath?: string
    onSelect: (path: string) => void
    className?: string
}

function extIcon(ext: string): string {
    const map: Record<string, string> = {
        '.ts': '🟦', '.tsx': '⚛️', '.js': '🟨', '.jsx': '⚛️',
        '.json': '📋', '.md': '📝', '.css': '🎨', '.html': '🌐',
        '.sh': '⚙️', '.yml': '.yaml', '.yaml': '⚙️', '.env': '🔒',
        '.png': '🖼', '.jpg': '🖼', '.svg': '🎨', '.gif': '🖼',
        '.go': '🐹', '.py': '🐍', '.rs': '🦀', '.prisma': '🔷',
    }
    return map[ext] ?? '📄'
}

// Build a directory tree from flat file list
interface DirNode {
    type: 'dir'
    name: string
    path: string
    children: TreeNode[]
}
interface LeafNode {
    type: 'file'
    name: string
    path: string
    ext: string
    size: number
    mtime: number
}
type TreeNode = DirNode | LeafNode

function buildTree(files: FileNode[]): DirNode {
    const root: DirNode = { type: 'dir', name: '', path: '', children: [] }
    for (const f of files) {
        const parts = f.path.split('/')
        let node = root
        for (let i = 0; i < parts.length - 1; i++) {
            const part = parts[i]
            let child = node.children.find((c): c is DirNode => c.type === 'dir' && c.name === part)
            if (!child) {
                child = { type: 'dir', name: part, path: parts.slice(0, i + 1).join('/'), children: [] }
                node.children.push(child)
            }
            node = child
        }
        node.children.push({
            type: 'file',
            name: f.name,
            path: f.path,
            ext: f.ext,
            size: f.size,
            mtime: f.mtime,
        })
    }
    // Sort: dirs first, then files, alphabetically within each
    function sortNode(n: DirNode) {
        n.children.sort((a, b) => {
            if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
            return a.name.localeCompare(b.name)
        })
        for (const c of n.children) if (c.type === 'dir') sortNode(c)
    }
    sortNode(root)
    return root
}

function DirItem({
    node, depth, modifiedPaths, selectedPath, onSelect, expandedPaths, onToggle,
}: {
    node: DirNode
    depth: number
    modifiedPaths: Set<string>
    selectedPath?: string
    onSelect: (path: string) => void
    expandedPaths: Set<string>
    onToggle: (path: string) => void
}) {
    const isExpanded = expandedPaths.has(node.path)
    const hasModified = node.children.some((c) =>
        c.type === 'file'
            ? modifiedPaths.has(c.path)
            : modifiedPaths // approximate: check by path prefix
    )

    return (
        <div>
            <button
                onClick={() => onToggle(node.path)}
                style={{ paddingLeft: `${depth * 12 + 8}px` }}
                className="flex items-center gap-1.5 w-full text-left py-0.5 pr-2 hover:bg-zinc-800/60 rounded text-zinc-400 hover:text-zinc-200 transition-colors group text-xs"
            >
                {isExpanded
                    ? <ChevronDown className="w-3 h-3 flex-shrink-0" />
                    : <ChevronRight className="w-3 h-3 flex-shrink-0" />
                }
                <span className="text-zinc-500">📁</span>
                <span className="flex-1 truncate font-mono">{node.name}</span>
                {hasModified && <span className="w-1.5 h-1.5 rounded-full bg-amber-400 flex-shrink-0" />}
            </button>
            {isExpanded && (
                <div>
                    {node.children.map((child) =>
                        child.type === 'dir'
                            ? <DirItem
                                key={child.path}
                                node={child}
                                depth={depth + 1}
                                modifiedPaths={modifiedPaths}
                                selectedPath={selectedPath}
                                onSelect={onSelect}
                                expandedPaths={expandedPaths}
                                onToggle={onToggle}
                            />
                            : <FileItem
                                key={child.path}
                                node={child}
                                depth={depth + 1}
                                isModified={modifiedPaths.has(child.path)}
                                isSelected={selectedPath === child.path}
                                onSelect={onSelect}
                            />
                    )}
                </div>
            )}
        </div>
    )
}

function FileItem({
    node, depth, isModified, isSelected, onSelect,
}: {
    node: LeafNode
    depth: number
    isModified: boolean
    isSelected: boolean
    onSelect: (path: string) => void
}) {
    return (
        <button
            onClick={() => onSelect(node.path)}
            style={{ paddingLeft: `${depth * 12 + 8}px` }}
            className={`flex items-center gap-1.5 w-full text-left py-0.5 pr-2 rounded transition-colors text-xs font-mono group ${
                isSelected
                    ? 'bg-blue-500/20 text-blue-300'
                    : 'hover:bg-zinc-800/60 text-zinc-400 hover:text-zinc-200'
            }`}
        >
            <span className="w-3 flex-shrink-0" />
            <span>{extIcon(node.ext)}</span>
            <span className="flex-1 truncate">{node.name}</span>
            {isModified && (
                <span className="w-1.5 h-1.5 rounded-full bg-amber-400 flex-shrink-0" title="Modified by agent" />
            )}
        </button>
    )
}

export function FileTree({ files, modifiedPaths, selectedPath, onSelect, className = '' }: FileTreeProps) {
    const [query, setQuery] = useState('')
    const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set(['']))

    const tree = useMemo(() => buildTree(files), [files])

    const filteredFiles = useMemo(() => {
        if (!query) return null
        const q = query.toLowerCase()
        return files.filter((f) => f.path.toLowerCase().includes(q))
    }, [query, files])

    function toggleDir(path: string) {
        setExpandedPaths((prev) => {
            const next = new Set(prev)
            if (next.has(path)) next.delete(path)
            else next.add(path)
            return next
        })
    }

    if (files.length === 0) {
        return (
            <div className={`flex items-center justify-center h-full ${className}`}>
                <div className="text-center text-zinc-500 text-xs space-y-1 px-4">
                    <FileText className="w-8 h-8 mx-auto opacity-30 mb-2" />
                    <p>No files loaded</p>
                    <p className="opacity-60">Start a coding task to see the repo</p>
                </div>
            </div>
        )
    }

    return (
        <div className={`flex flex-col h-full ${className}`}>
            {/* Search */}
            <div className="px-2 py-2 border-b border-zinc-800">
                <div className="flex items-center gap-1.5 bg-zinc-900 rounded px-2 py-1">
                    <Search className="w-3 h-3 text-zinc-500" />
                    <input
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder="Search files…"
                        className="flex-1 bg-transparent text-xs text-zinc-200 placeholder-zinc-600 outline-none font-mono"
                    />
                </div>
            </div>

            {/* Tree or filtered list */}
            <div className="overflow-auto flex-1 py-1">
                {filteredFiles
                    ? filteredFiles.map((f) => (
                        <FileItem
                            key={f.path}
                            node={{ type: 'file', ...f }}
                            depth={0}
                            isModified={modifiedPaths.has(f.path)}
                            isSelected={selectedPath === f.path}
                            onSelect={onSelect}
                        />
                    ))
                    : tree.children.map((child) =>
                        child.type === 'dir'
                            ? <DirItem
                                key={child.path}
                                node={child}
                                depth={0}
                                modifiedPaths={modifiedPaths}
                                selectedPath={selectedPath}
                                onSelect={onSelect}
                                expandedPaths={expandedPaths}
                                onToggle={toggleDir}
                            />
                            : <FileItem
                                key={child.path}
                                node={child as LeafNode}
                                depth={0}
                                isModified={modifiedPaths.has(child.path)}
                                isSelected={selectedPath === child.path}
                                onSelect={onSelect}
                            />
                    )
                }
            </div>

            {/* Footer stats */}
            <div className="px-3 py-1.5 border-t border-zinc-800 text-xs text-zinc-600 font-mono flex gap-2">
                <span>{files.length} files</span>
                {modifiedPaths.size > 0 && (
                    <span className="text-amber-500">{modifiedPaths.size} modified</span>
                )}
            </div>
        </div>
    )
}
