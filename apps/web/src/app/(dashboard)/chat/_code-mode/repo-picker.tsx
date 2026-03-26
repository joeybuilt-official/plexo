// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { useState, useEffect } from 'react'
import {
    GitBranch,
    Link2,
    Plus,
    Github,
    ArrowRight,
    FolderGit2,
    Folder,
    ExternalLink,
    Loader2,
    AlertCircle,
    X,
    Search,
    Check,
    ChevronDown,
} from 'lucide-react'
import Link from 'next/link'
import { cn } from '@plexo/ui'

export interface RepoSelection {
    repo: string       // owner/repo OR absolute local path
    branch: string
    isNew: boolean
    isLocal?: boolean  // true when a local directory is selected
}

interface RepoPickerProps {
    workspaceId: string
    onSelect: (selection: RepoSelection) => void
    onClose?: () => void
    className?: string
}

const API_BASE = typeof window !== 'undefined' ? '' : (process.env.INTERNAL_API_URL ?? 'http://localhost:3001')
const LOCAL_MODE = process.env.NEXT_PUBLIC_LOCAL_MODE === 'true'

// ── Connection status check ──────────────────────────────────────────────────

type CheckState = 'loading' | 'connected' | 'missing'

async function checkGitHubConnection(workspaceId: string): Promise<CheckState> {
    if (!workspaceId) return 'missing'
    try {
        const res = await fetch(`${API_BASE}/api/v1/connections/installed?workspaceId=${workspaceId}`)
        if (!res.ok) return 'missing'
        const data = await res.json() as { items: Array<{ registryId: string; status: string }> }
        const github = data.items.find((i) => i.registryId === 'github')
        return github?.status === 'active' ? 'connected' : 'missing'
    } catch {
        return 'missing'
    }
}

// ── Not-connected wall ────────────────────────────────────────────────────────

function GitHubNotConnected({ onClose }: { onClose?: () => void }) {
    return (
        <div className="flex items-center justify-center h-full w-full" onClick={onClose}>
            <div className="max-w-md w-full mx-4 animate-in fade-in slide-in-from-bottom-4 duration-500" onClick={(e) => e.stopPropagation()}>
                <div className="bg-surface-2/60 backdrop-blur-xl border border-border/60 rounded-2xl p-6 shadow-2xl relative overflow-hidden">
                    {/* Top glow */}
                    <div className="absolute -top-10 left-1/2 -translate-x-1/2 w-48 h-24 bg-amber/10 blur-[50px] pointer-events-none rounded-full" />

                    {/* Close button */}
                    {onClose && (
                        <button
                            onClick={onClose}
                            aria-label="Close"
                            className="absolute top-4 right-4 z-10 p-1.5 rounded-lg text-text-muted hover:text-text-primary hover:bg-surface-3 transition-colors"
                        >
                            <X className="w-4 h-4" />
                        </button>
                    )}

                    <div className="text-center mb-6 relative">
                        <div className="w-12 h-12 rounded-xl bg-surface-3 border border-amber/30 flex items-center justify-center mx-auto mb-4 shadow-sm">
                            <AlertCircle className="w-6 h-6 text-amber" />
                        </div>
                        <h3 className="text-xl font-bold text-text-primary tracking-tight">GitHub not connected</h3>
                        <p className="text-sm text-text-muted mt-1.5 leading-relaxed">
                            Code mode requires a GitHub connection so the agent can clone, read, and push to repositories.
                        </p>
                    </div>

                    <div className="rounded-xl border border-border bg-surface-1/60 p-4 mb-5 text-xs text-text-secondary leading-relaxed">
                        <p className="font-semibold text-text-primary mb-1">What you need</p>
                        <ul className="space-y-1 list-disc list-inside text-text-muted">
                            <li>A GitHub Personal Access Token with <code className="text-azure">repo</code> scope</li>
                            <li>Or connect via OAuth from the Connections page</li>
                        </ul>
                    </div>

                    <Link
                        href="/settings/connections?highlight=github"
                        className="w-full flex items-center justify-center gap-2 py-3 px-4 rounded-xl text-sm font-semibold bg-azure hover:bg-azure/90 text-white transition-all group"
                    >
                        <Github className="w-4 h-4" />
                        Connect GitHub
                        <ExternalLink className="w-3.5 h-3.5 ml-1 opacity-60 group-hover:opacity-100 transition-opacity" />
                    </Link>

                    {LOCAL_MODE && (
                        <p className="text-center text-xs text-text-muted mt-4">
                            or use a{' '}
                            <button
                                className="text-azure hover:underline"
                                onClick={() => {
                                    // Scroll past this wall — parent will detect LOCAL_MODE and show local tab
                                    // We signal this by dispatching a custom event that the parent picker listens to
                                    window.dispatchEvent(new CustomEvent('plexo:force-local-mode'))
                                }}
                            >
                                local directory
                            </button>
                            {' '}instead
                        </p>
                    )}
                </div>
            </div>
        </div>
    )
}

// ── Main picker ───────────────────────────────────────────────────────────────

type Tab = 'existing' | 'new' | 'local'

export function RepoPicker({ workspaceId, onSelect, onClose, className = '' }: RepoPickerProps) {
    const [checkState, setCheckState] = useState<CheckState>('loading')
    const [forceLocal, setForceLocal] = useState(false)

    const [tab, setTab] = useState<Tab>('existing')
    const [repo, setRepo] = useState('')
    const [branch, setBranch] = useState('main')
    const [newRepo, setNewRepo] = useState('')
    const [newBranch, setNewBranch] = useState('main')
    const [localPath, setLocalPath] = useState('')

    // GitHub repos
    const [repos, setRepos] = useState<any[]>([])
    const [loadingRepos, setLoadingRepos] = useState(false)
    const [repoSearch, setRepoSearch] = useState('')
    const [isDropdownOpen, setIsDropdownOpen] = useState(false)

    // GitHub branches
    const [branches, setBranches] = useState<any[]>([])
    const [loadingBranches, setLoadingBranches] = useState(false)
    const [branchSearch, setBranchSearch] = useState('')
    const [isBranchDropdownOpen, setIsBranchDropdownOpen] = useState(false)
    const [isCreatingNewBranch, setIsCreatingNewBranch] = useState(false)

    // Check GitHub connection on mount
    useEffect(() => {
        checkGitHubConnection(workspaceId).then((state) => {
            setCheckState(state)
            if (state === 'connected') {
                fetchRepos()
            }
        })
    }, [workspaceId])

    async function fetchRepos() {
        setLoadingRepos(true)
        try {
            const res = await fetch(`${API_BASE}/api/v1/connections/github/repos?workspaceId=${workspaceId}`)
            if (res.ok) {
                const data = await res.json()
                setRepos(data.items || [])
            }
        } catch (err) {
            console.error('Failed to fetch repos:', err)
        } finally {
            setLoadingRepos(false)
        }
    }

    async function fetchBranches(repoName: string) {
        if (!repoName) return
        setLoadingBranches(true)
        try {
            const res = await fetch(`${API_BASE}/api/v1/connections/github/branches?workspaceId=${workspaceId}&repo=${repoName}`)
            if (res.ok) {
                const data = await res.json()
                setBranches(data.items || [])
            }
        } catch (err) {
            console.error('Failed to fetch branches:', err)
        } finally {
            setLoadingBranches(false)
        }
    }

    // Local-mode bypass from the not-connected wall
    useEffect(() => {
        const handler = () => setForceLocal(true)
        window.addEventListener('plexo:force-local-mode', handler)
        return () => window.removeEventListener('plexo:force-local-mode', handler)
    }, [])

    function submit() {
        if (tab === 'existing') {
            if (!repo.trim()) return
            onSelect({ repo: repo.trim(), branch: branch.trim() || 'main', isNew: isCreatingNewBranch })
        } else if (tab === 'new') {
            if (!newRepo.trim()) return
            onSelect({ repo: newRepo.trim(), branch: newBranch.trim() || 'main', isNew: true })
        } else {
            if (!localPath.trim()) return
            onSelect({ repo: localPath.trim(), branch: '', isNew: false, isLocal: true })
        }
    }

    const isValid =
        tab === 'existing' ? !!repo.trim() :
        tab === 'new'      ? !!newRepo.trim() :
                             !!localPath.trim()

    // ── Loading ──────────────────────────────────────────────────────────────
    if (checkState === 'loading') {
        return (
            <div className={`flex items-center justify-center h-full w-full ${className}`}>
                <Loader2 className="w-5 h-5 text-text-muted animate-spin" />
            </div>
        )
    }

    // ── GitHub not connected (and not bypassing to local) ────────────────────
    if (checkState === 'missing' && !forceLocal) {
        return <GitHubNotConnected onClose={onClose} />
    }

    // ── Full picker ───────────────────────────────────────────────────────────
    const showLocalTab = LOCAL_MODE || forceLocal

    // Tabs to show
    const tabs: Tab[] = showLocalTab ? ['existing', 'new', 'local'] : ['existing', 'new']

    return (
        <div className={`flex items-center justify-center h-full w-full ${className}`} onClick={onClose}>
            <div className="max-w-md w-full mx-4 animate-in fade-in slide-in-from-bottom-4 duration-500" onClick={(e) => e.stopPropagation()}>
                <div className="bg-surface-2/60 backdrop-blur-xl border border-border/60 rounded-2xl p-6 shadow-2xl relative overflow-hidden group">
                    {/* Top glow */}
                    <div className="absolute -top-10 left-1/2 -translate-x-1/2 w-48 h-24 bg-azure/20 blur-[50px] pointer-events-none rounded-full" />

                    {/* Close button */}
                    {onClose && (
                        <button
                            onClick={onClose}
                            aria-label="Close"
                            className="absolute top-4 right-4 z-10 p-1.5 rounded-lg text-text-muted hover:text-text-primary hover:bg-surface-3 transition-colors"
                        >
                            <X className="w-4 h-4" />
                        </button>
                    )}

                    <div className="text-center mb-6 relative">
                        <div className="w-12 h-12 rounded-xl bg-surface-3 border border-border flex items-center justify-center mx-auto mb-4 shadow-sm group-hover:border-azure/30 group-hover:bg-azure-dim transition-all duration-500">
                            <FolderGit2 className="w-6 h-6 text-azure" />
                        </div>
                        <h3 className="text-xl font-bold text-text-primary tracking-tight font-display">Workspace Configuration</h3>
                        <p className="text-sm text-text-muted mt-1.5">
                            Connect your agent to a codebase.
                        </p>
                    </div>

                    {/* Segmented control */}
                    <div className={`flex p-1 bg-surface-1 rounded-xl mb-6 border border-border/50 relative`}>
                        <div
                            className="absolute inset-y-1 bg-surface-3 border border-border rounded-lg shadow-sm transition-all duration-300 ease-out z-0"
                            style={{
                                width: `calc(${100 / tabs.length}% - 8px / ${tabs.length})`,
                                left: `calc(${tabs.indexOf(tab)} * ${100 / tabs.length}% + 4px)`,
                            }}
                        />
                        {tabs.map((t) => {
                            const icons: Record<Tab, React.ReactNode> = {
                                existing: <Link2 className="w-3.5 h-3.5" />,
                                new:      <Plus className="w-3.5 h-3.5" />,
                                local:    <Folder className="w-3.5 h-3.5" />,
                            }
                            const labels: Record<Tab, string> = {
                                existing: 'Existing',
                                new:      'Create New',
                                local:    'Local',
                            }
                            return (
                                <button
                                    key={t}
                                    onClick={() => setTab(t)}
                                    className={`relative z-10 flex-1 flex items-center justify-center gap-1.5 py-2 text-sm font-medium transition-colors ${
                                        tab === t ? 'text-text-primary' : 'text-text-muted hover:text-text-secondary'
                                    }`}
                                >
                                    {icons[t]}
                                    {labels[t]}
                                </button>
                            )
                        })}
                    </div>

                    <div className="space-y-4">
                        {tab === 'local' ? (
                            <div className="space-y-1.5 relative z-10">
                                <label className="text-xs font-semibold uppercase tracking-wider text-text-muted ml-1">
                                    Directory Path
                                </label>
                                <div className="relative">
                                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted">
                                        <Folder className="w-4 h-4" />
                                    </span>
                                    <input
                                        value={localPath}
                                        onChange={(e) => setLocalPath(e.target.value)}
                                        placeholder="/home/user/my-project"
                                        className="w-full bg-surface-1 border border-border hover:border-border-subtle rounded-xl pl-10 pr-4 py-3 text-sm text-text-primary placeholder:text-text-muted/50 outline-none focus:border-azure focus:ring-1 focus:ring-azure/20 transition-all font-mono"
                                        onKeyDown={(e) => e.key === 'Enter' && isValid && submit()}
                                        autoFocus
                                    />
                                </div>
                                <p className="text-[11px] text-text-muted ml-1 mt-1">
                                    Absolute path to a directory on the server where Plexo is running.
                                </p>
                            </div>
                        ) : (
                            <>
                                <div className="space-y-1.5 relative z-20">
                                    <label className="text-xs font-semibold uppercase tracking-wider text-text-muted ml-1">
                                        {tab === 'existing' ? 'Repository' : 'Project Name'}
                                    </label>
                                    
                                    {tab === 'existing' ? (
                                        <div className="relative">
                                            <button
                                                type="button"
                                                onClick={() => setIsDropdownOpen(!isDropdownOpen)}
                                                className="w-full bg-surface-1 border border-border hover:border-border-subtle rounded-xl pl-10 pr-10 py-3 text-sm text-text-primary text-left outline-none focus:border-azure focus:ring-1 focus:ring-azure/20 transition-all font-mono min-h-[46px] group"
                                            >
                                                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted">
                                                    <Github className="w-4 h-4" />
                                                </span>
                                                <span className={cn(
                                                    "block truncate",
                                                    !repo && "text-text-muted/50"
                                                )}>
                                                    {repo || 'Select a repository...'}
                                                </span>
                                                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-text-muted group-hover:text-text-secondary transition-colors">
                                                    <ChevronDown className={cn("w-4 h-4 transition-transform duration-200", isDropdownOpen && "rotate-180")} />
                                                </span>
                                            </button>

                                            {isDropdownOpen && (
                                                <div className="absolute top-full left-0 right-0 mt-2 bg-surface-2 border border-border/60 rounded-xl shadow-2xl overflow-hidden z-50 animate-in fade-in zoom-in-95 duration-200">
                                                    <div className="p-2 border-b border-border/40 bg-surface-3/50">
                                                        <div className="relative">
                                                            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-muted" />
                                                            <input
                                                                value={repoSearch}
                                                                onChange={(e) => setRepoSearch(e.target.value)}
                                                                placeholder="Search repositories..."
                                                                className="w-full bg-surface-1 border border-border rounded-lg pl-8 pr-3 py-1.5 text-xs text-text-primary outline-none focus:border-azure transition-all"
                                                                autoFocus
                                                                onClick={(e) => e.stopPropagation()}
                                                            />
                                                        </div>
                                                    </div>
                                                    <div className="max-h-60 overflow-y-auto p-1 custom-scrollbar">
                                                        {loadingRepos ? (
                                                            <div className="flex items-center justify-center py-8">
                                                                <Loader2 className="w-4 h-4 text-text-muted animate-spin" />
                                                            </div>
                                                        ) : repos.length === 0 ? (
                                                            <div className="py-8 text-center text-xs text-text-muted">
                                                                No repositories found
                                                            </div>
                                                        ) : (
                                                            repos
                                                                .filter(r => r.fullName.toLowerCase().includes(repoSearch.toLowerCase()))
                                                                .map((r) => (
                                                                    <button
                                                                        key={r.id}
                                                                        onClick={() => {
                                                                            setRepo(r.fullName)
                                                                            setBranch(r.defaultBranch || 'main')
                                                                            setIsDropdownOpen(false)
                                                                            setRepoSearch('')
                                                                            setIsCreatingNewBranch(false)
                                                                            fetchBranches(r.fullName)
                                                                        }}
                                                                        className={cn(
                                                                            "w-full flex items-center justify-between px-3 py-2 text-left text-xs rounded-lg transition-colors",
                                                                            repo === r.fullName ? "bg-azure-dim text-azure" : "text-text-secondary hover:bg-surface-3 hover:text-text-primary"
                                                                        )}
                                                                    >
                                                                        <div className="flex flex-col min-w-0">
                                                                            <span className="font-medium truncate">{r.fullName}</span>
                                                                            {r.description && <span className="text-[10px] text-text-muted truncate mt-0.5">{r.description}</span>}
                                                                        </div>
                                                                        {repo === r.fullName && <Check className="w-3.5 h-3.5 shrink-0 ml-2" />}
                                                                        {r.private && <span className="ml-2 px-1 rounded bg-surface-3 text-[9px] text-text-muted border border-border">Private</span>}
                                                                    </button>
                                                                ))
                                                        )}
                                                        {!loadingRepos && repos.length > 0 && repos.filter(r => r.fullName.toLowerCase().includes(repoSearch.toLowerCase())).length === 0 && (
                                                            <div className="py-8 text-center text-xs text-text-muted">
                                                                No matches for "{repoSearch}"
                                                            </div>
                                                        )}
                                                    </div>
                                                </div>
                                            )}
                                            
                                            {isDropdownOpen && (
                                                <div 
                                                    className="fixed inset-0 z-40" 
                                                    onClick={() => setIsDropdownOpen(false)}
                                                />
                                            )}
                                        </div>
                                    ) : (
                                        <div className="relative">
                                            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted">
                                                <Github className="w-4 h-4" />
                                            </span>
                                            <input
                                                value={newRepo}
                                                onChange={(e) => setNewRepo(e.target.value)}
                                                placeholder="my-awesome-project"
                                                className="w-full bg-surface-1 border border-border hover:border-border-subtle rounded-xl pl-10 pr-4 py-3 text-sm text-text-primary placeholder:text-text-muted/50 outline-none focus:border-azure focus:ring-1 focus:ring-azure/20 transition-all font-mono"
                                                onKeyDown={(e) => e.key === 'Enter' && isValid && submit()}
                                                autoFocus
                                            />
                                        </div>
                                    )}
                                </div>

                                <div className="space-y-1.5 relative z-10">
                                    <div className="flex items-center justify-between ml-1">
                                        <label className="text-xs font-semibold uppercase tracking-wider text-text-muted">
                                            {isCreatingNewBranch ? 'New Branch Name' : 'Target Branch'}
                                        </label>
                                        {tab === 'existing' && (
                                            <button 
                                                onClick={() => {
                                                    setIsCreatingNewBranch(!isCreatingNewBranch)
                                                    if (!isCreatingNewBranch) {
                                                        setBranch('')
                                                    } else {
                                                        const r = repos.find(r => r.fullName === repo)
                                                        setBranch(r?.defaultBranch || 'main')
                                                    }
                                                }}
                                                className="text-[10px] text-azure hover:text-azure/80 font-medium transition-colors"
                                            >
                                                {isCreatingNewBranch ? 'Select existing' : 'Create new?'}
                                            </button>
                                        )}
                                    </div>
                                    <div className="relative">
                                        {isCreatingNewBranch || tab === 'new' ? (
                                            <>
                                                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted">
                                                    <Plus className="w-4 h-4" />
                                                </span>
                                                <input
                                                    value={tab === 'existing' ? branch : newBranch}
                                                    onChange={(e) => tab === 'existing' ? setBranch(e.target.value) : setNewBranch(e.target.value)}
                                                    placeholder="feature/my-new-branch"
                                                    className="w-full bg-surface-1 border border-border hover:border-border-subtle rounded-xl pl-10 pr-4 py-3 text-sm text-text-primary placeholder:text-text-muted/50 outline-none focus:border-azure focus:ring-1 focus:ring-azure/20 transition-all font-mono shadow-sm"
                                                    onKeyDown={(e) => e.key === 'Enter' && isValid && submit()}
                                                    autoFocus
                                                />
                                            </>
                                        ) : (
                                            <div className="relative">
                                                <button
                                                    type="button"
                                                    onClick={() => setIsBranchDropdownOpen(!isBranchDropdownOpen)}
                                                    disabled={!repo}
                                                    className="w-full bg-surface-1 border border-border hover:border-border-subtle rounded-xl pl-10 pr-10 py-3 text-sm text-text-primary text-left outline-none focus:border-azure focus:ring-1 focus:ring-azure/20 transition-all font-mono min-h-[46px] group disabled:opacity-50 disabled:cursor-not-allowed"
                                                >
                                                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted">
                                                        <GitBranch className="w-4 h-4" />
                                                    </span>
                                                    <span className={cn(
                                                        "block truncate",
                                                        !branch && "text-text-muted/50"
                                                    )}>
                                                        {branch || 'Select a branch...'}
                                                    </span>
                                                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-text-muted group-hover:text-text-secondary transition-colors">
                                                        <ChevronDown className={cn("w-4 h-4 transition-transform duration-200", isBranchDropdownOpen && "rotate-180")} />
                                                    </span>
                                                </button>

                                                {isBranchDropdownOpen && (
                                                    <div className="absolute top-full left-0 right-0 mt-2 bg-surface-2 border border-border/60 rounded-xl shadow-2xl overflow-hidden z-50 animate-in fade-in zoom-in-95 duration-200">
                                                        <div className="p-2 border-b border-border/40 bg-surface-3/50">
                                                            <div className="relative">
                                                                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-muted" />
                                                                <input
                                                                    value={branchSearch}
                                                                    onChange={(e) => setBranchSearch(e.target.value)}
                                                                    placeholder="Search branches..."
                                                                    className="w-full bg-surface-1 border border-border rounded-lg pl-8 pr-3 py-1.5 text-xs text-text-primary outline-none focus:border-azure transition-all"
                                                                    autoFocus
                                                                    onClick={(e) => e.stopPropagation()}
                                                                />
                                                            </div>
                                                        </div>
                                                        <div className="max-h-48 overflow-y-auto p-1 custom-scrollbar">
                                                            {loadingBranches ? (
                                                                <div className="flex items-center justify-center py-6">
                                                                    <Loader2 className="w-4 h-4 text-text-muted animate-spin" />
                                                                </div>
                                                            ) : branches.length === 0 ? (
                                                                <div className="py-6 text-center text-xs text-text-muted">
                                                                    No branches found
                                                                </div>
                                                            ) : (
                                                                branches
                                                                    .filter(b => b.name.toLowerCase().includes(branchSearch.toLowerCase()))
                                                                    .map((b) => (
                                                                        <button
                                                                            key={b.name}
                                                                            onClick={() => {
                                                                                setBranch(b.name)
                                                                                setIsBranchDropdownOpen(false)
                                                                                setBranchSearch('')
                                                                            }}
                                                                            className={cn(
                                                                                "w-full flex items-center justify-between px-3 py-2 text-left text-xs rounded-lg transition-colors",
                                                                                branch === b.name ? "bg-azure-dim text-azure" : "text-text-secondary hover:bg-surface-3 hover:text-text-primary"
                                                                            )}
                                                                        >
                                                                            <span className="font-medium truncate">{b.name}</span>
                                                                            {branch === b.name && <Check className="w-3.5 h-3.5 shrink-0 ml-2" />}
                                                                        </button>
                                                                    ))
                                                            )}
                                                            {!loadingBranches && branches.length > 0 && branches.filter(b => b.name.toLowerCase().includes(branchSearch.toLowerCase())).length === 0 && (
                                                                <div className="py-6 text-center text-xs text-text-muted">
                                                                    No matches for "{branchSearch}"
                                                                </div>
                                                            )}
                                                        </div>
                                                        <div className="p-1 border-top border-border/40 bg-surface-3/50">
                                                            <button 
                                                                onClick={() => {
                                                                    setIsCreatingNewBranch(true)
                                                                    setBranch('')
                                                                    setIsBranchDropdownOpen(false)
                                                                }}
                                                                className="w-full flex items-center gap-2 px-3 py-2 text-left text-xs text-azure hover:bg-surface-1 rounded-lg transition-colors font-medium"
                                                            >
                                                                <Plus className="w-3.5 h-3.5" />
                                                                Create new branch...
                                                            </button>
                                                        </div>
                                                    </div>
                                                )}
                                                
                                                {isBranchDropdownOpen && (
                                                    <div 
                                                        className="fixed inset-0 z-40" 
                                                        onClick={() => setIsBranchDropdownOpen(false)}
                                                    />
                                                )}
                                            </div>
                                        )}
                                    </div>
                                </div>
                            </>
                        )}
                    </div>

                    <button
                        onClick={submit}
                        disabled={!isValid}
                        className={`w-full mt-6 py-3 px-4 rounded-xl text-sm font-semibold text-white transition-all flex items-center justify-center gap-2 group relative z-10 overflow-hidden ${
                            tab === 'new'
                                ? 'bg-azure hover:bg-azure-600 focus:ring-azure/50'
                                : 'bg-azure hover:bg-azure/90 focus:ring-azure/50'
                        } disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus:ring-2`}
                    >
                        <span className="relative z-10 flex items-center gap-2">
                            {tab === 'existing' ? 'Connect Repository' : tab === 'new' ? 'Create & Connect' : 'Use Directory'}
                            <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
                        </span>
                    </button>
                </div>
            </div>
        </div>
    )
}
