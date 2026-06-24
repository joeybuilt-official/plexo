'use client'

import { useEffect, useRef } from 'react'

const FOCUSABLE = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
    'details > summary',
].join(', ')

export function useFocusTrap<T extends HTMLElement>(active: boolean) {
    const ref = useRef<T>(null)

    useEffect(() => {
        if (!active || !ref.current) return
        const el = ref.current
        const prev = document.activeElement as HTMLElement | null

        // Focus first focusable element
        const focusables = Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE))
        focusables[0]?.focus()

        function handleKeyDown(e: KeyboardEvent) {
            if (e.key !== 'Tab') return
            const items = Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE))
            if (items.length === 0) return
            const first = items[0]!
            const last = items[items.length - 1]!
            if (e.shiftKey) {
                if (document.activeElement === first) {
                    e.preventDefault()
                    last.focus()
                }
            } else {
                if (document.activeElement === last) {
                    e.preventDefault()
                    first.focus()
                }
            }
        }

        el.addEventListener('keydown', handleKeyDown)
        return () => {
            el.removeEventListener('keydown', handleKeyDown)
            prev?.focus()
        }
    }, [active])

    return ref
}
