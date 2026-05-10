import { getFeatured, getRecent, getCategories, getStats, getFeaturedByType } from '@hub/lib/db'
import { SkillCard } from '@hub/components/skill-card'
import { SearchBar } from '@hub/components/search-bar'
import { CATEGORY_META } from '@hub/lib/categories'
import Link from 'next/link'
import { ArrowRight, Bot } from 'lucide-react'

export const dynamic = 'force-dynamic'

function renderCard(ext: any) {
    const manifest = (ext.manifest ?? {}) as Record<string, unknown>
    const mtype = (manifest.type as string) ?? 'skill'
    const comingSoon = !manifest.entry && mtype === 'agent'
    return (
        <SkillCard
            key={ext.id}
            name={ext.name}
            displayName={ext.displayName ?? ext.display_name ?? ext.name}
            description={ext.description}
            publisher={ext.publisher}
            installCount={ext.installCount ?? ext.install_count ?? 0}
            type={mtype}
            iconUrl={ext.iconUrl ?? ext.icon_url}
            comingSoon={comingSoon}
        />
    )
}

export default async function HomePage() {
    const [featured, recent, categories, stats, featuredAgents] = await Promise.all([
        getFeatured(6),
        getRecent(6),
        getCategories(),
        getStats(),
        getFeaturedByType('agent', 6),
    ])

    return (
        <div>
            {/* Hero */}
            <section className="relative overflow-hidden">
                <div className="absolute inset-0 hero-glow" />
                <div className="absolute inset-0 bg-grid-dots opacity-40" />
                <div className="relative max-w-4xl mx-auto px-4 sm:px-6 pt-20 pb-16 sm:pt-28 sm:pb-24 text-center">
                    <h1 className="font-display text-4xl sm:text-5xl md:text-6xl font-bold tracking-tight leading-[1.1]">
                        <span className="gradient-text">Extend your AI workspace</span>
                    </h1>
                    <p className="mt-4 text-base sm:text-lg text-text-secondary max-w-xl mx-auto leading-relaxed">
                        Discover agents, skills, and tools built for Plexo.
                        Install with a single command.
                    </p>
                    <div className="mt-8 flex justify-center">
                        <SearchBar placeholder="Search extensions..." />
                    </div>
                    <div className="flex items-center justify-center gap-6 sm:gap-8 mt-6 text-sm text-text-muted">
                        <span><strong className="text-text-primary tabular-nums">{stats.total}</strong> extensions</span>
                        <span className="text-border/60">&middot;</span>
                        <span><strong className="text-text-primary tabular-nums">{stats.installs.toLocaleString()}</strong> installs</span>
                        <span className="text-border/60">&middot;</span>
                        <span><strong className="text-text-primary tabular-nums">{stats.publishers}</strong> {stats.publishers === 1 ? 'publisher' : 'publishers'}</span>
                    </div>
                </div>
            </section>

            <div className="max-w-6xl mx-auto px-4 sm:px-6">
                {/* Categories */}
                {categories.length > 0 && (
                    <section className="py-12 border-t border-border/30">
                        <h2 className="text-xs font-semibold uppercase tracking-[0.2em] text-azure mb-5">Categories</h2>
                        <div className="flex flex-wrap gap-2.5">
                            {categories.map((cat) => {
                                const meta = CATEGORY_META[cat.category] ?? CATEGORY_META.other
                                const Icon = meta.icon
                                return (
                                    <Link
                                        key={cat.category}
                                        href={`/browse?category=${cat.category}`}
                                        className="flex items-center gap-2 px-3.5 py-2 rounded-lg bg-surface-1/60 backdrop-blur-sm glow-border text-sm text-text-secondary hover:text-text-primary transition-colors"
                                    >
                                        <Icon className={`h-3.5 w-3.5 ${meta.color}`} />
                                        {meta.label}
                                        <span className="text-text-muted text-xs tabular-nums">{cat.count}</span>
                                    </Link>
                                )
                            })}
                        </div>
                    </section>
                )}

                {/* Featured Agents */}
                {featuredAgents.length > 0 && (
                    <section className="py-12 border-t border-border/30">
                        <div className="flex items-center justify-between mb-6">
                            <h2 className="text-xs font-semibold uppercase tracking-[0.2em] text-violet-400 flex items-center gap-2">
                                <Bot className="h-3.5 w-3.5" />
                                Featured Agents
                            </h2>
                            <Link href="/browse?type=agent" className="flex items-center gap-1 text-xs text-text-muted hover:text-violet-400 transition-colors">
                                View all <ArrowRight className="h-3 w-3" />
                            </Link>
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                            {featuredAgents.map(renderCard)}
                        </div>
                    </section>
                )}

                {/* Featured */}
                {featured.length > 0 && (
                    <section className="py-12 border-t border-border/30">
                        <div className="flex items-center justify-between mb-6">
                            <h2 className="text-xs font-semibold uppercase tracking-[0.2em] text-azure">Featured</h2>
                            <Link href="/browse?sort=popular" className="flex items-center gap-1 text-xs text-text-muted hover:text-azure transition-colors">
                                View all <ArrowRight className="h-3 w-3" />
                            </Link>
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                            {featured.map(renderCard)}
                        </div>
                    </section>
                )}

                {/* Recent */}
                {recent.length > 0 && (
                    <section className="py-12 border-t border-border/30">
                        <div className="flex items-center justify-between mb-6">
                            <h2 className="text-xs font-semibold uppercase tracking-[0.2em] text-azure">Recently Updated</h2>
                            <Link href="/browse?sort=recent" className="flex items-center gap-1 text-xs text-text-muted hover:text-azure transition-colors">
                                View all <ArrowRight className="h-3 w-3" />
                            </Link>
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                            {recent.map(renderCard)}
                        </div>
                    </section>
                )}

                {/* Empty state */}
                {featured.length === 0 && recent.length === 0 && (
                    <section className="py-20 text-center">
                        <p className="text-lg text-text-muted">No extensions published yet.</p>
                        <p className="mt-3 text-sm text-text-secondary">
                            Be the first &mdash; <Link href="/submit" className="text-azure hover:underline">publish an extension</Link>.
                        </p>
                    </section>
                )}
            </div>
        </div>
    )
}
