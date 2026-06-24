// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

/**
 * Attachment scan-status badge — Phase N+1 (ADR 0012 §D5).
 *
 * Renders the operator-facing scan state for an inbound attachment:
 *
 *   unscanned → neutral "Not scanned" (Shield)
 *   scanning  → spinner "Scanning…"   (Loader2)
 *   clean     → green   "Clean"       (ShieldCheck)
 *   infected  → red     "Infected"    (ShieldX)  + signature in tooltip
 *   error     → amber   "Scan failed" (ShieldAlert)
 *
 * 'scanning' is a UI-only derivation surfaced when the API joins
 * attachment_scan_queue and reports started_at IS NOT NULL AND
 * completed_at IS NULL. Phase N+1 v1 ships the prop but the API does
 * not yet emit it; UI shows 'unscanned' until the worker writes
 * back 'clean' / 'infected' / 'error'.
 *
 * Pure helpers (`badgeConfigFor`, `tooltipFor`) are exported separately so
 * the unit-test surface (vitest under node) can exercise them without
 * DOM rendering.
 */

import { Shield, ShieldCheck, ShieldAlert, ShieldX, Loader2 } from 'lucide-react'

// ── Types ────────────────────────────────────────────────────────────────────

export type ScanStatus = 'unscanned' | 'scanning' | 'clean' | 'infected' | 'error'

export interface AttachmentScanBadgeProps {
    scanStatus?: ScanStatus
    signature?: string
}

// ── Pure helpers (testable under node) ───────────────────────────────────────

export interface BadgeConfig {
    label: string
    iconClass: string
    containerClass: string
    spin: boolean
}

/**
 * Map scan status to label + Tailwind classes. Undefined/unknown defaults
 * to 'unscanned'. Centralised so component + tests + future call sites
 * agree on copy + colour tokens.
 */
export function badgeConfigFor(status: ScanStatus | undefined): BadgeConfig {
    switch (status) {
        case 'scanning':
            return {
                label: 'Scanning…',
                iconClass: 'text-zinc-400',
                containerClass: 'bg-zinc-500/10 border-zinc-500/20 text-zinc-300',
                spin: true,
            }
        case 'clean':
            return {
                label: 'Clean',
                iconClass: 'text-signal-green',
                containerClass: 'bg-signal-green/10 border-signal-green/20 text-emerald-400',
                spin: false,
            }
        case 'infected':
            return {
                label: 'Infected',
                iconClass: 'text-red-500',
                containerClass: 'bg-red-500/10 border-red-500/20 text-red-400',
                spin: false,
            }
        case 'error':
            return {
                label: 'Scan failed',
                iconClass: 'text-amber-500',
                containerClass: 'bg-amber-500/10 border-amber-500/20 text-amber-400',
                spin: false,
            }
        case 'unscanned':
        default:
            return {
                label: 'Not scanned',
                iconClass: 'text-zinc-400',
                containerClass: 'bg-zinc-500/10 border-zinc-500/20 text-zinc-300',
                spin: false,
            }
    }
}

/**
 * Tooltip / `title` text. Infected surfaces the clamd signature name when
 * provided (read-only operator information; never exposed to plugin code
 * per ADR 0012 §D5). Unknown/undefined → 'Awaiting scan'.
 */
export function tooltipFor(status: ScanStatus | undefined, signature?: string): string {
    switch (status) {
        case 'scanning':
            return 'Scan in progress'
        case 'clean':
            return 'No threats detected'
        case 'infected':
            return signature ? `Detected: ${signature}` : 'Malware detected — quarantined'
        case 'error':
            return 'Scan failed — re-scan available'
        case 'unscanned':
        default:
            return 'Awaiting scan'
    }
}

// ── Icon picker (component-only; not part of pure-helper surface) ────────────

function iconFor(status: ScanStatus | undefined) {
    switch (status) {
        case 'scanning': return Loader2
        case 'clean':    return ShieldCheck
        case 'infected': return ShieldX
        case 'error':    return ShieldAlert
        case 'unscanned':
        default:         return Shield
    }
}

// ── Component ────────────────────────────────────────────────────────────────

export function AttachmentScanBadge({ scanStatus, signature }: AttachmentScanBadgeProps) {
    const cfg = badgeConfigFor(scanStatus)
    const Icon = iconFor(scanStatus)
    const tip = tooltipFor(scanStatus, signature)

    return (
        <span
            title={tip}
            aria-label={`Attachment scan status: ${cfg.label}`}
            className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium border ${cfg.containerClass}`}
        >
            <Icon
                aria-hidden="true"
                className={`h-3 w-3 ${cfg.iconClass} ${cfg.spin ? 'animate-spin' : ''}`}
            />
            {cfg.label}
        </span>
    )
}
