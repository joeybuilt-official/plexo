import {
    Activity,
    Zap,
    MessageSquare,
    DollarSign,
    Clock,
    GitBranch,
} from 'lucide-react'
import { DashboardCards } from './_components/dashboard-cards'
import { TaskFeed } from './_components/task-feed'
import { QuickSend } from './_components/quick-send'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export default function HomePage() {
    return (
        <div>
            {/* Header */}
            <div className="mb-8">
                <h1 className="text-xl font-semibold tracking-tight">Dashboard</h1>
                <p className="mt-1 text-sm text-zinc-500">Your AI agent overview</p>
            </div>

            {/* Live dashboard cards — fetches from API */}
            <DashboardCards />

            {/* Task feed */}
            <div className="mt-8">
                <TaskFeed />
            </div>

            {/* Quick Send */}
            <div className="mt-6">
                <QuickSend />
            </div>

            {/* Version */}
            <p className="mt-6 text-center text-[10px] text-zinc-700">
                v0.2.0 (dev:local)
            </p>
        </div>
    )
}
