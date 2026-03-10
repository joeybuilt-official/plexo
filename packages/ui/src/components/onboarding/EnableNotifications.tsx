// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

"use client"

import React, { useState, useEffect } from 'react'

export function EnableNotifications({ onComplete }: { onComplete: () => void }) {
    const [status, setStatus] = useState<'idle' | 'checking' | 'failed'>('idle')

    const requestPermissions = async () => {
        try {
            const { PushNotifications } = await import('@capacitor/push-notifications')
            let permStatus = await PushNotifications.checkPermissions()
            
            if (permStatus.receive === 'prompt') {
                permStatus = await PushNotifications.requestPermissions()
            }
            
            if (permStatus.receive !== 'granted') {
                // Not granted, that's fine, we can still proceed
            } else {
                await PushNotifications.register()
            }
            onComplete()
        } catch (e) {
            console.error('Push Notifications Error', e)
            onComplete() // Proceed anyway
        }
    }

    return (
        <div className="flex flex-col p-6 space-y-6 max-w-md mx-auto h-full justify-center text-center">
            <h1 className="text-2xl font-bold text-text-primary">Stay on top of your agents</h1>
            <p className="text-text-secondary">Get notified when your agent needs approval or finishes a task.</p>
            
            <button 
                onClick={requestPermissions}
                className="w-full py-3 bg-indigo-600 hover:bg-indigo-500 text-text-primary rounded-lg font-semibold flex items-center justify-center transition-colors shadow-lg shadow-indigo-500/20 mt-8"
            >
                Enable Notifications
            </button>
            
            <button 
                onClick={onComplete}
                className="text-text-muted hover:text-text-secondary font-medium text-sm mt-4 transition-colors"
            >
                Not now
            </button>
        </div>
    )
}
