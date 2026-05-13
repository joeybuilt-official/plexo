'use client'

import { useState, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { Search } from 'lucide-react'

export function SearchBar({ defaultValue, placeholder }: { defaultValue?: string; placeholder?: string }) {
    const [query, setQuery] = useState(defaultValue ?? '')
    const router = useRouter()
    const inputRef = useRef<HTMLInputElement>(null)

    useEffect(() => {
        function handleKey(e: KeyboardEvent) {
            if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
                e.preventDefault()
                inputRef.current?.focus()
            }
            if (e.key === '/' && !['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement)?.tagName)) {
                e.preventDefault()
                inputRef.current?.focus()
            }
        }
        window.addEventListener('keydown', handleKey)
        return () => window.removeEventListener('keydown', handleKey)
    }, [])

    function handleSubmit(e: React.FormEvent) {
        e.preventDefault()
        if (query.trim()) {
            router.push(`/browse?q=${encodeURIComponent(query.trim())}`)
        }
    }

    return (
        <form onSubmit={handleSubmit} className="relative w-full max-w-xl">
            <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-text-muted" />
            <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={placeholder ?? 'Search extensions...'}
                className="w-full pl-10 pr-16 py-2.5 rounded-xl bg-surface-1/60 backdrop-blur-sm border border-border/60 text-sm text-text-primary placeholder:text-text-muted focus:border-azure/50 focus:ring-1 focus:ring-azure/30 transition-colors"
            />
            <kbd className="absolute right-3.5 top-1/2 -translate-y-1/2 hidden sm:inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-surface-2 border border-border/60 text-[10px] text-text-muted font-mono">
                /
            </kbd>
        </form>
    )
}
