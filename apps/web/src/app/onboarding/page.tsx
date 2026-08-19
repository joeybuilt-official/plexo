// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

"use client"

import React, { useState, useEffect, Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { ModeSelection } from '@plexo/ui/components/onboarding/ModeSelection'
import { InstanceConnect } from '@plexo/ui/components/onboarding/InstanceConnect'
import { SignIn, type CredentialsResult } from '@plexo/ui/components/onboarding/SignIn'
import { EnableNotifications } from '@plexo/ui/components/onboarding/EnableNotifications'
import { EnableBiometric } from '@plexo/ui/components/onboarding/EnableBiometric'
import { OnboardingComplete } from '@plexo/ui/components/onboarding/OnboardingComplete'
import { ChooseProvider } from '@web/components/onboarding/choose-provider'
import { getRuntimeContext } from '@plexo/ui/lib/runtime'
import { PlexoMark } from '@web/components/plexo-logo'

/** Read workspace ID from cookie or localStorage (available after sign-in). */
function getWorkspaceId(): string {
    if (typeof window === 'undefined') return ''
    // Cookie
    const match = document.cookie.match(/(?:^|;\s*)plexo_workspace_id=([^;]+)/)
    if (match) return decodeURIComponent(match[1])
    // localStorage fallback
    try { return localStorage.getItem('plexo_workspace_id') || '' } catch { return '' }
}

export default function OnboardingPage() {
    return (
        <Suspense>
            <OnboardingContent />
        </Suspense>
    )
}

function OnboardingContent() {
    const router = useRouter()
    const searchParams = useSearchParams()
    const step = parseInt(searchParams.get('step') || '1', 10)
    const runtime = getRuntimeContext()

    // Tauri mode
    if (runtime === 'tauri') {
        const handleModeSelect = (mode: 'local' | 'remote') => {
            if (mode === 'local') {
                router.push('/app/home')
            } else {
                router.push('/app/onboarding?step=2')
            }
        }

        if (step === 1) return <ModeSelection onSelectMode={handleModeSelect} />
        if (step === 2) return <InstanceConnect onConnect={() => router.push('/app/home')} />

        router.push('/app/home')
        return null
    }

    // Capacitor Native Mode
    if (runtime === 'capacitor') {
        // Screen 1: Welcome
        if (step === 1) {
            return (
                <div className="flex flex-col p-6 space-y-6 max-w-md mx-auto h-full justify-center text-center">
                    <div className="flex items-center justify-center w-16 h-16 mx-auto mb-4">
                        <PlexoMark className="w-12 h-12 text-accent" />
                    </div>
                    <h1 className="text-3xl font-medium text-text-primary">Welcome to Plexo</h1>
                    <p className="text-text-secondary">Your AI agentic platform.</p>

                    <button
                        onClick={() => router.push('/app/onboarding?step=2')}
                        className="w-full py-3 bg-text-primary hover:opacity-90 text-canvas rounded-md font-medium flex items-center justify-center transition-colors mt-12"
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
            const onSubmitCredentials = async (email: string, password: string): Promise<CredentialsResult> => {
                try {
                    const base = window.location.origin
                    const res = await fetch(`${base}/api/auth/callback/credentials`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                        body: new URLSearchParams({ email, password, callbackUrl: '/', redirect: 'false' })
                    })
                    if (!res.ok) return { success: false, error: 'Failed to sign in.' }
                    const data = await res.json()
                    if (data.url && !data.error) return { success: true }
                    return { success: false, error: 'Invalid credentials.' }
                } catch (e) {
                    return { success: false, error: e instanceof Error ? e.message : 'Sign in failed' }
                }
            }
            return <SignIn
                onSignIn={() => router.push('/app/onboarding?step=4')}
                onSubmitCredentials={onSubmitCredentials}
            />
        }

        // Screen 4: Choose AI provider
        if (step === 4) {
            return (
                <ChooseProvider
                    workspaceId={getWorkspaceId()}
                    onComplete={() => router.push('/app/onboarding?step=5')}
                    onSkip={() => router.push('/app/onboarding?step=5')}
                    onGoToSettings={() => router.push('/app/settings/intelligence')}
                />
            )
        }

        // Screen 5: Notifications
        if (step === 5) {
            return <EnableNotifications onComplete={() => router.push('/app/onboarding?step=6')} />
        }

        // Screen 6: Biometric
        if (step === 6) {
            return <EnableBiometric onComplete={() => router.push('/app/onboarding?step=7')} />
        }

        // Screen 7: Ready
        if (step === 7) {
            return <OnboardingComplete onComplete={() => router.push('/app/home')} />
        }
    }

    // Web mode: show ChooseProvider for step 4 (explicit) or step 1 (default entry)
    // This gives web users a friendly provider selection experience before
    // landing on the dashboard where the setup wizard overlay handles the rest.
    if (step === 1 || step === 4) {
        return (
            <ChooseProvider
                workspaceId={getWorkspaceId()}
                onComplete={() => router.push('/app/home')}
                onSkip={() => router.push('/app/home')}
                onGoToSettings={() => router.push('/app/settings/intelligence')}
            />
        )
    }

    // Any other step on web — redirect to home
    return <RedirectToHome />
}

function RedirectToHome() {
    const router = useRouter()
    useEffect(() => { router.push('/app/home') }, [router])
    return null
}
