// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

"use client"

import React, { useState, useEffect } from 'react'
import { Server, MonitorPlay } from 'lucide-react'

export function ModeSelection({ onSelectMode }: { onSelectMode: (mode: 'local' | 'remote') => void }) {
    const [dockerInstalled, setDockerInstalled] = useState<boolean | null>(null)
    const [starting, setStarting] = useState(false)
    const [error, setError] = useState<string | null>(null)

    useEffect(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Tauri global has no typings
        const _win = window as any
        if (typeof _win.__TAURI__ !== 'undefined') {
            const tauriObj = _win.__TAURI__ as Record<string, Record<string, unknown>> | undefined
            const { invoke } = tauriObj?.core ?? tauriObj?.tauri ?? {} as Record<string, unknown>
            if (invoke) {
                import('@tauri-apps/plugin-shell').then(({ Command }) => {
                    Command.create('docker', ['--version']).execute()
                        .then(res => {
                            if (res.code === 0) setDockerInstalled(true)
                            else setDockerInstalled(false)
                        })
                        .catch(() => setDockerInstalled(false))
                }).catch(() => setDockerInstalled(false))
            }
        }
    }, [])

    const handleLocal = async () => {
        if (!dockerInstalled) return
        setStarting(true)
        setError(null)
        try {
            const { Command } = await import('@tauri-apps/plugin-shell')
            const compose = Command.create('docker', ['compose', 'up', '-d'])
            const res = await compose.execute()
            if (res.code !== 0) {
                setError(res.stderr || 'Failed to start local stack')
                setStarting(false)
                return
            }
            
            let passed = false
            for (let i = 0; i < 30; i++) {
                try {
                    const health = await fetch('http://localhost:3000/health')
                    if (health.ok) { passed = true; break; }
                } catch { /* health endpoint not ready yet */ }
                await new Promise(r => setTimeout(r, 2000))
            }

            if (!passed) {
                setError('Local stack took too long to become healthy.')
                setStarting(false)
            } else {
                onSelectMode('local')
            }
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Error starting local mode')
            setStarting(false)
        }
    }

    return (
        <div className="flex flex-col items-center justify-center p-6 space-y-6 max-w-md mx-auto text-center">
            <h1 className="text-2xl font-bold text-text-primary">How do you want to run Plexo?</h1>
            
            <button 
                onClick={handleLocal}
                disabled={dockerInstalled === false || starting}
                className="w-full flex-col flex items-start p-4 rounded-xl border border-border bg-surface-1 hover:bg-surface-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed group text-left"
            >
                <div className="flex items-center gap-3 font-semibold text-text-primary">
                    <MonitorPlay className="w-5 h-5 text-indigo" />
                    Run locally on this machine
                </div>
                <p className="text-sm text-text-secondary mt-2">Plexo runs on your computer. When you close the app, the service stops.</p>
                {dockerInstalled === false && (
                    <p className="text-xs text-red mt-2 font-medium">Docker is required. Please install Docker first.</p>
                )}
                {starting && (
                    <p className="text-xs text-indigo mt-2 font-medium">Starting Plexo (this may take a minute)...</p>
                )}
            </button>

            <button 
                onClick={() => onSelectMode('remote')}
                disabled={starting}
                className="w-full flex-col flex items-start p-4 rounded-xl border border-border bg-surface-1 hover:bg-surface-2 transition-colors text-left"
            >
                <div className="flex items-center gap-3 font-semibold text-text-primary">
                    <Server className="w-5 h-5 text-indigo" />
                    Connect to a remote instance
                </div>
                <p className="text-sm text-text-secondary mt-2">Connect to getplexo.com or your own server. Works from anywhere.</p>
            </button>

            {error && <p className="text-red text-sm mt-4 font-medium">{error}</p>}
        </div>
    )
}
