// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { useState, useCallback, useMemo } from 'react'
import useSWR from 'swr'
import { jsonFetcher } from '@web/lib/swr'
import {
    Brain,
    RefreshCw,
    Search,
    Plus,
    Trash2,
    Pencil,
    X,
    Check,
    BookOpen,
    Paperclip,
    FileText,
    Image as ImageIcon,
    Music,
} from 'lucide-react'
import { EmptyState } from '@web/components/ui/empty-state'
import { toast } from 'sonner'
import { useWorkspaceId } from '@web/context/workspace'
import { ViewModeToggle } from '@web/components/view-mode-toggle'
import { PlexoAwarenessBadge } from '@web/components/plexo-awareness-badge'

const API_BASE = (typeof window !== 'undefined' ? '' : (process.env.INTERNAL_API_URL || 'http://localhost:3001'))

type Tab = 'browse' | 'search'

interface MemoryEntry {
    id: string
    type: string
    content: string
    shorthand: string | null
    metadata: Record<string, unknown>
    tier: string
    created_at: string
}

interface SearchResult {
    id: string
    content: string
    metadata: Record<string, unknown>
    similarity?: number
}

function timeAgo(iso: string | undefined | null) {
    if (!iso) return ''
    const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
    if (isNaN(s)) return ''
    if (s < 60) return `${s}s ago`
    if (s < 3600) return `${Math.floor(s / 60)}m ago`
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`
    return `${Math.floor(s / 86400)}d ago`
}

const TIER_STYLE: Record<string, string> = {
    hot: 'text-red bg-red/20',
    active: 'text-azure bg-azure/20',
    cold: 'text-text-muted bg-surface-2',
}

const TYPE_STYLE: Record<string, string> = {
    task: 'text-azure',
    incident: 'text-red',
    session: 'text-amber',
    pattern: 'text-purple-400',
}

export default function MemoryPage() {
    const WS_ID = useWorkspaceId()
    const [tab, setTab] = useState<Tab>('browse')

    // Browse state — entries come from SWR below, filters drive the cache key.
    const [typeFilter, setTypeFilter] = useState('')
    const [tierFilter, setTierFilter] = useState('')
    const [editingId, setEditingId] = useState<string | null>(null)
    const [editContent, setEditContent] = useState('')
    const [deletingId, setDeletingId] = useState<string | null>(null)

    // Teach state
    const [teachOpen, setTeachOpen] = useState(false)
    const [teachContent, setTeachContent] = useState('')
    const [teachType, setTeachType] = useState('pattern')
    const [teaching, setTeaching] = useState(false)
    const [teachFiles, setTeachFiles] = useState<Array<{ name: string; data: string; mimeType: string; preview?: string }>>([])

    function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
        const files = e.target.files
        if (!files) return
        for (const file of Array.from(files).slice(0, 5 - teachFiles.length)) {
            const reader = new FileReader()
            reader.onload = () => {
                const data = reader.result as string
                const preview = file.type.startsWith('image/') ? data : undefined
                setTeachFiles(prev => [...prev.slice(0, 4), { name: file.name, data, mimeType: file.type, preview }])
            }
            reader.readAsDataURL(file)
        }
        e.target.value = ''
    }

    // Search state
    const [searchQ, setSearchQ] = useState('')
    const [searching, setSearching] = useState(false)
    const [searchResults, setSearchResults] = useState<SearchResult[] | null>(null)

    // ── Browse ────────────────────────────────────────────────────────────────

    // Phase 8: SWR-backed browse. Filters baked into the cache key so every
    // filter combo caches independently; focus revalidation + 30s dedupe.
    const entriesKey = useMemo(() => {
        if (!WS_ID) return null
        const params = new URLSearchParams({ workspaceId: WS_ID })
        if (typeFilter) params.set('type', typeFilter)
        if (tierFilter) params.set('tier', tierFilter)
        return `${API_BASE}/api/v1/memory/entries?${params.toString()}`
    }, [WS_ID, typeFilter, tierFilter])

    const { data: entriesData, isLoading: entriesLoading, mutate: mutateEntries } = useSWR<{ items: MemoryEntry[]; total: number }>(
        entriesKey,
        jsonFetcher,
        { dedupingInterval: 30_000, revalidateOnFocus: true, keepPreviousData: true },
    )
    const entries = entriesData?.items ?? []
    const total = entriesData?.total ?? 0
    const loading = entriesLoading && !entriesData

    const loadEntries = useCallback(async () => {
        await mutateEntries()
    }, [mutateEntries])

    const handleEdit = async (id: string) => {
        try {
            const res = await fetch(`${API_BASE}/api/v1/memory/entries/${id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ workspaceId: WS_ID, content: editContent }),
            })
            if (res.ok) {
                setEditingId(null)
                void loadEntries()
                toast.success('Memory entry updated')
            } else {
                toast.error('Failed to update memory entry')
            }
        } catch { toast.error('Failed to update memory entry') }
    }

    const handleDelete = async (id: string) => {
        try {
            const res = await fetch(`${API_BASE}/api/v1/memory/entries/${id}?workspaceId=${WS_ID}`, { method: 'DELETE' })
            if (res.ok) {
                setDeletingId(null)
                void loadEntries()
                toast.success('Memory entry deleted')
            } else {
                toast.error('Failed to delete memory entry')
            }
        } catch { toast.error('Failed to delete memory entry') }
    }

    const handleTeach = async () => {
        if (!teachContent.trim()) return
        setTeaching(true)
        try {
            const payload: Record<string, unknown> = {
                workspaceId: WS_ID,
                content: teachContent.trim(),
                type: teachType,
            }
            if (teachFiles.length > 0) {
                payload.attachments = teachFiles.map(f => ({ name: f.name, data: f.data, mimeType: f.mimeType }))
            }
            const res = await fetch(`${API_BASE}/api/v1/memory/entries`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            })
            if (res.ok) {
                setTeachContent('')
                setTeachFiles([])
                setTeachOpen(false)
                void loadEntries()
                toast.success('Memory entry created')
            } else {
                toast.error('Failed to create memory entry')
            }
        } catch { toast.error('Failed to create memory entry') }
        setTeaching(false)
    }

    // ── Search ────────────────────────────────────────────────────────────────

    const handleSearch = async () => {
        if (!searchQ.trim() || !WS_ID) return
        setSearching(true)
        try {
            const res = await fetch(`${API_BASE}/api/v1/memory/search?workspaceId=${WS_ID}&q=${encodeURIComponent(searchQ)}&limit=10`)
            if (res.ok) {
                const data = await res.json() as { results: SearchResult[] }
                setSearchResults(data.results)
            }
        } catch { /* silent */ }
        setSearching(false)
    }

    // ── Render ────────────────────────────────────────────────────────────────

    return (
        <div className="flex flex-col gap-6 max-w-6xl">
            {/* Header */}
            <div className="flex items-start justify-between">
                <div>
                    <h1 className="text-2xl font-medium text-text-primary">Memory</h1>
                    <p className="mt-0.5 text-sm text-text-muted">What Plexo knows about your work</p>
                </div>
                <div className="flex items-center gap-2">
                    <button
                        onClick={() => setTeachOpen(true)}
                        className="flex items-center gap-1.5 rounded-sm bg-azure px-3 py-2 text-xs font-medium text-text-primary hover:bg-azure/90 transition-colors"
                    >
                        <Plus className="h-3.5 w-3.5" />
                        Teach Plexo
                    </button>
                    <button
                        onClick={() => void loadEntries()}
                        disabled={loading}
                        aria-label="Refresh memory entries"
                        className="flex items-center gap-1.5 rounded-sm border border-border px-3 py-2 text-xs text-text-muted hover:text-text-secondary transition-colors"
                    >
                        <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
                    </button>
                </div>
            </div>

            {/* Tabs */}
            <div className="flex items-center gap-1 border-b border-border">
                {([
                    { id: 'browse' as Tab, label: 'Browse', icon: BookOpen },
                    { id: 'search' as Tab, label: 'Search', icon: Search },
                ] as const).map(t => (
                    <button
                        key={t.id}
                        onClick={() => setTab(t.id)}
                        className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium border-b-2 transition-colors ${
                            tab === t.id
                                ? 'border-azure text-azure'
                                : 'border-transparent text-text-muted hover:text-text-secondary'
                        }`}
                    >
                        <t.icon className="h-3.5 w-3.5" />
                        {t.label}
                    </button>
                ))}
                <div className="ml-auto pb-1">
                    <ViewModeToggle />
                </div>
            </div>

            {/* Teach Modal */}
            {teachOpen && (
                <div className="rounded-sm border border-azure/30 bg-surface-1/80 p-4 space-y-3">
                    <div className="flex items-center justify-between">
                        <h3 className="text-sm font-medium text-text-primary">Teach Plexo something new</h3>
                        <button onClick={() => setTeachOpen(false)} aria-label="Close teach panel" className="text-text-muted hover:text-text-secondary">
                            <X className="h-4 w-4" />
                        </button>
                    </div>
                    <textarea
                        value={teachContent}
                        onChange={e => setTeachContent(e.target.value)}
                        placeholder="Tell Plexo something it should remember about your work, preferences, or domain..."
                        className="w-full rounded-sm border border-border bg-canvas px-4 py-3 text-sm text-text-primary placeholder:text-text-muted resize-none"
                        rows={4}
                    />

                    {/* Attachments */}
                    {teachFiles.length > 0 && (
                        <div className="flex flex-wrap gap-2">
                            {teachFiles.map((f, i) => (
                                <div key={i} className="flex items-center gap-1.5 rounded-sm border border-border bg-surface-2/60 px-2.5 py-1.5 text-sm text-text-secondary">
                                    {f.preview ? (
                                        // eslint-disable-next-line @next/next/no-img-element
                                        <img src={f.preview} alt={f.name} className="h-6 w-6 rounded object-cover" />
                                    ) : f.mimeType.startsWith('audio/') ? (
                                        <Music className="h-3.5 w-3.5 text-text-muted" />
                                    ) : (
                                        <FileText className="h-3.5 w-3.5 text-text-muted" />
                                    )}
                                    <span className="truncate max-w-[120px]">{f.name}</span>
                                    <button onClick={() => setTeachFiles(prev => prev.filter((_, j) => j !== i))} aria-label="Remove attachment" className="text-text-muted hover:text-red">
                                        <X className="h-3 w-3" />
                                    </button>
                                </div>
                            ))}
                        </div>
                    )}

                    <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                            <select
                                value={teachType}
                                onChange={e => setTeachType(e.target.value)}
                                className="rounded-sm border border-border bg-canvas px-2 py-1.5 text-xs text-text-secondary"
                            >
                                <option value="pattern">Pattern / Preference</option>
                                <option value="task">Task Context</option>
                                <option value="session">Session Note</option>
                                <option value="incident">Incident</option>
                            </select>
                            <label className={`flex items-center gap-1 rounded-sm border border-border px-2 py-1.5 text-xs text-text-muted hover:text-text-secondary hover:border-border cursor-pointer transition-colors ${teachFiles.length >= 5 ? 'opacity-40 pointer-events-none' : ''}`}>
                                <Paperclip className="h-3.5 w-3.5" />
                                <span className="hidden sm:inline">Attach</span>
                                <input
                                    type="file"
                                    multiple
                                    accept="image/*,audio/*,.pdf,.txt,.md,.json,.csv,.yaml,.yml"
                                    onChange={handleFileSelect}
                                    className="hidden"
                                    disabled={teachFiles.length >= 5}
                                />
                            </label>
                        </div>
                        <button
                            onClick={() => void handleTeach()}
                            disabled={teaching || !teachContent.trim()}
                            className="flex items-center gap-1.5 rounded-sm bg-azure px-3 py-2 text-xs font-medium text-text-primary hover:bg-azure/90 disabled:opacity-40 transition-colors"
                        >
                            {teaching ? 'Saving…' : 'Save to memory'}
                        </button>
                    </div>
                </div>
            )}

            {/* ── Browse Tab ───────────────────────────────────────────────── */}
            {tab === 'browse' && (
                <div className="space-y-4">
                    {/* Filters */}
                    <div className="flex gap-2">
                        <select
                            value={typeFilter}
                            onChange={e => setTypeFilter(e.target.value)}
                            className="rounded-sm border border-border bg-canvas px-2 py-1.5 text-xs text-text-secondary"
                        >
                            <option value="">All types</option>
                            <option value="task">Task</option>
                            <option value="pattern">Pattern</option>
                            <option value="session">Session</option>
                            <option value="incident">Incident</option>
                        </select>
                        <select
                            value={tierFilter}
                            onChange={e => setTierFilter(e.target.value)}
                            className="rounded-sm border border-border bg-canvas px-2 py-1.5 text-xs text-text-secondary"
                        >
                            <option value="">All tiers</option>
                            <option value="hot">Hot</option>
                            <option value="active">Active</option>
                            <option value="cold">Cold</option>
                        </select>
                        <span className="flex items-center text-xs text-text-muted ml-auto">{total} entries</span>
                    </div>

                    {/* Entry list */}
                    {loading ? (
                        <div className="space-y-3">
                            {Array.from({ length: 5 }).map((_, i) => (
                                <div key={i} className="h-20 rounded-sm bg-surface-1/40 animate-pulse" />
                            ))}
                        </div>
                    ) : entries.length === 0 ? (
                        <EmptyState
                            icon={Brain}
                            headline="No memories yet"
                            description="Plexo learns from tasks it completes. You can also teach it directly using the button above."
                            actionLabel="Teach Plexo"
                            onAction={() => setTeachOpen(true)}
                        />
                    ) : (
                        <div className="space-y-2">
                            {entries.map(entry => (
                                <div key={entry.id} className="rounded-sm border border-border bg-surface-1/40 p-3 group">
                                    {editingId === entry.id ? (
                                        <div className="space-y-2">
                                            <textarea
                                                value={editContent}
                                                onChange={e => setEditContent(e.target.value)}
                                                className="w-full rounded-sm border border-border bg-canvas px-4 py-3 text-sm text-text-primary resize-none"
                                                rows={3}
                                            />
                                            <div className="flex gap-2 justify-end">
                                                <button onClick={() => setEditingId(null)} className="text-xs text-text-muted hover:text-text-secondary">Cancel</button>
                                                <button onClick={() => void handleEdit(entry.id)} className="flex items-center gap-1 text-xs text-azure hover:text-azure/80">
                                                    <Check className="h-3 w-3" /> Save
                                                </button>
                                            </div>
                                        </div>
                                    ) : deletingId === entry.id ? (
                                        <div className="flex items-center justify-between">
                                            <p className="text-xs text-red">Delete this memory entry?</p>
                                            <div className="flex gap-2">
                                                <button onClick={() => setDeletingId(null)} className="text-xs text-text-muted hover:text-text-secondary">Cancel</button>
                                                <button onClick={() => void handleDelete(entry.id)} className="text-xs text-red hover:text-red/80">Delete</button>
                                            </div>
                                        </div>
                                    ) : (
                                        <>
                                            <div className="flex items-start justify-between gap-2">
                                                <div className="flex items-center gap-2 mb-1">
                                                    <span className={`text-[11px] font-medium uppercase tracking-wider ${TYPE_STYLE[entry.type] ?? 'text-text-muted'}`}>
                                                        {entry.type}
                                                    </span>
                                                    <span className={`rounded-sm px-1.5 py-0.5 text-[11px] ${TIER_STYLE[entry.tier] ?? TIER_STYLE.active}`}>
                                                        {entry.tier}
                                                    </span>
                                                    <span className="text-[11px] text-text-muted">{timeAgo(entry.created_at)}</span>
                                                </div>
                                                <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                                    <button
                                                        onClick={() => { setEditingId(entry.id); setEditContent(entry.content) }}
                                                        aria-label="Edit memory entry"
                                                        className="p-1 text-text-muted hover:text-text-secondary rounded"
                                                    >
                                                        <Pencil className="h-3 w-3" />
                                                    </button>
                                                    <button
                                                        onClick={() => setDeletingId(entry.id)}
                                                        aria-label="Delete memory entry"
                                                        className="p-1 text-text-muted hover:text-red rounded"
                                                    >
                                                        <Trash2 className="h-3 w-3" />
                                                    </button>
                                                </div>
                                            </div>
                                            <div className="flex items-end justify-between gap-2">
                                                <p className="text-sm text-text-secondary line-clamp-3 flex-1">{entry.shorthand || entry.content}</p>
                                                <PlexoAwarenessBadge action="Memory" compact />
                                            </div>
                                            {/* Attachment thumbnails */}
                                            {(() => {
                                                const atts = (entry.metadata as { attachments?: Array<{ name: string; url: string; mimeType: string }> })?.attachments
                                                if (!atts?.length) return null
                                                return (
                                                    <div className="flex flex-wrap gap-1.5 mt-2">
                                                        {atts.map((a, i) => (
                                                            <a key={i} href={a.url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 rounded border border-border bg-surface-2/40 px-2 py-1 text-[11px] text-text-muted hover:text-text-secondary transition-colors">
                                                                {a.mimeType?.startsWith('image/') ? <ImageIcon className="h-3 w-3" />
                                                                    : a.mimeType?.startsWith('audio/') ? <Music className="h-3 w-3" />
                                                                    : <FileText className="h-3 w-3" />}
                                                                <span className="truncate max-w-[100px]">{a.name}</span>
                                                            </a>
                                                        ))}
                                                    </div>
                                                )
                                            })()}
                                        </>
                                    )}
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            )}

            {/* ── Search Tab ──────────────────────────────────────────────── */}
            {tab === 'search' && (
                <div className="space-y-4">
                    <form onSubmit={e => { e.preventDefault(); void handleSearch() }} className="flex gap-2">
                        <input
                            value={searchQ}
                            onChange={e => setSearchQ(e.target.value)}
                            placeholder="Search memories by meaning..."
                            className="flex-1 rounded-sm border border-border bg-canvas px-3 py-2 text-sm text-text-primary placeholder:text-text-muted"
                        />
                        <button
                            type="submit"
                            disabled={searching || !searchQ.trim()}
                            className="flex items-center gap-1.5 rounded-sm bg-azure px-3 py-2 text-xs font-medium text-text-primary hover:bg-azure/90 disabled:opacity-40 transition-colors"
                        >
                            <Search className="h-3.5 w-3.5" />
                            {searching ? 'Searching…' : 'Search'}
                        </button>
                    </form>

                    {searchResults === null ? (
                        <div className="flex flex-col items-center py-12 text-center">
                            <Search className="h-10 w-10 text-text-muted mb-3" />
                            <p className="text-sm text-text-muted">Search uses vector similarity to find relevant memories</p>
                        </div>
                    ) : searchResults.length === 0 ? (
                        <p className="text-sm text-text-muted py-8 text-center">No matching memories found</p>
                    ) : (
                        <div className="space-y-2">
                            {searchResults.map((r, i) => (
                                <div key={r.id} className="rounded-sm border border-border bg-surface-1/40 p-3">
                                    <div className="flex items-center gap-2 mb-1">
                                        <span className="text-[11px] font-medium text-azure">#{i + 1}</span>
                                        {r.similarity != null && (
                                            <span className="text-[11px] text-text-muted">{(r.similarity * 100).toFixed(0)}% match</span>
                                        )}
                                    </div>
                                    <p className="text-sm text-text-secondary">{r.content}</p>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            )}

        </div>
    )
}
