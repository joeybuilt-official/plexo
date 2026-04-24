// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { useState, useEffect } from 'react'
import {
    RefreshCw, Check, Plus, Trash2, Lock, ChevronDown, Eye, EyeOff,
    Shield, Settings2, MessageSquare, BookOpen, Sparkles, Wrench, Target,
} from 'lucide-react'
import { Toggle } from './ui-primitives'
import type { BehaviorRule, GroupDef, ResolvedRule, RuleSource, RuleType, RuleValue } from './types'
import { API } from './types'

const ICON_MAP: Record<string, React.ElementType> = {
    Shield, Settings2, MessageSquare, BookOpen, Sparkles, Wrench, Target,
}

const COLOR_MAP: Record<string, { border: string; accent: string; bg: string; text: string; badge: string }> = {
    red: { border: 'border-red-800/40', accent: 'border-l-red-500', bg: 'bg-red-dim', text: 'text-red', badge: 'bg-red-900/30 text-red' },
    amber: { border: 'border-amber-800/40', accent: 'border-l-amber-500', bg: 'bg-amber-dim', text: 'text-amber', badge: 'bg-amber-900/30 text-amber' },
    blue: { border: 'border-azure-800/40', accent: 'border-l-azure', bg: 'bg-azure-dim', text: 'text-azure', badge: 'bg-azure/10 text-azure' },
    green: { border: 'border-green-800/40', accent: 'border-l-green-500', bg: 'bg-surface-2', text: 'text-green-400', badge: 'bg-green-900/30 text-green-400' },
    purple: { border: 'border-purple-800/40', accent: 'border-l-purple-500', bg: 'bg-surface-2', text: 'text-purple-400', badge: 'bg-purple-900/30 text-purple-400' },
    orange: { border: 'border-orange-800/40', accent: 'border-l-orange-500', bg: 'bg-amber-dim/20', text: 'text-orange-400', badge: 'bg-orange-900/30 text-orange-400' },
    zinc: { border: 'border-border/40', accent: 'border-l-border', bg: 'bg-surface-1/20', text: 'text-text-secondary', badge: 'bg-surface-2/40 text-text-secondary' },
}

export function SourceBadge({ source }: { source: RuleSource }) {
    const map: Record<RuleSource, string> = {
        platform: 'bg-surface-2 text-text-muted',
        workspace: 'bg-azure/10 text-azure',
        project: 'bg-purple-900/30 text-purple-400',
        task: 'bg-amber-900/30 text-amber',
    }
    return <span className={`text-[11px] font-medium px-1.5 py-0.5 rounded uppercase tracking-wide ${map[source]}`}>{source}</span>
}

function RuleValueEditor({ val, locked, onChange }: { val: RuleValue; locked: boolean; onChange: (v: RuleValue) => void }) {
    if (locked) {
        return <span className="text-sm text-text-muted font-mono">{val.type === 'boolean' ? (val.value ? 'enabled' : 'disabled') : String(val.value)}</span>
    }
    switch (val.type) {
        case 'boolean':
            return <Toggle checked={!!val.value} onChange={() => onChange({ ...val, value: !val.value })} />
        case 'number':
            return (
                <input type="number" value={val.value as number} min={val.min} max={val.max}
                    onChange={e => onChange({ ...val, value: parseFloat(e.target.value) })}
                    className="w-full sm:w-24 min-h-[44px] rounded-lg border border-border bg-surface-1 px-4 py-2.5 text-[16px] sm:text-sm text-text-primary focus:border-azure focus-ring"
                />
            )
        case 'enum':
            return (
                <select value={val.value as string} onChange={e => onChange({ ...val, value: e.target.value })}
                    className="w-full min-h-[44px] rounded-lg border border-border bg-surface-1 px-3 py-2 text-[16px] sm:text-sm text-text-primary focus:border-azure focus-ring">
                    {(val.options ?? []).map(opt => <option key={opt} value={opt}>{opt}</option>)}
                </select>
            )
        case 'string':
            return (
                <input type="text" value={val.value as string} onChange={e => onChange({ ...val, value: e.target.value })}
                    className="flex-1 w-full min-h-[44px] rounded-lg border border-border bg-surface-1 px-4 py-2.5 text-[16px] sm:text-sm text-text-primary focus:border-azure focus-ring"
                />
            )
        case 'text_block':
            return (
                <textarea value={val.value as string} onChange={e => onChange({ ...val, value: e.target.value })} rows={3}
                    className="flex-1 w-full resize-none min-h-[44px] rounded-lg border border-border bg-surface-1 px-4 py-2.5 text-[16px] sm:text-sm text-text-primary focus:border-azure focus-ring leading-relaxed"
                />
            )
        default:
            return <span className="text-xs text-text-muted font-mono break-all">{JSON.stringify(val.value)}</span>
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
        <div className={`group flex flex-col gap-2 py-3 border-b border-border/60 last:border-0 ${overriddenBy ? 'opacity-60' : ''}`}>
            <div className="flex flex-col sm:flex-row sm:items-start gap-3">
                <div className="flex items-start gap-3 flex-1 min-w-0">
                    {rule.locked && <Lock className="h-3.5 w-3.5 text-text-muted mt-0.5 shrink-0" />}
                    <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-sm font-medium text-text-primary">{rule.label}</span>
                            {showSource && <SourceBadge source={source} />}
                            {overriddenBy && <span className="text-[11px] text-text-muted italic">overridden at {overriddenBy.source} level</span>}
                            {rule.locked && <span className="text-[11px] text-text-muted px-1.5 py-0.5 rounded border border-border">enforced</span>}
                        </div>
                        {rule.description && <p className="text-xs text-text-muted mt-0.5">{rule.description}</p>}
                    </div>
                </div>
                <div className="flex items-center gap-2 shrink-0 w-full sm:w-auto mt-2 sm:mt-0">
                    <div className="flex-1 sm:flex-initial">
                        <RuleValueEditor val={localVal} locked={rule.locked} onChange={handleChange} />
                    </div>
                    {needsTextSave && dirty && (
                        <button onClick={() => void handleSave()} disabled={saving}
                            className="text-[16px] sm:text-xs bg-azure text-text-primary min-h-[44px] min-w-[44px] rounded-lg hover:bg-azure/90 disabled:opacity-50 flex flex-col items-center justify-center shrink-0">
                            {saving ? <RefreshCw className="h-4 w-4 sm:h-3 sm:w-3 animate-spin" /> : <Check className="h-4 w-4 sm:h-3 sm:w-3" />}
                        </button>
                    )}
                    {!rule.locked && (
                        <button onClick={() => onDelete(id)}
                            className="text-text-muted hover:text-red transition-colors sm:opacity-0 group-hover:opacity-100 min-h-[44px] min-w-[44px] flex items-center justify-center shrink-0"
                            aria-label="Delete rule">
                            <Trash2 className="h-4 w-4 sm:h-3.5 sm:w-3.5" />
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
        <div className="mt-3 border border-dashed border-border rounded-xl p-4 flex flex-col gap-4 sm:gap-3 bg-surface-1/30 w-full">
            <div className="flex flex-col sm:flex-row gap-4 sm:gap-3">
                <div className="flex-1">
                    <label className="text-xs text-text-muted mb-1 block">Label</label>
                    <input type="text" value={label} onChange={e => setLabel(e.target.value)} autoFocus
                        placeholder="e.g. Always use TypeScript strict mode"
                        className="w-full min-h-[44px] rounded-lg border border-border bg-surface-1 px-4 py-2.5 text-[16px] sm:text-sm text-text-primary placeholder:text-text-muted focus:border-azure focus-ring"
                    />
                    {autoKey && <p className="text-[11px] text-text-muted mt-1 sm:mt-0.5 font-mono">key: {autoKey}</p>}
                </div>
                <div>
                    <label className="text-xs text-text-muted mb-1 block">Type</label>
                    <select value={valueType} onChange={e => setValueType(e.target.value as RuleValue['type'])}
                        className="w-full sm:w-auto min-h-[44px] rounded-lg border border-border bg-surface-1 px-4 py-2.5 text-[16px] sm:text-sm text-text-primary focus:border-azure focus-ring">
                        <option value="text_block">Text block</option>
                        <option value="string">Short string</option>
                        <option value="boolean">Toggle</option>
                        <option value="number">Number</option>
                        <option value="enum">Enum (comma-sep)</option>
                    </select>
                </div>
            </div>
            <div>
                <label className="text-xs text-text-muted mb-1 block">
                    {valueType === 'text_block' ? 'Content' : valueType === 'enum' ? 'Options (comma-separated)' : 'Value'}
                </label>
                {valueType === 'text_block' ? (
                    <textarea rows={3} value={value} onChange={e => setValue(e.target.value)}
                        placeholder="Enter the rule content…"
                        className="w-full resize-none min-h-[44px] rounded-lg border border-border bg-surface-1 px-4 py-2.5 text-[16px] sm:text-sm text-text-primary placeholder:text-text-muted focus:border-azure focus-ring"
                    />
                ) : (
                    <input type={valueType === 'number' ? 'number' : 'text'} value={value} onChange={e => setValue(e.target.value)}
                        placeholder={valueType === 'enum' ? 'option1, option2, option3' : ''}
                        className="w-full min-h-[44px] rounded-lg border border-border bg-surface-1 px-4 py-2.5 text-[16px] sm:text-sm text-text-primary placeholder:text-text-muted focus:border-azure focus-ring"
                    />
                )}
            </div>
            <div>
                <label className="text-xs text-text-muted mb-1 block">Description (optional)</label>
                <input type="text" value={description} onChange={e => setDescription(e.target.value)}
                    placeholder="What does this rule do?"
                    className="w-full min-h-[44px] rounded-lg border border-border bg-surface-1 px-4 py-2.5 text-[16px] sm:text-sm text-text-primary placeholder:text-text-muted focus:border-azure focus-ring"
                />
            </div>
            <div className="flex flex-col sm:flex-row gap-2 justify-end mt-2">
                <button onClick={onCancel} className="text-[16px] sm:text-xs text-text-secondary hover:text-text-primary min-h-[44px] px-4 rounded-lg transition-colors border border-border sm:border-transparent">Cancel</button>
                <button onClick={() => { if (!label.trim()) return; onAdd({ type, key: autoKey, label: label.trim(), description, value: buildValue() }) }}
                    disabled={!label.trim()}
                    className="flex justify-center items-center text-[16px] sm:text-xs bg-azure text-text-primary min-h-[44px] px-4 rounded-lg hover:bg-azure/90 disabled:opacity-40 transition-colors cursor-pointer">
                    Add rule
                </button>
            </div>
        </div>
    )
}

export function BehaviorCard({ group, rules, inheritanceMode, resolvedRules, onUpdate, onDelete, onAdd }: {
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
        <div className={`rounded-xl border ${colors.border} border-l-4 ${colors.accent} bg-surface-1/40 overflow-hidden`}>
            <button onClick={() => setExpanded(e => !e)}
                className="w-full flex items-center gap-3 px-4 sm:px-5 py-4 min-h-[64px] hover:bg-surface-2/20 transition-colors text-left">
                <div className={`p-1.5 rounded-lg ${colors.bg}`}>
                    <Icon className={`h-4 w-4 ${colors.text}`} />
                </div>
                <div className="flex-1 min-w-0 pr-2">
                    <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-text-primary">{group.label}</span>
                        {group.locked && <Lock className="h-3 w-3 text-text-muted shrink-0" />}
                    </div>
                    <p className="text-xs text-text-muted truncate mt-0.5 max-w-[200px] sm:max-w-none">{group.description}</p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${colors.badge}`}>
                        <span className="whitespace-nowrap">{displayRules.length} <span className="hidden sm:inline">{displayRules.length === 1 ? 'rule' : 'rules'}</span></span>
                    </span>
                    <ChevronDown className={`h-4 w-4 text-text-muted transition-transform ${expanded ? 'rotate-180' : ''}`} />
                </div>
            </button>
            {expanded && (
                <div className="px-5 pb-4">
                    {displayRules.length === 0 && !adding ? (
                        <p className="text-xs text-text-muted py-2 italic">No rules yet.</p>
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
                                className={`mt-2 flex items-center justify-center gap-1.5 text-[16px] sm:text-xs ${colors.text} hover:opacity-80 transition-opacity min-h-[44px] w-full sm:w-auto sm:justify-start border border-dashed border-border sm:border-transparent rounded-lg`}>
                                <Plus className="h-4 w-4 sm:h-3.5 sm:w-3.5" /> Add rule
                            </button>
                        )
                    )}
                    {group.locked && (
                        <p className="text-[11px] text-text-muted mt-2 flex items-center gap-1.5">
                            <Lock className="h-3 w-3" /> These constraints are structurally enforced and cannot be removed or disabled.
                        </p>
                    )}
                </div>
            )}
        </div>
    )
}

export function SystemPromptPreview({ workspaceId, refreshTick }: { workspaceId: string; refreshTick: number }) {
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
        <div className="rounded-xl border border-border bg-surface-1/40 overflow-hidden">
            <button onClick={() => setOpen(o => !o)}
                className="w-full flex items-center gap-3 px-4 sm:px-5 py-4 min-h-[64px] hover:bg-surface-2/20 transition-colors text-left">
                {open ? <EyeOff className="h-4 w-4 text-text-muted shrink-0" /> : <Eye className="h-4 w-4 text-text-muted shrink-0" />}
                <span className="text-sm font-medium text-text-secondary min-w-0 truncate">{open ? 'Hide' : 'Preview'} compiled system prompt</span>
                <span className="ml-auto text-xs text-text-muted shrink-0 hidden sm:inline">What the agent actually receives →</span>
            </button>
            {open && (
                <div className="px-5 pb-5">
                    {loading ? (
                        <div className="flex items-center gap-2 py-4 text-sm text-text-muted"><RefreshCw className="h-3.5 w-3.5 animate-spin" /> Compiling…</div>
                    ) : prompt ? (
                        <pre className="text-xs text-text-secondary bg-canvas rounded-lg p-4 overflow-auto max-h-80 whitespace-pre-wrap leading-relaxed border border-border">{prompt}</pre>
                    ) : (
                        <p className="text-sm text-text-muted py-2 italic">No rules configured yet.</p>
                    )}
                </div>
            )}
        </div>
    )
}
