// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * SWR client for provider-health alerts (Fix A).
 * Talks to /api/v1/workspaces/:id/provider-alerts.
 */

import useSWR from 'swr'
import { jsonFetcher } from './swr'

export interface BalanceExhaustedProvider {
    providerType: string
    nickname: string
    exhaustedAt: string
}

export interface ProviderAlertsResponse {
    balanceExhausted: BalanceExhaustedProvider[]
}

export function useProviderAlerts(workspaceId: string | null | undefined) {
    return useSWR<ProviderAlertsResponse>(
        workspaceId ? `/api/v1/workspaces/${workspaceId}/provider-alerts` : null,
        jsonFetcher,
        { refreshInterval: 60_000, revalidateOnFocus: true, dedupingInterval: 15_000 },
    )
}

export async function dismissProviderAlert(workspaceId: string, providerType: string): Promise<void> {
    const res = await fetch(
        `/api/v1/workspaces/${workspaceId}/provider-alerts/${encodeURIComponent(providerType)}/dismiss`,
        { method: 'POST', credentials: 'include', headers: { 'Accept': 'application/json' } },
    )
    if (!res.ok) throw new Error(`dismiss failed: ${res.status}`)
}
