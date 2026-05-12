// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Gmail API client helpers shared between the channels POST baseline path
 * and the gmail polling worker.
 *
 * Centralizes:
 *  - Decrypt + parse credentials from installed_connections
 *  - OAuth refresh on 401 / near-expiry
 *  - users.getProfile fetch (used to baseline historyId)
 */

import { db, eq } from '@plexo/db'
import { installedConnections } from '@plexo/db'
import { decrypt, encrypt } from '../crypto.js'
import { logger } from '../logger.js'

export interface GmailCredentials {
    access_token: string
    refresh_token: string | null
    expires_at: string | null
    email?: string
    scope?: string
}

export interface GmailProfile {
    emailAddress: string
    historyId: string
}

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'

function isExpired(expiresAt: string | null): boolean {
    if (!expiresAt) return false
    const ts = Date.parse(expiresAt)
    if (Number.isNaN(ts)) return false
    return ts - Date.now() < 60_000
}

export async function loadGmailCredentials(
    connectionId: string,
    workspaceId: string,
): Promise<GmailCredentials | null> {
    const [row] = await db.select({
        credentials: installedConnections.credentials,
    }).from(installedConnections)
        .where(eq(installedConnections.id, connectionId))
        .limit(1)

    if (!row) return null
    const raw = row.credentials as Record<string, unknown>
    if (!raw.encrypted) return null
    try {
        const decrypted = decrypt(raw.encrypted as string, workspaceId)
        return JSON.parse(decrypted) as GmailCredentials
    } catch (err) {
        logger.warn({ err, connectionId }, 'gmail-client: failed to decrypt credentials')
        return null
    }
}

/** Refresh + persist the credentials. Returns the refreshed creds on success,
 *  null on refresh failure. Persistence failures are logged but do not nullify
 *  the result — the in-memory creds are still usable for the current request. */
export async function refreshAndPersistCredentials(
    connectionId: string,
    workspaceId: string,
    creds: GmailCredentials,
): Promise<GmailCredentials | null> {
    const refreshed = await refreshAccessToken(creds)
    if (!refreshed) return null
    await persistRefreshedCredentials(connectionId, workspaceId, refreshed).catch((err) =>
        logger.warn({ err, connectionId }, 'gmail-client: failed to persist refreshed token'),
    )
    return refreshed
}

async function refreshAccessToken(creds: GmailCredentials): Promise<GmailCredentials | null> {
    if (!creds.refresh_token) return null
    const clientId = process.env.GOOGLE_CLIENT_ID
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET
    if (!clientId || !clientSecret) {
        logger.warn('gmail-client: GOOGLE_CLIENT_ID/SECRET not set — cannot refresh')
        return null
    }
    const res = await fetch(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            refresh_token: creds.refresh_token,
            grant_type: 'refresh_token',
        }).toString(),
    })
    if (!res.ok) {
        logger.warn({ status: res.status }, 'gmail-client: refresh failed')
        return null
    }
    const data = await res.json() as Record<string, unknown>
    const accessToken = data.access_token as string | undefined
    if (!accessToken) return null
    return {
        ...creds,
        access_token: accessToken,
        expires_at: data.expires_in
            ? new Date(Date.now() + Number(data.expires_in) * 1000).toISOString()
            : null,
    }
}

async function persistRefreshedCredentials(
    connectionId: string,
    workspaceId: string,
    creds: GmailCredentials,
): Promise<void> {
    const encrypted = { encrypted: encrypt(JSON.stringify(creds), workspaceId) }
    await db.update(installedConnections)
        .set({ credentials: encrypted, lastVerifiedAt: new Date() })
        .where(eq(installedConnections.id, connectionId))
}

/**
 * Fetch the Gmail profile for the authenticated user (the connected account).
 * Refreshes the token on 401 and persists the new credentials.
 *
 * Returns null on any non-recoverable failure (caller should leave lastHistoryId
 * unset and let the next poll cycle baseline).
 */
export async function fetchGmailProfile(
    connectionId: string,
    workspaceId: string,
): Promise<GmailProfile | null> {
    let creds = await loadGmailCredentials(connectionId, workspaceId)
    if (!creds) return null

    if (isExpired(creds.expires_at)) {
        const refreshed = await refreshAndPersistCredentials(connectionId, workspaceId, creds)
        if (refreshed) creds = refreshed
    }

    let res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
        headers: { Authorization: `Bearer ${creds.access_token}` },
    })

    if (res.status === 401 && creds.refresh_token) {
        const refreshed = await refreshAndPersistCredentials(connectionId, workspaceId, creds)
        if (!refreshed) return null
        creds = refreshed
        res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
            headers: { Authorization: `Bearer ${creds.access_token}` },
        })
    }

    if (!res.ok) {
        logger.warn({ status: res.status, connectionId }, 'gmail-client: profile fetch failed')
        return null
    }

    const data = await res.json() as Record<string, unknown>
    const emailAddress = data.emailAddress as string | undefined
    const historyId = data.historyId as string | undefined
    if (!emailAddress || !historyId) return null
    return { emailAddress, historyId }
}
