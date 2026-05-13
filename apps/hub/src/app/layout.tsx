import type { Metadata } from 'next'
import { Inter, JetBrains_Mono, Syne } from 'next/font/google'
import { HubHeader } from '@hub/components/hub-header'
import { HubFooter } from '@hub/components/hub-footer'
import './globals.css'

const inter = Inter({ subsets: ['latin'], variable: '--font-inter' })
const mono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-mono' })
const syne = Syne({ subsets: ['latin'], variable: '--font-display' })

export const metadata: Metadata = {
    metadataBase: new URL('https://hub.getplexo.com'),
    title: 'Plexo Hub — Skills, Tools & Agents',
    description: 'Discover and install skills, tools, and agents for your Plexo AI workspace. A Joeybuilt product.',
    keywords: ['Plexo Hub', 'AI skills', 'AI tools', 'AI agents', 'Plexo extensions', 'Joeybuilt'],
    openGraph: {
        type: 'website',
        locale: 'en_US',
        siteName: 'Plexo Hub',
        title: 'Plexo Hub — Skills, Tools & Agents',
        description: 'Discover and install skills, tools, and agents for your Plexo AI workspace.',
        url: 'https://hub.getplexo.com',
    },
    twitter: {
        card: 'summary',
        title: 'Plexo Hub — Skills, Tools & Agents',
        description: 'AI skills, tools, and agents for Plexo. Open marketplace.',
    },
    robots: { index: true, follow: true },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
    return (
        <html lang="en" className={`${inter.variable} ${mono.variable} ${syne.variable}`}>
            <body className="min-h-screen flex flex-col">
                <HubHeader />
                <main className="flex-1">{children}</main>
                <HubFooter />
            </body>
        </html>
    )
}
