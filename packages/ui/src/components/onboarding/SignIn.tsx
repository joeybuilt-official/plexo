// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

"use client"

import React, { useState } from 'react'

export function SignIn({ onSignIn, apiUrl }: { onSignIn: () => void; apiUrl?: string }) {
    const [email, setEmail] = useState('')
    const [password, setPassword] = useState('')
    const [error, setError] = useState('')
    const [loading, setLoading] = useState(false)

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault()
        setLoading(true)
        setError('')

        try {
            const base = apiUrl || window.location.origin
            const res = await fetch(`${base}/api/auth/callback/credentials`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ email, password, callbackUrl: '/', redirect: 'false' })
            })

            if (res.ok) {
                const data = await res.json()
                if (data.url && !data.error) {
                    onSignIn()
                } else {
                    setError('Invalid credentials.')
                }
            } else {
                setError('Failed to sign in.')
            }
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Sign in failed')
        } finally {
            setLoading(false)
        }
    }

    return (
        <div className="flex flex-col p-6 space-y-6 max-w-md mx-auto h-full justify-center text-center">
            <h1 className="text-2xl font-bold text-text-primary">Sign In</h1>
            <form onSubmit={handleSubmit} className="flex flex-col space-y-4 text-left">
                <div>
                    <label className="text-sm font-medium text-text-secondary">Email</label>
                    <input 
                        type="email" 
                        required
                        value={email}
                        onChange={e => setEmail(e.target.value)}
                        className="w-full px-3 py-2 bg-canvas border border-border rounded-lg text-text-primary mt-1 focus:outline-none focus:border-indigo"
                    />
                </div>
                <div>
                    <label className="text-sm font-medium text-text-secondary">Password</label>
                    <input 
                        type="password" 
                        required
                        value={password}
                        onChange={e => setPassword(e.target.value)}
                        className="w-full px-3 py-2 bg-canvas border border-border rounded-lg text-text-primary mt-1 focus:outline-none focus:border-indigo"
                    />
                </div>
                
                {error && <p className="text-red text-sm font-medium">{error}</p>}
                
                <button 
                    type="submit"
                    disabled={loading || !email || !password}
                    className="w-full py-2 bg-indigo-600 hover:bg-indigo-500 text-text-primary rounded-lg font-semibold disabled:opacity-50 transition-colors"
                >
                    {loading ? '...' : 'Sign In'}
                </button>
            </form>
            <p className="text-sm text-text-muted mt-4">Forgot your password? Reset it from the web client.</p>
        </div>
    )
}
