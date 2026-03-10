// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

"use client"

import React, { useState, useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { ModeSelection } from '@plexo/ui/components/onboarding/ModeSelection'
import { InstanceConnect } from '@plexo/ui/components/onboarding/InstanceConnect'
import { SignIn } from '@plexo/ui/components/onboarding/SignIn'
import { EnableNotifications } from '@plexo/ui/components/onboarding/EnableNotifications'
import { EnableBiometric } from '@plexo/ui/components/onboarding/EnableBiometric'
import { OnboardingComplete } from '@plexo/ui/components/onboarding/OnboardingComplete'
import { getRuntimeContext } from '@plexo/ui/lib/runtime'
import { PlexoMark } from '@web/components/plexo-logo'

export default function OnboardingPage() {
    const router = useRouter()
    const searchParams = useSearchParams()
    const step = parseInt(searchParams.get('step') || '1', 10)
    const runtime = getRuntimeContext()
    
    // Tauri mode
    if (runtime === 'tauri') {
        const handleModeSelect = (mode: 'local' | 'remote') => {
            if (mode === 'local') {
                router.push('/')
            } else {
                router.push('/onboarding?step=2')
            }
        }
        
        if (step === 1) return <ModeSelection onSelectMode={handleModeSelect} />
        if (step === 2) return <InstanceConnect onConnect={() => router.push('/')} />
        
        router.push('/')
        return null
    }

    // Capacitor Native Mode
    if (runtime === 'capacitor') {
        // Screen 1: Welcome
        if (step === 1) {
            return (
                <div className="flex flex-col p-6 space-y-6 max-w-md mx-auto h-full justify-center text-center">
                    <div className="flex items-center justify-center w-16 h-16 mx-auto mb-4">
                        <PlexoMark className="w-12 h-12 text-indigo drop-shadow-lg" />
                    </div>
                    <h1 className="text-3xl font-bold text-text-primary">Welcome to Plexo</h1>
                    <p className="text-text-secondary">Your AI agentic platform.</p>
                    
                    <button 
                        onClick={() => router.push('/onboarding?step=2')}
                        className="w-full py-3 bg-indigo hover:bg-indigo/90 text-white rounded-lg font-semibold flex items-center justify-center transition-colors shadow-lg shadow-indigo/20 mt-12"
                    >
                        Get Started
                    </button>
                </div>
            )
        }

        // Screen 2: Connect
        if (step === 2) {
            const handleConnect = async (url: string) => {
                try {
                    const { Preferences } = await import('@capacitor/preferences')
                    await Preferences.set({ key: 'plexo_instance_url', value: url })
                    // Redirect entire webview to that URL's onboarding step 3
                    window.location.replace(`${url}/onboarding?step=3`)
                } catch (e) {
                    console.error('Failed to set preferences', e)
                }
            }
            return <InstanceConnect onConnect={handleConnect} />
        }

        // Screen 3: Sign in
        if (step === 3) {
            return <SignIn onSignIn={() => router.push('/onboarding?step=4')} />
        }

        // Screen 4: Notifications
        if (step === 4) {
            return <EnableNotifications onComplete={() => router.push('/onboarding?step=5')} />
        }

        // Screen 5: Biometric
        if (step === 5) {
            return <EnableBiometric onComplete={() => router.push('/onboarding?step=6')} />
        }

        // Screen 6: Ready
        if (step === 6) {
            return <OnboardingComplete onComplete={() => router.push('/')} />
        }
    }

    // Not native or fallback
    useEffect(() => {
        router.push('/')
    }, [router])

    return null
}
