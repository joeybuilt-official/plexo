// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import Link from 'next/link'
import { PlexoMark } from '@web/components/plexo-logo'

export default function DashboardNotFound() {
    return (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6">
            <PlexoMark className="h-10 w-10 text-text-muted" />
            <h2 className="text-lg font-medium text-text-primary">Page not found</h2>
            <p className="text-sm text-text-muted">
                The page you&apos;re looking for doesn&apos;t exist or was moved.
            </p>
            <Link
                href="/app/home"
                className="rounded-md bg-azure px-4 py-2 text-sm font-medium text-white hover:opacity-90"
            >
                Back to dashboard
            </Link>
        </div>
    )
}
