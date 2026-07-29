// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { useState, useEffect } from 'react'
import { RefreshCw, User, MessageSquare, Users, BookOpen } from 'lucide-react'
import type { UserSelfData } from './types'
import { API } from './types'

function InfoSection({ label, icon, children }: { label: string; icon: React.ReactNode; children: React.ReactNode }) {
    return (
        <div>
            <div className="flex items-center gap-2 mb-3">
                <span className="text-text-muted">{icon}</span>
                <p className="text-xs font-medium text-text-secondary uppercase tracking-wider">{label}</p>
            </div>
            {children}
        </div>
    )
}

function KV({ label, value }: { label: string; value: string }) {
    return (
        <div>
            <p className="text-[11px] text-text-muted mb-0.5">{label}</p>
            <p className="text-sm text-text-primary">{value}</p>
        </div>
    )
}

export default function UserSelfTab({ workspaceId }: { workspaceId: string }) {
    const [data, setData] = useState<UserSelfData | null>(null)
    const [loading, setLoading] = useState(true)

    useEffect(() => {
        if (!workspaceId) return
        setLoading(true)
        fetch(`${API}/api/v1/user-self?workspaceId=${workspaceId}`)
            .then(r => r.ok ? r.json() as Promise<UserSelfData> : null)
            .then(d => setData(d))
            .catch(() => setData(null))
            .finally(() => setLoading(false))
    }, [workspaceId])

    if (loading) {
        return (
            <div className="flex items-center justify-center py-16">
                <RefreshCw className="h-5 w-5 text-text-muted animate-spin" />
            </div>
        )
    }

    if (!data) {
        return (
            <div className="rounded-sm border border-border bg-surface-1/60 p-7">
                <div className="flex flex-col items-center justify-center py-12 gap-3">
                    <User className="h-10 w-10 text-text-muted" />
                    <div className="text-center">
                        <p className="text-sm font-medium text-text-muted">UserSelf not configured</p>
                        <p className="text-xs text-text-muted mt-1">
                            The UserSelf graph builds over time as tools learn about you — your preferences, relationships, and communication style.
                        </p>
                    </div>
                </div>
            </div>
        )
    }

    return (
        <div className="flex flex-col gap-6 animate-in fade-in slide-in-from-bottom-2 duration-300">
            <div className="rounded-sm border border-azure-800/30 bg-azure/10 px-4 py-3 flex items-start gap-3">
                <User className="h-4 w-4 text-azure shrink-0 mt-0.5" />
                <p className="text-xs text-azure/70">
                    The UserSelf graph persists across all tools and sessions. Tools contribute via structured proposals; the host resolves conflicts.
                </p>
            </div>

            <div className="rounded-sm border border-border bg-surface-1/60 p-7 flex flex-col gap-6">
                <InfoSection label="Identity" icon={<User className="h-4 w-4" />}>
                    <div className="grid grid-cols-2 gap-3">
                        {data.identity?.name && <KV label="Name" value={data.identity.name} />}
                        {data.identity?.primaryEmail && <KV label="Email" value={data.identity.primaryEmail} />}
                        {data.identity?.timezone && <KV label="Timezone" value={data.identity.timezone} />}
                        {data.identity?.locale && <KV label="Locale" value={data.identity.locale} />}
                    </div>
                </InfoSection>

                <InfoSection label="Communication Style" icon={<MessageSquare className="h-4 w-4" />}>
                    <div className="grid grid-cols-2 gap-3">
                        {data.communicationStyle?.formality && <KV label="Formality" value={data.communicationStyle.formality} />}
                        {data.communicationStyle?.verbosity && <KV label="Verbosity" value={data.communicationStyle.verbosity} />}
                        {data.communicationStyle?.preferredChannels && data.communicationStyle.preferredChannels.length > 0 && (
                            <KV label="Preferred Channels" value={data.communicationStyle.preferredChannels.join(', ')} />
                        )}
                    </div>
                </InfoSection>

                {data.relationships && data.relationships.length > 0 && (
                    <InfoSection label="Relationships" icon={<Users className="h-4 w-4" />}>
                        <p className="text-xs text-text-muted">{data.relationships.length} known contacts (ranked by recency/frequency)</p>
                    </InfoSection>
                )}

                {data.contexts && Object.keys(data.contexts).length > 0 && (
                    <InfoSection label="Contexts" icon={<BookOpen className="h-4 w-4" />}>
                        <div className="flex flex-col gap-2">
                            {Object.entries(data.contexts).map(([key, ctx]) => (
                                <div key={key} className="flex items-start gap-3 rounded-sm border border-border bg-canvas px-3 py-2">
                                    <span className="text-xs font-mono font-medium text-text-secondary">{key}</span>
                                    <span className="text-xs text-text-muted flex-1">{ctx.summary}</span>
                                    <span className="text-[11px] text-text-muted shrink-0">
                                        {new Date(ctx.lastUpdated).toLocaleDateString()}
                                    </span>
                                </div>
                            ))}
                        </div>
                    </InfoSection>
                )}
            </div>
        </div>
    )
}
