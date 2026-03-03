export default function DebugPage() {
    return (
        <div className="flex flex-col gap-4">
            <div>
                <h1 className="text-xl font-bold text-zinc-50">Debug</h1>
                <p className="mt-0.5 text-sm text-zinc-500">
                    Agent state snapshots and manual RPC for power users.
                </p>
            </div>
            <div className="flex h-48 items-center justify-center rounded-xl border border-dashed border-zinc-800 text-sm text-zinc-600">
                Debug panel — Phase G
            </div>
        </div>
    )
}
