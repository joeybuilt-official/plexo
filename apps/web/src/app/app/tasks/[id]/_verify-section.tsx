// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

import { ShieldAlert, ShieldCheck, ExternalLink } from 'lucide-react'
import { verifyOutcomeCopy } from '@web/lib/lifecycle-copy'

/**
 * Phase F2 — load-bearing addition. The "silent hallucination" failure mode
 * (Frank's audit) is invisible when there's no UI cell for verification. This
 * component renders one of three states for the deliverable's verification
 * provenance:
 *
 *   1. The deliverable carries explicit verify metadata (sources, citations,
 *      verifyOutcome, verificationMethod) → render it.
 *   2. The deliverable exists but carries none of those fields → render the
 *      "no verification recorded" placeholder. This is THE point — the absence
 *      is the signal.
 *   3. No deliverable at all → render nothing (parent decides).
 */

interface Source {
    title?: string
    url?: string
    snippet?: string
}

interface Citation {
    text?: string
    source?: string
    url?: string
}

interface VerifyData {
    sources?: Source[]
    citations?: Citation[]
    verifyOutcome?: string
    verificationMethod?: string
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function extractVerify(deliverable: unknown): VerifyData {
    if (!isPlainObject(deliverable)) return {}
    const d = deliverable
    const out: VerifyData = {}

    if (Array.isArray(d.sources)) {
        out.sources = d.sources.filter(isPlainObject).map((s) => ({
            title: typeof s.title === 'string' ? s.title : undefined,
            url: typeof s.url === 'string' ? s.url : undefined,
            snippet: typeof s.snippet === 'string' ? s.snippet : undefined,
        }))
    }
    if (Array.isArray(d.citations)) {
        out.citations = d.citations.filter(isPlainObject).map((c) => ({
            text: typeof c.text === 'string' ? c.text : undefined,
            source: typeof c.source === 'string' ? c.source : undefined,
            url: typeof c.url === 'string' ? c.url : undefined,
        }))
    }
    if (typeof d.verifyOutcome === 'string') out.verifyOutcome = d.verifyOutcome
    if (typeof d.verificationMethod === 'string') out.verificationMethod = d.verificationMethod

    return out
}

function hasAny(v: VerifyData): boolean {
    return Boolean(
        (v.sources && v.sources.length > 0) ||
            (v.citations && v.citations.length > 0) ||
            v.verifyOutcome ||
            v.verificationMethod,
    )
}

export function VerifySection({ deliverable }: { deliverable: unknown }) {
    const v = extractVerify(deliverable)
    const headingId = 'verify-heading'

    if (!hasAny(v)) {
        const copy = verifyOutcomeCopy()
        return (
            <section
                role="region"
                aria-labelledby={headingId}
                className="rounded-sm border border-amber-900/40 bg-amber-dim/10 p-4"
            >
                <h2
                    id={headingId}
                    className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-amber-300 flex items-center gap-2"
                >
                    <ShieldAlert className="h-3 w-3" aria-hidden="true" />
                    {copy.heading}
                </h2>
                <p className="text-sm text-amber/90 leading-relaxed">{copy.placeholderBody}</p>
            </section>
        )
    }

    const copy = verifyOutcomeCopy()
    return (
        <section
            role="region"
            aria-labelledby={headingId}
            className="rounded-sm border border-emerald-900/40 bg-emerald-dim/10 p-4 flex flex-col gap-3"
        >
            <h2
                id={headingId}
                className="text-[11px] font-medium uppercase tracking-wider text-emerald-400 flex items-center gap-2"
            >
                <ShieldCheck className="h-3 w-3" aria-hidden="true" />
                {copy.heading}
            </h2>

            {v.verificationMethod && (
                <div className="flex flex-col gap-0.5">
                    <span className="text-[11px] text-text-muted">Method</span>
                    <span className="text-sm text-text-primary">{v.verificationMethod}</span>
                </div>
            )}

            {v.verifyOutcome && (
                <div className="flex flex-col gap-0.5">
                    <span className="text-[11px] text-text-muted">Outcome</span>
                    <span className="text-sm text-text-primary leading-relaxed">{v.verifyOutcome}</span>
                </div>
            )}

            {v.sources && v.sources.length > 0 && (
                <div className="flex flex-col gap-1.5">
                    <span className="text-[11px] text-text-muted">Sources ({v.sources.length})</span>
                    <ul role="list" className="flex flex-col gap-1">
                        {v.sources.map((s, i) => (
                            <li key={i} className="text-sm leading-snug">
                                {s.url ? (
                                    <a
                                        href={s.url}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="inline-flex items-center gap-1 text-azure hover:underline break-all"
                                    >
                                        {s.title ?? s.url}
                                        <ExternalLink className="h-3 w-3 shrink-0" aria-hidden="true" />
                                    </a>
                                ) : (
                                    <span className="text-text-secondary">{s.title ?? '(untitled source)'}</span>
                                )}
                                {s.snippet && (
                                    <p className="mt-0.5 text-[12px] text-text-muted line-clamp-2">{s.snippet}</p>
                                )}
                            </li>
                        ))}
                    </ul>
                </div>
            )}

            {v.citations && v.citations.length > 0 && (
                <div className="flex flex-col gap-1.5">
                    <span className="text-[11px] text-text-muted">Citations ({v.citations.length})</span>
                    <ul role="list" className="flex flex-col gap-1.5">
                        {v.citations.map((c, i) => (
                            <li key={i} className="text-sm leading-snug border-l-2 border-emerald-900/40 pl-2">
                                {c.text && <p className="text-text-primary italic">&ldquo;{c.text}&rdquo;</p>}
                                {(c.source || c.url) && (
                                    <p className="mt-0.5 text-[12px] text-text-muted">
                                        {c.url ? (
                                            <a
                                                href={c.url}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                className="text-azure hover:underline break-all"
                                            >
                                                {c.source ?? c.url}
                                            </a>
                                        ) : (
                                            c.source
                                        )}
                                    </p>
                                )}
                            </li>
                        ))}
                    </ul>
                </div>
            )}
        </section>
    )
}
