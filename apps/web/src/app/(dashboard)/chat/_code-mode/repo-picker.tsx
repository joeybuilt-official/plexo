// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { useState } from 'react'
import { GitBranch, Plus, Link2 } from 'lucide-react'

export interface RepoSelection {
    repo: string       // owner/repo
    branch: string
    isNew: boolean     // true if creating new repo
}

interface RepoPickerProps {
    onSelect: (selection: RepoSelection) => void
    className?: string
}

/**
 * Shown when Code Mode activates with no active sprint.
 * Lets the user specify a GitHub repo + branch to work with.
 * The selected repo/branch is injected into the next chat dispatch as context.
 */
export function RepoPicker({ onSelect, className = '' }: RepoPickerProps) {
    const [mode, setMode] = useState<'choose' | 'existing' | 'new'>('choose')
    const [repo, setRepo] = useState('')
    const [branch, setBranch] = useState('main')
    const [newRepo, setNewRepo] = useState('')
    const [newBranch, setNewBranch] = useState('main')

    function submitExisting() {
        if (!repo.trim()) return
        onSelect({ repo: repo.trim(), branch: branch.trim() || 'main', isNew: false })
    }

    function submitNew() {
        if (!newRepo.trim()) return
        onSelect({ repo: newRepo.trim(), branch: newBranch.trim() || 'main', isNew: true })
    }

    if (mode === 'choose') {
        return (
            <div className={`flex items-center justify-center h-full ${className}`}>
                <div className="max-w-sm w-full mx-4 space-y-3">
                    <div className="text-center mb-6">
                        <div className="w-12 h-12 rounded-2xl bg-zinc-800 flex items-center justify-center mx-auto mb-3">
                            <GitBranch className="w-6 h-6 text-zinc-400" />
                        </div>
                        <h3 className="text-sm font-semibold text-zinc-200">Connect a repository</h3>
                        <p className="text-xs text-zinc-500 mt-1">
                            The agent will clone this repo and work inside it
                        </p>
                    </div>

                    <button
                        onClick={() => setMode('existing')}
                        className="w-full flex items-center gap-3 px-4 py-3 rounded-xl bg-zinc-800 hover:bg-zinc-700/80 border border-zinc-700 hover:border-zinc-600 transition-all text-left group"
                    >
                        <Link2 className="w-4 h-4 text-zinc-400 group-hover:text-blue-400 transition-colors" />
                        <div>
                            <div className="text-sm text-zinc-200 font-medium">Use existing repo</div>
                            <div className="text-xs text-zinc-500">Connect to a GitHub repository</div>
                        </div>
                    </button>

                    <button
                        onClick={() => setMode('new')}
                        className="w-full flex items-center gap-3 px-4 py-3 rounded-xl bg-zinc-800 hover:bg-zinc-700/80 border border-zinc-700 hover:border-zinc-600 transition-all text-left group"
                    >
                        <Plus className="w-4 h-4 text-zinc-400 group-hover:text-emerald-400 transition-colors" />
                        <div>
                            <div className="text-sm text-zinc-200 font-medium">Create new repo</div>
                            <div className="text-xs text-zinc-500">Agent will initialise a fresh repository</div>
                        </div>
                    </button>
                </div>
            </div>
        )
    }

    if (mode === 'existing') {
        return (
            <div className={`flex items-center justify-center h-full ${className}`}>
                <div className="max-w-sm w-full mx-4 space-y-3">
                    <button onClick={() => setMode('choose')} className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors mb-2">
                        ← back
                    </button>
                    <h3 className="text-sm font-semibold text-zinc-200">Existing repository</h3>
                    <div className="space-y-2">
                        <input
                            value={repo}
                            onChange={(e) => setRepo(e.target.value)}
                            placeholder="owner/repo (e.g. joeybuilt-official/plexo)"
                            className="w-full bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 outline-none focus:border-blue-500 transition-colors font-mono"
                        />
                        <div className="flex items-center gap-2">
                            <GitBranch className="w-4 h-4 text-zinc-500 flex-shrink-0" />
                            <input
                                value={branch}
                                onChange={(e) => setBranch(e.target.value)}
                                placeholder="branch (default: main)"
                                className="flex-1 bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 outline-none focus:border-blue-500 transition-colors font-mono"
                            />
                        </div>
                    </div>
                    <button
                        onClick={submitExisting}
                        disabled={!repo.trim()}
                        className="w-full py-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-sm font-medium text-white transition-colors"
                    >
                        Connect repository
                    </button>
                </div>
            </div>
        )
    }

    // mode === 'new'
    return (
        <div className={`flex items-center justify-center h-full ${className}`}>
            <div className="max-w-sm w-full mx-4 space-y-3">
                <button onClick={() => setMode('choose')} className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors mb-2">
                    ← back
                </button>
                <h3 className="text-sm font-semibold text-zinc-200">New repository</h3>
                <div className="space-y-2">
                    <input
                        value={newRepo}
                        onChange={(e) => setNewRepo(e.target.value)}
                        placeholder="Name (e.g. my-project)"
                        className="w-full bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 outline-none focus:border-emerald-500 transition-colors font-mono"
                    />
                    <div className="flex items-center gap-2">
                        <GitBranch className="w-4 h-4 text-zinc-500 flex-shrink-0" />
                        <input
                            value={newBranch}
                            onChange={(e) => setNewBranch(e.target.value)}
                            placeholder="default branch (main)"
                            className="flex-1 bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 outline-none focus:border-emerald-500 transition-colors font-mono"
                        />
                    </div>
                </div>
                <button
                    onClick={submitNew}
                    disabled={!newRepo.trim()}
                    className="w-full py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed text-sm font-medium text-white transition-colors"
                >
                    Create &amp; connect
                </button>
            </div>
        </div>
    )
}
