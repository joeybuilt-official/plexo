// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import type { Metadata, Viewport } from 'next'
import './globals.css'
import { ThemeProvider } from '@web/components/theme-provider'
import { PostHogProvider } from '@web/components/posthog-provider'
import { createServerClient } from '@web/auth'
import { SessionErrorBoundary } from '@web/components/session-error-boundary'

export const metadata: Metadata = {
  title: 'Plexo',
  description: 'AI agent platform — autonomous work, on your terms',
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: 'cover',
}

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const supabase = await createServerClient()
  const { data: { user } } = await supabase.auth.getUser()

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Syne:wght@400;500;600;700;800&family=Inter:wght@300;400;500;600&family=JetBrains+Mono:wght@400;500&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="min-h-screen bg-canvas font-sans text-text-primary antialiased">
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          storageKey="plexo-theme"
          disableTransitionOnChange
        >
          <PostHogProvider
            userId={user?.id}
            userEmail={user?.email}
            userName={user?.user_metadata?.full_name ?? user?.user_metadata?.name}
          >
            <SessionErrorBoundary sessionId={user?.id}>
              {children}
            </SessionErrorBoundary>
          </PostHogProvider>
        </ThemeProvider>
      </body>
    </html>
  )
}
