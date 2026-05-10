// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

import type { Metadata, Viewport } from 'next'
import './globals.css'
import { ThemeProvider } from '@web/components/theme-provider'
import { SessionErrorBoundary } from '@web/components/session-error-boundary'
import { CookieConsent } from '@web/components/cookie-consent'

const appName = process.env.APP_NAME || 'Plexo'
const isCustomInstance = appName !== 'Plexo'
const baseUrl = process.env.BETTER_AUTH_URL || 'https://getplexo.com'

export async function generateMetadata(): Promise<Metadata> {
  const title = isCustomInstance ? appName : 'Plexo — AI Agent Platform'
  const description = isCustomInstance
    ? `${appName} — powered by Plexo`
    : 'AI agent platform with semantic memory, SCL domain reasoning, persistent agents, and intelligent model routing. Open source. Self-hostable. A Joeybuilt product.'

  return {
    metadataBase: new URL(baseUrl),
    title: {
      default: title,
      template: `%s | ${appName}`,
    },
    description,
    ...(!isCustomInstance && {
      keywords: ['Plexo', 'AI agent platform', 'semantic memory', 'SCL', 'Semantic Context Lattice', 'open source AI', 'self-hosted', 'Joeybuilt'],
      openGraph: {
        type: 'website',
        locale: 'en_US',
        siteName: 'Plexo',
        title: 'Plexo — AI Agent Platform',
        description: 'AI agent platform with semantic memory, domain reasoning, persistent agents, and intelligent model routing. Open source. Self-hostable.',
        url: 'https://getplexo.com',
      },
      twitter: {
        card: 'summary' as const,
        title: 'Plexo — AI Agent Platform',
        description: 'AI agent platform with semantic memory, domain reasoning, and persistent agents. Open source.',
      },
    }),
    robots: { index: !isCustomInstance, follow: !isCustomInstance },
  }
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
  viewportFit: 'cover',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=Syne:wght@400;500;600;700;800&family=Inter:wght@300;400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet" />
      </head>
      <body className="min-h-screen bg-canvas font-sans text-text-primary antialiased">
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          storageKey="plexo-theme"
          disableTransitionOnChange
        >
          <SessionErrorBoundary>
            {children}
            <CookieConsent />
          </SessionErrorBoundary>
        </ThemeProvider>
      </body>
    </html>
  )
}
