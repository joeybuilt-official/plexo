// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

"use client"

import React, { useEffect, useState } from 'react'
import { CheckCircle2 } from 'lucide-react'

export function OnboardingComplete({ onComplete }: { onComplete: () => void }) {
    const [url, setUrl] = useState('')

    useEffect(() => {
        const getUrl = async () => {
            try {
                // If native
                if (typeof (window as any).Capacitor !== 'undefined') {
                    const { Preferences } = await import('@capacitor/preferences')
                    const res = await Preferences.get({ key: 'plexo_instance_url' })
                    if (res.value) setUrl(res.value)
                }
            } catch (e) {
                console.error(e)
            }
        }
        getUrl()
    }, [])

    return (
        <div className="flex flex-col p-6 space-y-6 max-w-md mx-auto h-full justify-center text-center">
            <h1 className="text-2xl font-bold text-zinc-100">You're all set</h1>
            {url && <p className="text-zinc-400">Connected to:<br/><span className="font-semibold text-zinc-200">{url}</span></p>}
            
            <CheckCircle2 className="w-16 h-16 text-green-500 mx-auto my-8" />
            
            <button 
                onClick={onComplete}
                className="w-full py-3 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg font-semibold flex items-center justify-center shadow-lg shadow-indigo-500/20"
            >
                Open Plexo
            </button>
        </div>
    )
}
