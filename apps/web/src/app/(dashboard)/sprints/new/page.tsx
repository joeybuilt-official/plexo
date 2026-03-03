'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'

interface FormState {
    repo: string
    request: string
    autoRun: boolean
}

export default function NewProjectPage() {
    const router = useRouter()
    const [isPending, startTransition] = useTransition()
    const [form, setForm] = useState<FormState>({ repo: '', request: '', autoRun: true })
    const [error, setError] = useState<string | null>(null)

    async function handleSubmit(e: React.FormEvent) {
        e.preventDefault()
        setError(null)

        const apiBase = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001'
        const workspaceId = process.env.NEXT_PUBLIC_DEV_WORKSPACE_ID ?? '00000000-0000-0000-0000-000000000000'

        try {
            // 1. Create the sprint record
            const createRes = await fetch(`${apiBase}/api/sprints`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ workspaceId, repo: form.repo, request: form.request }),
            })

            if (!createRes.ok) {
                const body = await createRes.json() as { error?: { message?: string } }
                throw new Error(body.error?.message ?? 'Failed to create sprint')
            }

            const { id: sprintId } = await createRes.json() as { id: string }

            // 2. Optionally auto-run
            if (form.autoRun) {
                await fetch(`${apiBase}/api/sprints/${sprintId}/run`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ workspaceId }),
                })
                // 202 — fire and forget; redirect to detail page
            }

            startTransition(() => {
                router.push(`/sprints/${sprintId}`)
            })
        } catch (err) {
            setError((err as Error).message)
        }
    }

    return (
        <div className="mx-auto max-w-2xl">
            {/* Header */}
            <div className="mb-6">
                <h1 className="text-xl font-bold text-zinc-50">New Project</h1>
                <p className="mt-0.5 text-sm text-zinc-500">
                    Describe a goal. Plexo breaks it into parallel tasks and works on them simultaneously.
                </p>
            </div>

            <form onSubmit={handleSubmit} className="flex flex-col gap-5">
                {/* Repo */}
                <div className="flex flex-col gap-1.5">
                    <label className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
                        GitHub Repository
                    </label>
                    <input
                        id="sprint-repo"
                        type="text"
                        placeholder="owner/repo"
                        value={form.repo}
                        onChange={(e) => setForm((f) => ({ ...f, repo: e.target.value }))}
                        required
                        pattern="[^/]+/[^/]+"
                        title="Format: owner/repo"
                        className="rounded-lg border border-zinc-800 bg-zinc-900 px-3.5 py-2.5 text-sm text-zinc-200 placeholder-zinc-600 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500/30 transition-colors"
                    />
                    <p className="text-[11px] text-zinc-600">
                        Must match a GitHub repository you have access to.
                    </p>
                </div>

                {/* Request */}
                <div className="flex flex-col gap-1.5">
                    <label className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
                        Request
                    </label>
                    <textarea
                        id="sprint-request"
                        rows={5}
                        placeholder="Add rate limiting to all public API routes, implement request deduplication, and add OpenTelemetry tracing to the auth service…"
                        value={form.request}
                        onChange={(e) => setForm((f) => ({ ...f, request: e.target.value }))}
                        required
                        minLength={20}
                        className="resize-none rounded-lg border border-zinc-800 bg-zinc-900 px-3.5 py-2.5 text-sm text-zinc-200 placeholder-zinc-600 leading-relaxed focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500/30 transition-colors"
                    />
                    <p className="text-[11px] text-zinc-600">
                        Be specific. Plexo uses this to plan the work and identify what can run in parallel.
                    </p>
                </div>

                {/* Auto-run toggle */}
                <div className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-900/60 px-4 py-3">
                    <div>
                        <p className="text-sm font-medium text-zinc-300">Auto-run after planning</p>
                        <p className="text-xs text-zinc-500 mt-0.5">
                            Starts execution immediately. Disable to review the plan first.
                        </p>
                    </div>
                    <button
                        type="button"
                        role="switch"
                        aria-checked={form.autoRun}
                        onClick={() => setForm((f) => ({ ...f, autoRun: !f.autoRun }))}
                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 focus:ring-offset-zinc-900 ${form.autoRun ? 'bg-indigo-600' : 'bg-zinc-700'}`}
                    >
                        <span
                            className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${form.autoRun ? 'translate-x-6' : 'translate-x-1'}`}
                        />
                    </button>
                </div>

                {/* How it works */}
                <div className="rounded-lg border border-zinc-800/60 bg-zinc-900/30 p-4">
                    <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-2">How projects work</p>
                    <ol className="flex flex-col gap-1.5">
                    {[
                    'Plexo analyzes your goal and the repository',
                    'Breaks it into parallel tasks that can run simultaneously',
                    'Each task runs in isolation, then results are combined',
                    'Draft pull requests are opened; any conflicts flagged for review',
                    ].map((step, i) => (
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
                        disabled={isPending || !form.repo || !form.request}
                        className="flex items-center gap-2 rounded-lg bg-indigo-600 px-5 py-2.5 text-sm font-medium text-white transition-all hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                        {isPending ? (
                            <>
                                <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                                Creating…
                            </>
                        ) : (
                            <>
                                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                                </svg>
                                {form.autoRun ? 'Create & Run' : 'Create Project'}
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
            </form>
        </div>
    )
}
