// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

'use client'

import { useState } from 'react'
import { Menu, X } from 'lucide-react'
import { Sidebar } from './sidebar'

interface SessionUser {
    name?: string | null
    email?: string | null
}

export function MobileHeader({ user }: { user?: SessionUser }) {
    const [open, setOpen] = useState(false)

    return (
        <>
            {/* Mobile Sticky Header */}
            <div className="flex md:hidden sticky top-0 z-40 w-full items-center justify-between border-b border-zinc-800 bg-zinc-950/80 p-4 backdrop-blur-md shrink-0">
                <button
                    onClick={() => setOpen(true)}
                    className="flex h-10 w-10 items-center justify-center rounded-lg text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100 transition-colors"
                    aria-label="Open menu"
                >
                    <Menu className="h-6 w-6" />
                </button>
                <div className="text-sm font-semibold text-zinc-200 tracking-wide uppercase">
                    Plexo
                </div>
                {/* Empty div for flex balance against the 40px left button */}
                <div className="w-10 flex justify-end" />
            </div>

            {/* Mobile Drawer Overlay */}
            {open && (
                <div className="fixed inset-0 z-50 flex md:hidden">
                    <div 
                        className="fixed inset-0 bg-black/60 backdrop-blur-sm transition-opacity" 
                        onClick={() => setOpen(false)} 
                    />
                    <div className="relative flex w-[220px] shadow-2xl animate-in slide-in-from-left h-full duration-200">
                        <Sidebar 
                            user={user} 
                            onNavClick={() => setOpen(false)} 
                            className="border-r-0 shadow-xl"
                        />
                        <button
                            onClick={() => setOpen(false)}
                            className="absolute -right-12 top-4 flex h-10 w-10 items-center justify-center rounded-full bg-zinc-800 text-zinc-400 opacity-90 transition-all hover:bg-zinc-700 hover:text-white"
                            aria-label="Close menu"
                        >
                            <X className="h-5 w-5" />
                        </button>
                    </div>
                </div>
            )}
        </>
    )
}
