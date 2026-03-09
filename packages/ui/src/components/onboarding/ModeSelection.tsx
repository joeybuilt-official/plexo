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
        // Only run on Tauri
        if (typeof (window as any).__TAURI__ !== 'undefined') {
            const { invoke } = (window as any).__TAURI__.core || (window as any).__TAURI__.tauri || {}
            if (invoke) {
                // Wait actually we use tauri-plugin-shell to run docker --version
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
            // Option A uses Tauri sidecar 'docker' to run `compose up -d` 
            // since we bundled docker-compose.yml 
            // "from a bundled docker-compose.yml inside the app package"
            // Actually `docker compose` is fine for now
            const compose = Command.create('docker', ['compose', 'up', '-d'])
            const res = await compose.execute()
            if (res.code !== 0) {
                setError(res.stderr || 'Failed to start local stack')
                setStarting(false)
                return
            }
            
            // Wait for localhost:3000/health
            let passed = false
            for (let i = 0; i < 30; i++) {
                try {
                    const health = await fetch('http://localhost:3000/health')
                    if (health.ok) { passed = true; break; }
                } catch { }
                await new Promise(r => setTimeout(r, 2000))
            }

            if (!passed) {
                setError('Local stack took too long to become healthy.')
                setStarting(false)
            } else {
                onSelectMode('local')
            }
        } catch (e: any) {
            setError(e.message || 'Error starting local mode')
            setStarting(false)
        }
    }

    return (
        <div className="flex flex-col items-center justify-center p-6 space-y-6 max-w-md mx-auto text-center">
            <h1 className="text-2xl font-bold text-zinc-100">How do you want to run Plexo?</h1>
            
            <button 
                onClick={handleLocal}
                disabled={dockerInstalled === false || starting}
                className="w-full flex-col flex items-start p-4 rounded-xl border border-zinc-800 bg-zinc-900 hover:bg-zinc-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed group text-left"
            >
                <div className="flex items-center gap-3 font-semibold text-zinc-100">
                    <MonitorPlay className="w-5 h-5 text-indigo-400" />
                    Run locally on this machine
                </div>
                <p className="text-sm text-zinc-400 mt-2">Plexo runs on your computer. When you close the app, the service stops.</p>
                {dockerInstalled === false && (
                    <p className="text-xs text-red-400 mt-2 font-medium">Docker is required. Please install Docker first.</p>
                )}
                {starting && (
                    <p className="text-xs text-indigo-400 mt-2 font-medium">Starting Plexo (this may take a minute)...</p>
                )}
            </button>

            <button 
                onClick={() => onSelectMode('remote')}
                disabled={starting}
                className="w-full flex-col flex items-start p-4 rounded-xl border border-zinc-800 bg-zinc-900 hover:bg-zinc-800 transition-colors text-left"
            >
                <div className="flex items-center gap-3 font-semibold text-zinc-100">
                    <Server className="w-5 h-5 text-indigo-400" />
                    Connect to a remote instance
                </div>
                <p className="text-sm text-zinc-400 mt-2">Connect to getplexo.com or your own server. Works from anywhere.</p>
            </button>

            {error && <p className="text-red-400 text-sm mt-4 font-medium">{error}</p>}
        </div>
    )
}
