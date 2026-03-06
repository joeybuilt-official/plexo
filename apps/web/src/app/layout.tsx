import type { Metadata } from 'next'
import './globals.css'
import { ThemeProvider } from '@web/components/theme-provider'
import { PostHogProvider } from '@web/components/posthog-provider'
import { auth } from '@web/auth'

export const metadata: Metadata = {
  title: 'Plexo',
  description: 'AI agent platform — autonomous work, on your terms',
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
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="min-h-screen bg-zinc-950 font-sans text-zinc-100 antialiased">
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
