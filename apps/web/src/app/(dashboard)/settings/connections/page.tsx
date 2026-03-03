export default function ConnectionsPage() {
    return (
        <div className="flex flex-col gap-4">
            <div>
                <h1 className="text-xl font-bold text-zinc-50">Connections</h1>
                <p className="mt-0.5 text-sm text-zinc-500">
                    Connect Plexo to external services like GitHub, Linear, Notion, and more.
                </p>
            </div>
            <div className="flex h-48 items-center justify-center rounded-xl border border-dashed border-zinc-800 text-sm text-zinc-600">
                Service connections — Phase D
            </div>
        </div>
    )
}
