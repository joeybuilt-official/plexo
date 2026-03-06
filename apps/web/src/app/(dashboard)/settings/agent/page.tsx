'use client'

export const dynamic = 'force-dynamic'

import { useState, useEffect, useCallback, useRef, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import {
    Zap, RefreshCw, Save, Check, AlertCircle, Brain, Shield, Sparkles,
    User, Settings2, MessageSquare, BookOpen, Wrench, Target, Lock,
    Plus, Trash2, ChevronDown, Eye, EyeOff, History, Layers,
    ArrowLeftRight, X, Bot, DollarSign, Users,
} from 'lucide-react'
import { useWorkspace } from '@web/context/workspace'
import { getModelCapabilities } from '@web/lib/models'
import { CapabilityList } from '@web/components/capabilities'

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'

// ── Types ─────────────────────────────────────────────────────────────────────

interface AgentStatus {
    status: 'idle' | 'running'
    currentTask: string | null
    currentModel: string | null
    sessionCount: number
    lastActivity: string | null
}

interface WorkspaceSettings {
    defaultModel?: string
    maxStepsPerTask?: number
    tokenBudgetPerTask?: number
    maxRetries?: number
    costCeilingUsd?: number
    autoApproveThreshold?: number
    safeMode?: boolean
    systemPromptExtra?: string
    agentName?: string
    agentTagline?: string
    agentAvatar?: string
    agentPersona?: string
    /** Max judges from Ollama ensemble (1–5). Default 3. */
    ensembleSize?: number
    /** Dissent threshold for cloud arbitration (0–1). Default 0.25. */
    dissentThreshold?: number
}

type RuleType = 'safety_constraint' | 'operational_rule' | 'communication_style' | 'domain_knowledge' | 'persona_trait' | 'tool_preference' | 'quality_gate'
type RuleSource = 'platform' | 'workspace' | 'project' | 'task'

interface RuleValue {
    type: 'boolean' | 'string' | 'number' | 'enum' | 'text_block' | 'json'
    value: unknown
    options?: string[]
    min?: number
    max?: number
}

interface BehaviorRule {
    id: string
    workspaceId: string
    projectId: string | null
    type: RuleType
    key: string
    label: string
    description: string
    value: RuleValue
    locked: boolean
    source: RuleSource
    tags: string[]
    createdAt: string
    updatedAt: string
}

interface ResolvedRule {
    key: string
    label: string
    description: string
    type: RuleType
    value: RuleValue
    locked: boolean
    effectiveSource: RuleSource
    ruleId: string
    overriddenBy: { ruleId: string; source: RuleSource } | null
}

interface GroupDef {
    id: string
    label: string
    description: string
    icon: string
    ruleTypes: RuleType[]
    locked: boolean
    color: string
    displayOrder: number
}

interface Snapshot {
    id: string
    compiledPrompt: string
    triggeredBy: string
    triggerResourceId: string | null
    createdAt: string
}

// ── Primitive components ───────────────────────────────────────────────────────

function Input({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
    'use no memo';
    return (
        <input
            className={`rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500/30 disabled:opacity-40 ${className ?? ''}`}
            {...props}
        />
    )
}

function Textarea({ className, ...props }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
    'use no memo';
    return (
        <textarea
            className={`resize-none rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500/30 leading-relaxed ${className ?? ''}`}
            {...props}
        />
    )
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: () => void }) {
    'use no memo';
    return (
        <button
            type="button"
            onClick={onChange}
            className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${checked ? 'bg-indigo-600' : 'bg-zinc-700'}`}
        >
            <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-4.5' : 'translate-x-0.5'}`} />
        </button>
    )
}

function Field({ label, description, children }: { label: string; description?: string; children: React.ReactNode }) {
    return (
        <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-zinc-300">{label}</label>
            {children}
            {description && <p className="text-xs text-zinc-600">{description}</p>}
        </div>
    )
}

function Section({ title, icon: Icon, children }: { title: string; icon: React.ElementType; children: React.ReactNode }) {
    return (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
            <div className="flex items-center gap-2 mb-4">
                <Icon className="h-4 w-4 text-zinc-500" />
                <h2 className="text-sm font-semibold text-zinc-200">{title}</h2>
            </div>
            <div className="flex flex-col gap-4">{children}</div>
        </div>
    )
}

// ── Tab nav ───────────────────────────────────────────────────────────────────

type Tab = 'identity' | 'behavior' | 'limits' | 'quality' | 'history'

const TABS: { id: Tab; label: string; icon: React.ElementType }[] = [
    { id: 'identity', label: 'Identity', icon: User },
    { id: 'behavior', label: 'Behavior', icon: Sparkles },
    { id: 'limits', label: 'Limits', icon: Shield },
    { id: 'quality', label: 'Quality', icon: Users },
    { id: 'history', label: 'History', icon: History },
]

// ── Behavior tab internals ─────────────────────────────────────────────────────

const ICON_MAP: Record<string, React.ElementType> = {
    Shield, Settings2, MessageSquare, BookOpen, Sparkles, Wrench, Target,
}

const COLOR_MAP: Record<string, { border: string; accent: string; bg: string; text: string; badge: string }> = {
    red: { border: 'border-red-800/40', accent: 'border-l-red-500', bg: 'bg-red-950/20', text: 'text-red-400', badge: 'bg-red-900/30 text-red-400' },
    amber: { border: 'border-amber-800/40', accent: 'border-l-amber-500', bg: 'bg-amber-950/20', text: 'text-amber-400', badge: 'bg-amber-900/30 text-amber-400' },
    blue: { border: 'border-blue-800/40', accent: 'border-l-blue-500', bg: 'bg-blue-950/20', text: 'text-blue-400', badge: 'bg-blue-900/30 text-blue-400' },
    green: { border: 'border-green-800/40', accent: 'border-l-green-500', bg: 'bg-green-950/20', text: 'text-green-400', badge: 'bg-green-900/30 text-green-400' },
    purple: { border: 'border-purple-800/40', accent: 'border-l-purple-500', bg: 'bg-purple-950/20', text: 'text-purple-400', badge: 'bg-purple-900/30 text-purple-400' },
    orange: { border: 'border-orange-800/40', accent: 'border-l-orange-500', bg: 'bg-orange-950/20', text: 'text-orange-400', badge: 'bg-orange-900/30 text-orange-400' },
    zinc: { border: 'border-zinc-700/40', accent: 'border-l-zinc-500', bg: 'bg-zinc-900/20', text: 'text-zinc-400', badge: 'bg-zinc-800/40 text-zinc-400' },
}

function SourceBadge({ source }: { source: RuleSource }) {
    const map: Record<RuleSource, string> = {
        platform: 'bg-zinc-800 text-zinc-500',
        workspace: 'bg-blue-900/30 text-blue-400',
        project: 'bg-purple-900/30 text-purple-400',
        task: 'bg-amber-900/30 text-amber-400',
    }
    return <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded uppercase tracking-wide ${map[source]}`}>{source}</span>
}

function RuleValueEditor({ val, locked, onChange }: { val: RuleValue; locked: boolean; onChange: (v: RuleValue) => void }) {
    if (locked) {
        return <span className="text-sm text-zinc-500 font-mono">{val.type === 'boolean' ? (val.value ? 'enabled' : 'disabled') : String(val.value)}</span>
    }
    switch (val.type) {
        case 'boolean':
            return <Toggle checked={!!val.value} onChange={() => onChange({ ...val, value: !val.value })} />
        case 'number':
            return (
                <input type="number" value={val.value as number} min={val.min} max={val.max}
                    onChange={e => onChange({ ...val, value: parseFloat(e.target.value) })}
                    className="w-24 rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm text-zinc-100 focus:border-indigo-500 focus:outline-none"
                />
            )
        case 'enum':
            return (
                <select value={val.value as string} onChange={e => onChange({ ...val, value: e.target.value })}
                    className="rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm text-zinc-100 focus:border-indigo-500 focus:outline-none">
                    {(val.options ?? []).map(opt => <option key={opt} value={opt}>{opt}</option>)}
                </select>
            )
        case 'string':
            return (
                <input type="text" value={val.value as string} onChange={e => onChange({ ...val, value: e.target.value })}
                    className="flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm text-zinc-100 focus:border-indigo-500 focus:outline-none"
                />
            )
        case 'text_block':
            return (
                <textarea value={val.value as string} onChange={e => onChange({ ...val, value: e.target.value })} rows={3}
                    className="flex-1 resize-none rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-100 focus:border-indigo-500 focus:outline-none leading-relaxed"
                />
            )
        default:
            return <span className="text-xs text-zinc-600 font-mono">{JSON.stringify(val.value)}</span>
    }
}

function RuleRow({ rule, onUpdate, onDelete, showSource = false, overriddenBy }: {
    rule: BehaviorRule | ResolvedRule
    onUpdate: (id: string, value: RuleValue) => void
    onDelete: (id: string) => void
    showSource?: boolean
    overriddenBy?: { ruleId: string; source: RuleSource } | null
}) {
    const id = 'ruleId' in rule ? rule.ruleId : rule.id
    const source = 'effectiveSource' in rule ? rule.effectiveSource : rule.source
    const [localVal, setLocalVal] = useState<RuleValue>(rule.value)
    const [dirty, setDirty] = useState(false)
    const [saving, setSaving] = useState(false)
    const autoSaveTypes = ['boolean', 'number', 'enum']

    useEffect(() => { setLocalVal(rule.value); setDirty(false) }, [rule.value])

    const handleChange = (v: RuleValue) => { setLocalVal(v); setDirty(true) }

    const handleSave = async () => {
        setSaving(true)
        await onUpdate(id, localVal)
        setSaving(false)
        setDirty(false)
    }

    useEffect(() => {
        if (dirty && autoSaveTypes.includes(localVal.type)) {
            void onUpdate(id, localVal)
            setDirty(false)
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [localVal, dirty])

    const needsTextSave = ['text_block', 'string', 'json'].includes(localVal.type)

    return (
        <div className={`group flex flex-col gap-2 py-3 border-b border-zinc-800/60 last:border-0 ${overriddenBy ? 'opacity-60' : ''}`}>
            <div className="flex items-start gap-3">
                {rule.locked && <Lock className="h-3.5 w-3.5 text-zinc-600 mt-0.5 shrink-0" />}
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium text-zinc-200">{rule.label}</span>
                        {showSource && <SourceBadge source={source} />}
                        {overriddenBy && <span className="text-[10px] text-zinc-600 italic">overridden at {overriddenBy.source} level</span>}
                        {rule.locked && <span className="text-[10px] text-zinc-600 px-1.5 py-0.5 rounded border border-zinc-800">enforced</span>}
                    </div>
                    {rule.description && <p className="text-xs text-zinc-600 mt-0.5">{rule.description}</p>}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                    <RuleValueEditor val={localVal} locked={rule.locked} onChange={handleChange} />
                    {needsTextSave && dirty && (
                        <button onClick={() => void handleSave()} disabled={saving}
                            className="text-xs bg-indigo-600 text-white px-2 py-1 rounded-lg hover:bg-indigo-500 disabled:opacity-50">
                            {saving ? <RefreshCw className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                        </button>
                    )}
                    {!rule.locked && (
                        <button onClick={() => onDelete(id)}
                            className="text-zinc-700 hover:text-red-400 transition-colors opacity-0 group-hover:opacity-100"
                            aria-label="Delete rule">
                            <Trash2 className="h-3.5 w-3.5" />
                        </button>
                    )}
                </div>
            </div>
        </div>
    )
}

function AddRuleForm({ groupTypes, onAdd, onCancel }: {
    groupTypes: RuleType[]
    onAdd: (rule: Partial<BehaviorRule>) => void
    onCancel: () => void
}) {
    const [label, setLabel] = useState('')
    const [description, setDescription] = useState('')
    const [valueType, setValueType] = useState<RuleValue['type']>('text_block')
    const [value, setValue] = useState('')
    const [type] = useState<RuleType>(groupTypes[0] ?? 'communication_style')
    const autoKey = label.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '').slice(0, 50)

    function buildValue(): RuleValue {
        switch (valueType) {
            case 'boolean': return { type: 'boolean', value: false }
            case 'number': return { type: 'number', value: parseFloat(value) || 0 }
            case 'text_block': return { type: 'text_block', value }
            case 'string': return { type: 'string', value }
            case 'enum': return { type: 'enum', value: value.split(',')[0]?.trim() ?? '', options: value.split(',').map(s => s.trim()).filter(Boolean) }
            default: return { type: 'text_block', value }
        }
    }

    return (
        <div className="mt-3 border border-dashed border-zinc-700 rounded-xl p-4 flex flex-col gap-3 bg-zinc-900/30">
            <div className="flex gap-3">
                <div className="flex-1">
                    <label className="text-xs text-zinc-500 mb-1 block">Label</label>
                    <input type="text" value={label} onChange={e => setLabel(e.target.value)} autoFocus
                        placeholder="e.g. Always use TypeScript strict mode"
                        className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-indigo-500 focus:outline-none"
                    />
                    {autoKey && <p className="text-[10px] text-zinc-700 mt-0.5 font-mono">key: {autoKey}</p>}
                </div>
                <div>
                    <label className="text-xs text-zinc-500 mb-1 block">Type</label>
                    <select value={valueType} onChange={e => setValueType(e.target.value as RuleValue['type'])}
                        className="rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-2 text-sm text-zinc-100 focus:border-indigo-500 focus:outline-none">
                        <option value="text_block">Text block</option>
                        <option value="string">Short string</option>
                        <option value="boolean">Toggle</option>
                        <option value="number">Number</option>
                        <option value="enum">Enum (comma-sep)</option>
                    </select>
                </div>
            </div>
            <div>
                <label className="text-xs text-zinc-500 mb-1 block">
                    {valueType === 'text_block' ? 'Content' : valueType === 'enum' ? 'Options (comma-separated)' : 'Value'}
                </label>
                {valueType === 'text_block' ? (
                    <textarea rows={3} value={value} onChange={e => setValue(e.target.value)}
                        placeholder="Enter the rule content…"
                        className="w-full resize-none rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-indigo-500 focus:outline-none"
                    />
                ) : (
                    <input type={valueType === 'number' ? 'number' : 'text'} value={value} onChange={e => setValue(e.target.value)}
                        placeholder={valueType === 'enum' ? 'option1, option2, option3' : ''}
                        className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-indigo-500 focus:outline-none"
                    />
                )}
            </div>
            <div>
                <label className="text-xs text-zinc-500 mb-1 block">Description (optional)</label>
                <input type="text" value={description} onChange={e => setDescription(e.target.value)}
                    placeholder="What does this rule do?"
                    className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-indigo-500 focus:outline-none"
                />
            </div>
            <div className="flex gap-2 justify-end">
                <button onClick={onCancel} className="text-xs text-zinc-500 hover:text-zinc-300 px-3 py-2 rounded-lg transition-colors">Cancel</button>
                <button onClick={() => { if (!label.trim()) return; onAdd({ type, key: autoKey, label: label.trim(), description, value: buildValue() }) }}
                    disabled={!label.trim()}
                    className="text-xs bg-indigo-600 text-white px-3 py-2 rounded-lg hover:bg-indigo-500 disabled:opacity-40 transition-colors">
                    Add rule
                </button>
            </div>
        </div>
    )
}

function BehaviorCard({ group, rules, inheritanceMode, resolvedRules, onUpdate, onDelete, onAdd }: {
    group: GroupDef
    rules: BehaviorRule[]
    inheritanceMode: boolean
    resolvedRules: ResolvedRule[]
    onUpdate: (id: string, value: RuleValue) => void
    onDelete: (id: string) => void
    onAdd: (rule: Partial<BehaviorRule>) => void
}) {
    const [expanded, setExpanded] = useState(true)
    const [adding, setAdding] = useState(false)
    const colors = COLOR_MAP[group.color] ?? COLOR_MAP['zinc']!
    const Icon = ICON_MAP[group.icon] ?? Settings2
    const displayRules = inheritanceMode
        ? resolvedRules.filter(r => group.ruleTypes.includes(r.type))
        : rules.filter(r => group.ruleTypes.includes(r.type))

    return (
        <div className={`rounded-xl border ${colors.border} border-l-4 ${colors.accent} bg-zinc-900/40 overflow-hidden`}>
            <button onClick={() => setExpanded(e => !e)}
                className="w-full flex items-center gap-3 px-5 py-4 hover:bg-zinc-800/20 transition-colors text-left">
                <div className={`p-1.5 rounded-lg ${colors.bg}`}>
                    <Icon className={`h-4 w-4 ${colors.text}`} />
                </div>
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-zinc-200">{group.label}</span>
                        {group.locked && <Lock className="h-3 w-3 text-zinc-600" />}
                    </div>
                    <p className="text-xs text-zinc-600 truncate mt-0.5">{group.description}</p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${colors.badge}`}>
                        {displayRules.length} {displayRules.length === 1 ? 'rule' : 'rules'}
                    </span>
                    <ChevronDown className={`h-4 w-4 text-zinc-600 transition-transform ${expanded ? 'rotate-180' : ''}`} />
                </div>
            </button>
            {expanded && (
                <div className="px-5 pb-4">
                    {displayRules.length === 0 && !adding ? (
                        <p className="text-xs text-zinc-700 py-2 italic">No rules yet.</p>
                    ) : (
                        <div>
                            {displayRules.map(rule => {
                                const resolvedRule = 'effectiveSource' in rule ? rule : null
                                return (
                                    <RuleRow key={resolvedRule?.ruleId ?? (rule as BehaviorRule).id}
                                        rule={rule as BehaviorRule}
                                        onUpdate={onUpdate} onDelete={onDelete}
                                        showSource={inheritanceMode}
                                        overriddenBy={resolvedRule?.overriddenBy ?? undefined}
                                    />
                                )
                            })}
                        </div>
                    )}
                    {!group.locked && (
                        adding ? (
                            <AddRuleForm groupTypes={group.ruleTypes}
                                onAdd={(rule) => { onAdd(rule); setAdding(false) }}
                                onCancel={() => setAdding(false)} />
                        ) : (
                            <button onClick={() => setAdding(true)}
                                className={`mt-2 flex items-center gap-1.5 text-xs ${colors.text} hover:opacity-80 transition-opacity`}>
                                <Plus className="h-3.5 w-3.5" /> Add rule
                            </button>
                        )
                    )}
                    {group.locked && (
                        <p className="text-[11px] text-zinc-700 mt-2 flex items-center gap-1.5">
                            <Lock className="h-3 w-3" /> These constraints are structurally enforced and cannot be removed or disabled.
                        </p>
                    )}
                </div>
            )}
        </div>
    )
}

function SystemPromptPreview({ workspaceId, refreshTick }: { workspaceId: string; refreshTick: number }) {
    const [open, setOpen] = useState(false)
    const [prompt, setPrompt] = useState<string | null>(null)
    const [loading, setLoading] = useState(false)

    useEffect(() => {
        if (!open || !workspaceId) return
        let cancelled = false
        const t = setTimeout(async () => {
            setLoading(true)
            try {
                const res = await fetch(`${API}/api/v1/behavior/${workspaceId}/resolve`)
                if (!res.ok) return
                const data = await res.json() as { compiledPrompt: string }
                if (!cancelled) setPrompt(data.compiledPrompt)
            } finally {
                if (!cancelled) setLoading(false)
            }
        }, 500)
        return () => { cancelled = true; clearTimeout(t) }
    }, [open, workspaceId, refreshTick])

    return (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 overflow-hidden">
            <button onClick={() => setOpen(o => !o)}
                className="w-full flex items-center gap-3 px-5 py-4 hover:bg-zinc-800/20 transition-colors text-left">
                {open ? <EyeOff className="h-4 w-4 text-zinc-500" /> : <Eye className="h-4 w-4 text-zinc-500" />}
                <span className="text-sm font-medium text-zinc-300">{open ? 'Hide' : 'Preview'} compiled system prompt</span>
                <span className="ml-auto text-xs text-zinc-600">What the agent actually receives →</span>
            </button>
            {open && (
                <div className="px-5 pb-5">
                    {loading ? (
                        <div className="flex items-center gap-2 py-4 text-sm text-zinc-600"><RefreshCw className="h-3.5 w-3.5 animate-spin" /> Compiling…</div>
                    ) : prompt ? (
                        <pre className="text-xs text-zinc-400 bg-zinc-950 rounded-lg p-4 overflow-auto max-h-80 whitespace-pre-wrap leading-relaxed border border-zinc-800">{prompt}</pre>
                    ) : (
                        <p className="text-sm text-zinc-600 py-2 italic">No rules configured yet.</p>
                    )}
                </div>
            )}
        </div>
    )
}

// ── History tab ────────────────────────────────────────────────────────────────

function HistoryTab({ workspaceId }: { workspaceId: string }) {
    const [snapshots, setSnapshots] = useState<Snapshot[]>([])
    const [loading, setLoading] = useState(true)
    const [selected, setSelected] = useState<Snapshot | null>(null)

    useEffect(() => {
        if (!workspaceId) return
        void (async () => {
            const res = await fetch(`${API}/api/v1/behavior/${workspaceId}/snapshots?limit=20`)
            if (res.ok) setSnapshots((await res.json() as { snapshots: Snapshot[] }).snapshots)
            setLoading(false)
        })()
    }, [workspaceId])

    if (loading) return <div className="flex items-center gap-2 py-8 text-sm text-zinc-600"><RefreshCw className="h-4 w-4 animate-spin" /> Loading…</div>

    return (
        <div className="flex flex-col gap-4">
            <p className="text-sm text-zinc-500">
                Snapshots capture the compiled system prompt at each task start or manual preview. Click a snapshot to inspect its prompt.
            </p>
            {snapshots.length === 0 ? (
                <p className="text-sm text-zinc-600 italic py-4">No snapshots yet. They&apos;re created each time the agent starts a task.</p>
            ) : (
                <div className="flex flex-col gap-1.5">
                    {snapshots.map(s => (
                        <div key={s.id}
                            className={`rounded-lg border px-4 py-3 cursor-pointer transition-colors ${selected?.id === s.id ? 'border-indigo-500/40 bg-indigo-950/10' : 'border-zinc-800 hover:border-zinc-700'}`}
                            onClick={() => setSelected(selected?.id === s.id ? null : s)}>
                            <div className="flex items-center justify-between">
                                <span className="text-xs font-medium text-zinc-300 capitalize">{s.triggeredBy.replace('_', ' ')}</span>
                                <span className="text-[10px] text-zinc-600">{new Date(s.createdAt).toLocaleString()}</span>
                            </div>
                            {s.triggerResourceId && <p className="text-[10px] text-zinc-700 font-mono mt-0.5">{s.triggerResourceId.slice(0, 8)}</p>}
                            {selected?.id === s.id && s.compiledPrompt && (
                                <pre className="mt-3 text-[11px] text-zinc-500 bg-zinc-950 rounded-lg p-3 overflow-auto max-h-48 whitespace-pre-wrap border border-zinc-800">
                                    {s.compiledPrompt}
                                </pre>
                            )}
                        </div>
                    ))}
                </div>
            )}
        </div>
    )
}

// ── Main page ──────────────────────────────────────────────────────────────────

export default function AgentSettingsPage() {
    return (
        <Suspense fallback={
            <div className="flex items-center gap-2 py-8 text-sm text-zinc-600">
                <RefreshCw className="h-4 w-4 animate-spin" /> Loading settings…
            </div>
        }>
            <AgentSettingsContent />
        </Suspense>
    )
}

function AgentSettingsContent() {
    const { workspaceId: ctxId } = useWorkspace()
    const WS_ID = ctxId || (process.env.NEXT_PUBLIC_DEFAULT_WORKSPACE ?? '')
    const searchParams = useSearchParams()

    const initialTab = (['identity', 'behavior', 'limits', 'quality', 'history'].includes(searchParams.get('tab') ?? '')
        ? searchParams.get('tab')!
        : 'identity') as Tab

    const [tab, setTab] = useState<Tab>(initialTab)
    const [agentStatus, setAgentStatus] = useState<AgentStatus | null>(null)
    const [settings, setSettings] = useState<WorkspaceSettings>({})
    const [workspaceName, setWorkspaceName] = useState('')
    const [workspaceId, setWorkspaceId] = useState('')
    const [loading, setLoading] = useState(true)
    const [saving, setSaving] = useState(false)
    const [saved, setSaved] = useState(false)

    // Behavior tab state
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
            if (statusRes.ok) setAgentStatus(await statusRes.json() as AgentStatus)
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

    // Lazy-load behavior data on first visit to that tab
    useEffect(() => {
        if (tab === 'behavior' && !behaviorLoaded.current) {
            behaviorLoaded.current = true
            void fetchBehavior()
        }
    }, [tab, fetchBehavior])

    async function handleSave() {
        if (!workspaceId) return
        setSaving(true)
        try {
            await fetch(`${API}/api/v1/workspaces/${workspaceId}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: workspaceName, settings }),
            })
            setSaved(true)
            setTimeout(() => setSaved(false), 2000)
        } finally {
            setSaving(false)
        }
    }

    function updateSetting<K extends keyof WorkspaceSettings>(key: K, value: WorkspaceSettings[K]) {
        setSettings(s => ({ ...s, [key]: value }))
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
        <div className="flex flex-col gap-6 max-w-3xl">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                    <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 text-xl shadow-lg shadow-indigo-500/20">
                        {settings.agentAvatar ?? '🤖'}
                    </div>
                    <div>
                        <h1 className="text-xl font-bold text-zinc-50">{settings.agentName || 'Agent'}</h1>
                        <p className="text-xs text-zinc-500">{settings.agentTagline || 'Configure your AI agent'}</p>
                    </div>
                </div>
                <div className="flex items-center gap-2">
                    <button onClick={() => void fetchCore()} disabled={loading}
                        className="rounded-lg border border-zinc-800 bg-zinc-900 p-2 text-zinc-500 hover:text-zinc-300 transition-colors">
                        <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
                    </button>
                    {showSaveButton && (
                        <button onClick={() => void handleSave()} disabled={saving || loading || !workspaceId}
                            className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50 transition-colors">
                            {saving ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : saved ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Save className="h-3.5 w-3.5" />}
                            {saved ? 'Saved' : 'Save changes'}
                        </button>
                    )}
                </div>
            </div>

            {/* Status banner */}
            {agentStatus && (
                <div className={`flex items-center gap-3 rounded-xl border px-4 py-3 ${agentStatus.status === 'running' ? 'border-green-800/40 bg-green-950/20' : 'border-zinc-800 bg-zinc-900/40'}`}>
                    <div className={`h-2.5 w-2.5 rounded-full shrink-0 ${agentStatus.status === 'running' ? 'bg-green-400 animate-pulse' : 'bg-zinc-600'}`} />
                    <div className="text-sm">
                        <span className="font-medium text-zinc-200 capitalize">{agentStatus.status}</span>
                        {agentStatus.currentTask && <span className="text-zinc-500 ml-2">· task {agentStatus.currentTask.slice(0, 8)}</span>}
                        {agentStatus.currentModel && <span className="text-zinc-600 ml-2">via {agentStatus.currentModel}</span>}
                    </div>
                    <div className="ml-auto text-xs text-zinc-600">{agentStatus.sessionCount} sessions</div>
                </div>
            )}

            {!workspaceId && !loading && (
                <div className="flex items-center gap-2 rounded-xl border border-amber-800/40 bg-amber-950/20 px-4 py-3 text-sm text-amber-400">
                    <AlertCircle className="h-4 w-4 shrink-0" />
                    NEXT_PUBLIC_DEFAULT_WORKSPACE not configured — settings cannot be saved.
                </div>
            )}

            {/* Tabs */}
            <div className="flex gap-1 border-b border-zinc-800">
                {TABS.map(({ id, label, icon: Icon }) => (
                    <button key={id} onClick={() => setTab(id)}
                        className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px ${tab === id ? 'border-indigo-500 text-indigo-400' : 'border-transparent text-zinc-500 hover:text-zinc-300'}`}>
                        <Icon className="h-3.5 w-3.5" />
                        {label}
                    </button>
                ))}
            </div>

            {/* ── Identity tab ── */}
            {tab === 'identity' && (
                loading ? (
                    <div className="flex items-center gap-2 py-8 text-sm text-zinc-600"><RefreshCw className="h-4 w-4 animate-spin" /> Loading…</div>
                ) : (
                    <div className="flex flex-col gap-4">
                        <Section title="Personality" icon={Sparkles}>
                            <div className="flex items-start gap-4">
                                <div className="flex flex-col gap-2">
                                    <label className="text-sm font-medium text-zinc-300">Avatar</label>
                                    <div className="flex flex-wrap gap-1.5">
                                        {['🤖', '🧠', '⚡', '🦾', '🌟', '👾', '🔱', '🦊', '🐉', '🔮'].map((emoji) => (
                                            <button key={emoji} onClick={() => updateSetting('agentAvatar', emoji)}
                                                className={`h-9 w-9 rounded-lg text-lg transition-all ${(settings.agentAvatar ?? '🤖') === emoji ? 'bg-indigo-600/30 ring-1 ring-indigo-500' : 'bg-zinc-800 hover:bg-zinc-700'}`}>
                                                {emoji}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                                <div className="flex flex-col items-center gap-1.5 ml-auto">
                                    <div className="flex h-14 w-14 items-center justify-center rounded-full bg-gradient-to-br from-indigo-500 to-purple-600 text-3xl shadow-lg shadow-indigo-500/20">
                                        {settings.agentAvatar ?? '🤖'}
                                    </div>
                                    <span className="text-xs text-zinc-500 font-medium">{settings.agentName || 'Plexo'}</span>
                                    {settings.agentTagline && <span className="text-[10px] text-zinc-600 italic max-w-[100px] text-center truncate">{settings.agentTagline}</span>}
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

                        <div className="flex items-start gap-2 text-xs text-zinc-600 px-1">
                            <Bot className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                            Changes take effect on the next task started after saving.
                        </div>
                    </div>
                )
            )}

            {/* ── Behavior tab ── */}
            {tab === 'behavior' && (
                <div className="flex flex-col gap-5">
                    {/* Simple fields — persona + domain knowledge */}
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
                            className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50 transition-colors">
                            {saving ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : saved ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Save className="h-3.5 w-3.5" />}
                            {saved ? 'Saved' : 'Save changes'}
                        </button>
                    </div>

                    {/* Advanced rules accordion */}
                    <div className="rounded-xl border border-zinc-800 overflow-hidden">
                        <button onClick={() => setShowAdvanced(v => !v)}
                            className="w-full flex items-center gap-3 px-5 py-4 hover:bg-zinc-800/20 transition-colors text-left">
                            <Settings2 className="h-4 w-4 text-zinc-500" />
                            <div className="flex-1">
                                <span className="text-sm font-medium text-zinc-300">Advanced rules</span>
                                <p className="text-xs text-zinc-600 mt-0.5">Fine-grained layered rules for communication style, operational limits, quality gates, and more.</p>
                            </div>
                            <ChevronDown className={`h-4 w-4 text-zinc-600 transition-transform ${showAdvanced ? 'rotate-180' : ''}`} />
                        </button>

                        {showAdvanced && (
                            <div className="px-5 pb-5 flex flex-col gap-4 border-t border-zinc-800">
                                {/* Inheritance toggle */}
                                <div className="flex items-center justify-between pt-4">
                                    <div className="flex items-center gap-3 text-xs text-zinc-600">
                                        <Layers className="h-3.5 w-3.5" />
                                        <span>Rule sources:</span>
                                        {(['platform', 'workspace', 'project', 'task'] as RuleSource[]).map(s => (
                                            <SourceBadge key={s} source={s} />
                                        ))}
                                        <span className="text-zinc-700">— later layers override earlier ones</span>
                                    </div>
                                    <button onClick={() => setInheritanceMode(m => !m)}
                                        className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-all ${inheritanceMode ? 'border-indigo-500/40 bg-indigo-950/20 text-indigo-400' : 'border-zinc-700 text-zinc-500 hover:text-zinc-300'}`}>
                                        <ArrowLeftRight className="h-3.5 w-3.5" />
                                        {inheritanceMode ? 'Inheritance view' : 'Inheritance view'}
                                    </button>
                                </div>

                                {behaviorError && (
                                    <div className="flex items-center gap-2 rounded-xl border border-red-800/40 bg-red-950/20 px-4 py-3 text-sm text-red-400">
                                        <X className="h-4 w-4 shrink-0" />
                                        {behaviorError}
                                        <button onClick={() => void fetchBehavior()} className="ml-auto text-xs underline">Retry</button>
                                    </div>
                                )}

                                {behaviorLoading ? (
                                    <div className="flex items-center gap-2 py-6 text-sm text-zinc-600">
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
                                    <SystemPromptPreview workspaceId={WS_ID} refreshTick={refreshTick} />
                                )}
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* ── Limits tab ── */}
            {tab === 'limits' && (
                loading ? (
                    <div className="flex items-center gap-2 py-8 text-sm text-zinc-600"><RefreshCw className="h-4 w-4 animate-spin" /> Loading…</div>
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
                                        className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 focus:border-indigo-500 focus:outline-none w-fit"
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
                                    <span className="text-sm text-zinc-500">$</span>
                                    <Input type="number" min={0} step={0.5}
                                        value={settings.costCeilingUsd ?? 10}
                                        onChange={e => updateSetting('costCeilingUsd', parseFloat(e.target.value) || 10)}
                                        className="w-28"
                                    />
                                    <span className="text-xs text-zinc-600">per week</span>
                                </div>
                            </Field>

                            <Field label="Low-confidence tasks" description="When the agent isn't sure about a result, what should happen?">
                                <select
                                    value={settings.autoApproveThreshold === undefined || settings.autoApproveThreshold >= 0.7 ? 'auto' : settings.autoApproveThreshold <= 0.3 ? 'always_ask' : 'manual'}
                                    onChange={e => {
                                        const v = e.target.value
                                        if (v === 'auto') updateSetting('autoApproveThreshold', 0.7)
                                        else if (v === 'always_ask') updateSetting('autoApproveThreshold', 0.0)
                                        else updateSetting('autoApproveThreshold', 0.5)
                                    }}
                                    className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 focus:border-indigo-500 focus:outline-none w-fit"
                                >
                                    <option value="auto">Auto-approve (default)</option>
                                    <option value="manual">Ask me when uncertain</option>
                                    <option value="always_ask">Always ask before completing</option>
                                </select>
                            </Field>

                            <Field label="Safe mode" description="When enabled, all file-write and destructive tool calls require your approval before executing.">
                                <div className="flex items-center gap-3">
                                    <Toggle checked={!!settings.safeMode} onChange={() => updateSetting('safeMode', !settings.safeMode)} />
                                    <span className="text-sm text-zinc-400">{settings.safeMode ? 'Enabled — writes need approval' : 'Disabled'}</span>
                                </div>
                            </Field>
                        </Section>

                        <div className="flex items-start gap-2 text-xs text-zinc-600 px-1">
                            <DollarSign className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                            Limits are enforced at task start. Changes take effect on the next task.
                        </div>
                    </div>
                )
            )}

            {/* ── Quality tab ── */}
            {tab === 'quality' && (
                <div className="flex flex-col gap-4">
                    <Section title="Ensemble configuration" icon={Users}>
                        <p className="text-sm text-zinc-400 leading-relaxed">
                            When Ollama is configured, Plexo recruits multiple local models to independently
                            score each task deliverable. Their weighted votes form a consensus quality score,
                            decoupled from the executing agent's self-assessment.
                        </p>

                        <div className="grid grid-cols-2 gap-4">
                            <Field label="Ensemble size" description="Max judges recruited from your Ollama instance per task.">
                                <select
                                    value={settings.ensembleSize ?? 3}
                                    onChange={e => updateSetting('ensembleSize', parseInt(e.target.value))}
                                    className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 focus:border-indigo-500 focus:outline-none w-fit"
                                >
                                    {[1, 2, 3, 4, 5].map(n => (
                                        <option key={n} value={n}>{n} judge{n !== 1 ? 's' : ''}</option>
                                    ))}
                                </select>
                            </Field>

                            <Field label="Dissent threshold" description="Score deviation that triggers cloud arbitration.">
                                <select
                                    value={settings.dissentThreshold ?? 0.25}
                                    onChange={e => updateSetting('dissentThreshold', parseFloat(e.target.value))}
                                    className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 focus:border-indigo-500 focus:outline-none w-fit"
                                >
                                    {[0.10, 0.15, 0.20, 0.25, 0.30, 0.40, 0.50].map(v => (
                                        <option key={v} value={v}>{Math.round(v * 100)}pp</option>
                                    ))}
                                </select>
                            </Field>
                        </div>

                        <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 flex flex-col gap-3">
                            <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">How it works</p>
                            <ol className="flex flex-col gap-2 text-xs text-zinc-500 list-none">
                                <li className="flex items-start gap-2">
                                    <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-indigo-900/50 text-[9px] font-bold text-indigo-400">1</span>
                                    Task completes → executor calls <code className="text-zinc-400">judgeQuality()</code>
                                </li>
                                <li className="flex items-start gap-2">
                                    <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-indigo-900/50 text-[9px] font-bold text-indigo-400">2</span>
                                    Ollama <code className="text-zinc-400">/api/tags</code> queried → up to <strong className="text-zinc-400">{settings.ensembleSize ?? 3}</strong> small models recruited
                                </li>
                                <li className="flex items-start gap-2">
                                    <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-indigo-900/50 text-[9px] font-bold text-indigo-400">3</span>
                                    All judges score the deliverable in parallel — weighted by their <code className="text-zinc-400">reliabilityScore</code>
                                </li>
                                <li className="flex items-start gap-2">
                                    <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-amber-900/50 text-[9px] font-bold text-amber-400">4</span>
                                    If any judge diverges &gt; <strong className="text-amber-400">{Math.round((settings.dissentThreshold ?? 0.25) * 100)}pp</strong> from consensus → cloud arbitrator resolves
                                </li>
                                <li className="flex items-start gap-2">
                                    <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-emerald-900/50 text-[9px] font-bold text-emerald-400">5</span>
                                    Result stored in task context · each judge's <code className="text-zinc-400">reliabilityScore</code> nudged ±0.5–1% based on agreement
                                </li>
                            </ol>
                        </div>

                        <div className="rounded-lg border border-zinc-800 bg-zinc-900/30 p-4 flex flex-col gap-2">
                            <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Model preference order</p>
                            <div className="flex flex-wrap gap-1.5">
                                {['llama3.2', 'llama3.1', 'phi3', 'phi3.5', 'gemma2', 'gemma3', 'mistral', 'qwen2.5', 'deepseek-r1'].map((m) => (
                                    <span key={m} className="rounded bg-zinc-800 px-2 py-0.5 text-[10px] font-mono text-zinc-500">{m}</span>
                                ))}
                            </div>
                            <p className="text-[11px] text-zinc-600">Tried in priority order. First {settings.ensembleSize ?? 3} available win.</p>
                        </div>

                        <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 flex flex-col gap-2">
                            <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Fallback modes</p>
                            <div className="flex flex-col gap-1.5 text-xs text-zinc-500">
                                {[
                                    { mode: 'ensemble', color: 'bg-indigo-900/30 text-indigo-400', label: 'Ollama configured + models available + consensus reached' },
                                    { mode: 'ensemble+arbitration', color: 'bg-amber-900/30 text-amber-400', label: 'Ensemble ran but judges disagreed — cloud resolved' },
                                    { mode: 'single', color: 'bg-zinc-800 text-zinc-400', label: 'Ollama not configured — single cheap cloud model judges' },
                                    { mode: 'fallback', color: 'bg-zinc-800 text-zinc-600', label: 'All judges failed — self-reported score passed through' },
                                ].map(({ mode, color, label }) => (
                                    <div key={mode} className="flex items-center gap-2">
                                        <span className={`rounded px-1.5 py-0.5 ${color} font-mono text-[10px]`}>{mode}</span>
                                        <span>{label}</span>
                                    </div>
                                ))}
                            </div>
                        </div>

                        <a
                            href="/settings/ai-providers"
                            className="inline-flex items-center gap-1.5 text-xs text-indigo-400 hover:text-indigo-300 transition-colors"
                        >
                            <Zap className="h-3.5 w-3.5" />
                            Configure Ollama in AI Providers →
                        </a>
                    </Section>
                </div>
            )}


            {/* ── History tab ── */}
            {tab === 'history' && WS_ID && <HistoryTab workspaceId={WS_ID} />}
        </div>
    )
}
