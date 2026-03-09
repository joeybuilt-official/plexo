// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

"use client"

import React, { useEffect, useState } from 'react'

export function EnableBiometric({ onComplete }: { onComplete: () => void }) {
    const [isAvailable, setIsAvailable] = useState(false)
    const [checked, setChecked] = useState(false)

    useEffect(() => {
        const checkBiometric = async () => {
            try {
                const { NativeBiometric } = await import('@capgo/capacitor-native-biometric')
                const res = await NativeBiometric.isAvailable()
                if (res.isAvailable) setIsAvailable(true)
            } catch (e) {
                console.error(e)
            } finally {
                setChecked(true)
            }
        }
        checkBiometric()
    }, [])

    const enableBiometric = async () => {
        try {
            const { NativeBiometric } = await import('@capgo/capacitor-native-biometric')
            // To enroll/enable, we just test a verification or store a setting locally
            await NativeBiometric.verifyIdentity({
                reason: "Unlock Plexo securely",
                title: "Unlock Plexo",
                subtitle: "Use biometrics to enter securely"
            })
            // If it succeeds, save preference
            const { Preferences } = await import('@capacitor/preferences')
            await Preferences.set({ key: 'biometric_enabled', value: 'true' })
            onComplete()
        } catch (e) {
            console.error(e)
        }
    }

    // Skip if not available
    if (checked && !isAvailable) {
        onComplete()
        return null
    }

    if (!checked) return <div className="flex h-full items-center justify-center"><p className="text-zinc-500">Checking device...</p></div>

    return (
        <div className="flex flex-col p-6 space-y-6 max-w-md mx-auto h-full justify-center text-center">
            <h1 className="text-2xl font-bold text-zinc-100">Unlock faster</h1>
            <p className="text-zinc-400">Use your fingerprint to open Plexo securely.</p>
            
            <button 
                onClick={enableBiometric}
                className="w-full py-3 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg font-semibold flex items-center justify-center transition-colors shadow-lg shadow-indigo-500/20 mt-8"
            >
                Enable Biometric
            </button>
            
            <button 
                onClick={onComplete}
                className="text-zinc-500 hover:text-zinc-300 font-medium text-sm mt-4 transition-colors"
            >
                Not now
            </button>
        </div>
    )
}
