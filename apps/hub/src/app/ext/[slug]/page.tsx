import { getBySlug } from '@hub/lib/db'
import { ReadmeRenderer } from '@hub/components/readme-renderer'
import { InstallButton } from '@hub/components/install-button'
import { TrustBadge } from '@hub/components/trust-badge'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { Calendar, Download, ExternalLink, Tag, Bot, Zap, Wrench, Radio, Plug, Clock } from 'lucide-react'
import type { Metadata } from 'next'
import type { ElementType } from 'react'

export const dynamic = 'force-dynamic'

interface PageProps {
    params: Promise<{ slug: string }>
}

const TYPE_META: Record<string, { label: string; icon: ElementType; badge: string; accent: string }> = {
    agent: { label: 'Agent', icon: Bot, badge: 'bg-violet-500/15 text-violet-400 border border-violet-500/30', accent: 'text-violet-400' },
    skill: { label: 'Skill', icon: Zap, badge: 'bg-azure-dim text-azure', accent: 'text-azure' },
    tool: { label: 'Tool', icon: Wrench, badge: 'bg-amber-500/15 text-amber-400 border border-amber-500/30', accent: 'text-amber-400' },
    function: { label: 'Tool', icon: Wrench, badge: 'bg-amber-500/15 text-amber-400 border border-amber-500/30', accent: 'text-amber-400' },
    channel: { label: 'Channel', icon: Radio, badge: 'bg-green-500/15 text-green-400 border border-green-500/30', accent: 'text-green-400' },
    connector: { label: 'Connector', icon: Plug, badge: 'bg-rose-500/15 text-rose-400 border border-rose-500/30', accent: 'text-rose-400' },
    'mcp-server': { label: 'Connector', icon: Plug, badge: 'bg-rose-500/15 text-rose-400 border border-rose-500/30', accent: 'text-rose-400' },
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
    const { slug } = await params
    const ext = await getBySlug(slug)
    if (!ext) return { title: 'Not Found — Plexo Hub' }
    return {
        title: `${ext.displayName} — Plexo Hub`,
        description: ext.description,
        openGraph: {
            title: `${ext.displayName} — Plexo Hub`,
            description: ext.description,
            type: 'website',
        },
    }
}

export default async function ExtDetailPage({ params }: PageProps) {
    const { slug } = await params
    const ext = await getBySlug(slug)
    if (!ext) notFound()

    const manifest = ext.manifest as Record<string, unknown> | null
    const trust = (manifest?.trust as string) ?? 'community'
    const license = (manifest?.license as string) ?? 'MIT'
    const versions = ext.versions as string[] | null

    const rawType = (manifest?.type as string) ?? 'skill'
    const meta = TYPE_META[rawType] ?? TYPE_META.skill
    const TypeIcon = meta.icon
    const isAgent = rawType === 'agent'
    const comingSoon = isAgent && !manifest?.entry

    return (
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-10">
            {/* Header */}
            <div className={`rounded-2xl bg-surface-1/50 backdrop-blur-sm glow-border p-6 sm:p-8 mb-10 ${isAgent ? 'ring-1 ring-violet-500/20' : ''}`}>
                <div className="flex items-start gap-5">
                    {ext.iconUrl ? (
                        <img src={ext.iconUrl} alt="" className="h-20 w-20 rounded-2xl shrink-0" />
                    ) : (
                        <div className={`h-20 w-20 rounded-2xl border border-border/60 flex items-center justify-center shrink-0 ${isAgent ? 'bg-violet-500/10' : 'bg-surface-2'}`}>
                            <TypeIcon className={`h-8 w-8 ${isAgent ? meta.accent : 'text-text-muted'}`} />
                        </div>
                    )}
                    <div className="min-w-0">
                        <div className="flex items-center gap-3 mb-1 flex-wrap">
                            <h1 className="font-display text-2xl sm:text-3xl font-bold text-text-primary tracking-tight">{ext.displayName}</h1>
                            <span className={`shrink-0 inline-flex items-center gap-1 px-2.5 py-0.5 rounded-md text-xs font-medium uppercase tracking-wider ${meta.badge}`}>
                                <TypeIcon className="h-3 w-3" />
                                {meta.label}
                            </span>
                            {comingSoon && (
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-surface-2 text-text-muted border border-border/60">
                                    <Clock className="h-3 w-3" />
                                    Coming soon
                                </span>
                            )}
                        </div>
                        <p className="text-sm text-text-secondary mt-1.5 leading-relaxed">{ext.description}</p>
                        <div className="flex items-center gap-3 mt-3 flex-wrap">
                            <Link href={`/publisher/${encodeURIComponent(ext.publisher)}`} className="text-xs text-azure hover:underline font-medium">
                                {ext.publisher}
                            </Link>
                            <span className="text-border/60">&middot;</span>
                            <TrustBadge tier={trust} />
                            <span className="text-border/60">&middot;</span>
                            <span className="text-xs text-text-muted font-mono">v{ext.latestVersion}</span>
                        </div>
                    </div>
                </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-10">
                {/* README */}
                <div className="lg:col-span-2 min-w-0">
                    <ReadmeRenderer content={ext.readme} />
                </div>

                {/* Sidebar */}
                <aside className="space-y-5 lg:sticky lg:top-20 lg:self-start">
                    {comingSoon ? (
                        <div className="w-full rounded-xl border border-border/60 bg-surface-2 p-4 text-xs text-text-muted text-center">
                            This agent is a preview and is not yet installable.
                        </div>
                    ) : (
                        <InstallButton name={ext.name} />
                    )}

                    <div className="rounded-xl bg-surface-1/50 backdrop-blur-sm glow-border p-4 space-y-3">
                        <div className="flex items-center justify-between text-xs">
                            <span className="text-text-muted">Version</span>
                            <span className="text-text-primary font-mono">{ext.latestVersion}</span>
                        </div>
                        <hr className="border-border/30" />
                        <div className="flex items-center justify-between text-xs">
                            <span className="text-text-muted">License</span>
                            <span className="text-text-primary">{license}</span>
                        </div>
                        <hr className="border-border/30" />
                        <div className="flex items-center justify-between text-xs">
                            <span className="text-text-muted flex items-center gap-1"><Download className="h-3 w-3" /> Installs</span>
                            <span className="text-text-primary tabular-nums">{ext.installCount.toLocaleString()}</span>
                        </div>
                        <hr className="border-border/30" />
                        <div className="flex items-center justify-between text-xs">
                            <span className="text-text-muted flex items-center gap-1"><Calendar className="h-3 w-3" /> Updated</span>
                            <span className="text-text-primary">{ext.updatedAt.toLocaleDateString()}</span>
                        </div>
                        {ext.repositoryUrl && (
                            <>
                                <hr className="border-border/30" />
                                <a href={ext.repositoryUrl} target="_blank" rel="noopener noreferrer"
                                    className="flex items-center gap-1.5 text-xs text-azure hover:underline">
                                    <ExternalLink className="h-3 w-3" /> Source
                                </a>
                            </>
                        )}
                    </div>

                    {/* Tags */}
                    {ext.tags.length > 0 && (
                        <div className="rounded-xl bg-surface-1/50 backdrop-blur-sm glow-border p-4 space-y-3">
                            <h3 className="text-xs font-medium text-text-muted flex items-center gap-1"><Tag className="h-3 w-3" /> Tags</h3>
                            <div className="flex flex-wrap gap-1.5">
                                {ext.tags.map((tag) => (
                                    <Link key={tag} href={`/browse?q=${tag}`}
                                        className="px-2.5 py-1 rounded-lg bg-surface-2 text-xs text-text-muted hover:text-text-secondary hover:bg-surface-3 transition-colors">
                                        {tag}
                                    </Link>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Versions */}
                    {versions && versions.length > 1 && (
                        <div className="rounded-xl bg-surface-1/50 backdrop-blur-sm glow-border p-4 space-y-3">
                            <h3 className="text-xs font-medium text-text-muted">Version History</h3>
                            <div className="space-y-1.5">
                                {versions.slice(0, 10).map((v) => (
                                    <div key={v} className="text-xs text-text-secondary font-mono">{v}</div>
                                ))}
                                {versions.length > 10 && (
                                    <p className="text-xs text-text-muted">+{versions.length - 10} more</p>
                                )}
                            </div>
                        </div>
                    )}
                </aside>
            </div>
        </div>
    )
}
