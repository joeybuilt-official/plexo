"use client"
import { useWorkspace } from '@web/context/workspace'

export function Greeting() {
    const { userName } = useWorkspace()
    const h = new Date().getHours()
    const time = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'
    const name = userName ? userName.split(' ')[0] : ''
    const greeting = name ? `${time}, ${name}` : time

    return (
        // Fixed min-height prevents layout shift when greeting text changes length
        <div className="text-center mb-10 mt-8 min-h-[120px] flex flex-col items-center justify-center animate-in fade-in duration-700">
            <h1 className="text-3xl md:text-[32px] font-serif font-medium text-text-primary tracking-tight mb-2 text-transparent bg-clip-text bg-gradient-to-br from-zinc-100 to-zinc-400">
                {greeting}
            </h1>
            <p className="text-base text-text-muted">
                What are we working on today?
            </p>
        </div>
    )
}
