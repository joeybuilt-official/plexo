// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

import type { Metadata, Viewport } from 'next'
import { Geist, IBM_Plex_Sans, JetBrains_Mono } from 'next/font/google'
import './globals.css'
import { ThemeProvider } from '@web/components/theme-provider'
import { SessionErrorBoundary } from '@web/components/session-error-boundary'
import { CookieConsent } from '@web/components/cookie-consent'

// FE11 (ADR 0044-adjacent): globals.css declares --font-display:Geist + --font-body:'IBM Plex Sans',
// but those were never loaded (the old <link> shipped Syne+Inter) so every heading fell back to
// system-ui. Load the DECLARED faces via next/font/google — self-hosted (no CORS, no CLS,
// not render-blocking) and built into Next (no new package, ADR-0033-safe). Distinct var names
// so they don't clash with the --font-* vars globals.css already exposes to components.
const fontDisplay = Geist({ subsets: ['latin'], weight: ['400', '500', '600', '700'], variable: '--font-geist', display: 'swap' })
const fontBody = IBM_Plex_Sans({ subsets: ['latin'], weight: ['300', '400', '500', '600'], variable: '--font-ibm-plex', display: 'swap' })
const fontMono = JetBrains_Mono({ subsets: ['latin'], weight: ['400', '500'], variable: '--font-jetbrains', display: 'swap' })

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
    <html lang="en" className={`${fontDisplay.variable} ${fontBody.variable} ${fontMono.variable}`} suppressHydrationWarning>
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
