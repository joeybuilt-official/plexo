'use client'

import { useRouter } from 'next/navigation'
import { RefreshCw } from 'lucide-react'
import { useState, useTransition } from 'react'

export function RefreshButton() {
    const router = useRouter()
    const [isPending, startTransition] = useTransition()
    const [spin, setSpin] = useState(false)

    function refresh() {
        setSpin(true)
        startTransition(() => {
            router.refresh()
            setTimeout(() => setSpin(false), 600)
        })
    }

    return (
        <button
            onClick={refresh}
            disabled={isPending}
            className="flex items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-800/50 px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 transition-colors disabled:opacity-50"
        >
            <RefreshCw size={12} className={spin ? 'animate-spin' : ''} />
            Refresh
        </button>
    )
}
