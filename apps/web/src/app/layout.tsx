// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import type { Metadata, Viewport } from 'next'
import './globals.css'
import { ThemeProvider } from '@web/components/theme-provider'
import { PostHogProvider } from '@web/components/posthog-provider'
import { auth } from '@web/auth'

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
  const session = await auth()

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
          defaultTheme="dark"
          enableSystem
          disableTransitionOnChange
        >
          <PostHogProvider
            userId={session?.user?.id}
            userEmail={session?.user?.email}
            userName={session?.user?.name}
          >
            {children}
          </PostHogProvider>
        </ThemeProvider>
      </body>
    </html>
  )
}
