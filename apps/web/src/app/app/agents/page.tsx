// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

'use client'

export const dynamic = 'force-dynamic'

import { useState, useEffect, useCallback, useRef, Suspense } from 'react'
import { useUnsavedChanges } from '@web/hooks/use-unsaved-changes'
import { useSearchParams } from 'next/navigation'
import dynamicImport from 'next/dynamic'
import {
    Zap, RefreshCw, Save, Check, AlertCircle, Brain, Shield, Sparkles,
    User, Settings2, BookOpen, History, Layers,
    ArrowLeftRight, X, Bot, DollarSign, Users, Cpu, ChevronDown,
    ChevronRight, ToggleLeft, ToggleRight, Info, Globe, ShieldAlert,
} from 'lucide-react'
import { useWorkspace } from '@web/context/workspace'
import { useViewMode } from '@web/hooks/use-view-mode'
import { ViewModeToggle } from '@web/components/view-mode-toggle'
import { useConfirm } from '@web/components/ui/confirm-dialog'
import { getModelCapabilities } from '@web/lib/models'
import { CapabilityList } from '@web/components/capabilities'
import { PersonalityReconfigureModal } from '@web/components/onboarding/personality-modal'
import { useListFilter, ListToolbar } from '@web/components/list-toolbar'
import { EmptyState } from '@web/components/ui/empty-state'

import { Input, Textarea, Toggle, Field, FieldSelect, Section } from './_tabs/ui-primitives'
import { BehaviorCard, SourceBadge, SystemPromptPreview } from './_tabs/behavior-card'
import type {
    WorkspaceSettings, BehaviorRule, ResolvedRule,
    GroupDef, RuleSource, RuleValue,
} from './_tabs/types'
import { API } from './_tabs/types'

// Heavy / non-critical panels — lazy loaded with ssr:false so they never hit
// the initial bundle. Each tab is split into its own chunk.
const ParallelStatusPanel = dynamicImport(
    () => import('./_components/parallel-status-panel').then(m => ({ default: m.ParallelStatusPanel })),
    { ssr: false, loading: () => <div className="text-sm text-text-muted">Loading…</div> },
)
const ExtensionPromptsTab = dynamicImport(() => import('./_tabs/tab-extensions'), {
    ssr: false,
    loading: () => <div className="text-sm text-text-muted">Loading…</div>,
})
const HistoryTab = dynamicImport(() => import('./_tabs/tab-history'), {
    ssr: false,
    loading: () => <div className="text-sm text-text-muted">Loading…</div>,
})
const UserSelfTab = dynamicImport(() => import('./_tabs/tab-userself'), {
    ssr: false,
    loading: () => <div className="text-sm text-text-muted">Loading…</div>,
})
const QualityTab = dynamicImport(() => import('./_tabs/tab-quality'), {
    ssr: false,
    loading: () => <div className="text-sm text-text-muted">Loading…</div>,
})

// Re-export types referenced by consumers (none currently)
export type { WorkspaceSettings }

const API_BASE = (typeof window !== 'undefined' ? '' : (process.env.INTERNAL_API_URL || 'http://localhost:3001'))

interface AgentStatusLocal {
    status: 'idle' | 'running'
    currentTask: string | null
    currentModel: string | null
    sessionCount: number
    lastActivity: string | null
}

interface ExtensionManifest {
    name: string
    version: string
    description?: string
    displayName?: string
    icon?: string
    type: string
    plexo: string
    capabilities?: string[]
    trust?: string
    dataResidency?: { sendsDataExternally: boolean; externalDestinations?: Array<{ host: string; purpose: string }> }
    modelRequirements?: {
        minimumContextWindow?: number
        requiresFunctionCalling?: boolean
        localModelAcceptable?: boolean
        preferredProviders?: string[]
    }
    escalation?: {
        irreversibleActions?: string[]
        requestsStandingApprovals?: boolean
    }
    agentHints?: {
        taskTypes?: string[]
        minConfidence?: number
    }
}

interface ExtensionIdentityOverride {
    displayName?: string
    avatar?: string
    identityOverrideInChat?: boolean
}

interface Extension {
    id: string
    name: string
    version: string
    type: string
    pexVersion: string
    enabled: boolean
    installedAt: string
    manifest: ExtensionManifest | null
    settings: Record<string, unknown> & { identity?: ExtensionIdentityOverride }
}

interface AuditRow {
    id: string
    action: string
    target: string
    outcome: string
    createdAt: string
}

type Tab = 'identity' | 'behavior' | 'limits' | 'quality' | 'orchestration' | 'extensions' | 'history' | 'userself'

const TABS: { id: Tab; label: string; icon: React.ElementType }[] = [
    { id: 'identity', label: 'Identity', icon: User },
    { id: 'behavior', label: 'Behavior', icon: Sparkles },
    { id: 'limits', label: 'Limits', icon: Shield },
    { id: 'quality', label: 'Quality', icon: Users },
    { id: 'orchestration', label: 'Orchestration', icon: Cpu },
    { id: 'extensions', label: 'Extensions', icon: Layers },
    { id: 'userself', label: 'About You', icon: User },
    { id: 'history', label: 'History', icon: History },
]

const SIMPLE_TABS = new Set<Tab>(['identity', 'behavior', 'limits'])

export default function AgentsPage() {
    return (
        <Suspense fallback={
            <div className="flex items-center gap-2 py-8 text-sm text-text-muted">
                <RefreshCw className="h-4 w-4 animate-spin" /> Loading agents…
            </div>
        }>
            <AgentsContent />
        </Suspense>
    )
}

function AgentsContent() {
    const { workspaceId: ctxId } = useWorkspace()
    const { isAdvanced } = useViewMode()
    const confirmAction = useConfirm()
    const WS_ID = ctxId || (process.env.NEXT_PUBLIC_DEFAULT_WORKSPACE ?? '')
    const searchParams = useSearchParams()

    const initialTab = (['identity', 'behavior', 'limits', 'quality', 'history'].includes(searchParams.get('tab') ?? '')
        ? searchParams.get('tab')!
        : 'identity') as Tab

    const [tab, setTab] = useState<Tab>(initialTab)

    useEffect(() => {
        if (!isAdvanced && !SIMPLE_TABS.has(tab)) setTab('identity')
    }, [isAdvanced, tab])

    const [agentStatus, setAgentStatus] = useState<AgentStatusLocal | null>(null)
    const [settings, setSettings] = useState<WorkspaceSettings>({})
    const [workspaceName, setWorkspaceName] = useState('')
    const [workspaceId, setWorkspaceId] = useState('')
    const [loading, setLoading] = useState(true)
    const [saving, setSaving] = useState(false)
    const [saved, setSaved] = useState(false)
    const [showWsWarning, setShowWsWarning] = useState(false)

    const [showPersonalityQuiz, setShowPersonalityQuiz] = useState(false)
    const [dirty, setDirty] = useState(false)
    useUnsavedChanges(dirty)

    const [groups, setGroups] = useState<GroupDef[]>([])
    const [rules, setRules] = useState<BehaviorRule[]>([])
    const [resolvedRules, setResolvedRules] = useState<ResolvedRule[]>([])
    const [behaviorLoading, setBehaviorLoading] = useState(false)
    const [behaviorError, setBehaviorError] = useState<string | null>(null)
    const [inheritanceMode, setInheritanceMode] = useState(false)
    const [refreshTick, setRefreshTick] = useState(0)
    const [showAdvanced, setShowAdvanced] = useState(false)
    const behaviorLoaded = useRef(false)

    const fetchCore = useCallback(async () => {
        setLoading(true)
        try {
            const [statusRes, wsRes] = await Promise.all([
                fetch(`${API}/api/v1/agent/status`),
                WS_ID ? fetch(`${API}/api/v1/workspaces/${WS_ID}`) : Promise.resolve(null),
            ])
            if (statusRes.ok) setAgentStatus(await statusRes.json() as AgentStatusLocal)
            if (wsRes?.ok) {
                const ws = await wsRes.json() as { id: string; name: string; settings: WorkspaceSettings }
                setWorkspaceId(ws.id)
                setWorkspaceName(ws.name)
                setSettings(ws.settings ?? {})
            }
        } finally {
            setLoading(false)
        }
    }, [WS_ID])

    const fetchBehavior = useCallback(async () => {
        if (!WS_ID) return
        setBehaviorLoading(true)
        setBehaviorError(null)
        try {
            const [groupsRes, rulesRes, resolvedRes] = await Promise.all([
                fetch(`${API}/api/v1/behavior/${WS_ID}/groups`),
                fetch(`${API}/api/v1/behavior/${WS_ID}`),
                fetch(`${API}/api/v1/behavior/${WS_ID}/resolve`),
            ])
            if (!groupsRes.ok || !rulesRes.ok) throw new Error('Failed to load behavior data')
            const g = (await groupsRes.json() as { groups: GroupDef[] }).groups
            const r = (await rulesRes.json() as { rules: BehaviorRule[] }).rules
            const resolved = resolvedRes.ok ? (await resolvedRes.json() as { rules: ResolvedRule[] }).rules : []
            setGroups(g.sort((a, b) => a.displayOrder - b.displayOrder))
            setRules(r)
            setResolvedRules(resolved)
        } catch (e) {
            setBehaviorError(e instanceof Error ? e.message : 'Unknown error')
        } finally {
            setBehaviorLoading(false)
        }
    }, [WS_ID])

    useEffect(() => { void fetchCore() }, [fetchCore])

    useEffect(() => {
        if (tab === 'behavior' && !behaviorLoaded.current) {
            behaviorLoaded.current = true
            void fetchBehavior()
        }
    }, [tab, fetchBehavior])

    useEffect(() => {
        if (!workspaceId && !loading) {
            const t = setTimeout(() => setShowWsWarning(true), 600)
            return () => clearTimeout(t)
        }
        setShowWsWarning(false)
    }, [workspaceId, loading])

    async function handleSave() {
        if (!workspaceId) return
        setSaving(true)
        try {
            const payloadSettings: Record<string, unknown> = {
                agentName: settings.agentName,
                agentTagline: settings.agentTagline,
                agentAvatar: settings.agentAvatar,
                agentPersona: settings.agentPersona,
                defaultModel: settings.defaultModel,
                systemPromptExtra: settings.systemPromptExtra,
                maxStepsPerTask: settings.maxStepsPerTask,
                tokenBudgetPerTask: settings.tokenBudgetPerTask,
                maxRetries: settings.maxRetries,
                costCeilingUsd: settings.costCeilingUsd,
                autoApproveThreshold: settings.autoApproveThreshold,
                safeMode: settings.safeMode,
                readOnlyMode: settings.readOnlyMode,
                ensembleSize: settings.ensembleSize,
                dissentThreshold: settings.dissentThreshold,
            }
            await fetch(`${API}/api/v1/workspaces/${workspaceId}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: workspaceName, settings: payloadSettings }),
            })
            setSaved(true)
            setDirty(false)
            setTimeout(() => setSaved(false), 2000)
        } finally {
            setSaving(false)
        }
    }

    function updateSetting<K extends keyof WorkspaceSettings>(key: K, value: WorkspaceSettings[K]) {
        setSettings(s => ({ ...s, [key]: value }))
        setDirty(true)
    }

    const handleRuleUpdate = useCallback(async (id: string, value: RuleValue) => {
        if (!WS_ID) return
        await fetch(`${API}/api/v1/behavior/${WS_ID}/rules/${id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ value }),
        })
        setRules(prev => prev.map(r => r.id === id ? { ...r, value } : r))
        setRefreshTick(t => t + 1)
    }, [WS_ID])

    const handleRuleDelete = useCallback(async (id: string) => {
        if (!WS_ID) return
        if (!await confirmAction({ title: 'Delete rule', description: 'Delete this behavior rule? This cannot be undone.', confirmLabel: 'Delete', variant: 'danger' })) return
        await fetch(`${API}/api/v1/behavior/${WS_ID}/rules/${id}`, { method: 'DELETE' })
        setRules(prev => prev.filter(r => r.id !== id))
        setRefreshTick(t => t + 1)
    }, [WS_ID])

    const handleRuleAdd = useCallback(async (partial: Partial<BehaviorRule>) => {
        if (!WS_ID) return
        const res = await fetch(`${API}/api/v1/behavior/${WS_ID}/rules`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(partial),
        })
        if (res.ok) {
            const rule = await res.json() as BehaviorRule
            setRules(prev => [...prev, rule])
            setRefreshTick(t => t + 1)
        }
    }, [WS_ID])

    const showSaveButton = tab === 'identity' || tab === 'limits' || tab === 'quality'

    return (
        <div className="flex flex-col gap-8 max-w-5xl">
            {/* Page header */}
            <div>
                <h1 className="text-2xl font-medium tracking-tight text-text-primary">Your Agent</h1>
                <p className="mt-0.5 text-sm text-text-muted">
                    Configure your workspace's primary AI agent — personality, behavior, model, and limits.
                </p>
            </div>

            {/* ── Workspace Primary Agent ────────────────────────────────── */}
            <section className="flex flex-col gap-4">
                <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                        <Bot className="h-4 w-4 text-azure" />
                        <h2 className="text-sm font-medium uppercase tracking-wider text-text-secondary">Workspace Primary Agent</h2>
                    </div>
                    <ViewModeToggle />
                </div>

                {/* Hero card */}
                <div className="rounded-sm border border-azure-800/30 bg-azure/10 p-5">
                    <div className="flex flex-col sm:flex-row sm:items-center gap-4">
                        <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-sm bg-surface-1 border border-border text-4xl">
                            {settings.agentAvatar ?? '🤖'}
                        </div>
                        <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 flex-wrap">
                                <h3 className="text-xl font-medium text-text-primary truncate">{settings.agentName || 'Plexo'}</h3>
                                {agentStatus && (
                                    <span className={`inline-flex items-center rounded-sm border px-2 py-0.5 text-[11px] font-mono font-medium uppercase tracking-wider ${agentStatus.status === 'running' ? 'border-green-800/40 bg-green-dim text-green' : 'border-border bg-surface-1 text-text-muted'}`}>
                                        [{agentStatus.status}]
                                    </span>
                                )}
                            </div>
                            <p className="text-sm text-text-muted truncate mt-0.5">
                                {settings.agentTagline || 'Your workspace primary agent'}
                            </p>
                            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2 text-xs text-text-muted">
                                {settings.defaultModel && (
                                    <span className="inline-flex items-center gap-1">
                                        <Brain className="h-3 w-3" />
                                        <span className="font-mono text-text-secondary">{settings.defaultModel}</span>
                                    </span>
                                )}
                                {agentStatus?.currentTask && (
                                    <span>task {agentStatus.currentTask.slice(0, 8)}</span>
                                )}
                                {agentStatus && (
                                    <span>{agentStatus.sessionCount} sessions</span>
                                )}
                            </div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                            <button onClick={() => void fetchCore()} disabled={loading}
                                title="Refresh"
                                className="flex items-center justify-center rounded-sm border border-border bg-surface-1 p-2 text-text-muted hover:text-text-secondary transition-colors min-h-[40px] min-w-[40px]">
                                <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
                            </button>
                            {showSaveButton && (
                                <button onClick={() => void handleSave()} disabled={saving || loading || !workspaceId}
                                    className="flex items-center justify-center gap-1.5 rounded-sm bg-azure px-3 py-2 text-sm font-medium text-text-primary hover:bg-azure/90 disabled:opacity-50 transition-colors min-h-[40px]">
                                    {saving ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : saved ? <Check className="h-3.5 w-3.5" /> : <Save className="h-3.5 w-3.5" />}
                                    {saved ? 'Saved' : 'Save'}
                                </button>
                            )}
                        </div>
                    </div>
                </div>

                {showWsWarning && (
                    <div className="flex items-center gap-2 rounded-sm border border-amber-800/40 bg-amber-dim px-4 py-3 text-sm text-amber">
                        <AlertCircle className="h-4 w-4 shrink-0" />
                        No workspace selected. Go to Settings &gt; Workspace to create or select one before configuring your agent.
                    </div>
                )}

                {/* Tabs */}
                <div className="flex gap-1 border-b border-border overflow-x-auto pb-px [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
                    {TABS.filter(t => isAdvanced || SIMPLE_TABS.has(t.id)).map(({ id, label, icon: Icon }) => (
                        <button key={id} onClick={() => setTab(id)}
                            className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px shrink-0 w-auto min-h-[44px] ${tab === id ? 'border-azure text-azure' : 'border-transparent text-text-muted hover:text-text-secondary'}`}>
                            <Icon className="h-4 w-4 sm:h-3.5 sm:w-3.5" />
                            {label}
                        </button>
                    ))}
                </div>

                {/* Identity tab */}
                {tab === 'identity' && (
                    loading ? (
                        <div className="flex items-center gap-2 py-8 text-sm text-text-muted"><RefreshCw className="h-4 w-4 animate-spin" /> Loading…</div>
                    ) : (
                        <div className="flex flex-col gap-4">
                            <Section title="Personality" icon={Sparkles}>
                                <div className="flex flex-col sm:flex-row items-center gap-4">
                                    <div className="flex flex-col gap-2 w-full sm:w-auto">
                                        <label className="text-sm font-medium text-text-secondary">Avatar</label>
                                        <div className="flex flex-row justify-between sm:justify-start gap-1.5 w-full overflow-x-auto pb-2 sm:pb-0 [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
                                            {['🤖', '🧠', '⚡', '🦾', '🌟', '👾', '🔱', '🦊', '🐉', '🔮'].map((emoji) => (
                                                <button key={emoji} onClick={() => updateSetting('agentAvatar', emoji)}
                                                    className={`min-h-[44px] min-w-[44px] shrink-0 rounded-sm text-lg transition-all ${(settings.agentAvatar ?? '🤖') === emoji ? 'bg-azure/30 ring-1 ring-azure' : 'bg-surface-2 hover:bg-surface-2'}`}>
                                                    {emoji}
                                                </button>
                                            ))}
                                        </div>
                                    </div>
                                    <div className="flex flex-col items-center gap-1.5 sm:ml-auto w-full sm:w-auto pt-4 sm:pt-0 border-t border-border sm:border-0 order-first sm:order-none">
                                        <div className="flex h-16 w-16 sm:h-14 sm:w-14 items-center justify-center rounded-full   text-3xl">
                                            {settings.agentAvatar ?? '🤖'}
                                        </div>
                                        <span className="text-sm sm:text-xs text-text-primary sm:text-text-muted font-medium">{settings.agentName || 'Plexo'}</span>
                                        {settings.agentTagline && <span className="text-[11px] text-text-secondary sm:text-text-muted italic max-w-[200px] sm:max-w-[100px] text-center truncate">{settings.agentTagline}</span>}
                                    </div>
                                </div>
                                <Field label="Agent name" description="How the agent refers to itself in messages.">
                                    <Input value={settings.agentName ?? ''} onChange={e => updateSetting('agentName', e.target.value || undefined)} placeholder="Plexo" />
                                </Field>
                                <Field label="Tagline" description="Short descriptor shown under the agent name (optional).">
                                    <Input value={settings.agentTagline ?? ''} onChange={e => updateSetting('agentTagline', e.target.value || undefined)} placeholder="Your autonomous ops agent" />
                                </Field>
                            </Section>

                            <Section title="Model" icon={Brain}>
                                <Field label="Default model override" description="Overrides the provider registry default. Leave blank to use the registry's model routing.">
                                    <Input value={settings.defaultModel ?? ''} onChange={e => updateSetting('defaultModel', e.target.value || undefined)} placeholder="claude-sonnet-4-5" />
                                    {settings.defaultModel && (
                                        <div className="mt-1">
                                            <CapabilityList caps={getModelCapabilities(settings.defaultModel)} />
                                        </div>
                                    )}
                                </Field>
                            </Section>

                            <div className="rounded-sm border border-border/60 bg-surface-1/20 p-4 flex items-center justify-between gap-4">
                                <div>
                                    <p className="text-sm font-medium text-text-secondary">Personality quiz</p>
                                    <p className="text-xs text-text-muted mt-0.5">Quickly reconfigure communication style, detail level, and persona with a 30-second quiz.</p>
                                </div>
                                <button
                                    onClick={() => setShowPersonalityQuiz(true)}
                                    className="shrink-0 flex items-center gap-1.5 rounded-sm border border-azure/30 bg-azure/5 px-3 py-2 text-xs font-medium text-azure hover:bg-azure/10 transition-colors"
                                >
                                    <Sparkles className="h-3.5 w-3.5" />
                                    Reconfigure
                                </button>
                            </div>

                            <div className="flex items-start gap-2 text-xs text-text-muted px-1">
                                <Bot className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                                Changes take effect on the next task started after saving.
                            </div>

                            <PersonalityReconfigureModal open={showPersonalityQuiz} onClose={() => { setShowPersonalityQuiz(false); window.location.reload() }} />
                        </div>
                    )
                )}

                {/* Behavior tab */}
                {tab === 'behavior' && (
                    <div className="flex flex-col gap-5">
                        <Section title="Persona" icon={User}>
                            <Field label="Who is this agent?" description="Describe the agent's role, personality, and approach. This becomes the core of its system prompt.">
                                <Textarea rows={4} value={settings.agentPersona ?? ''}
                                    onChange={e => updateSetting('agentPersona', e.target.value || undefined)}
                                    placeholder="You are a senior full-stack engineer with deep expertise in TypeScript, React, and distributed systems. You are methodical, prefer explicit types over inference, and always write tests before committing code."
                                />
                            </Field>
                        </Section>

                        <Section title="Context" icon={BookOpen}>
                            <Field label="What should the agent know about your stack or domain?" description="Tech stack, conventions, project context, constraints. Injected into every task.">
                                <Textarea rows={5} value={settings.systemPromptExtra ?? ''}
                                    onChange={e => updateSetting('systemPromptExtra', e.target.value || undefined)}
                                    placeholder="TypeScript monorepo using pnpm workspaces. Main stack: Next.js 15, Drizzle ORM, PostgreSQL, Redis. All new files use strict mode. Prefer functional patterns over classes."
                                />
                            </Field>
                        </Section>

                        <div className="flex items-center justify-end gap-2">
                            <button onClick={() => void handleSave()} disabled={saving || !workspaceId}
                                className="flex items-center gap-1.5 rounded-sm bg-azure px-3 py-2 text-sm font-medium text-text-primary hover:bg-azure/90 disabled:opacity-50 transition-colors">
                                {saving ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : saved ? <Check className="h-3.5 w-3.5 text-azure" /> : <Save className="h-3.5 w-3.5" />}
                                {saved ? 'Saved' : 'Save changes'}
                            </button>
                        </div>

                        {/* Advanced rules accordion */}
                        <div className="rounded-sm border border-border overflow-hidden">
                            <button onClick={() => setShowAdvanced(v => !v)}
                                className="w-full flex items-center gap-3 px-5 py-4 hover:bg-surface-2/20 transition-colors text-left">
                                <Settings2 className="h-4 w-4 text-text-muted" />
                                <div className="flex-1">
                                    <span className="text-sm font-medium text-text-secondary">Advanced rules</span>
                                    <p className="text-xs text-text-muted mt-0.5">Fine-grained layered rules for communication style, operational limits, quality gates, and more.</p>
                                </div>
                                <ChevronDown className={`h-4 w-4 text-text-muted transition-transform ${showAdvanced ? 'rotate-180' : ''}`} />
                            </button>

                            {showAdvanced && (
                                <div className="px-5 pb-5 flex flex-col gap-4 border-t border-border">
                                    <div className="flex items-center justify-between pt-4">
                                        <div className="flex items-center gap-3 text-xs text-text-muted">
                                            <Layers className="h-3.5 w-3.5" />
                                            <span>Rule sources:</span>
                                            {(['platform', 'workspace', 'project', 'task'] as RuleSource[]).map(s => (
                                                <SourceBadge key={s} source={s} />
                                            ))}
                                            <span className="text-text-muted">— later layers override earlier ones</span>
                                        </div>
                                        <button onClick={() => setInheritanceMode(m => !m)}
                                            className={`flex items-center gap-1.5 rounded-sm border px-3 py-1.5 text-sm font-medium transition-all ${inheritanceMode ? 'border-azure/40 bg-azure/20 text-azure' : 'border-border text-text-muted hover:text-text-secondary'}`}>
                                            <ArrowLeftRight className="h-3.5 w-3.5" />
                                            {inheritanceMode ? 'Inheritance view' : 'Inheritance view'}
                                        </button>
                                    </div>

                                    {behaviorError && (
                                        <div className="flex items-center gap-2 rounded-sm border border-red-800/40 bg-red-dim px-4 py-3 text-sm text-red">
                                            <X className="h-4 w-4 shrink-0" />
                                            {behaviorError}
                                            <button onClick={() => void fetchBehavior()} className="ml-auto text-xs underline">Retry</button>
                                        </div>
                                    )}

                                    {behaviorLoading ? (
                                        <div className="flex items-center gap-2 py-6 text-sm text-text-muted">
                                            <RefreshCw className="h-4 w-4 animate-spin" /> Loading rules…
                                        </div>
                                    ) : (
                                        <div className="flex flex-col gap-3">
                                            {groups.map(group => (
                                                <BehaviorCard key={group.id} group={group} rules={rules}
                                                    inheritanceMode={inheritanceMode} resolvedRules={resolvedRules}
                                                    onUpdate={handleRuleUpdate} onDelete={handleRuleDelete} onAdd={handleRuleAdd}
                                                />
                                            ))}
                                        </div>
                                    )}

                                    {!behaviorLoading && WS_ID && (
                                        <div className="flex flex-col sm:flex-row items-center justify-between gap-4 pt-4 mt-2 border-t border-border">
                                            <SystemPromptPreview workspaceId={WS_ID} refreshTick={refreshTick} />
                                            <div className="flex gap-2">
                                                <a href={`${API}/api/v1/behavior/${WS_ID}/rules/export`} download="AGENTS.md" className="flex items-center gap-2 px-3 py-2 rounded-sm border border-border bg-surface-1 hover:bg-surface-2 text-xs text-text-secondary transition-colors whitespace-nowrap">
                                                    Export AGENTS.md
                                                </a>
                                                <button onClick={async () => {
                                                    const input = document.createElement('input')
                                                    input.type = 'file'
                                                    input.accept = '.md'
                                                    input.onchange = async (e) => {
                                                        const file = (e.target as HTMLInputElement).files?.[0]
                                                        if (!file) return
                                                        const content = await file.text()
                                                        await fetch(`${API}/api/v1/behavior/${WS_ID}/rules/import`, {
                                                            method: 'POST',
                                                            headers: { 'Content-Type': 'application/json' },
                                                            body: JSON.stringify({ content })
                                                        })
                                                        fetchBehavior()
                                                    }
                                                    input.click()
                                                }} className="flex items-center gap-2 px-3 py-2 rounded-sm border border-azure/30 bg-azure/20 hover:bg-azure/40 text-xs text-azure transition-colors whitespace-nowrap">
                                                    Import AGENTS.md
                                                </button>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    </div>
                )}

                {/* Limits tab */}
                {tab === 'limits' && (
                    loading ? (
                        <div className="flex items-center gap-2 py-8 text-sm text-text-muted"><RefreshCw className="h-4 w-4 animate-spin" /> Loading…</div>
                    ) : (
                        <div className="flex flex-col gap-4">
                            <Section title="Execution" icon={Zap}>
                                <div className="flex flex-col gap-4">
                                    <div className="grid grid-cols-2 gap-4">
                                        <Field label="Max steps per task" description="Hard stop — the agent won't make more than this many tool calls in a single task.">
                                            <Input type="number" min={1} max={100}
                                                value={settings.maxStepsPerTask ?? 20}
                                                onChange={e => updateSetting('maxStepsPerTask', parseInt(e.target.value) || 20)}
                                            />
                                        </Field>
                                        <Field label="Token budget per task" description="Total input + output tokens allowed. Task halts if exceeded.">
                                            <Input type="number" min={1000} step={1000}
                                                value={settings.tokenBudgetPerTask ?? 50000}
                                                onChange={e => updateSetting('tokenBudgetPerTask', parseInt(e.target.value) || 50000)}
                                            />
                                        </Field>
                                    </div>

                                    <Field label="Max retries on failure" description="Number of times the agent retries a failed step before marking the task as failed.">
                                        <select
                                            value={settings.maxRetries ?? 3}
                                            onChange={e => updateSetting('maxRetries', parseInt(e.target.value))}
                                            className="rounded-sm border border-border bg-surface-1 px-3 py-2 text-sm text-text-primary focus:border-azure focus-ring w-fit"
                                        >
                                            {[0, 1, 2, 3, 5].map((v) => (
                                                <option key={v} value={v}>{v}</option>
                                            ))}
                                        </select>
                                    </Field>
                                </div>
                            </Section>

                            <Section title="Cost & Safety" icon={Shield}>
                                <Field label="Weekly spend cap (USD)" description="Agent tasks pause automatically when this amount is reached in a 7-day window.">
                                    <div className="flex items-center gap-2">
                                        <span className="text-sm text-text-muted">$</span>
                                        <Input type="number" min={0} step={0.5}
                                            value={settings.costCeilingUsd ?? 10}
                                            onChange={e => updateSetting('costCeilingUsd', parseFloat(e.target.value) || 10)}
                                            className="w-28"
                                        />
                                        <span className="text-xs text-text-muted">per week</span>
                                    </div>
                                </Field>

                                <Field label="Low-confidence tasks" description="When the agent isn't sure about a result, what should happen?">
                                    <FieldSelect
                                        value={settings.autoApproveThreshold === undefined || settings.autoApproveThreshold >= 0.7 ? 'auto' : settings.autoApproveThreshold <= 0.3 ? 'always_ask' : 'manual'}
                                        onChange={e => {
                                            const v = e.target.value
                                            if (v === 'auto') updateSetting('autoApproveThreshold', 0.7)
                                            else if (v === 'always_ask') updateSetting('autoApproveThreshold', 0.0)
                                            else updateSetting('autoApproveThreshold', 0.5)
                                        }}
                                        className="rounded-sm border border-border bg-surface-1 px-3 py-2 text-sm text-text-primary focus:border-azure focus-ring w-fit"
                                    >
                                        <option value="auto">Auto-approve (default)</option>
                                        <option value="manual">Ask me when uncertain</option>
                                        <option value="always_ask">Always ask before completing</option>
                                    </FieldSelect>
                                </Field>

                                <Field label="Safe mode" description="When enabled, all file-write and destructive tool calls require your approval before executing.">
                                    <div className="flex items-center gap-3">
                                        <Toggle checked={!!settings.safeMode} onChange={() => updateSetting('safeMode', !settings.safeMode)} />
                                        <span className="text-sm text-text-secondary">{settings.safeMode ? 'Enabled — writes need approval' : 'Disabled'}</span>
                                    </div>
                                </Field>

                                <Field label="Read-only mode" description="Completely disables every tool that mutates external state — GitHub push, Slack send, Notion create, SSH exec, etc. The agent can still read, search, and analyze. Use for safe testing, demos, or observation without risk of side-effects.">
                                    <div className="flex items-center gap-3">
                                        <Toggle checked={!!settings.readOnlyMode} onChange={() => updateSetting('readOnlyMode', !settings.readOnlyMode)} />
                                        <span className="text-sm text-text-secondary">{settings.readOnlyMode ? 'Enabled — agent cannot change anything' : 'Disabled'}</span>
                                    </div>
                                </Field>
                            </Section>

                            <div className="flex items-start gap-2 text-xs text-text-muted px-1">
                                <DollarSign className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                                Limits are enforced at task start. Changes take effect on the next task.
                            </div>
                        </div>
                    )
                )}

                {tab === 'quality' && <QualityTab settings={settings} updateSetting={updateSetting} />}

                {tab === 'orchestration' && (
                    <div className="flex flex-col gap-6 animate-in fade-in slide-in-from-bottom-2 duration-300">
                        <ParallelStatusPanel />
                    </div>
                )}

                {tab === 'extensions' && WS_ID && <ExtensionPromptsTab workspaceId={WS_ID} />}
                {tab === 'history' && WS_ID && <HistoryTab workspaceId={WS_ID} />}
                {tab === 'userself' && <UserSelfTab workspaceId={WS_ID} />}
            </section>

            {/* ── Additional Extensions ─────────────────────────────────── */}
            <AdditionalAgentsSection workspaceId={WS_ID} />
        </div>
    )
}

// ── Additional Extensions ────────────────────────────────────────────────

function AdditionalAgentsSection({ workspaceId }: { workspaceId: string }) {
    const [extensions, setExtensions] = useState<Extension[]>([])
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)

    const lf = useListFilter(['status'], 'name_asc')
    const { search, filterValues, clearAll } = lf

    const fetchAgents = useCallback(async () => {
        if (!workspaceId) return
        setLoading(true)
        setError(null)
        try {
            const res = await fetch(`${API_BASE}/api/v1/extensions?workspaceId=${workspaceId}&type=agent`)
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            const data = await res.json() as { items: Extension[] }
            setExtensions(data.items)
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to load agents')
        } finally {
            setLoading(false)
        }
    }, [workspaceId])

    useEffect(() => { void fetchAgents() }, [fetchAgents])

    async function handleToggle(id: string, enabled: boolean) {
        const res = await fetch(`${API_BASE}/api/v1/extensions/${id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceId, enabled }),
        })
        if (res.ok) {
            setExtensions((prev) => prev.map((p) => p.id === id ? { ...p, enabled } : p))
        } else {
            const msg = await res.text().catch(() => '')
            setError(`Toggle failed: ${res.status} ${msg}`)
        }
    }

    const filtered = extensions.filter((p) => {
        if (filterValues.status === 'enabled' && !p.enabled) return false
        if (filterValues.status === 'disabled' && p.enabled) return false
        if (!search.trim()) return true
        const q = search.toLowerCase()
        return p.name.toLowerCase().includes(q) || p.manifest?.description?.toLowerCase().includes(q)
    }).sort((a, b) => {
        if (lf.sort === 'name_desc') return b.name.localeCompare(a.name)
        return a.name.localeCompare(b.name)
    })

    return (
        <section className="flex flex-col gap-4 pt-4 border-t border-border">
            <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
                <div className="min-w-0">
                    <div className="flex items-center gap-2">
                        <Layers className="h-4 w-4 text-text-muted" />
                        <h2 className="text-sm font-medium uppercase tracking-wider text-text-secondary">Agent Extensions</h2>
                    </div>
                    <p className="mt-1 text-sm text-text-muted">
                        Agent extensions add specialized expertise to your primary agent. They don't run independently — they enhance what your agent can do. Install from the Hub.
                    </p>
                </div>
                <button
                    onClick={() => void fetchAgents()}
                    disabled={loading}
                    title="Refresh"
                    className="flex items-center gap-1.5 rounded-sm border border-border px-3 py-2 text-xs font-medium text-text-secondary hover:border-border hover:text-text-primary transition-colors disabled:opacity-40 shrink-0"
                >
                    <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
                    <span className="hidden sm:inline">Refresh</span>
                </button>
            </div>

            <div className="rounded-sm border border-azure-800/30 bg-azure/10 px-4 py-3 flex items-start gap-3">
                <Info className="h-4 w-4 text-azure shrink-0 mt-0.5" />
                <div>
                    <p className="text-xs font-medium text-azure mb-0.5">How Agent Extensions Work</p>
                    <p className="text-xs text-azure/70">
                        Agent extensions add specialized personas and domain expertise to your primary agent. They don't
                        create separate, independent agents — they enhance your primary agent's capabilities for specific
                        domains. Skills, tools, channels, and connectors are managed on the <a href="/app/extensions" className="underline hover:text-azure">Extensions page</a>.
                    </p>
                </div>
            </div>

            {error && (
                <div role="alert" className="rounded-sm border border-red-800/50 bg-red-dim px-3 py-2 flex items-center gap-2 text-xs text-red">
                    <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                    {error}
                </div>
            )}

            {extensions.length > 0 && (
                <ListToolbar
                    hook={lf}
                    placeholder="Search extensions..."
                    dimensions={[
                        {
                            key: 'status',
                            label: 'Status',
                            options: [
                                { value: 'enabled', label: 'Enabled' },
                                { value: 'disabled', label: 'Disabled' },
                            ],
                        },
                    ]}
                    sortOptions={[
                        { label: 'Name: A → Z', value: 'name_asc' },
                        { label: 'Name: Z → A', value: 'name_desc' },
                    ]}
                />
            )}

            {loading ? (
                <div className="flex items-center justify-center py-12">
                    <RefreshCw className="h-5 w-5 text-text-muted animate-spin" />
                </div>
            ) : extensions.length === 0 ? (
                <EmptyState
                    icon={Bot}
                    headline="No agent extensions installed"
                    description="Your primary agent handles most work. Install agent extensions to add specialized personas."
                />
            ) : filtered.length === 0 ? (
                <div className="rounded-sm border border-border bg-surface-1/40 py-10 text-center">
                    <p className="text-sm text-text-muted">No results match your filters.</p>
                    <button onClick={clearAll} className="mt-3 flex items-center gap-1.5 rounded-sm border border-border px-3 py-1.5 text-sm text-text-secondary hover:text-text-primary transition-colors mx-auto">
                        Clear search
                    </button>
                </div>
            ) : (
                <div className="flex flex-col gap-2">
                    <div className="flex items-center justify-between mb-1">
                        <p className="text-xs text-text-muted">{extensions.filter((p) => p.enabled).length} / {extensions.length} enabled</p>
                    </div>
                    {filtered.map((a) => (
                        <AgentCard key={a.id} agent={a} onToggle={handleToggle} />
                    ))}
                </div>
            )}
        </section>
    )
}

function AgentCard({ agent, onToggle }: { agent: Extension; onToggle: (id: string, enabled: boolean) => Promise<void> }) {
    const [expanded, setExpanded] = useState(false)
    const [toggling, setToggling] = useState(false)
    const manifest = agent.manifest

    // Phase 7 — identity override (per-workspace). Stored under settings.identity.
    const [override, setOverride] = useState<ExtensionIdentityOverride>(
        (agent.settings?.identity ?? {}) as ExtensionIdentityOverride,
    )
    const [savingIdentity, setSavingIdentity] = useState(false)
    const [identitySaved, setIdentitySaved] = useState(false)
    const { workspaceId } = useWorkspace()

    // Resolved identity: override > manifest > extension name
    const displayName = override.displayName || manifest?.displayName || agent.name
    const avatar = override.avatar || manifest?.icon || '🤖'
    const isEmojiAvatar = typeof avatar === 'string' && /^\p{Extended_Pictographic}/u.test(avatar)

    // Phase 7 — last N audit rows for this extension.
    const [auditRows, setAuditRows] = useState<AuditRow[] | null>(null)
    const [auditLoading, setAuditLoading] = useState(false)

    useEffect(() => {
        if (!expanded || !workspaceId || auditRows !== null) return
        setAuditLoading(true)
        void (async () => {
            try {
                const params = new URLSearchParams({ workspaceId, extensionId: agent.name, limit: '5' })
                const res = await fetch(`${API_BASE}/api/v1/extension-audit?${params}`)
                if (res.ok) {
                    const data = await res.json() as { items: AuditRow[] }
                    setAuditRows(data.items ?? [])
                } else {
                    setAuditRows([])
                }
            } catch { setAuditRows([]) }
            finally { setAuditLoading(false) }
        })()
    }, [expanded, workspaceId, agent.name, auditRows])

    async function handleToggle() {
        setToggling(true)
        try { await onToggle(agent.id, !agent.enabled) } finally { setToggling(false) }
    }

    async function handleSaveIdentity() {
        if (!workspaceId) return
        setSavingIdentity(true)
        try {
            const res = await fetch(`${API_BASE}/api/v1/extensions/${agent.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ workspaceId, settings: { identity: override } }),
            })
            if (res.ok) {
                setIdentitySaved(true)
                setTimeout(() => setIdentitySaved(false), 1500)
            }
        } finally {
            setSavingIdentity(false)
        }
    }

    return (
        <div className={`rounded-sm border transition-all ${agent.enabled
            ? 'border-border/60 bg-surface-1/60'
            : 'border-border/40 bg-surface-1/20 opacity-70'
            }`}>
            <div
                className="flex items-center gap-3 px-4 py-3 cursor-pointer"
                onClick={() => setExpanded((e) => !e)}
            >
                <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-sm ${agent.enabled ? 'bg-azure/20' : 'bg-surface-2'} ${isEmojiAvatar ? 'text-xl' : ''}`}>
                    {isEmojiAvatar
                        ? <span>{avatar}</span>
                        : <Bot className={`h-4.5 w-4.5 ${agent.enabled ? 'text-azure' : 'text-text-muted'}`} />
                    }
                </div>
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-text-primary truncate">{displayName}</span>
                        <span className="text-[11px] font-mono text-text-muted shrink-0">v{agent.version}</span>
                        <span className="text-[11px] rounded border border-azure-800/30 bg-azure/10 px-1.5 py-0.5 text-azure font-medium shrink-0">Agent</span>
                        {manifest?.trust && (
                            <span className="text-[11px] rounded border border-border px-1.5 py-0.5 text-text-muted shrink-0">{manifest.trust}</span>
                        )}
                    </div>
                    <div className="flex items-center gap-2 text-xs text-text-muted truncate">
                        <span className="font-mono">{agent.name}</span>
                        {manifest?.description && <span className="truncate">— {manifest.description}</span>}
                    </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                    <button
                        onClick={(e) => { e.stopPropagation(); void handleToggle() }}
                        disabled={toggling}
                        className="flex items-center gap-1 rounded-sm border border-border px-2.5 py-1 text-xs transition-colors hover:border-border disabled:opacity-40"
                    >
                        {toggling ? (
                            <RefreshCw className="h-3.5 w-3.5 animate-spin text-text-muted" />
                        ) : agent.enabled ? (
                            <><ToggleRight className="h-4 w-4 text-azure" /><span className="text-azure">Enabled</span></>
                        ) : (
                            <><ToggleLeft className="h-4 w-4 text-text-muted" /><span className="text-text-muted">Disabled</span></>
                        )}
                    </button>
                    {expanded
                        ? <ChevronDown className="h-3.5 w-3.5 text-text-muted" />
                        : <ChevronRight className="h-3.5 w-3.5 text-text-muted" />
                    }
                </div>
            </div>

            {expanded && (
                <div className="border-t border-border px-4 py-3 flex flex-col gap-3">
                    {(manifest?.capabilities ?? []).length > 0 && (
                        <div>
                            <p className="text-[11px] font-medium uppercase tracking-wider text-text-muted mb-1.5">Capabilities</p>
                            <div className="flex flex-wrap gap-1">
                                {manifest!.capabilities!.map((c) => (
                                    <span key={c} className="rounded border border-amber-800/40 bg-amber-dim px-2 py-0.5 text-[11px] font-mono text-amber">{c}</span>
                                ))}
                            </div>
                        </div>
                    )}

                    {manifest?.modelRequirements && (
                        <div>
                            <p className="text-[11px] font-medium uppercase tracking-wider text-text-muted mb-1.5 flex items-center gap-1">
                                <Cpu className="h-3 w-3" /> Model Requirements
                            </p>
                            <div className="flex flex-wrap gap-2 text-[11px] text-text-muted">
                                {manifest.modelRequirements.minimumContextWindow && (
                                    <span>Min context: <span className="text-text-secondary font-medium">{(manifest.modelRequirements.minimumContextWindow / 1000).toFixed(0)}k</span></span>
                                )}
                                {manifest.modelRequirements.requiresFunctionCalling && (
                                    <span className="text-text-secondary">Requires function calling</span>
                                )}
                                {manifest.modelRequirements.localModelAcceptable !== undefined && (
                                    <span>Local model: <span className="text-text-secondary font-medium">{manifest.modelRequirements.localModelAcceptable ? 'OK' : 'No'}</span></span>
                                )}
                                {manifest.modelRequirements.preferredProviders && (
                                    <span>Preferred: <span className="text-text-secondary font-medium">{manifest.modelRequirements.preferredProviders.join(', ')}</span></span>
                                )}
                            </div>
                        </div>
                    )}

                    {manifest?.escalation && (
                        <div>
                            <p className="text-[11px] font-medium uppercase tracking-wider text-text-muted mb-1.5 flex items-center gap-1">
                                <ShieldAlert className="h-3 w-3" /> Escalation
                            </p>
                            {manifest.escalation.irreversibleActions && manifest.escalation.irreversibleActions.length > 0 && (
                                <div className="flex flex-wrap gap-1">
                                    {manifest.escalation.irreversibleActions.map((a) => (
                                        <span key={a} className="rounded border border-red-800/40 bg-red-dim px-2 py-0.5 text-[11px] font-mono text-red">{a}</span>
                                    ))}
                                </div>
                            )}
                            {manifest.escalation.requestsStandingApprovals && (
                                <p className="text-[11px] text-text-muted mt-1">Requests standing approval capability</p>
                            )}
                        </div>
                    )}

                    {manifest?.dataResidency && (
                        <div className="flex items-center gap-2 text-[11px] text-text-muted">
                            <Globe className="h-3 w-3" />
                            <span>{manifest.dataResidency.sendsDataExternally ? 'Sends data externally' : 'Local only'}</span>
                        </div>
                    )}

                    {manifest?.agentHints?.taskTypes && manifest.agentHints.taskTypes.length > 0 && (
                        <div className="flex items-center gap-2 text-[11px] text-text-muted">
                            <Zap className="h-3 w-3" />
                            <span>Task types: {manifest.agentHints.taskTypes.join(', ')}</span>
                        </div>
                    )}

                    {/* Phase 7 — Identity override */}
                    <div className="rounded-sm border border-border/60 bg-surface-2/30 p-3 flex flex-col gap-2.5">
                        <div className="flex items-center gap-2">
                            <User className="h-3.5 w-3.5 text-text-muted" />
                            <p className="text-[11px] font-medium uppercase tracking-wider text-text-muted">Identity Override</p>
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                            <label className="flex flex-col gap-1">
                                <span className="text-[11px] text-text-muted">Display name</span>
                                <input
                                    type="text"
                                    value={override.displayName ?? ''}
                                    onChange={e => setOverride(o => ({ ...o, displayName: e.target.value || undefined }))}
                                    placeholder={manifest?.displayName ?? agent.name}
                                    className="rounded border border-border bg-surface-1 px-2 py-1 text-xs text-text-primary focus:border-azure focus-ring"
                                />
                            </label>
                            <label className="flex flex-col gap-1">
                                <span className="text-[11px] text-text-muted">Avatar (emoji or URL)</span>
                                <input
                                    type="text"
                                    value={override.avatar ?? ''}
                                    onChange={e => setOverride(o => ({ ...o, avatar: e.target.value || undefined }))}
                                    placeholder={manifest?.icon ?? '🤖'}
                                    className="rounded border border-border bg-surface-1 px-2 py-1 text-xs text-text-primary focus:border-azure focus-ring"
                                />
                            </label>
                        </div>
                        <label className="flex items-center gap-2 text-[11px] text-text-muted">
                            <input
                                type="checkbox"
                                checked={!!override.identityOverrideInChat}
                                onChange={e => setOverride(o => ({ ...o, identityOverrideInChat: e.target.checked }))}
                                className="rounded border-border"
                            />
                            Show this extension with its own identity in chat (instead of the primary agent&apos;s)
                        </label>
                        <div className="flex items-center gap-2">
                            <button
                                onClick={(e) => { e.stopPropagation(); void handleSaveIdentity() }}
                                disabled={savingIdentity || !workspaceId}
                                className="flex items-center gap-1 rounded border border-azure/40 bg-azure/20 px-2.5 py-1 text-[11px] font-medium text-azure hover:bg-azure/30 disabled:opacity-50"
                            >
                                {savingIdentity ? <RefreshCw className="h-3 w-3 animate-spin" /> : identitySaved ? <Check className="h-3 w-3" /> : <Save className="h-3 w-3" />}
                                {identitySaved ? 'Saved' : 'Save identity'}
                            </button>
                            {(override.displayName || override.avatar) && (
                                <button
                                    onClick={(e) => { e.stopPropagation(); setOverride({ identityOverrideInChat: override.identityOverrideInChat }) }}
                                    className="text-[11px] text-text-muted hover:text-text-primary underline"
                                >
                                    Reset to manifest defaults
                                </button>
                            )}
                        </div>
                    </div>

                    {/* Phase 7 — Audit preview */}
                    <div className="rounded-sm border border-border/60 bg-surface-2/30 p-3 flex flex-col gap-2">
                        <div className="flex items-center gap-2">
                            <History className="h-3.5 w-3.5 text-text-muted" />
                            <p className="text-[11px] font-medium uppercase tracking-wider text-text-muted">Recent activity</p>
                        </div>
                        {auditLoading ? (
                            <div className="flex items-center gap-1.5 py-1 text-[11px] text-text-muted">
                                <RefreshCw className="h-3 w-3 animate-spin" /> Loading…
                            </div>
                        ) : auditRows && auditRows.length > 0 ? (
                            <ul className="flex flex-col gap-0.5">
                                {auditRows.map(row => (
                                    <li key={row.id} className="flex items-center gap-2 text-[11px]">
                                        <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${row.outcome === 'success' ? 'bg-green' : row.outcome === 'failure' ? 'bg-red' : 'bg-amber'}`} />
                                        <span className="font-mono text-text-secondary truncate flex-1">{row.action}</span>
                                        <span className="font-mono text-text-muted truncate">{row.target}</span>
                                        <span className="text-text-muted shrink-0">{new Date(row.createdAt).toLocaleDateString()}</span>
                                    </li>
                                ))}
                            </ul>
                        ) : (
                            <p className="text-[11px] text-text-muted">No activity yet.</p>
                        )}
                    </div>

                    <div className="flex items-center gap-4 text-[11px] text-text-muted">
                        <span>Installed {new Date(agent.installedAt).toLocaleDateString()}</span>
                    </div>
                </div>
            )}
        </div>
    )
}
