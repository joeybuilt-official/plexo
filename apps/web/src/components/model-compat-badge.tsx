// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

/**
 * Model-compatibility status surface for BYOK setup + providers settings.
 *
 * Phase I Stage 2 (sibling of `generateObjectWithRepair`). Backend records
 * `modelCompatStatus` on `provider_instances` after the synthetic structured-
 * output probe runs on PATCH. This component renders the result per the C2
 * panel resolution (AUDIENCE-SPLIT):
 *
 *   - 'native'   → silent. Don't clutter healthy paths.
 *   - 'repair'   → subtle info: "we'll work around it; here's why".
 *   - 'failed'   → visible amber/red warning + suggested-models link.
 *   - null       → "not yet checked" + click-to-revalidate.
 *
 * NEVER auto-swap a BYOK user's chosen model — they explicitly picked it.
 * The managed-default path doesn't render this at all (gated upstream).
 *
 * Pure helpers (`pickStatusKind`, `formatRelativeValidatedAt`,
 * `KNOWN_COMPATIBLE_MODELS`) are exported separately so the unit-test
 * surface (vitest under node) can exercise them without DOM rendering.
 */

import { AlertTriangle, Info, CheckCircle2, RefreshCw, Loader2 } from 'lucide-react'

// ── Types ────────────────────────────────────────────────────────────────────

export type ModelCompatStatus = 'native' | 'repair' | 'failed' | null

export type StatusKind = 'native' | 'repair' | 'failed' | 'unchecked'

// ── Pure helpers (testable under node) ───────────────────────────────────────

/**
 * Map the API field to a UI kind. `null`/`undefined`/unknown → 'unchecked'.
 * Centralised so the wizard + settings page render identically.
 */
export function pickStatusKind(status: ModelCompatStatus | undefined): StatusKind {
    if (status === 'native') return 'native'
    if (status === 'repair') return 'repair'
    if (status === 'failed') return 'failed'
    return 'unchecked'
}

/**
 * Human-readable relative time for `modelCompatValidatedAt`. `null`/invalid
 * inputs return null (callers omit the timestamp line). Pure — takes a
 * comparison `now` so tests can pin time without faking the clock.
 */
export function formatRelativeValidatedAt(
    iso: string | null | undefined,
    now: Date = new Date(),
): string | null {
    if (!iso) return null
    const t = new Date(iso).getTime()
    if (!Number.isFinite(t)) return null
    const diffMs = now.getTime() - t
    if (diffMs < 0) return 'just now'
    const sec = Math.floor(diffMs / 1000)
    if (sec < 60) return 'just now'
    const min = Math.floor(sec / 60)
    if (min < 60) return `validated ${min} minute${min === 1 ? '' : 's'} ago`
    const hr = Math.floor(min / 60)
    if (hr < 24) return `validated ${hr} hour${hr === 1 ? '' : 's'} ago`
    const day = Math.floor(hr / 24)
    if (day < 30) return `validated ${day} day${day === 1 ? '' : 's'} ago`
    const mo = Math.floor(day / 30)
    if (mo < 12) return `validated ${mo} month${mo === 1 ? '' : 's'} ago`
    const yr = Math.floor(mo / 12)
    return `validated ${yr} year${yr === 1 ? '' : 's'} ago`
}

/**
 * Curated short-list of models known to produce structured outputs natively.
 * Surfaced as guidance when `failed` — not exhaustive, just enough to
 * unstick a confused user. Order matters: most-recommended first.
 */
export const KNOWN_COMPATIBLE_MODELS: ReadonlyArray<{ provider: string; model: string }> = [
    { provider: 'Anthropic', model: 'claude-sonnet-4-5' },
    { provider: 'Anthropic', model: 'claude-haiku-4-5' },
    { provider: 'OpenAI', model: 'gpt-4o' },
    { provider: 'OpenAI', model: 'gpt-4o-mini' },
    { provider: 'Google', model: 'gemini-2.5-pro' },
    { provider: 'Google', model: 'gemini-2.5-flash' },
]

// ── Status copy (pure, testable) ─────────────────────────────────────────────

interface StatusCopy {
    title: string
    body: string
    ariaLabel: string
}

export function statusCopyFor(kind: StatusKind): StatusCopy {
    if (kind === 'native') {
        return {
            title: 'Compatible',
            body: 'This model produces structured output reliably. No workarounds needed.',
            ariaLabel: 'Model compatibility status: compatible',
        }
    }
    if (kind === 'repair') {
        return {
            title: 'Compatible with workaround',
            body: "Plexo will work around this model's structured-output limitations automatically. Performance may be slightly slower.",
            ariaLabel: 'Model compatibility status: compatible with workaround',
        }
    }
    if (kind === 'failed') {
        return {
            title: 'Incompatible model',
            body: "This model couldn't produce structured output even with our compatibility layer. Sprint planning, quality scoring, and other agent tasks will fail. Consider picking a different model from the curated compatible list below.",
            ariaLabel: 'Model compatibility status: incompatible',
        }
    }
    return {
        title: 'Compatibility not yet checked',
        body: "Plexo hasn't tested this model for structured output yet. Click \"Test now\" to validate.",
        ariaLabel: 'Model compatibility status: not yet checked',
    }
}

// ── Component ────────────────────────────────────────────────────────────────

interface ModelCompatBadgeProps {
    status: ModelCompatStatus | undefined
    validatedAt: string | null | undefined
    onRevalidate?: () => void | Promise<void>
    revalidating?: boolean
    /** Compact variant for table rows (settings page). */
    compact?: boolean
    /** Optional id used to suppress repeated "native" badges in dense lists. */
    hideWhenNative?: boolean
}

export function ModelCompatBadge({
    status,
    validatedAt,
    onRevalidate,
    revalidating = false,
    compact = false,
    hideWhenNative = false,
}: ModelCompatBadgeProps) {
    const kind = pickStatusKind(status)
    if (kind === 'native' && hideWhenNative) return null

    const copy = statusCopyFor(kind)
    const relTime = formatRelativeValidatedAt(validatedAt)

    // Color tokens chosen for ≥4.5:1 contrast on the surface-1 background.
    const tone =
        kind === 'failed' ? {
            border: 'border-red-500/50',
            bg: 'bg-red-500/10',
            text: 'text-red-300',
            icon: 'text-red-400',
            Icon: AlertTriangle,
        } :
        kind === 'repair' ? {
            border: 'border-azure/40',
            bg: 'bg-azure/10',
            text: 'text-azure',
            icon: 'text-azure',
            Icon: Info,
        } :
        kind === 'native' ? {
            border: 'border-signal-green/40',
            bg: 'bg-signal-green/10',
            text: 'text-emerald-300',
            icon: 'text-emerald-400',
            Icon: CheckCircle2,
        } : {
            border: 'border-border',
            bg: 'bg-surface-2/40',
            text: 'text-text-secondary',
            icon: 'text-text-muted',
            Icon: Info,
        }

    if (compact) {
        return (
            <span
                role="status"
                aria-label={copy.ariaLabel}
                title={copy.body}
                className={`inline-flex items-center gap-1 rounded-sm border ${tone.border} ${tone.bg} ${tone.text} px-1.5 py-0.5 text-[11px] font-medium`}
            >
                <tone.Icon className={`h-3 w-3 ${tone.icon}`} aria-hidden="true" />
                {copy.title}
                {relTime && <span className="text-text-muted ml-1 font-normal">· {relTime}</span>}
            </span>
        )
    }

    return (
        <div
            role="status"
            aria-label={copy.ariaLabel}
            className={`rounded-sm border ${tone.border} ${tone.bg} px-3 py-2.5`}
        >
            <div className="flex items-start gap-2">
                <tone.Icon className={`h-4 w-4 mt-0.5 shrink-0 ${tone.icon}`} aria-hidden="true" />
                <div className="flex-1 min-w-0">
                    <p className={`text-sm font-medium ${tone.text}`}>{copy.title}</p>
                    <p className="text-xs mt-0.5 text-text-secondary leading-relaxed">{copy.body}</p>

                    {kind === 'failed' && (
                        <div className="mt-2 flex flex-col gap-0.5">
                            <p className="text-[11px] font-medium uppercase tracking-wider text-text-muted">
                                Known compatible models
                            </p>
                            <ul className="text-[11px] text-text-secondary space-y-0.5">
                                {KNOWN_COMPATIBLE_MODELS.map((m) => (
                                    <li key={`${m.provider}/${m.model}`} className="font-mono">
                                        <span className="text-text-muted">{m.provider}:</span> {m.model}
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}

                    <div className="mt-1.5 flex items-center justify-between gap-2">
                        {relTime ? (
                            <span className="text-[11px] text-text-muted">{relTime}</span>
                        ) : (
                            <span className="text-[11px] text-text-muted">not validated yet</span>
                        )}
                        {onRevalidate && (
                            <button
                                type="button"
                                onClick={() => void onRevalidate()}
                                disabled={revalidating}
                                aria-label="Re-test model compatibility"
                                className="inline-flex items-center gap-1 text-[11px] text-azure hover:text-azure/80 disabled:opacity-50 transition-colors"
                            >
                                {revalidating
                                    ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                                    : <RefreshCw className="h-3 w-3" aria-hidden="true" />}
                                {kind === 'unchecked' ? 'Test now' : 'Re-test'}
                            </button>
                        )}
                    </div>
                </div>
            </div>
        </div>
    )
}
