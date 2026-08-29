// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ShareContent } from './ShareContent'

const API_URL = process.env.INTERNAL_API_URL || 'http://localhost:3001'

interface ShareData {
    artifact: {
        filename: string
        kind: string
        content: string
        version: number
        meta?: Record<string, unknown> | null
        createdAt: string
    }
    share: {
        createdAt: string
        viewCount: number
    }
}

async function fetchShare(shareId: string): Promise<ShareData | null> {
    try {
        const res = await fetch(`${API_URL}/api/v1/s/${shareId}`, {
            cache: 'no-store',
        })
        if (!res.ok) return null
        return await res.json()
    } catch {
        return null
    }
}

export async function generateMetadata(
    { params }: { params: Promise<{ shareId: string }> }
): Promise<Metadata> {
    const { shareId } = await params
    const data = await fetchShare(shareId)
    if (!data) {
        return { title: 'Share Not Found | Plexo' }
    }

    const { artifact } = data
    const description = `${artifact.filename} — ${artifact.kind} · Created with Plexo`

    return {
        title: `${artifact.filename} | Plexo`,
        description,
        openGraph: {
            title: `${artifact.filename} — Shared Work`,
            description,
            type: 'article',
            siteName: 'Plexo',
        },
        twitter: {
            card: 'summary',
            title: `${artifact.filename} — Shared Work`,
            description,
        },
    }
}

export default async function SharePage(
    { params }: { params: Promise<{ shareId: string }> }
) {
    const { shareId } = await params
    const data = await fetchShare(shareId)

    if (!data) {
        notFound()
    }

    const { artifact, share } = data
    const createdDate = new Date(artifact.createdAt).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
    })

    return (
        <div className="min-h-screen bg-canvas">
            <header className="border-b border-border px-6 py-4 flex items-center justify-between">
                <div className="flex items-center gap-3">
                    <Link href="/" className="font-display text-lg font-bold text-text-primary tracking-tight">
                        Plexo
                    </Link>
                    <span className="text-text-muted text-sm">Shared Work</span>
                </div>
                <a
                    href="/register"
                    className="text-azure hover:underline text-sm"
                >
                    Create with Plexo &rarr;
                </a>
            </header>

            <main className="max-w-4xl mx-auto px-6 py-8">
                <h1 className="text-xl font-semibold text-text-primary font-mono">
                    {artifact.filename}
                </h1>
                <div className="flex gap-2 text-sm text-text-muted mt-1">
                    <span>{artifact.kind}</span>
                    <span>&middot;</span>
                    <span>{createdDate}</span>
                    <span>&middot;</span>
                    <span>v{artifact.version}</span>
                    <span>&middot;</span>
                    <span>{share.viewCount} {share.viewCount === 1 ? 'view' : 'views'}</span>
                </div>

                <div className="mt-6 border border-border rounded p-6 bg-surface-1 overflow-auto">
                    <ShareContent
                        content={artifact.content}
                        filename={artifact.filename}
                        kind={artifact.kind}
                        meta={artifact.meta}
                    />
                </div>
            </main>

            <footer className="text-center py-8 text-text-muted text-sm">
                Made with{' '}
                <Link href="/" className="text-azure hover:underline">Plexo</Link>
                {' '}&mdash; AI Agent Platform
            </footer>
        </div>
    )
}
