// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * SWR client wrappers for the Phase 3a SCL controls UI.
 *
 * Persists to `workspaces.intelligence_settings.scl.*` via the existing
 * scl router. Mirrors the intelligence-client.ts module from Phase 2a/2b
 * so the cache key namespace stays consistent.
 */

import useSWR from 'swr'
import { jsonFetcher } from './swr'

export interface SclSettingsView {
    enabled: boolean
    driftThreshold: number
    expandDepth: number
    expandWidth: number
    domainRegions: string[] | null
    piiScrubEnabled: boolean
}

export interface SclSettingsBounds {
    driftThreshold: { min: number; max: number }
    expandDepth: { min: number; max: number }
    expandWidth: { min: number; max: number }
}

export interface SclSettingsResponse {
    settings: SclSettingsView
    defaults: SclSettingsView
    bounds: SclSettingsBounds
}

export interface DomainRegionRow {
    region: string
    count: number
}

export interface DomainRegionsResponse {
    regions: DomainRegionRow[]
}

export interface PiiPreviewResponse {
    available: boolean
    reason?: string
    latest?: {
        id: string
        model: string
        inputPattern: string | null
        outputPattern: string | null
        createdAt: string
    }
    sample?: { original: string; scrubbed: string }
}

// ── Hook keys ────────────────────────────────────────────────────────────

export function sclSettingsKey(workspaceId: string | null | undefined): string | null {
    return workspaceId ? `/api/v1/scl/settings?workspaceId=${workspaceId}` : null
}

export function sclDomainRegionsKey(workspaceId: string | null | undefined): string | null {
    return workspaceId ? `/api/v1/scl/domain-regions?workspaceId=${workspaceId}` : null
}

export function sclPiiPreviewKey(workspaceId: string | null | undefined): string | null {
    return workspaceId ? `/api/v1/scl/pii-preview?workspaceId=${workspaceId}` : null
}

// ── Hooks ────────────────────────────────────────────────────────────────

export function useSclSettings(workspaceId: string | null | undefined) {
    return useSWR<SclSettingsResponse>(
        sclSettingsKey(workspaceId),
        jsonFetcher,
        { refreshInterval: 0, revalidateOnFocus: true, dedupingInterval: 5_000 },
    )
}

export function useSclDomainRegions(workspaceId: string | null | undefined) {
    return useSWR<DomainRegionsResponse>(
        sclDomainRegionsKey(workspaceId),
        jsonFetcher,
        { refreshInterval: 0, revalidateOnFocus: false, dedupingInterval: 30_000 },
    )
}

export function useSclPiiPreview(workspaceId: string | null | undefined) {
    return useSWR<PiiPreviewResponse>(
        sclPiiPreviewKey(workspaceId),
        jsonFetcher,
        { refreshInterval: 0, revalidateOnFocus: false, dedupingInterval: 30_000 },
    )
}

// ── Mutations ────────────────────────────────────────────────────────────

export async function patchSclSettings(
    workspaceId: string,
    body: Partial<SclSettingsView>,
): Promise<{ ok: boolean; settings: SclSettingsView }> {
    const res = await fetch('/api/v1/scl/settings', {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, ...body }),
    })
    if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`PATCH scl settings failed (${res.status}): ${text.slice(0, 200)}`)
    }
    return res.json()
}

// ── Phase 3b — Inboxes + attractors ──────────────────────────────────────

export type DriftStatus = 'pending' | 'confirmed' | 'rejected'

export interface DriftWarningView {
    id: string
    attractorId: string
    attractorLabel: string
    semanticDistance: number
    threshold: number
    source: string
    status: DriftStatus
    createdAt: string
    resolvedAt: string | null
}

export interface DriftWarningsResponse {
    warnings: DriftWarningView[]
    counts: Record<string, number>
}

export type RsiStatus = 'pending' | 'approved' | 'rejected'
export type RsiRisk = 'low' | 'medium' | 'high'

export interface RsiProposalView {
    id: string
    anomalyType: string
    hypothesis: string
    proposedChange: Record<string, unknown>
    risk: RsiRisk
    status: RsiStatus
    approvedAt: string | null
    rejectedAt: string | null
    createdAt: string
}

export interface RsiProposalsResponse {
    proposals: RsiProposalView[]
    counts: Record<string, number>
}

export interface AttractorListItem {
    id: string
    sourceLogId: string | null
    domainRegion: string | null
    createdAt: string
    updatedAt: string | null
}

export interface AttractorListResponse {
    attractors: AttractorListItem[]
    total: number
}

export interface AttractorDetail extends AttractorListItem {
    graphJson: Record<string, unknown>
    mindsetObject: Record<string, unknown> | null
}

export interface AttractorDetailResponse {
    attractor: AttractorDetail
}

// ── Hook keys ────────────────────────────────────────────────────────────

export function driftWarningsKey(workspaceId: string | null | undefined, status: DriftStatus | 'all' = 'pending'): string | null {
    return workspaceId ? `/api/v1/scl/drift-warnings?workspaceId=${workspaceId}&status=${status}` : null
}

export function rsiProposalsKey(workspaceId: string | null | undefined, status: RsiStatus | 'all' = 'pending'): string | null {
    return workspaceId ? `/api/v1/scl/rsi-proposals?workspaceId=${workspaceId}&status=${status}` : null
}

export function attractorsKey(
    workspaceId: string | null | undefined,
    opts?: { domain?: string; query?: string; limit?: number },
): string | null {
    if (!workspaceId) return null
    const params = new URLSearchParams({ workspaceId })
    if (opts?.domain) params.set('domain', opts.domain)
    if (opts?.query) params.set('query', opts.query)
    if (opts?.limit) params.set('limit', String(opts.limit))
    return `/api/v1/scl/attractors?${params.toString()}`
}

export function attractorDetailKey(
    workspaceId: string | null | undefined,
    id: string | null | undefined,
): string | null {
    return workspaceId && id ? `/api/v1/scl/attractors/${id}?workspaceId=${workspaceId}` : null
}

// ── Hooks ────────────────────────────────────────────────────────────────

export function useDriftWarnings(
    workspaceId: string | null | undefined,
    status: DriftStatus | 'all' = 'pending',
) {
    return useSWR<DriftWarningsResponse>(
        driftWarningsKey(workspaceId, status),
        jsonFetcher,
        { refreshInterval: 30_000, revalidateOnFocus: true, dedupingInterval: 5_000 },
    )
}

export function useRsiProposals(
    workspaceId: string | null | undefined,
    status: RsiStatus | 'all' = 'pending',
) {
    return useSWR<RsiProposalsResponse>(
        rsiProposalsKey(workspaceId, status),
        jsonFetcher,
        { refreshInterval: 30_000, revalidateOnFocus: true, dedupingInterval: 5_000 },
    )
}

export function useAttractors(
    workspaceId: string | null | undefined,
    opts?: { domain?: string; query?: string; limit?: number },
) {
    return useSWR<AttractorListResponse>(
        attractorsKey(workspaceId, opts),
        jsonFetcher,
        { refreshInterval: 0, revalidateOnFocus: false, dedupingInterval: 30_000 },
    )
}

export function useAttractor(
    workspaceId: string | null | undefined,
    id: string | null | undefined,
) {
    return useSWR<AttractorDetailResponse>(
        attractorDetailKey(workspaceId, id),
        jsonFetcher,
        { refreshInterval: 0, revalidateOnFocus: false, dedupingInterval: 60_000 },
    )
}

// ── Mutations ────────────────────────────────────────────────────────────

async function postWithWorkspace(url: string, workspaceId: string): Promise<Response> {
    return fetch(url, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId }),
    })
}

export async function approveDriftWarning(workspaceId: string, id: string): Promise<{ ok: boolean; status: 'confirmed' }> {
    const res = await postWithWorkspace(`/api/v1/scl/drift-warnings/${id}/approve`, workspaceId)
    if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`Approve drift failed (${res.status}): ${text.slice(0, 200)}`)
    }
    return res.json()
}

export async function rejectDriftWarning(workspaceId: string, id: string): Promise<{ ok: boolean; status: 'rejected' }> {
    const res = await postWithWorkspace(`/api/v1/scl/drift-warnings/${id}/reject`, workspaceId)
    if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`Reject drift failed (${res.status}): ${text.slice(0, 200)}`)
    }
    return res.json()
}

export async function approveRsiProposal(workspaceId: string, id: string): Promise<{ ok: boolean; status: 'approved' }> {
    const res = await postWithWorkspace(`/api/v1/scl/rsi-proposals/${id}/approve`, workspaceId)
    if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`Approve RSI failed (${res.status}): ${text.slice(0, 200)}`)
    }
    return res.json()
}

export async function rejectRsiProposal(workspaceId: string, id: string): Promise<{ ok: boolean; status: 'rejected' }> {
    const res = await postWithWorkspace(`/api/v1/scl/rsi-proposals/${id}/reject`, workspaceId)
    if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`Reject RSI failed (${res.status}): ${text.slice(0, 200)}`)
    }
    return res.json()
}
