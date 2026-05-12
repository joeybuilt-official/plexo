import Link from 'next/link'
import { CATEGORY_META } from '@hub/lib/categories'

interface CategoryPillsProps {
    categories: { category: string; count: number }[]
    active?: string
}

export function CategoryPills({ categories, active }: CategoryPillsProps) {
    return (
        <div className="flex flex-wrap gap-2">
            <Link
                href="/browse"
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm transition-colors ${
                    !active
                        ? 'bg-azure-dim text-azure glow-border'
                        : 'bg-surface-1/40 text-text-muted glow-border hover:text-text-secondary'
                }`}
            >
                All
            </Link>
            {categories.map((cat) => {
                const meta = CATEGORY_META[cat.category] ?? CATEGORY_META.other
                const Icon = meta.icon
                const isActive = active === cat.category
                return (
                    <Link
                        key={cat.category}
                        href={`/browse?category=${cat.category}`}
                        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm transition-colors ${
                            isActive
                                ? 'bg-azure-dim text-azure glow-border'
                                : 'bg-surface-1/40 text-text-muted glow-border hover:text-text-secondary'
                        }`}
                    >
                        <Icon className={`h-3.5 w-3.5 ${isActive ? 'text-azure' : meta.color}`} />
                        {meta.label}
                        <span className="text-xs opacity-50 tabular-nums">{cat.count}</span>
                    </Link>
                )
            })}
        </div>
    )
}
