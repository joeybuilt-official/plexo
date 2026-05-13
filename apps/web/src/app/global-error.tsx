// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

export default function GlobalError({
    reset,
}: {
    error: Error & { digest?: string }
    reset: () => void
}) {
    return (
        <html>
            <body>
                <div
                    style={{
                        display: 'flex',
                        minHeight: '100vh',
                        flexDirection: 'column',
                        alignItems: 'center',
                        justifyContent: 'center',
                        padding: '1.5rem',
                        textAlign: 'center',
                        fontFamily: 'system-ui, sans-serif',
                    }}
                >
                    <h2 style={{ fontSize: '1.125rem', fontWeight: 600, marginBottom: '0.5rem' }}>
                        Something went wrong
                    </h2>
                    <p style={{ fontSize: '0.875rem', color: '#888', marginBottom: '1rem', maxWidth: '28rem' }}>
                        A critical error occurred while loading the app. Please try again.
                    </p>
                    <button
                        onClick={reset}
                        style={{
                            padding: '0.5rem 1rem',
                            borderRadius: '0.375rem',
                            background: '#3b82f6',
                            color: '#fff',
                            fontSize: '0.875rem',
                            fontWeight: 500,
                            border: 'none',
                            cursor: 'pointer',
                        }}
                    >
                        Try again
                    </button>
                </div>
            </body>
        </html>
    )
}
