export function HubFooter() {
    return (
        <footer className="border-t border-border/30 py-10 mt-16">
            <div className="max-w-5xl mx-auto px-4 sm:px-6 flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-text-muted">
                <p>Plexo Hub &middot; AGPL-3.0 Open Source</p>
                <div className="flex items-center gap-5">
                    <a href="https://getplexo.com" className="hover:text-azure transition-colors">Plexo</a>
                    <a href="https://github.com/joeybuilt-official/plexo" className="hover:text-azure transition-colors">GitHub</a>
                    <a href="https://joeybuilt.com" className="hover:text-azure transition-colors">Joeybuilt</a>
                </div>
            </div>
        </footer>
    )
}
