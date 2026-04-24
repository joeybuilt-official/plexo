import Link from 'next/link'
import { ChevronLeft, ChevronRight } from 'lucide-react'

interface PaginationProps {
    page: number
    pageCount: number
    baseHref: string
}

export function Pagination({ page, pageCount, baseHref }: PaginationProps) {
    if (pageCount <= 1) return null

    const sep = baseHref.includes('?') ? '&' : '?'

    return (
        <div className="flex items-center justify-center gap-3 mt-12 pt-8 border-t border-border/30">
            {page > 1 ? (
                <Link
                    href={`${baseHref}${sep}page=${page - 1}`}
                    className="flex items-center gap-1 px-3.5 py-2 rounded-lg bg-surface-1/50 glow-border text-sm text-text-secondary hover:text-text-primary transition-colors"
                >
                    <ChevronLeft className="h-3.5 w-3.5" />
                    Prev
                </Link>
            ) : (
                <span className="px-3.5 py-2 text-sm text-text-muted/40 cursor-not-allowed">
                    <ChevronLeft className="h-3.5 w-3.5 inline" /> Prev
                </span>
            )}

            <span className="text-xs text-text-muted tabular-nums px-2">
                {page} / {pageCount}
            </span>

            {page < pageCount ? (
                <Link
                    href={`${baseHref}${sep}page=${page + 1}`}
                    className="flex items-center gap-1 px-3.5 py-2 rounded-lg bg-surface-1/50 glow-border text-sm text-text-secondary hover:text-text-primary transition-colors"
                >
                    Next
                    <ChevronRight className="h-3.5 w-3.5" />
                </Link>
            ) : (
                <span className="px-3.5 py-2 text-sm text-text-muted/40 cursor-not-allowed">
                    Next <ChevronRight className="h-3.5 w-3.5 inline" />
                </span>
            )}
        </div>
    )
}
