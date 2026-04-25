// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { useState, useCallback, createContext, useContext, useRef, useEffect } from 'react'
import { AlertTriangle, Trash2, X } from 'lucide-react'
import { useFocusTrap } from '@web/hooks/use-focus-trap'

// ── Types ────────────────────────────────────────────────────────────────────

interface ConfirmOptions {
    title: string
    description: string
    confirmLabel?: string
    cancelLabel?: string
    variant?: 'danger' | 'warning' | 'default'
}

interface ConfirmDialogContextValue {
    confirm: (opts: ConfirmOptions) => Promise<boolean>
}

// ── Context ──────────────────────────────────────────────────────────────────

const ConfirmDialogContext = createContext<ConfirmDialogContextValue | null>(null)

export function useConfirm(): (opts: ConfirmOptions) => Promise<boolean> {
    const ctx = useContext(ConfirmDialogContext)
    if (!ctx) throw new Error('useConfirm must be used within <ConfirmDialogProvider>')
    return ctx.confirm
}

// ── Provider ─────────────────────────────────────────────────────────────────

export function ConfirmDialogProvider({ children }: { children: React.ReactNode }) {
    const [state, setState] = useState<(ConfirmOptions & { open: boolean }) | null>(null)
    const resolveRef = useRef<((v: boolean) => void) | null>(null)

    const confirm = useCallback((opts: ConfirmOptions): Promise<boolean> => {
        return new Promise<boolean>((resolve) => {
            resolveRef.current = resolve
            setState({ ...opts, open: true })
        })
    }, [])

    const handleClose = useCallback((result: boolean) => {
        resolveRef.current?.(result)
        resolveRef.current = null
        setState(null)
    }, [])

    // Close on Escape
    useEffect(() => {
        if (!state?.open) return
        function onKey(e: KeyboardEvent) {
            if (e.key === 'Escape') handleClose(false)
        }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
    }, [state?.open, handleClose])

    return (
        <ConfirmDialogContext.Provider value={{ confirm }}>
            {children}
            {state?.open && (
                <ConfirmDialog
                    {...state}
                    onConfirm={() => handleClose(true)}
                    onCancel={() => handleClose(false)}
                />
            )}
        </ConfirmDialogContext.Provider>
    )
}

// ── Dialog ───────────────────────────────────────────────────────────────────

function ConfirmDialog({
    title,
    description,
    confirmLabel = 'Confirm',
    cancelLabel = 'Cancel',
    variant = 'default',
    onConfirm,
    onCancel,
}: ConfirmOptions & { onConfirm: () => void; onCancel: () => void }) {
    const confirmRef = useRef<HTMLButtonElement>(null)
    const trapRef = useFocusTrap<HTMLDivElement>(true)

    useEffect(() => {
        confirmRef.current?.focus()
    }, [])

    const Icon = variant === 'danger' ? Trash2 : AlertTriangle
    const iconColor = variant === 'danger' ? 'text-red' : variant === 'warning' ? 'text-amber' : 'text-text-muted'
    const iconBg = variant === 'danger' ? 'bg-red/10' : variant === 'warning' ? 'bg-amber/10' : 'bg-surface-2'
    const confirmBtnClass = variant === 'danger'
        ? 'bg-red/90 hover:bg-red text-white'
        : variant === 'warning'
            ? 'bg-amber/90 hover:bg-amber text-black'
            : 'bg-azure hover:bg-azure/90 text-text-primary'

    return (
        <div ref={trapRef} className="fixed inset-0 z-[100] flex items-center justify-center" role="dialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-desc">
            {/* Backdrop */}
            <div className="absolute inset-0 bg-black/50" onClick={onCancel} />
            {/* Panel */}
            <div className="relative mx-4 w-full max-w-md rounded border border-border bg-surface-1 animate-in fade-in zoom-in-95 duration-150">
                <div className="flex items-start gap-3 p-5">
                    <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded ${iconBg}`}>
                        <Icon className={`h-4.5 w-4.5 ${iconColor}`} />
                    </div>
                    <div className="flex-1 min-w-0">
                        <h2 id="confirm-title" className="text-sm font-semibold text-text-primary">{title}</h2>
                        <p id="confirm-desc" className="mt-1 text-xs text-text-muted leading-relaxed">{description}</p>
                    </div>
                    <button onClick={onCancel} className="shrink-0 rounded-md p-1 text-text-muted hover:text-text-primary transition-colors" aria-label="Close">
                        <X className="h-4 w-4" />
                    </button>
                </div>
                <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
                    <button
                        onClick={onCancel}
                        className="rounded border border-border px-3 py-1.5 text-xs font-medium text-text-secondary hover:text-text-primary hover:border-border transition-colors"
                    >
                        {cancelLabel}
                    </button>
                    <button
                        ref={confirmRef}
                        onClick={onConfirm}
                        className={`rounded px-3 py-1.5 text-xs font-medium transition-colors ${confirmBtnClass}`}
                    >
                        {confirmLabel}
                    </button>
                </div>
            </div>
        </div>
    )
}
