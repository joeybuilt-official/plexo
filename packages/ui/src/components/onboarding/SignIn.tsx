// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

"use client"

import React, { useState } from 'react'

export type CredentialsResult = { success: boolean; error?: string }

export function SignIn({
    onSignIn,
    onSubmitCredentials
}: {
    onSignIn: () => void
    onSubmitCredentials: (email: string, password: string) => Promise<CredentialsResult>
}) {
    const [email, setEmail] = useState('')
    const [password, setPassword] = useState('')
    const [error, setError] = useState('')
    const [loading, setLoading] = useState(false)

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault()
        setLoading(true)
        setError('')

        const result = await onSubmitCredentials(email, password)
        if (result.success) {
            onSignIn()
        } else {
            setError(result.error ?? 'Sign in failed')
        }
        setLoading(false)
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
