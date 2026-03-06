'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
    Code2,
    Search,
    PenLine,
    Server,
    BarChart2,
    Megaphone,
    Sparkles,
    ArrowRight,
    Zap,
    ChevronDown,
    DollarSign,
} from 'lucide-react'
import { CATEGORIES, type ProjectCategory, type CategoryDef } from '@web/lib/project-categories'

// ── Icon resolver ─────────────────────────────────────────────────────────────

const ICON_MAP: Record<string, React.ElementType> = {
    Code2, Search, PenLine, Server, BarChart2, Megaphone, Sparkles,
}

function CategoryIcon({ name, className }: { name: string; className?: string }) {
    const Icon = ICON_MAP[name] ?? Sparkles
    return <Icon className={className} />
}

// ── Category picker card ──────────────────────────────────────────────────────

function CategoryCard({
    def,
    selected,
    onSelect,
}: {
    def: CategoryDef
    selected: boolean
    onSelect: () => void
}) {
    return (
        <button
            type="button"
            onClick={onSelect}
            className={`group relative flex flex-col gap-2 rounded-xl border p-4 text-left transition-all duration-150 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 ${selected
                ? 'border-indigo-500/70 bg-indigo-500/10 shadow-[0_0_0_1px_rgba(99,102,241,0.3)]'
                : 'border-zinc-800 bg-zinc-900/40 hover:border-zinc-700 hover:bg-zinc-900/70'
                }`}
        >
            {/* Selected indicator */}
            {selected && (
                <span className="absolute right-3 top-3 flex h-4 w-4 items-center justify-center rounded-full bg-indigo-500 text-[10px] text-white">
                    ✓
                </span>
            )}

            {/* Icon */}
            <div
                className={`flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-to-br ${def.accent} text-white shadow-sm transition-transform group-hover:scale-105 ${selected ? 'scale-105' : ''}`}
            >
                <CategoryIcon name={def.icon} className="h-4.5 w-4.5 h-[18px] w-[18px]" />
            </div>

            {/* Labels */}
            <div>
                <p className={`text-sm font-semibold transition-colors ${selected ? 'text-zinc-100' : 'text-zinc-300 group-hover:text-zinc-200'}`}>
                    {def.label}
                </p>
                <p className="mt-0.5 text-[11px] text-zinc-500 leading-relaxed">
                    {def.description}
                </p>
            </div>
        </button>
    )
}

// ── URL list field ─────────────────────────────────────────────────────────────

function UrlListField({
    value,
    onChange,
    placeholder,
}: {
    value: string
    onChange: (v: string) => void
    placeholder?: string
}) {
    return (
        <textarea
            rows={3}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder ?? 'https://...'}
            className="resize-none rounded-lg border border-zinc-800 bg-zinc-900 px-3.5 py-2.5 text-sm text-zinc-200 placeholder-zinc-600 leading-relaxed focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500/30 transition-colors font-mono text-[12px]"
        />
    )
}

// ── Main component ────────────────────────────────────────────────────────────

export default function NewProjectPage() {
    const router = useRouter()
    const [isPending, startTransition] = useTransition()
    const [category, setCategory] = useState<ProjectCategory | null>(null)
    const [request, setRequest] = useState('')
    const [extraValues, setExtraValues] = useState<Record<string, string>>({})
    const [autoRun, setAutoRun] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const [showBudget, setShowBudget] = useState(false)
    const [projectCeiling, setProjectCeiling] = useState('')
    const [taskCeiling, setTaskCeiling] = useState('')
    // Track whether the category was just selected (for animation)
    const [didSelect, setDidSelect] = useState(false)

    const apiBase = (typeof window !== 'undefined' ? '' : (process.env.INTERNAL_API_URL || 'http://localhost:3001'))
    const workspaceId = process.env.NEXT_PUBLIC_DEFAULT_WORKSPACE ?? '00000000-0000-0000-0000-000000000000'

    const def = category ? CATEGORIES.find((c) => c.id === category) : null

    function handleCategoryChange(id: ProjectCategory) {
        if (id !== category) {
            setExtraValues({})
            setDidSelect(true)
            setTimeout(() => setDidSelect(false), 400)
        }
        setCategory(id)
    }

    function setExtra(key: string, value: string) {
        setExtraValues((prev) => ({ ...prev, [key]: value }))
    }

    function canSubmit(): boolean {
        if (!category || !request.trim() || request.trim().length < 10) return false
        if (!def) return false
        // Validate required extra fields
        for (const field of def.extraFields) {
            if (field.required && !extraValues[field.key]?.trim()) return false
        }
        return true
    }

    async function handleSubmit(e: React.FormEvent) {
        e.preventDefault()
        if (!category || !def) return
        setError(null)

        // Build metadata from extra fields
        const metadata: Record<string, string> = {}
        for (const field of def.extraFields) {
            if (extraValues[field.key]) metadata[field.key] = extraValues[field.key]
        }

        // For code category, repo comes from extraValues
        const repo = category === 'code' ? (extraValues['repo'] ?? '') : undefined

        try {
            const projectCeilingNum = parseFloat(projectCeiling)
            const taskCeilingNum = parseFloat(taskCeiling)

            const createRes = await fetch(`${apiBase}/api/v1/sprints`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    workspaceId,
                    category,
                    repo,
                    request: request.trim(),
                    metadata,
                    ...(projectCeilingNum > 0 ? { costCeilingUsd: projectCeilingNum } : {}),
                    ...(taskCeilingNum > 0 ? { perTaskCostCeiling: taskCeilingNum } : {}),
                }),
            })

            if (!createRes.ok) {
                const body = await createRes.json() as { error?: { message?: string } }
                throw new Error(body.error?.message ?? 'Failed to create project')
            }

            const { id: sprintId } = await createRes.json() as { id: string }

            // Auto-run only supported for code category right now (runner needs repo + GitHub)
            if (autoRun && category === 'code') {
                await fetch(`${apiBase}/api/v1/sprints/${sprintId}/run`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ workspaceId }),
                })
            }

            startTransition(() => {
                router.push(`/projects/${sprintId}`)
            })
        } catch (err) {
            setError((err as Error).message)
        }
    }

    return (
        <div className="mx-auto max-w-2xl">
            {/* Header */}
            <div className="mb-7">
                <h1 className="text-xl font-bold text-zinc-50">New Project</h1>
                <p className="mt-0.5 text-sm text-zinc-500">
                    Choose a category, describe your goal, and Plexo breaks it into parallel work.
                </p>
            </div>

            <form onSubmit={handleSubmit} className="flex flex-col gap-6">
                {/* Category picker */}
                <div className="flex flex-col gap-2.5">
                    <label className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
                        What kind of project is this?
                    </label>
                    <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 md:grid-cols-4">
                        {CATEGORIES.map((c) => (
                            <CategoryCard
                                key={c.id}
                                def={c}
                                selected={category === c.id}
                                onSelect={() => handleCategoryChange(c.id)}
                            />
                        ))}
                    </div>
                </div>

                {/* Dynamic fields — revealed after category selection */}
                {def && (
                    <div
                        className={`flex flex-col gap-5 transition-all duration-300 ${didSelect ? 'opacity-0 translate-y-1' : 'opacity-100 translate-y-0'}`}
                        style={{ animation: didSelect ? undefined : 'fadeSlideIn 0.25s ease both' }}
                    >
                        {/* Category-specific extra fields */}
                        {def.extraFields.map((field) => (
                            <div key={field.key} className="flex flex-col gap-1.5">
                                <label className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
                                    {field.label}
                                    {field.required && <span className="ml-1 text-indigo-400">*</span>}
                                </label>

                                {field.type === 'text' && (
                                    <input
                                        id={`field-${field.key}`}
                                        type="text"
                                        placeholder={field.placeholder}
                                        value={extraValues[field.key] ?? ''}
                                        onChange={(e) => setExtra(field.key, e.target.value)}
                                        required={field.required}
                                        className="rounded-lg border border-zinc-800 bg-zinc-900 px-3.5 py-2.5 text-sm text-zinc-200 placeholder-zinc-600 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500/30 transition-colors"
                                    />
                                )}

                                {field.type === 'textarea' && (
                                    <textarea
                                        id={`field-${field.key}`}
                                        rows={3}
                                        placeholder={field.placeholder}
                                        value={extraValues[field.key] ?? ''}
                                        onChange={(e) => setExtra(field.key, e.target.value)}
                                        className="resize-none rounded-lg border border-zinc-800 bg-zinc-900 px-3.5 py-2.5 text-sm text-zinc-200 placeholder-zinc-600 leading-relaxed focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500/30 transition-colors"
                                    />
                                )}

                                {field.type === 'select' && (
                                    <select
                                        id={`field-${field.key}`}
                                        value={extraValues[field.key] ?? (field.options?.[0]?.value ?? '')}
                                        onChange={(e) => setExtra(field.key, e.target.value)}
                                        className="rounded-lg border border-zinc-800 bg-zinc-900 px-3.5 py-2.5 text-sm text-zinc-200 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500/30 transition-colors"
                                    >
                                        {field.options?.map((opt) => (
                                            <option key={opt.value} value={opt.value}>
                                                {opt.label}
                                            </option>
                                        ))}
                                    </select>
                                )}

                                {field.type === 'url-list' && (
                                    <UrlListField
                                        value={extraValues[field.key] ?? ''}
                                        onChange={(v) => setExtra(field.key, v)}
                                        placeholder={field.placeholder}
                                    />
                                )}

                                {field.hint && (
                                    <p className="text-[11px] text-zinc-600">{field.hint}</p>
                                )}
                            </div>
                        ))}

                        {/* Request / goal — always shown */}
                        <div className="flex flex-col gap-1.5">
                            <label className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
                                {def.requestLabel}
                            </label>
                            <textarea
                                id="project-request"
                                rows={5}
                                placeholder={def.requestPlaceholder}
                                value={request}
                                onChange={(e) => setRequest(e.target.value)}
                                required
                                minLength={10}
                                className="resize-none rounded-lg border border-zinc-800 bg-zinc-900 px-3.5 py-2.5 text-sm text-zinc-200 placeholder-zinc-600 leading-relaxed focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500/30 transition-colors"
                            />
                            <p className="text-[11px] text-zinc-600">
                                Be specific. Plexo uses this to plan the work and identify what can run in parallel.
                            </p>
                        </div>

                        {/* Budget — optional, collapsed by default */}
                        <div className="rounded-lg border border-zinc-800 bg-zinc-900/30 overflow-hidden">
                            <button
                                type="button"
                                id="budget-toggle"
                                aria-expanded={showBudget}
                                onClick={() => setShowBudget((v) => !v)}
                                className="flex w-full items-center justify-between px-4 py-3 text-left"
                            >
                                <div className="flex items-center gap-2">
                                    <DollarSign className="h-3.5 w-3.5 text-zinc-600" />
                                    <span className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Budget</span>
                                    {(parseFloat(projectCeiling) > 0 || parseFloat(taskCeiling) > 0) && (
                                        <span className="rounded-full bg-indigo-500/15 border border-indigo-500/30 px-1.5 py-0.5 text-[10px] text-indigo-400">set</span>
                                    )}
                                </div>
                                <ChevronDown
                                    className={`h-3.5 w-3.5 text-zinc-600 transition-transform duration-200 ${showBudget ? 'rotate-180' : ''}`}
                                />
                            </button>

                            {showBudget && (
                                <div className="border-t border-zinc-800 px-4 pb-4 pt-3 flex flex-col gap-3">
                                    <div className="grid grid-cols-2 gap-3">
                                        <div className="flex flex-col gap-1">
                                            <label htmlFor="budget-project" className="text-[11px] text-zinc-500">
                                                Project ceiling
                                            </label>
                                            <div className="relative">
                                                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-600 text-sm">$</span>
                                                <input
                                                    id="budget-project"
                                                    type="number"
                                                    min="0.01"
                                                    step="0.50"
                                                    placeholder="e.g. 5.00"
                                                    value={projectCeiling}
                                                    onChange={(e) => setProjectCeiling(e.target.value)}
                                                    className="w-full rounded-lg border border-zinc-800 bg-zinc-900 pl-7 pr-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500/30 transition-colors"
                                                />
                                            </div>
                                            <p className="text-[10px] text-zinc-600">Total across all tasks</p>
                                        </div>
                                        <div className="flex flex-col gap-1">
                                            <label htmlFor="budget-task" className="text-[11px] text-zinc-500">
                                                Per-task ceiling
                                            </label>
                                            <div className="relative">
                                                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-600 text-sm">$</span>
                                                <input
                                                    id="budget-task"
                                                    type="number"
                                                    min="0.01"
                                                    step="0.10"
                                                    placeholder="e.g. 0.50"
                                                    value={taskCeiling}
                                                    onChange={(e) => setTaskCeiling(e.target.value)}
                                                    className="w-full rounded-lg border border-zinc-800 bg-zinc-900 pl-7 pr-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500/30 transition-colors"
                                                />
                                            </div>
                                            <p className="text-[10px] text-zinc-600">Applied to each task individually</p>
                                        </div>
                                    </div>
                                    <p className="text-[11px] text-zinc-600">
                                        Optional. Leave blank to use workspace defaults. Tasks are blocked, not errored, if a ceiling is hit.
                                    </p>
                                </div>
                            )}
                        </div>

                        {/* Auto-run toggle — code only with note for others */}
                        <div className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-900/60 px-4 py-3">
                            <div>
                                <p className="text-sm font-medium text-zinc-300">
                                    {category === 'code' ? 'Auto-run after planning' : 'Auto-run'}
                                </p>
                                <p className="text-xs text-zinc-500 mt-0.5">
                                    {category === 'code'
                                        ? 'Starts execution immediately. Disable to review the plan first.'
                                        : 'Automated execution for this category is coming soon.'}
                                </p>
                            </div>
                            <button
                                type="button"
                                role="switch"
                                aria-checked={autoRun && category === 'code'}
                                disabled={category !== 'code'}
                                onClick={() => setAutoRun((r) => !r)}
                                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 focus:ring-offset-zinc-900 disabled:opacity-30 ${autoRun && category === 'code' ? 'bg-indigo-600' : 'bg-zinc-700'}`}
                            >
                                <span
                                    className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${autoRun && category === 'code' ? 'translate-x-6' : 'translate-x-1'}`}
                                />
                            </button>
                        </div>

                        {/* How it works — category-specific */}
                        <div className="rounded-lg border border-zinc-800/60 bg-zinc-900/30 p-4">
                            <div className="flex items-center gap-2 mb-3">
                                <div className={`flex h-5 w-5 items-center justify-center rounded bg-gradient-to-br ${def.accent} text-white`}>
                                    <CategoryIcon name={def.icon} className="h-3 w-3" />
                                </div>
                                <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
                                    How {def.label} projects work
                                </p>
                            </div>
                            <ol className="flex flex-col gap-1.5">
                                {def.howItWorks.map((step, i) => (
                                    <li key={i} className="flex items-start gap-2 text-xs text-zinc-500">
                                        <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-zinc-800 text-[10px] font-bold text-zinc-400">
                                            {i + 1}
                                        </span>
                                        {step}
                                    </li>
                                ))}
                            </ol>
                        </div>

                        {/* Error */}
                        {error && (
                            <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
                                {error}
                            </div>
                        )}

                        {/* Actions */}
                        <div className="flex items-center gap-3 pt-1">
                            <button
                                type="submit"
                                disabled={isPending || !canSubmit()}
                                className="flex items-center gap-2 rounded-lg bg-indigo-600 px-5 py-2.5 text-sm font-medium text-white transition-all hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed"
                            >
                                {isPending ? (
                                    <>
                                        <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                                        Creating…
                                    </>
                                ) : (
                                    <>
                                        {category === 'code' && autoRun ? (
                                            <Zap className="h-4 w-4" />
                                        ) : (
                                            <ArrowRight className="h-4 w-4" />
                                        )}
                                        {category === 'code' && autoRun
                                            ? `Create & Run`
                                            : `Create ${def.label} Project`}
                                    </>
                                )}
                            </button>
                            <button
                                type="button"
                                onClick={() => router.back()}
                                disabled={isPending}
                                className="rounded-lg px-4 py-2.5 text-sm text-zinc-500 hover:text-zinc-300 transition-colors disabled:opacity-40"
                            >
                                Cancel
                            </button>
                        </div>
                    </div>
                )}

                {/* Prompt when no category selected yet */}
                {!def && (
                    <div className="flex items-center gap-2 py-2 text-xs text-zinc-600 animate-pulse">
                        <span className="h-px flex-1 bg-zinc-800" />
                        <span>Select a category above to continue</span>
                        <span className="h-px flex-1 bg-zinc-800" />
                    </div>
                )}
            </form>

            <style>{`
                @keyframes fadeSlideIn {
                    from { opacity: 0; transform: translateY(6px); }
                    to { opacity: 1; transform: translateY(0); }
                }
            `}</style>
        </div>
    )
}
