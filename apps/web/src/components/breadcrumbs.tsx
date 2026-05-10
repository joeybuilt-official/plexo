// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { usePathname } from 'next/navigation'
import Link from 'next/link'
import { ChevronRight } from 'lucide-react'

/** Maps known path segments to human-readable labels. */
const SEGMENT_LABELS: Record<string, string> = {
    app: 'Home',
    chat: 'Chat',
    conversations: 'Conversations',
    tasks: 'Tasks',
    approvals: 'Approvals',
    escalations: 'Escalations',
    projects: 'Projects',
    sprints: 'Sprints',
    memory: 'Memory',
    agents: 'Agents',
    extensions: 'Extensions',
    connections: 'Integrations',
    hub: 'Hub',
    settings: 'Settings',
    users: 'Users',
    intelligence: 'AI Models',
    providers: 'Providers',
    behavior: 'Behavior',
    voice: 'Voice',
    context: 'Context',
    channels: 'Channels',
    search: 'Search',
    federation: 'Federation',
    privacy: 'Privacy',
    cron: 'Schedules',
    audit: 'Audit Trail',
    logs: 'Logs',
    debug: 'Debug',
    thread: 'Thread',
    account: 'Account',
    subscription: 'Subscription',
    terms: 'Terms of Service',
}

export function Breadcrumbs() {
    const pathname = usePathname()

    // Split path: /app/settings/voice → ['app', 'settings', 'voice']
    const segments = pathname.split('/').filter(Boolean)

    // Don't render on /app home or outside /app
    if (segments.length <= 1 || (segments.length === 1 && segments[0] === 'app')) return null

    // Build crumbs — skip the first 'app' segment (shown as Home),
    // skip UUID-like segments (detail pages use id params)
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    const crumbs: { label: string; href: string }[] = []

    for (let i = 1; i < segments.length; i++) {
        const seg = segments[i]!
        if (UUID_RE.test(seg)) continue // skip detail IDs
        const label = SEGMENT_LABELS[seg] ?? seg.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
        const href = '/' + segments.slice(0, i + 1).join('/')
        crumbs.push({ label, href })
    }

    if (crumbs.length === 0) return null

    return (
        <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-xs text-text-muted mb-4">
            <Link href="/app" className="hover:text-text-secondary transition-colors">Home</Link>
            {crumbs.map((crumb, i) => {
                const isLast = i === crumbs.length - 1
                return (
                    <span key={crumb.href} className="flex items-center gap-1.5">
                        <ChevronRight className="h-3 w-3" />
                        {isLast ? (
                            <span className="text-text-secondary">{crumb.label}</span>
                        ) : (
                            <Link href={crumb.href} className="hover:text-text-secondary transition-colors">{crumb.label}</Link>
                        )}
                    </span>
                )
            })}
        </nav>
    )
}
