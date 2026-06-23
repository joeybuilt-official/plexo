"use client"
import { useEffect, useState } from 'react'
import { useWorkspace } from '@web/context/workspace'

export function Greeting() {
    const { userName } = useWorkspace()
    // Time-of-day + userName depend on the browser (local hour, client-only
    // context), so computing them during render mismatches the server-prerendered
    // HTML → React #418 hydration error on /app/home. Defer to post-mount; the
    // reserved min-height keeps the placeholder from shifting layout.
    const [greeting, setGreeting] = useState<string | null>(null)
    useEffect(() => {
        const h = new Date().getHours()
        const time = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'
        const name = userName ? userName.split(' ')[0] : ''
        setGreeting(name ? `${time}, ${name}` : time)
    }, [userName])

    return (
        // Fixed min-height prevents layout shift when greeting text changes length
        <div className="text-center mb-10 mt-8 min-h-[120px] flex flex-col items-center justify-center animate-in fade-in duration-700">
            <h1 className="text-3xl md:text-[32px] font-display font-medium text-text-primary tracking-tight mb-2 text-text-primary">
                {greeting ?? ' '}
            </h1>
            <p className="text-base text-text-muted">
                What are we working on today?
            </p>
        </div>
    )
}
