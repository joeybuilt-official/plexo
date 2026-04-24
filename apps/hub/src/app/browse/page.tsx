import { listExtensions, getCategories, getTypeCounts } from '@hub/lib/db'
import { SkillCard } from '@hub/components/skill-card'
import { SearchBar } from '@hub/components/search-bar'
import { CategoryPills } from '@hub/components/category-pills'
import { TypePills } from '@hub/components/type-pills'
import { Pagination } from '@hub/components/pagination'
import Link from 'next/link'

export const dynamic = 'force-dynamic'

const SORT_OPTIONS = [
    { value: 'popular', label: 'Popular' },
    { value: 'recent', label: 'Recent' },
    { value: 'trending', label: 'Trending' },
] as const

const VALID_TYPES = new Set(['agent', 'tool', 'skill', 'function', 'channel', 'connector', 'mcp-server'])

export default async function BrowsePage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
    const params = await searchParams
    const category = params.category
    const type = params.type && VALID_TYPES.has(params.type) ? params.type : undefined
    const sort = (params.sort ?? 'popular') as 'popular' | 'recent' | 'trending'
    const q = params.q
    const page = Math.max(1, parseInt(params.page ?? '1', 10))

    const [result, categories, typeCounts] = await Promise.all([
        listExtensions({ category, type, q, sort, page, limit: 20 }),
        getCategories(),
        getTypeCounts(),
    ])

    const filterParams = new URLSearchParams()
    if (category) filterParams.set('category', category)
    if (type) filterParams.set('type', type)
    if (sort !== 'popular') filterParams.set('sort', sort)
    if (q) filterParams.set('q', q)
    const baseHref = `/browse${filterParams.toString() ? `?${filterParams}` : ''}`

    const hasFilters = !!(category || type || q || sort !== 'popular')

    // Params to preserve when flipping filter pills.
    const baseParams: Record<string, string | undefined> = {
        category,
        type,
        q,
        sort: sort !== 'popular' ? sort : undefined,
    }

    const typeLabels: Record<string, string> = {
        agent: 'agents',
        tool: 'tools',
        skill: 'skills',
        channel: 'channels',
        connector: 'connectors',
        'mcp-server': 'connectors',
        function: 'tools',
    }
    const noun = type ? (typeLabels[type] ?? 'extensions') : 'extensions'

    return (
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-10 sm:py-14">
            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 mb-8">
                <div>
                    <h1 className="font-display text-2xl sm:text-3xl font-bold text-text-primary tracking-tight">Browse</h1>
                    <p className="text-sm text-text-muted mt-1">
                        {result.total} {result.total === 1 ? noun.replace(/s$/, '') : noun}{q ? ` matching "${q}"` : ''}
                    </p>
                </div>
                <SearchBar defaultValue={q} placeholder="Search extensions..." />
            </div>

            {/* Filters */}
            <div className="mb-8 space-y-4">
                <TypePills counts={typeCounts} active={type ?? 'all'} baseParams={baseParams} />
                <CategoryPills categories={categories} active={category} />
                <div className="flex items-center gap-2">
                    {SORT_OPTIONS.map((opt) => {
                        const next = new URLSearchParams()
                        if (category) next.set('category', category)
                        if (type) next.set('type', type)
                        if (q) next.set('q', q)
                        next.set('sort', opt.value)
                        return (
                            <Link
                                key={opt.value}
                                href={`/browse?${next}`}
                                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                                    sort === opt.value
                                        ? 'bg-azure-dim text-azure'
                                        : 'text-text-muted hover:text-text-secondary hover:bg-surface-1'
                                }`}
                            >
                                {opt.label}
                            </Link>
                        )
                    })}
                    {hasFilters && (
                        <Link
                            href="/browse"
                            className="ml-2 px-2 py-1 text-xs text-text-muted hover:text-red transition-colors"
                        >
                            Clear filters
                        </Link>
                    )}
                </div>
            </div>

            {/* Results */}
            {result.items.length === 0 ? (
                <div className="py-20 text-center">
                    <p className="text-text-muted text-lg">
                        {q ? `No results for "${q}"` : `No ${noun} found`}
                    </p>
                    <p className="text-sm text-text-muted mt-2">
                        {q
                            ? <span>Try a different search or <Link href="/browse" className="text-azure hover:underline">browse all extensions</Link>.</span>
                            : <span><Link href="/browse" className="text-azure hover:underline">Browse all extensions</Link> instead.</span>
                        }
                    </p>
                </div>
            ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                    {result.items.map((ext: any) => {
                        const manifest = ext.manifest ?? {}
                        const mtype = manifest.type ?? 'skill'
                        const comingSoon = !manifest.entry && mtype === 'agent'
                        return (
                            <SkillCard
                                key={ext.id}
                                name={ext.name}
                                displayName={ext.display_name ?? ext.displayName ?? ext.name}
                                description={ext.description}
                                publisher={ext.publisher}
                                installCount={ext.install_count ?? ext.installCount ?? 0}
                                type={mtype}
                                iconUrl={ext.icon_url ?? ext.iconUrl}
                                comingSoon={comingSoon}
                            />
                        )
                    })}
                </div>
            )}

            <Pagination page={page} pageCount={result.pageCount} baseHref={baseHref} />
        </div>
    )
}
