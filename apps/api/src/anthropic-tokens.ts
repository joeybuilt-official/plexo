/**
 * Anthropic OAuth token persistence layer.
 *
 * Tokens are stored encrypted (AES-256-GCM) in the `installed_connections`
 * table under `credentials`. The `registryId` references the Anthropic
 * entry in `connections_registry`.
 *
 * Token shape stored in credentials (decrypted):
 *   { accessToken, refreshToken, expiresAt (ISO) }
 */
import { db, eq, and } from '@plexo/db'
import { installedConnections, connectionsRegistry } from '@plexo/db'
import { encrypt, decrypt } from './crypto.js'
import { refreshAnthropicToken } from '@plexo/agent/ai/anthropic-oauth'
import { logger } from './logger.js'

const ANTHROPIC_REGISTRY_ID = 'anthropic-claude'

// ── Types ────────────────────────────────────────────────────────────────────

export interface AnthropicTokenRecord {
    accessToken: string
    refreshToken: string | null
    expiresAt: string | null // ISO datetime
}

// ── Ensure Anthropic registry entry exists ───────────────────────────────────

let _registryBootstrapped = false

async function ensureRegistryEntry(): Promise<void> {
    if (_registryBootstrapped) return
    // Check if the row already exists before attempting a write —
    // avoids lock contention with concurrent reads when the row is already seeded.
    const existing = await db.select({ id: connectionsRegistry.id })
        .from(connectionsRegistry)
        .where(eq(connectionsRegistry.id, ANTHROPIC_REGISTRY_ID))
        .limit(1)
    if (existing.length === 0) {
        await db.insert(connectionsRegistry).values({
            id: ANTHROPIC_REGISTRY_ID,
            name: 'Anthropic Claude',
            description: 'Anthropic Claude API — API key or Claude.ai OAuth subscription',
            category: 'ai',
            logoUrl: 'https://anthropic.com/favicon.ico',
            authType: 'oauth2',
            isCore: true,
        }).onConflictDoNothing()
    }
    _registryBootstrapped = true
}

// ── Store ────────────────────────────────────────────────────────────────────

export async function storeAnthropicTokens(
    workspaceId: string,
    tokens: {
        access_token: string
        refresh_token?: string
        expires_in?: number
    },
): Promise<void> {
    await ensureRegistryEntry()

    const expiresAt = tokens.expires_in
        ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
        : null

    const record: AnthropicTokenRecord = {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token ?? null,
        expiresAt,
    }

    const encryptedCreds = encrypt(JSON.stringify(record), workspaceId)

    const existing = await db.select({ id: installedConnections.id })
        .from(installedConnections)
        .where(and(
            eq(installedConnections.workspaceId, workspaceId),
            eq(installedConnections.registryId, ANTHROPIC_REGISTRY_ID),
        ))
        .limit(1)

    if (existing.length > 0) {
        await db.update(installedConnections)
            .set({ credentials: { encrypted: encryptedCreds }, lastVerifiedAt: new Date(), status: 'active' })
            .where(eq(installedConnections.id, existing[0]!.id))
    } else {
        await db.insert(installedConnections).values({
            workspaceId,
            registryId: ANTHROPIC_REGISTRY_ID,
            name: 'Anthropic (Claude.ai OAuth)',
            credentials: { encrypted: encryptedCreds },
            scopesGranted: ['org:read', 'user:read', 'user:inference'],
            status: 'active',
            lastVerifiedAt: new Date(),
        })
    }

    logger.info({ workspaceId }, 'Anthropic OAuth tokens persisted')
}

// ── Retrieve (with auto-refresh) ─────────────────────────────────────────────

export async function getAnthropicTokens(
    workspaceId: string,
): Promise<AnthropicTokenRecord | null> {
    const [row] = await db.select({ credentials: installedConnections.credentials })
        .from(installedConnections)
        .where(and(
            eq(installedConnections.workspaceId, workspaceId),
            eq(installedConnections.registryId, ANTHROPIC_REGISTRY_ID),
        ))
        .limit(1)

    if (!row) return null

    const creds = row.credentials as { encrypted?: string }
    if (!creds.encrypted) return null

    let record: AnthropicTokenRecord
    try {
        record = JSON.parse(decrypt(creds.encrypted, workspaceId)) as AnthropicTokenRecord
    } catch (err) {
        logger.error({ err, workspaceId }, 'Failed to decrypt Anthropic tokens')
        return null
    }

    // Auto-refresh if expiring within 60 seconds
    if (record.expiresAt && record.refreshToken) {
        const expiresAt = new Date(record.expiresAt).getTime()
        if (expiresAt - Date.now() < 60_000) {
            try {
                const fresh = await refreshAnthropicToken(record.refreshToken)
                await storeAnthropicTokens(workspaceId, fresh)
                return {
                    accessToken: fresh.access_token,
                    refreshToken: fresh.refresh_token ?? record.refreshToken,
                    expiresAt: fresh.expires_in
                        ? new Date(Date.now() + fresh.expires_in * 1000).toISOString()
                        : null,
                }
            } catch (err) {
                logger.warn({ err, workspaceId }, 'Anthropic token refresh failed — using existing token')
            }
        }
    }

    return record
}

// ── Delete ───────────────────────────────────────────────────────────────────

export async function revokeAnthropicTokens(workspaceId: string): Promise<void> {
    await db.update(installedConnections)
        .set({ status: 'disconnected', credentials: {} })
        .where(and(
            eq(installedConnections.workspaceId, workspaceId),
            eq(installedConnections.registryId, ANTHROPIC_REGISTRY_ID),
        ))
    logger.info({ workspaceId }, 'Anthropic tokens revoked')
}
