'use client'

import { useState } from 'react'
import {
    Activity, ChevronDown, ChevronRight, CheckCircle2, XCircle,
    AlertTriangle, Clock, Shield, GitBranch, Bot,
} from 'lucide-react'

// ── Types ─────────────────────────────────────────────────────────────

interface CycleResult {
    cycle: number
    timestamp: string
    scenarios: { passed: number; failed: number }
    workloads: { passed: number; failed: number }
    sclEval: { recallAt5?: number; precisionAt5?: number; ndcgAt5?: number } | null
    security: string
    tests: string
    sloBreaches: number
}

interface Workload {
    id: string
    name: string
    passed: boolean
    latencyMs: number
    quality?: number
    error?: string
    timestamp: string
}

interface FixerEntry {
    timestamp?: string
    branch?: string
    failures?: unknown
    reports?: unknown[]
    total?: number
    improved?: number
    status?: string
    _created_at?: string
    [key: string]: unknown
}

interface SCLEval {
    recallAt5?: number
    precisionAt5?: number
    ndcgAt5?: number
    mrr?: number
    details?: Array<{
        stimulus: string
        retrieved: string[]
        expected: string[]
        recall5: number
        precision5: number
        ndcg5: number
    }>
}

interface Finding {
    type: string
    description: string
    severity: 'low' | 'medium' | 'high' | 'critical'
    timestamp: string
}

interface ProactiveAgent {
    id?: unknown
    name?: unknown
    status?: unknown
    summary?: unknown
    timestamp?: unknown
    _created_at?: unknown
    [key: string]: unknown
}

interface FixerReport {
    rootCause?: string
    scenarioId?: string
    before?: string
    after?: string
    improved?: boolean
}

interface ConversationQualityEntry {
    passed: number
    failed: number
    issues: string[]
    rootCauses: string[]
    timestamp: string
}

interface DashboardData {
    currentCycle: CycleResult | null
    cycleHistory: CycleResult[]
    workloads: Workload[]
    sclEval: SCLEval | null
    fixerActivity: FixerEntry[]
    findings: Finding[]
    proactiveAgents?: ProactiveAgent[]
    conversationQuality?: ConversationQualityEntry[]
}

type Tab = 'cycles' | 'agents' | 'fixers' | 'scl' | 'findings' | 'quality'

// ── Helpers ───────────────────────────────────────────────────────────

function metricColor(value: number | undefined, target: number): string {
    if (value === undefined) return 'text-text-muted'
    if (value >= target) return 'text-green-400'
    if (value >= target * 0.85) return 'text-yellow-400'
    return 'text-red-400'
}

// Accept unknown to avoid crashes when JSONB returns unexpected types at runtime
function statusBadge(status: unknown) {
    const s = (typeof status === 'string' ? status : 'UNKNOWN').toUpperCase()
    if (s === 'GREEN' || s === 'PASS' || s === 'COMPLETED') return <span className="text-green-400 font-medium">{s}</span>
    if (s === 'RED' || s === 'FAIL' || s === 'FAILED') return <span className="text-red-400 font-medium">{s}</span>
    if (s === 'RUNNING') return <span className="text-yellow-400 font-medium">{s}</span>
    return <span className="text-text-muted">{s}</span>
}

function agentStatusBadge(status: unknown) {
    const s = typeof status === 'string' ? status : 'unknown'
    const colors =
        s === 'completed' ? 'bg-green-900/30 text-green-400' :
        s === 'failed' ? 'bg-red-900/30 text-red-400' :
        'bg-yellow-900/30 text-yellow-400'
    return <span className={`text-xs px-2 py-0.5 rounded-sm ${colors}`}>{s}</span>
}

function safeDate(ts: unknown): string {
    if (!ts || typeof ts !== 'string') return '—'
    const d = new Date(ts)
    return isNaN(d.getTime()) ? '—' : d.toLocaleString()
}

// Safely coerce any JSONB-sourced value to a string for JSX rendering
function safeStr(val: unknown, fallback = ''): string {
    if (val === null || val === undefined) return fallback
    if (typeof val === 'string') return val
    if (typeof val === 'number' || typeof val === 'boolean') return String(val)
    return fallback
}

// Safely render any value as a string — prevents "Objects are not valid as React child" crashes
function renderValue(val: unknown): string {
    if (val === null || val === undefined) return ''
    if (typeof val === 'string') return val
    if (typeof val === 'number' || typeof val === 'boolean') return String(val)
    try { return JSON.stringify(val) } catch { return '[unserializable]' }
}

function safeJsonStringify(val: unknown): string {
    try { return JSON.stringify(val, null, 2) } catch { return '[Unable to serialize]' }
}

// ── Collapsible Section ───────────────────────────────────────────────

function CollapsibleSection({ title, children, defaultOpen = false, badge }: {
    title: string
    children: React.ReactNode
    defaultOpen?: boolean
    badge?: React.ReactNode
}) {
    const [open, setOpen] = useState(defaultOpen)
    return (
        <div className="border border-border rounded overflow-hidden">
            <button
                onClick={() => setOpen(v => !v)}
                className="w-full flex items-center gap-2 p-3 hover:bg-surface-2 text-left bg-surface-2/40"
            >
                {open ? <ChevronDown className="w-4 h-4 shrink-0" /> : <ChevronRight className="w-4 h-4 shrink-0" />}
                <span className="font-medium text-sm">{title}</span>
                {badge}
            </button>
            {open && <div className="border-t border-border">{children}</div>}
        </div>
    )
}

// ── Component ─────────────────────────────────────────────────────────

export function StabilizationDashboard({ data }: { data: DashboardData | null }) {
    const [activeTab, setActiveTab] = useState<Tab>('cycles')
    const [expandedCycles, setExpandedCycles] = useState<Set<number>>(new Set())
    const [expandedAgents, setExpandedAgents] = useState<Set<number>>(new Set())
    const [expandedFixers, setExpandedFixers] = useState<Set<number>>(new Set())
    const [expandedQuality, setExpandedQuality] = useState<Set<number>>(new Set())

    if (!data || !data.currentCycle) {
        return (
            <div className="text-center py-20">
                <Activity className="w-12 h-12 mx-auto mb-4 text-text-muted animate-pulse" />
                <h2 className="text-xl font-semibold mb-2">No data yet</h2>
                <p className="text-text-muted">Waiting for the first stabilization cycle to complete.</p>
            </div>
        )
    }

    const cc = data.currentCycle
    // Guard all arrays against undefined/null in case API omits fields
    const cycleHistory = data.cycleHistory ?? []
    const workloads = data.workloads ?? []
    const sclEval = data.sclEval ?? null
    const fixerActivity = data.fixerActivity ?? []
    const findings = data.findings ?? []
    const proactiveAgents = data.proactiveAgents ?? []
    const conversationQuality = data.conversationQuality ?? []

    const isGreen = cc.scenarios.failed === 0 && cc.sloBreaches === 0

    const toggleSet = (set: Set<number>, val: number): Set<number> => {
        const next = new Set(set)
        next.has(val) ? next.delete(val) : next.add(val)
        return next
    }

    const tabs: { id: Tab; label: string; count?: number }[] = [
        { id: 'cycles', label: 'Cycles', count: cycleHistory.length },
        { id: 'agents', label: 'Agents', count: proactiveAgents.length },
        { id: 'fixers', label: 'Fixers', count: fixerActivity.length },
        { id: 'scl', label: 'SCL' },
        { id: 'findings', label: 'Findings', count: findings.length },
        { id: 'quality', label: 'Quality', count: conversationQuality.length },
    ]

    return (
        <div className="space-y-4">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-2xl font-semibold flex items-center gap-2">
                        <Activity className="w-6 h-6" />
                        Stabilization Pipeline
                    </h1>
                    <p className="text-sm text-text-muted mt-1">
                        Cycle {cc.cycle} &middot; {new Date(cc.timestamp).toLocaleString()}
                    </p>
                </div>
                <div className={`px-3 py-1 rounded-sm text-sm font-medium ${isGreen ? 'bg-green-900/30 text-green-400' : 'bg-red-900/30 text-red-400'}`}>
                    {isGreen ? 'GREEN' : 'RED'}
                </div>
            </div>

            {/* Current Cycle Metrics — always visible */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <MetricCard label="Scenarios" value={`${cc.scenarios.passed}/${cc.scenarios.passed + cc.scenarios.failed}`}
                    status={cc.scenarios.failed === 0 ? 'green' : 'red'} icon={<CheckCircle2 className="w-4 h-4" />} />
                <MetricCard label="Workloads" value={`${cc.workloads.passed}/${cc.workloads.passed + cc.workloads.failed}`}
                    status={cc.workloads.failed === 0 ? 'green' : 'red'} icon={<Clock className="w-4 h-4" />} />
                <MetricCard label="Security" value={cc.security}
                    status={cc.security === 'PASS' ? 'green' : 'red'} icon={<Shield className="w-4 h-4" />} />
                <MetricCard label="Tests" value={cc.tests}
                    status={cc.tests === 'GREEN' ? 'green' : 'red'} icon={<CheckCircle2 className="w-4 h-4" />} />
            </div>

            {/* SCL Summary — collapsed by default */}
            <CollapsibleSection title="SCL Retrieval Quality">
                <div className="grid grid-cols-3 gap-4 p-4">
                    <div>
                        <p className="text-xs text-text-muted">recall@5</p>
                        <p className={`text-lg font-mono ${metricColor(cc.sclEval?.recallAt5, 0.70)}`}>
                            {cc.sclEval?.recallAt5?.toFixed(3) ?? '—'}
                        </p>
                        <p className="text-xs text-text-muted">target: &ge;0.70</p>
                    </div>
                    <div>
                        <p className="text-xs text-text-muted">precision@5</p>
                        <p className={`text-lg font-mono ${metricColor(cc.sclEval?.precisionAt5, 0.60)}`}>
                            {cc.sclEval?.precisionAt5?.toFixed(3) ?? '—'}
                        </p>
                        <p className="text-xs text-text-muted">target: &ge;0.60</p>
                    </div>
                    <div>
                        <p className="text-xs text-text-muted">NDCG@5</p>
                        <p className={`text-lg font-mono ${metricColor(cc.sclEval?.ndcgAt5, 0.65)}`}>
                            {cc.sclEval?.ndcgAt5?.toFixed(3) ?? '—'}
                        </p>
                        <p className="text-xs text-text-muted">target: &ge;0.65</p>
                    </div>
                </div>
            </CollapsibleSection>

            {/* Ship Gate — collapsed by default */}
            <CollapsibleSection
                title="Ship Gate Progress"
                badge={
                    <span className="ml-auto text-xs text-text-muted font-mono">
                        {cycleHistory.filter(c => c.sloBreaches === 0).length} / 144 green
                    </span>
                }
            >
                <div className="p-4">
                    <div className="w-full bg-surface-2 rounded-full h-2">
                        <div className="bg-green-500 h-2 rounded-full transition-all"
                            style={{ width: `${Math.min(100, (cycleHistory.filter(c => c.sloBreaches === 0).length / 144) * 100)}%` }} />
                    </div>
                    <p className="text-xs text-text-muted mt-2">
                        72 hours of consecutive green cycles required to ship (144 × 30-min cycles)
                    </p>
                </div>
            </CollapsibleSection>

            {/* Tab Bar */}
            <div className="border-b border-border flex gap-1 overflow-x-auto">
                {tabs.map(t => (
                    <button
                        key={t.id}
                        onClick={() => setActiveTab(t.id)}
                        className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
                            activeTab === t.id
                                ? 'border-azure text-text-primary'
                                : 'border-transparent text-text-muted hover:text-text-primary'
                        }`}
                    >
                        {t.label}
                        {t.count !== undefined && t.count > 0 && (
                            <span className="ml-1.5 text-xs bg-surface-2 px-1.5 py-0.5 rounded-sm">{t.count}</span>
                        )}
                    </button>
                ))}
            </div>

            {/* Cycles Tab */}
            {activeTab === 'cycles' && (
                <div>
                    {cycleHistory.length === 0 ? (
                        <p className="text-center py-8 text-text-muted text-sm">No cycle history yet.</p>
                    ) : (
                        <div className="border border-border rounded overflow-hidden">
                            {cycleHistory.map(c => (
                                <div key={c.cycle} className={`border-b border-border last:border-0 ${c.sloBreaches > 0 ? 'bg-red-900/10' : ''}`}>
                                    <button
                                        onClick={() => setExpandedCycles(s => toggleSet(s, c.cycle))}
                                        className="w-full flex items-center gap-2 p-3 hover:bg-surface-2 text-left"
                                    >
                                        {expandedCycles.has(c.cycle) ? <ChevronDown className="w-3 h-3 shrink-0" /> : <ChevronRight className="w-3 h-3 shrink-0" />}
                                        <span className="font-mono w-10 text-sm shrink-0">{c.cycle}</span>
                                        <span className="text-text-muted text-xs w-36 shrink-0">{safeDate(c.timestamp)}</span>
                                        <span className="text-sm">{c.scenarios.passed}/{c.scenarios.passed + c.scenarios.failed} sc</span>
                                        <span className="text-sm ml-3">{c.workloads.passed}/{c.workloads.passed + c.workloads.failed} wl</span>
                                        <span className="text-sm ml-3 font-mono">{c.sclEval?.recallAt5?.toFixed(2) ?? '—'}</span>
                                        <span className="ml-auto shrink-0">
                                            {c.sloBreaches === 0
                                                ? <span className="text-green-400 text-xs">OK</span>
                                                : <span className="text-red-400 text-xs">{c.sloBreaches} breach</span>}
                                        </span>
                                    </button>
                                    {expandedCycles.has(c.cycle) && (
                                        <div className="px-4 pb-3 border-t border-border bg-surface-2/40">
                                            <div className="grid grid-cols-2 gap-4 mt-2 text-sm">
                                                <div>
                                                    <p className="text-xs text-text-muted mb-0.5">Scenarios</p>
                                                    <p>{c.scenarios.passed} passed / {c.scenarios.failed} failed</p>
                                                </div>
                                                <div>
                                                    <p className="text-xs text-text-muted mb-0.5">Workloads</p>
                                                    <p>{c.workloads.passed} passed / {c.workloads.failed} failed</p>
                                                </div>
                                                <div>
                                                    <p className="text-xs text-text-muted mb-0.5">Security</p>
                                                    <p>{c.security}</p>
                                                </div>
                                                <div>
                                                    <p className="text-xs text-text-muted mb-0.5">Tests</p>
                                                    <p>{c.tests}</p>
                                                </div>
                                                {c.sclEval && (
                                                    <div className="col-span-2">
                                                        <p className="text-xs text-text-muted mb-0.5">SCL retrieval</p>
                                                        <p className="font-mono text-xs">
                                                            R@5={c.sclEval.recallAt5?.toFixed(3) ?? '—'}&nbsp;&nbsp;
                                                            P@5={c.sclEval.precisionAt5?.toFixed(3) ?? '—'}&nbsp;&nbsp;
                                                            NDCG={c.sclEval.ndcgAt5?.toFixed(3) ?? '—'}
                                                        </p>
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                    )}
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            )}

            {/* Agents Tab */}
            {activeTab === 'agents' && (
                <div>
                    {proactiveAgents.length === 0 ? (
                        <p className="text-center py-8 text-text-muted text-sm">No proactive agent activity yet.</p>
                    ) : (
                        <div className="border border-border rounded overflow-hidden">
                            {proactiveAgents.map((agent, i) => {
                                if (!agent) return null
                                const agentType = safeStr(agent.type)
                                const agentId = safeStr(agent.id)
                                const isAutoDeploy = agentType === 'auto-deploy' || agentId.startsWith('auto-deploy')

                                // Name: prefer explicit name field; for auto-deploy fall back to "Auto Deploy";
                                // for others convert raw id to title-case (e.g. "security" → "Security")
                                const displayName = safeStr(agent.name) || (
                                    isAutoDeploy
                                        ? 'Auto Deploy'
                                        : agentId.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) || `Agent ${i + 1}`
                                )

                                const displayTs = safeStr(agent.timestamp) || safeStr(agent._created_at)

                                // Summary: prefer explicit summary; for auto-deploy synthesise from sha/commits/services
                                let summary = safeStr(agent.summary)
                                if (!summary && isAutoDeploy) {
                                    const shortSha = safeStr(agent.shortSha) || safeStr(agent.sha).slice(0, 7)
                                    const services = Array.isArray(agent.services) ? (agent.services as string[]).join(', ') : ''
                                    const firstCommit = Array.isArray(agent.commits)
                                        ? safeStr((agent.commits as unknown[])[0]).replace(/^[0-9a-f]+ /, '')
                                        : ''
                                    summary = [
                                        shortSha && `Commit ${shortSha}`,
                                        firstCommit,
                                        services && `Services: ${services}`,
                                    ].filter(Boolean).join(' · ')
                                }

                                // Fallback shown in expanded view when summary is still empty
                                const summaryFallback = agentId || `Agent ${i + 1}`

                                return (
                                    <div key={i} className="border-b border-border last:border-0">
                                        <button
                                            onClick={() => setExpandedAgents(s => toggleSet(s, i))}
                                            className="w-full flex items-center gap-3 p-3 hover:bg-surface-2 text-left"
                                        >
                                            {expandedAgents.has(i) ? <ChevronDown className="w-3 h-3 shrink-0" /> : <ChevronRight className="w-3 h-3 shrink-0" />}
                                            <Bot className="w-4 h-4 shrink-0 text-text-muted" />
                                            <div className="flex-1 min-w-0">
                                                <p className="font-medium text-sm truncate">{displayName}</p>
                                                {summary && (
                                                    <p className="text-xs text-text-muted truncate mt-0.5">{summary}</p>
                                                )}
                                            </div>
                                            {agentStatusBadge(agent.status)}
                                            {displayTs && (
                                                <span className="text-xs text-text-muted shrink-0 ml-2">{safeDate(displayTs)}</span>
                                            )}
                                        </button>
                                        {expandedAgents.has(i) && (
                                            <div className="px-4 pb-3 border-t border-border bg-surface-2/40">
                                                {summary ? (
                                                    <pre className="text-xs text-text-muted whitespace-pre-wrap mt-2 max-h-60 overflow-y-auto bg-surface-2/60 rounded p-2">
                                                        {summary}
                                                    </pre>
                                                ) : (
                                                    <p className="text-xs text-text-muted mt-2 font-mono">{summaryFallback}</p>
                                                )}
                                            </div>
                                        )}
                                    </div>
                                )
                            })}
                        </div>
                    )}
                </div>
            )}

            {/* Fixers Tab */}
            {activeTab === 'fixers' && (
                <div>
                    {fixerActivity.length === 0 ? (
                        <p className="text-center py-8 text-text-muted text-sm">No fixer activity yet.</p>
                    ) : (
                        <div className="border border-border rounded overflow-hidden">
                            {fixerActivity.map((f, i) => {
                                if (!f) return null
                                // Guard all field accesses — JSONB can return any type at runtime
                                const displayBranch = safeStr(f.branch) || `Dispatch #${i + 1}`
                                const displayTs = safeStr(f.timestamp) || safeStr(f._created_at)
                                const total = typeof f.total === 'number' ? f.total : null
                                const improved = typeof f.improved === 'number' ? f.improved : null
                                const reports = Array.isArray(f.reports) ? (f.reports as FixerReport[]) : null
                                return (
                                    <div key={i} className="border-b border-border last:border-0">
                                        <button
                                            onClick={() => setExpandedFixers(s => toggleSet(s, i))}
                                            className="w-full flex items-center gap-3 p-3 hover:bg-surface-2 text-left"
                                        >
                                            {expandedFixers.has(i) ? <ChevronDown className="w-3 h-3 shrink-0" /> : <ChevronRight className="w-3 h-3 shrink-0" />}
                                            <GitBranch className="w-4 h-4 shrink-0 text-text-muted" />
                                            <div className="flex-1 min-w-0">
                                                <code className="text-sm">{displayBranch}</code>
                                                {total !== null && (
                                                    <span className="text-xs text-text-muted ml-2">
                                                        {improved ?? 0}/{total} improved
                                                    </span>
                                                )}
                                            </div>
                                            {f.status != null && statusBadge(f.status)}
                                            {displayTs && (
                                                <span className="text-xs text-text-muted shrink-0 ml-2">{safeDate(displayTs)}</span>
                                            )}
                                        </button>
                                        {expandedFixers.has(i) && (
                                            <div className="px-4 pb-3 border-t border-border bg-surface-2/40 space-y-2 mt-2">
                                                {/* Show structured reports if available */}
                                                {reports && reports.length > 0 ? (
                                                    reports.map((r, j) => (
                                                        <div key={j} className="border border-border rounded p-2 text-xs space-y-1">
                                                            <div className="flex items-center justify-between gap-2">
                                                                <span className="font-medium truncate">{safeStr(r.scenarioId) || `Report ${j + 1}`}</span>
                                                                <span className={r.improved ? 'text-green-400 shrink-0' : 'text-red-400 shrink-0'}>
                                                                    {r.improved ? '✓ improved' : '✗ not improved'}
                                                                </span>
                                                            </div>
                                                            {r.rootCause && (
                                                                <p className="text-text-muted">{safeStr(r.rootCause)}</p>
                                                            )}
                                                        </div>
                                                    ))
                                                ) : (
                                                    // Fallback: show failures or raw JSON
                                                    f.failures != null ? (
                                                        <p className="text-xs text-text-muted">{renderValue(f.failures)}</p>
                                                    ) : (
                                                        <pre className="text-xs font-mono text-text-muted whitespace-pre-wrap max-h-60 overflow-y-auto">
                                                            {safeJsonStringify(f)}
                                                        </pre>
                                                    )
                                                )}
                                            </div>
                                        )}
                                    </div>
                                )
                            })}
                        </div>
                    )}
                </div>
            )}

            {/* SCL Tab */}
            {activeTab === 'scl' && (
                <div className="space-y-4">
                    {workloads.length > 0 && (
                        <div className="border border-border rounded overflow-hidden">
                            <div className="p-3 bg-surface-2/60 border-b border-border">
                                <h3 className="font-medium text-sm">Workload Results ({workloads.filter(w => w.passed).length}/{workloads.length})</h3>
                            </div>
                            {workloads.map(w => (
                                <div key={w.id} className={`flex items-center justify-between p-3 border-b border-border last:border-0 ${!w.passed ? 'bg-red-900/10' : ''}`}>
                                    <div className="flex items-center gap-2">
                                        {w.passed ? <CheckCircle2 className="w-4 h-4 text-green-400" /> : <XCircle className="w-4 h-4 text-red-400" />}
                                        <span className="text-sm">{w.name}</span>
                                    </div>
                                    <div className="flex items-center gap-4 text-sm text-text-muted">
                                        <span>{w.latencyMs}ms</span>
                                        {w.quality !== undefined && <span>q={w.quality.toFixed(1)}</span>}
                                        {w.error && <span className="text-red-400 max-w-xs truncate">{w.error}</span>}
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}

                    {sclEval?.details && sclEval.details.length > 0 ? (
                        <div className="border border-border rounded overflow-hidden">
                            <div className="p-3 bg-surface-2/60 border-b border-border">
                                <h3 className="font-medium text-sm">Per-Stimulus Detail ({sclEval.details.length})</h3>
                            </div>
                            {sclEval.details.map((d, i) => (
                                <div key={i} className="p-3 border-b border-border last:border-0">
                                    <p className="text-sm font-medium">&ldquo;{d.stimulus}&rdquo;</p>
                                    <div className="flex gap-4 mt-1 text-xs font-mono">
                                        <span className={metricColor(d.recall5, 0.70)}>R@5={d.recall5.toFixed(3)}</span>
                                        <span className={metricColor(d.precision5, 0.60)}>P@5={d.precision5.toFixed(3)}</span>
                                        <span className={metricColor(d.ndcg5, 0.65)}>NDCG={d.ndcg5.toFixed(3)}</span>
                                    </div>
                                    <p className="text-xs text-text-muted mt-1">
                                        Retrieved: [{d.retrieved.slice(0, 5).join(', ')}] &middot; Expected: [{d.expected.join(', ')}]
                                    </p>
                                </div>
                            ))}
                        </div>
                    ) : (
                        <p className="text-center py-8 text-text-muted text-sm">No SCL per-stimulus detail available.</p>
                    )}
                </div>
            )}

            {/* Findings Tab */}
            {activeTab === 'findings' && (
                <div>
                    {findings.length === 0 ? (
                        <div className="text-center py-12">
                            <CheckCircle2 className="w-10 h-10 mx-auto mb-3 text-green-400" />
                            <p className="text-text-muted text-sm">No open findings. Pipeline clean.</p>
                        </div>
                    ) : (
                        <div className="border border-red-800/50 rounded p-4">
                            <h3 className="font-medium flex items-center gap-2 mb-3">
                                <AlertTriangle className="w-4 h-4 text-red-400" />
                                Open Findings ({findings.length})
                            </h3>
                            {findings.map((f, i) => (
                                <div key={i} className="flex items-start gap-2 py-2 border-t border-border first:border-0">
                                    <span className={`text-xs px-1.5 py-0.5 rounded shrink-0 ${
                                        f.severity === 'critical' ? 'bg-red-900 text-red-300' :
                                        f.severity === 'high' ? 'bg-orange-900 text-orange-300' :
                                        'bg-yellow-900 text-yellow-300'
                                    }`}>
                                        {f.severity}
                                    </span>
                                    <div>
                                        <p className="text-sm">{f.description}</p>
                                        <p className="text-xs text-text-muted">{f.type} &middot; {safeDate(f.timestamp)}</p>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            )}

            {/* Quality Tab */}
            {activeTab === 'quality' && (
                <div className="space-y-3">
                    <div className="border border-border rounded p-3 bg-surface-1">
                        <p className="text-xs text-text-muted">
                            Multi-turn conversations scored for relevance, helpfulness, coherence, memory retention, and format compliance.
                            Each eval runs real conversations against the live agent and diagnoses root causes for failures.
                        </p>
                    </div>
                    {conversationQuality.length === 0 ? (
                        <p className="text-center py-8 text-text-muted text-sm">No conversation quality evals yet.</p>
                    ) : (
                        conversationQuality.map((cq, i) => {
                            if (!cq) return null
                            const total = (cq.passed ?? 0) + (cq.failed ?? 0)
                            const passRate = total > 0 ? Math.round((cq.passed / total) * 100) : 0
                            const isOpen = expandedQuality.has(i)
                            return (
                                <div key={i} className="border border-border rounded overflow-hidden">
                                    <button
                                        onClick={() => setExpandedQuality(s => toggleSet(s, i))}
                                        className="w-full flex items-center gap-3 p-3 hover:bg-surface-2 text-left"
                                    >
                                        {isOpen ? <ChevronDown className="w-3 h-3 shrink-0" /> : <ChevronRight className="w-3 h-3 shrink-0" />}
                                        <div className="flex-1">
                                            <p className="text-sm font-medium">
                                                {cq.passed ?? 0}/{total} scenarios passed
                                                <span className="text-text-muted ml-2">({passRate}%)</span>
                                            </p>
                                            <p className="text-xs text-text-muted mt-0.5">{safeDate(cq.timestamp)}</p>
                                        </div>
                                        <span className={`text-xs px-2 py-0.5 rounded-sm shrink-0 ${(cq.failed ?? 0) === 0 ? 'bg-green-900/30 text-green-400' : 'bg-red-900/30 text-red-400'}`}>
                                            {(cq.failed ?? 0) === 0 ? 'PASS' : `${cq.failed} failed`}
                                        </span>
                                    </button>
                                    {isOpen && (
                                        <div className="border-t border-border divide-y divide-border">
                                            {Array.isArray(cq.rootCauses) && cq.rootCauses.length > 0 && (
                                                <div className="px-3 py-2">
                                                    <p className="text-xs font-medium text-text-muted mb-1.5">Root causes of failures</p>
                                                    <div className="flex flex-wrap gap-1.5">
                                                        {[...new Set(cq.rootCauses)].map((rc, j) => (
                                                            <span key={j} className="text-xs bg-surface-2 px-2 py-0.5 rounded">{renderValue(rc)}</span>
                                                        ))}
                                                    </div>
                                                </div>
                                            )}
                                            {Array.isArray(cq.issues) && cq.issues.length > 0 && (
                                                <div className="px-3 py-2">
                                                    <p className="text-xs font-medium text-text-muted mb-1.5">Failed scenarios</p>
                                                    <ul className="space-y-0.5">
                                                        {cq.issues.slice(0, 5).map((issue, j) => (
                                                            <li key={j} className="text-xs text-red-400">&bull; {renderValue(issue)}</li>
                                                        ))}
                                                        {cq.issues.length > 5 && (
                                                            <li className="text-xs text-text-muted">&bull; +{cq.issues.length - 5} more</li>
                                                        )}
                                                    </ul>
                                                </div>
                                            )}
                                        </div>
                                    )}
                                </div>
                            )
                        })
                    )}
                </div>
            )}
        </div>
    )
}

function MetricCard({ label, value, status, icon }: { label: string; value: string; status: 'green' | 'red'; icon: React.ReactNode }) {
    return (
        <div className="border border-border rounded p-3 bg-surface-1">
            <div className="flex items-center gap-2 text-text-muted text-xs mb-1">{icon}{label}</div>
            <p className={`text-lg font-mono ${status === 'green' ? 'text-green-400' : 'text-red-400'}`}>{value}</p>
        </div>
    )
}
