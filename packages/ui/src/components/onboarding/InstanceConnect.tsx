// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

"use client"

import React, { useState } from 'react'
import { Server, Globe, Loader2 } from 'lucide-react'

export function InstanceConnect({ onConnect }: { onConnect: (url: string) => void }) {
    const [url, setUrl] = useState('')
    const [status, setStatus] = useState<'idle' | 'checking' | 'failed'>('idle')
    const [errorMsg, setErrorMsg] = useState('')

    const handleConnect = async (targetUrl: string) => {
        let cleanUrl = targetUrl.trim().replace(/\/+$/, '')
        if (!cleanUrl) return
        if (!/^https?:\/\//i.test(cleanUrl)) {
            cleanUrl = 'https://' + cleanUrl
        }
        
        setStatus('checking')
        setErrorMsg('')
        
        try {
            const res = await fetch(`${cleanUrl}/health`, { method: 'GET' })
            if (res.ok) {
                onConnect(cleanUrl)
            } else {
                setStatus('failed')
                setErrorMsg("Couldn't reach that address. Check the URL and try again.")
            }
        } catch (e) {
            setStatus('failed')
            setErrorMsg(e instanceof Error ? e.message : "Couldn't reach that address. Check the URL and try again.")
        }
    }

    return (
        <div className="flex flex-col p-6 space-y-6 max-w-md mx-auto h-full justify-center">
            <h1 className="text-2xl font-bold text-text-primary text-center">Where is your Plexo running?</h1>
            
            <button 
                onClick={() => handleConnect('https://app.getplexo.com')}
                className="w-full flex-col flex items-start p-4 rounded-xl border border-border bg-surface-1 hover:bg-surface-2 transition-colors text-left"
            >
                <div className="flex items-center gap-3 font-semibold text-text-primary">
                    <Globe className="w-5 h-5 text-indigo" />
                    getplexo.com
                </div>
                <p className="text-sm text-text-secondary mt-2">Managed cloud. Sign in with your account.</p>
            </button>

            <div className="w-full flex-col flex items-start p-4 rounded-xl border border-border bg-surface-1 text-left space-y-4">
                <div className="flex items-center gap-3 font-semibold text-text-primary">
                    <Server className="w-5 h-5 text-indigo" />
                    Self-hosted
                </div>
                <p className="text-sm text-text-secondary">Running on your own server.</p>
                <input 
                    type="url"
                    placeholder="https://plexo.yourdomain.com"
                    value={url}
                    onChange={e => setUrl(e.target.value)}
                    className="w-full px-3 py-2 bg-canvas border border-border rounded-lg text-text-primary placeholder:text-text-muted focus:outline-none focus:border-indigo"
                />
                <button 
                    onClick={() => handleConnect(url)}
                    disabled={!url || status === 'checking'}
                    className="w-full py-2 bg-indigo-600 hover:bg-indigo-500 text-text-primary rounded-lg font-semibold flex items-center justify-center disabled:opacity-50 transition-colors"
                >
                    {status === 'checking' ? <Loader2 className="w-5 h-5 animate-spin" /> : 'Connect'}
                </button>
            </div>

            {status === 'failed' && <p className="text-red text-sm font-medium text-center">{errorMsg}</p>}
        </div>
    )
}
