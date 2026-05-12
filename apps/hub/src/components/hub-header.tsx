import Link from 'next/link'
import { Search } from 'lucide-react'

export function HubHeader() {
    return (
        <header className="border-b border-border/50 sticky top-0 z-50 bg-canvas/80 backdrop-blur-xl">
            <div className="max-w-6xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between">
                <div className="flex items-center gap-6">
                    <Link href="/" className="font-display font-bold text-lg text-text-primary tracking-tight">
                        Plexo Hub
                    </Link>
                    <nav className="hidden sm:flex items-center gap-5 text-sm text-text-muted">
                        <Link href="/browse" className="hover:text-text-primary transition-colors">Browse</Link>
                        <Link href="/submit" className="hover:text-text-primary transition-colors">Publish</Link>
                        <Link href="/about" className="hover:text-text-primary transition-colors">About</Link>
                    </nav>
                </div>
                <div className="flex items-center gap-3">
                    <Link href="/browse" className="sm:hidden p-2 text-text-muted hover:text-text-primary transition-colors">
                        <Search className="h-4 w-4" />
                    </Link>
                    <a
                        href="https://getplexo.com/app/hub/"
                        className="rounded-lg bg-azure px-3.5 py-1.5 text-xs font-medium text-white hover:bg-azure-600 transition-colors"
                    >
                        Open Plexo
                    </a>
                </div>
            </div>
        </header>
    )
}
