// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { useFocusTrap } from '@web/hooks/use-focus-trap'
import {
    Home,
    MessagesSquare,
    CheckSquare,
    FolderOpen,
    ShieldAlert,
    Brain,
    Bot,
    Zap,
    Plug,
    Radio,
    Store,
    Clock,
    Settings,
    Search,
    ArrowRight,
    Plus,
    Rocket,
    Lightbulb,
    Network,
    FileText,
    Bug,
} from 'lucide-react'

// ── Destination registry ─────────────────────────────────────────────────────

interface PaletteItem {
    id: string
    label: string
    section: string
    href: string
    icon: React.ElementType
    keywords?: string[]
}

const DESTINATIONS: PaletteItem[] = [
    // Chat & Conversation
    { id: 'home', label: 'Home', section: 'Navigate', href: '/app', icon: Home, keywords: ['dashboard'] },
    { id: 'new-chat', label: 'New Chat', section: 'Actions', href: '/app/chat', icon: Plus, keywords: ['message', 'conversation'] },
    { id: 'conversations', label: 'Conversations', section: 'Navigate', href: '/app/conversations', icon: MessagesSquare, keywords: ['threads', 'history'] },

    // Work
    { id: 'tasks', label: 'Tasks', section: 'Navigate', href: '/app/tasks', icon: CheckSquare, keywords: ['todo', 'work'] },
    { id: 'sprints', label: 'Sprints', section: 'Navigate', href: '/app/sprints', icon: Rocket, keywords: ['sprint', 'batch'] },
    { id: 'projects', label: 'Projects', section: 'Navigate', href: '/app/projects', icon: FolderOpen },
    { id: 'approvals', label: 'Approvals', section: 'Navigate', href: '/app/approvals', icon: ShieldAlert, keywords: ['review', 'pending'] },
    { id: 'memory', label: 'Memory', section: 'Navigate', href: '/app/memory', icon: Brain, keywords: ['knowledge', 'learn', 'scl'] },
    { id: 'insights', label: 'Insights', section: 'Navigate', href: '/app/memory', icon: Lightbulb, keywords: ['scl', 'memory', 'improvements'] },

    // Platform
    { id: 'agents', label: 'Agents', section: 'Navigate', href: '/app/agents', icon: Bot, keywords: ['persona', 'behavior', 'tuning', 'config', 'plexo bot'] },
    { id: 'agent-identity', label: 'Agent: Identity', section: 'Navigate', href: '/app/agents?tab=identity', icon: Bot, keywords: ['persona', 'avatar', 'name'] },
    { id: 'agent-behavior', label: 'Agent: Behavior', section: 'Navigate', href: '/app/agents?tab=behavior', icon: Bot, keywords: ['rules', 'prompt'] },
    { id: 'agent-limits', label: 'Agent: Limits', section: 'Navigate', href: '/app/agents?tab=limits', icon: Bot, keywords: ['cost', 'budget', 'safe mode'] },
    { id: 'extensions', label: 'Extensions', section: 'Navigate', href: '/app/extensions', icon: Zap, keywords: ['tools', 'skills', 'agents', 'channels'] },
    { id: 'integrations', label: 'Integrations', section: 'Navigate', href: '/app/connections', icon: Plug, keywords: ['connections', 'oauth'] },
    { id: 'channels', label: 'Channels', section: 'Navigate', href: '/app/settings/channels', icon: Radio, keywords: ['telegram', 'slack', 'discord'] },
    { id: 'hub', label: 'Hub', section: 'Navigate', href: '/app/hub', icon: Store, keywords: ['marketplace', 'browse', 'extensions'] },
    { id: 'schedules', label: 'Scheduling', section: 'Navigate', href: '/app/scheduling', icon: Clock, keywords: ['cron', 'recurring', 'scheduled', 'reminder', 'reminders'] },

    // System
    { id: 'settings', label: 'Settings', section: 'Navigate', href: '/app/settings', icon: Settings },
    { id: 'federation', label: 'Federation', section: 'Navigate', href: '/app/settings/federation', icon: Network, keywords: ['peer', 'nodes', 'cluster'] },
    { id: 'logs', label: 'Logs', section: 'Navigate', href: '/app/logs', icon: FileText, keywords: ['task', 'execution', 'history', 'audit', 'trail'] },
    { id: 'debug', label: 'Debug', section: 'Navigate', href: '/app/debug', icon: Bug, keywords: ['diagnostics', 'health', 'system'] },

    // Actions
    { id: 'new-task', label: 'New Task', section: 'Actions', href: '/app/tasks?new=1', icon: Plus, keywords: ['create'] },

    // Settings subsections
    { id: 'settings-ai-models', label: 'AI Models', section: 'Settings', href: '/app/settings/intelligence/models', icon: Settings, keywords: ['model', 'provider', 'ai', 'intelligence'] },
    { id: 'settings-ai-providers', label: 'AI Providers', section: 'Settings', href: '/app/settings/intelligence/providers', icon: Settings, keywords: ['openai', 'anthropic', 'ollama'] },
    { id: 'settings-behavior', label: 'Behavior', section: 'Settings', href: '/app/settings/behavior', icon: Settings, keywords: ['rules', 'quality'] },
    { id: 'settings-context', label: 'Context', section: 'Settings', href: '/app/settings/context', icon: Settings, keywords: ['memory', 'scl'] },
    { id: 'settings-voice', label: 'Voice', section: 'Settings', href: '/app/settings/voice', icon: Settings, keywords: ['stt', 'tts', 'deepgram'] },
    { id: 'settings-integrations', label: 'Integrations Settings', section: 'Settings', href: '/app/settings/connections', icon: Plug, keywords: ['oauth', 'credentials', 'connections'] },
    { id: 'settings-users', label: 'Users', section: 'Settings', href: '/app/settings/users', icon: Settings, keywords: ['members', 'roles', 'invites'] },
    { id: 'settings-app-grants', label: 'App Grants', section: 'Settings', href: '/app/settings/app-grants', icon: Settings, keywords: ['grants', 'capabilities', 'connectors', 'permissions', 'profile', 'apps'] },
    { id: 'settings-privacy', label: 'Privacy', section: 'Settings', href: '/app/settings/privacy', icon: Settings, keywords: ['data', 'retention', 'pii'] },
    { id: 'settings-search', label: 'Search', section: 'Settings', href: '/app/settings/search', icon: Search, keywords: ['brave', 'ddg'] },
    { id: 'settings-webhooks', label: 'Webhooks', section: 'Settings', href: '/app/settings?section=webhooks', icon: Settings, keywords: ['webhook', 'trigger', 'http'] },
]

// ── Component ────────────────────────────────────────────────────────────────

export function CommandPalette() {
    const [open, setOpen] = useState(false)
    const [query, setQuery] = useState('')
    const [selectedIndex, setSelectedIndex] = useState(0)
    const inputRef = useRef<HTMLInputElement>(null)
    const listRef = useRef<HTMLDivElement>(null)
    const router = useRouter()
    const trapRef = useFocusTrap<HTMLDivElement>(open)

    // Global Cmd+K / Ctrl+K listener
    useEffect(() => {
        function handler(e: KeyboardEvent) {
            if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
                e.preventDefault()
                setOpen(prev => !prev)
            }
        }
        document.addEventListener('keydown', handler)
        return () => document.removeEventListener('keydown', handler)
    }, [])

    // Focus input when opened
    useEffect(() => {
        if (open) {
            setQuery('')
            setSelectedIndex(0)
            // Small delay to ensure DOM is ready
            requestAnimationFrame(() => inputRef.current?.focus())
        }
    }, [open])

    const filtered = useMemo(() => {
        if (!query.trim()) return DESTINATIONS
        const q = query.toLowerCase()
        return DESTINATIONS.filter(item =>
            item.label.toLowerCase().includes(q) ||
            item.section.toLowerCase().includes(q) ||
            item.keywords?.some(kw => kw.includes(q))
        )
    }, [query])

    // Group by section for display
    const grouped = useMemo(() => {
        const map = new Map<string, PaletteItem[]>()
        for (const item of filtered) {
            const list = map.get(item.section) ?? []
            list.push(item)
            map.set(item.section, list)
        }
        return map
    }, [filtered])

    const navigate = useCallback((item: PaletteItem) => {
        setOpen(false)
        router.push(item.href)
    }, [router])

    // Keyboard navigation
    useEffect(() => {
        if (!open) return

        function handler(e: KeyboardEvent) {
            if (e.key === 'Escape') {
                e.preventDefault()
                setOpen(false)
                return
            }
            if (e.key === 'ArrowDown') {
                e.preventDefault()
                setSelectedIndex(prev => Math.min(prev + 1, filtered.length - 1))
                return
            }
            if (e.key === 'ArrowUp') {
                e.preventDefault()
                setSelectedIndex(prev => Math.max(prev - 1, 0))
                return
            }
            if (e.key === 'Enter') {
                e.preventDefault()
                const item = filtered[selectedIndex]
                if (item) navigate(item)
            }
        }
        document.addEventListener('keydown', handler)
        return () => document.removeEventListener('keydown', handler)
    }, [open, filtered, selectedIndex, navigate])

    // Scroll selected item into view
    useEffect(() => {
        if (!open || !listRef.current) return
        const el = listRef.current.querySelector(`[data-index="${selectedIndex}"]`)
        el?.scrollIntoView({ block: 'nearest' })
    }, [open, selectedIndex])

    // Reset selection when query changes
    useEffect(() => {
        setSelectedIndex(0)
    }, [query])

    if (!open) return null

    let flatIndex = -1

    return (
        <div
            ref={trapRef}
            className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh] px-4 bg-black/60"
            onClick={() => setOpen(false)}
            role="dialog"
            aria-modal="true"
            aria-label="Command palette"
        >
            <div
                className="w-full max-w-lg rounded border border-border bg-surface-1 overflow-hidden"
                onClick={e => e.stopPropagation()}
            >
                {/* Search input */}
                <div className="flex items-center gap-3 border-b border-border px-4 py-3">
                    <Search className="h-4 w-4 text-text-muted shrink-0" />
                    <input
                        ref={inputRef}
                        type="text"
                        value={query}
                        onChange={e => setQuery(e.target.value)}
                        placeholder="Jump to..."
                        className="flex-1 bg-transparent text-sm text-text-primary placeholder:text-text-muted outline-none"
                        aria-label="Search commands"
                        autoComplete="off"
                    />
                    <kbd className="hidden sm:inline-flex items-center gap-0.5 rounded border border-border bg-surface-2 px-1.5 py-0.5 text-[11px] text-text-muted font-mono">
                        Esc
                    </kbd>
                </div>

                {/* Results */}
                <div ref={listRef} className="max-h-[50vh] overflow-y-auto p-2" role="listbox">
                    {filtered.length === 0 ? (
                        <div className="py-8 text-center text-sm text-text-muted">
                            No results for &ldquo;{query}&rdquo;
                        </div>
                    ) : (
                        Array.from(grouped.entries()).map(([section, items]) => (
                            <div key={section}>
                                <div className="px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-text-muted">
                                    {section}
                                </div>
                                {items.map(item => {
                                    flatIndex++
                                    const idx = flatIndex
                                    const Icon = item.icon
                                    return (
                                        <button
                                            key={item.id}
                                            data-index={idx}
                                            onClick={() => navigate(item)}
                                            onMouseEnter={() => setSelectedIndex(idx)}
                                            className={`flex w-full items-center gap-3 rounded px-3 py-2 text-sm transition-colors ${
                                                idx === selectedIndex
                                                    ? 'bg-surface-2 text-text-primary'
                                                    : 'text-text-secondary hover:bg-surface-2/50'
                                            }`}
                                            role="option"
                                            aria-selected={idx === selectedIndex}
                                        >
                                            <Icon className="h-4 w-4 shrink-0 text-text-muted" />
                                            <span className="flex-1 text-left">{item.label}</span>
                                            <ArrowRight className={`h-3 w-3 shrink-0 transition-opacity ${idx === selectedIndex ? 'opacity-60' : 'opacity-0'}`} />
                                        </button>
                                    )
                                })}
                            </div>
                        ))
                    )}
                </div>
            </div>
        </div>
    )
}
