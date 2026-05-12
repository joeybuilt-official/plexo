import { getByPublisher } from '@hub/lib/db'
import { SkillCard } from '@hub/components/skill-card'
import { notFound } from 'next/navigation'
import { Download, User } from 'lucide-react'

export const dynamic = 'force-dynamic'

interface PageProps {
    params: Promise<{ name: string }>
}

export default async function PublisherPage({ params }: PageProps) {
    const { name } = await params
    const publisher = decodeURIComponent(name)
    const extensions = await getByPublisher(publisher)

    if (extensions.length === 0) notFound()

    const totalInstalls = extensions.reduce((sum, e) => sum + e.installCount, 0)

    return (
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-10 sm:py-14">
            <div className="flex items-center gap-4 mb-10">
                <div className="h-14 w-14 rounded-2xl bg-surface-2 border border-border/60 flex items-center justify-center">
                    <User className="h-6 w-6 text-text-muted" />
                </div>
                <div>
                    <h1 className="font-display text-2xl font-bold text-text-primary tracking-tight">{publisher}</h1>
                    <div className="flex items-center gap-4 mt-1 text-sm text-text-muted">
                        <span>{extensions.length} {extensions.length === 1 ? 'extension' : 'extensions'}</span>
                        <span className="text-border/60">&middot;</span>
                        <span className="flex items-center gap-1"><Download className="h-3.5 w-3.5" /> {totalInstalls.toLocaleString()} installs</span>
                    </div>
                </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {extensions.map((ext) => (
                    <SkillCard
                        key={ext.id}
                        name={ext.name}
                        displayName={ext.displayName}
                        description={ext.description}
                        publisher={ext.publisher}
                        installCount={ext.installCount}
                        type={(ext.manifest as Record<string, unknown>)?.type as string}
                        iconUrl={ext.iconUrl}
                    />
                ))}
            </div>
        </div>
    )
}
