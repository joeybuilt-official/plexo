// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { createContext, useContext, useId } from 'react'

/**
 * FieldContext threads a stable `id` from <Field> down to its labelable
 * child (Input / Textarea / <select>) so the generated `<label htmlFor>`
 * association lands automatically without every consumer wiring useId.
 * Consumers can still pass an explicit `id` prop to override.
 */
const FieldContext = createContext<{ id: string; labelId: string } | null>(null)

function useFieldId(override?: string) {
    const ctx = useContext(FieldContext)
    return override ?? ctx?.id
}

export function Input({ className, id, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
    'use no memo';
    const fieldId = useFieldId(id)
    return (
        <input
            id={fieldId}
            className={`min-h-[44px] rounded-sm border border-border bg-surface-1 px-3 py-2 text-[16px] sm:text-sm text-text-primary placeholder:text-text-muted focus:border-azure focus-ring focus:ring-1 focus:ring-azure/30 disabled:opacity-40 w-full ${className ?? ''}`}
            {...props}
        />
    )
}

export function Textarea({ className, id, ...props }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
    'use no memo';
    const fieldId = useFieldId(id)
    return (
        <textarea
            id={fieldId}
            className={`min-h-[44px] w-full resize-none rounded-sm border border-border bg-surface-1 px-4 py-3 text-[16px] sm:text-sm text-text-primary placeholder:text-text-muted focus:border-azure focus-ring focus:ring-1 focus:ring-azure/30 leading-relaxed ${className ?? ''}`}
            {...props}
        />
    )
}

/**
 * FieldSelect is a thin wrapper around <select> that automatically picks up
 * the id threaded via FieldContext so the wrapping <Field>'s <label htmlFor>
 * association lands. Use inside <Field> instead of a raw <select>.
 */
export function FieldSelect({ className, id, children, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
    'use no memo';
    const fieldId = useFieldId(id)
    return (
        <select id={fieldId} className={className} {...props}>
            {children}
        </select>
    )
}

export function Toggle({ checked, onChange, ariaLabel }: { checked: boolean; onChange: () => void; ariaLabel?: string }) {
    'use no memo';
    const ctx = useContext(FieldContext)
    return (
        <button
            type="button"
            role="switch"
            aria-checked={checked}
            aria-labelledby={ctx?.labelId}
            aria-label={!ctx && ariaLabel ? ariaLabel : undefined}
            onClick={onChange}
            className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus-ring focus:ring-2 focus:ring-azure focus:ring-offset-2 focus:ring-offset-canvas min-h-[44px] ${checked ? 'bg-azure' : 'bg-surface-2'}`}
        >
            <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-6' : 'translate-x-1'}`} />
        </button>
    )
}

export function Field({ label, description, children }: { label: string; description?: string; children: React.ReactNode }) {
    const id = useId()
    const labelId = `${id}-label`
    return (
        <FieldContext.Provider value={{ id, labelId }}>
            <div className="flex flex-col gap-1.5">
                <label id={labelId} htmlFor={id} className="text-sm font-medium text-text-secondary">{label}</label>
                {children}
                {description && <p className="text-xs text-text-muted">{description}</p>}
            </div>
        </FieldContext.Provider>
    )
}

export function Section({ title, icon: Icon, children }: { title: string; icon: React.ElementType; children: React.ReactNode }) {
    return (
        <div className="rounded-sm border border-border bg-surface-1/40 p-4 sm:p-5">
            <div className="flex items-center gap-2 mb-4">
                <Icon className="h-4 w-4 text-text-muted" />
                <h2 className="text-sm font-medium text-text-primary">{title}</h2>
            </div>
            <div className="flex flex-col gap-4">{children}</div>
        </div>
    )
}
