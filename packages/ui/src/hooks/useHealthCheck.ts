// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

"use client"

import { useCallback } from 'react'

export function useHealthCheck() {
    const checkHealth = useCallback(async (
        url: string
    ): Promise<{ ok: boolean; error?: string }> => {
        try {
            const res = await fetch(`${url}/health`, { method: 'GET' })
            return { ok: res.ok }
        } catch (e) {
            return { ok: false, error: e instanceof Error ? e.message : undefined }
        }
    }, [])

    const waitForHealthy = useCallback(async (
        url: string,
        attempts = 30,
        intervalMs = 2000
    ): Promise<boolean> => {
        for (let i = 0; i < attempts; i++) {
            try {
                const res = await fetch(`${url}/health`)
                if (res.ok) return true
            } catch {
                // health endpoint not ready yet
            }
            await new Promise(r => setTimeout(r, intervalMs))
        }
        return false
    }, [])

    return { checkHealth, waitForHealthy }
}