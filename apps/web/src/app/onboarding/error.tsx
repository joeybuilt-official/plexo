// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

export default function OnboardingError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
    return (
        <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 text-center">
            <h2 className="text-lg font-medium">Setup encountered an error</h2>
            <p className="max-w-md text-sm text-text-muted">
                Something went wrong during onboarding. Refreshing usually fixes this.
            </p>
            <button
                onClick={reset}
                className="rounded-md bg-text-primary px-4 py-2 text-sm font-medium text-canvas hover:opacity-90"
            >
                Try again
            </button>
        </div>
    )
}
