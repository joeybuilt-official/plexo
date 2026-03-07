/**
 * AI Provider Credentials — encrypted storage layer.
 *
 * GET  /api/workspaces/:id/ai-providers
 *   Returns the full aiProviders config but with all apiKey / oauthToken values
 *   redacted (replaced with sentinel "configured" | null). Safe to return to the UI.
 *
 * PUT  /api/workspaces/:id/ai-providers
 *   Accepts the full aiProviders blob. Any provider entry that contains a
 *   non-sentinel apiKey or oauthToken value is encrypted via AES-256-GCM before
 *   being written into workspaces.settings.aiProviders.
 *
 * The on-disk shape inside workspaces.settings.aiProviders is identical to
 * the pre-existing format, except apiKey / oauthToken values are replaced with
 * their encrypted equivalents (same iv.ciphertext.authTag base64url format).
 * This lets agent-loop.ts decrypt them transparently.
 */
import { Router, type Router as RouterType } from 'express'
import { db, eq, and } from '@plexo/db'
import { workspaces, workspaceKeyShares } from '@plexo/db'
import { encrypt, decrypt } from '../crypto.js'
import { logger } from '../logger.js'

export const aiProviderCredsRouter: RouterType = Router({ mergeParams: true })

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Sentinel value written back to clients in place of real key values.
const CONFIGURED_SENTINEL = '__configured__'

// Detect whether a value is already our encrypted ciphertext (iv.ct.tag format).
function isEncrypted(v: string): boolean {
    const parts = v.split('.')
    return parts.length === 3 && parts.every((p) => p.length > 0)
}

type ProviderEntry = {
    apiKey?: string
    oauthToken?: string
    selectedModel?: string
    defaultModel?: string
    baseUrl?: string
    status?: string
    enabled?: boolean
    keySource?: { workspaceId: string; workspaceName?: string }
    [key: string]: unknown
}

type AIProvidersBlob = {
    primary?: string
    primaryProvider?: string
    fallbackOrder?: string[]
    fallbackChain?: string[]
    providers?: Record<string, ProviderEntry>
    [key: string]: unknown
}

/** Encrypt sensitive fields in-place (mutates). */
function encryptProviders(blob: AIProvidersBlob, workspaceId: string): AIProvidersBlob {
    const providers = blob.providers ?? {}
    const encrypted: Record<string, ProviderEntry> = {}

    for (const [key, entry] of Object.entries(providers)) {
        const e: ProviderEntry = { ...entry }

        if (e.apiKey && e.apiKey !== CONFIGURED_SENTINEL && !isEncrypted(e.apiKey)) {
            e.apiKey = encrypt(e.apiKey, workspaceId)
        }
        if (e.oauthToken && e.oauthToken !== CONFIGURED_SENTINEL && !isEncrypted(e.oauthToken)) {
            e.oauthToken = encrypt(e.oauthToken, workspaceId)
        }

        encrypted[key] = e
    }

    return { ...blob, providers: encrypted }
}

/** Decrypt sensitive fields in-place (mutates). Returns decrypted blob. */
function decryptProviders(blob: AIProvidersBlob, workspaceId: string): AIProvidersBlob {
    const providers = blob.providers ?? {}
    const decrypted: Record<string, ProviderEntry> = {}

    for (const [key, entry] of Object.entries(providers)) {
        const e: ProviderEntry = { ...entry }

        if (e.apiKey && isEncrypted(e.apiKey)) {
            try { e.apiKey = decrypt(e.apiKey, workspaceId) } catch { /* leave as-is */ }
        }
        if (e.oauthToken && isEncrypted(e.oauthToken)) {
            try { e.oauthToken = decrypt(e.oauthToken, workspaceId) } catch { /* leave as-is */ }
        }

        decrypted[key] = e
    }

    return { ...blob, providers: decrypted }
}

/** Redact sensitive fields for client responses. Never return real key values. */
function redactProviders(blob: AIProvidersBlob): AIProvidersBlob {
    const providers = blob.providers ?? {}
    const redacted: Record<string, ProviderEntry> = {}

    for (const [key, entry] of Object.entries(providers)) {
        const e: ProviderEntry = { ...entry }
        if (e.apiKey) e.apiKey = CONFIGURED_SENTINEL
        if (e.oauthToken) e.oauthToken = CONFIGURED_SENTINEL
        redacted[key] = e
    }

    return { ...blob, providers: redacted }
}

// ── GET /api/workspaces/:id/ai-providers ─────────────────────────────────────

aiProviderCredsRouter.get('/', async (req, res) => {
    const { id } = req.params as { id: string }
    if (!UUID_RE.test(id)) {
        res.status(400).json({ error: { code: 'INVALID_ID', message: 'Valid UUID required' } })
        return
    }

    try {
        const [ws] = await db
            .select({ settings: workspaces.settings })
            .from(workspaces)
            .where(eq(workspaces.id, id))
            .limit(1)

        if (!ws) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Workspace not found' } })
            return
        }

        const blob = ((ws.settings as Record<string, unknown>)?.aiProviders ?? {}) as AIProvidersBlob
        // Return redacted — clients see presence (sentinel) not values
        res.json({ aiProviders: redactProviders(blob) })
    } catch (err) {
        logger.error({ err, id }, 'GET ai-providers failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to load AI providers' } })
    }
})

// ── PUT /api/workspaces/:id/ai-providers ─────────────────────────────────────

aiProviderCredsRouter.put('/', async (req, res) => {
    const { id } = req.params as { id: string }
    if (!UUID_RE.test(id)) {
        res.status(400).json({ error: { code: 'INVALID_ID', message: 'Valid UUID required' } })
        return
    }

    const incoming = req.body as AIProvidersBlob
    if (!incoming || typeof incoming !== 'object') {
        res.status(400).json({ error: { code: 'INVALID_BODY', message: 'AI providers object required' } })
        return
    }

    try {
        // Read current settings for merge
        const [ws] = await db
            .select({ settings: workspaces.settings })
            .from(workspaces)
            .where(eq(workspaces.id, id))
            .limit(1)

        if (!ws) {
            res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Workspace not found' } })
            return
        }

        const currentSettings = (ws.settings ?? {}) as Record<string, unknown>
        const currentBlob = (currentSettings.aiProviders ?? {}) as AIProvidersBlob

        // Strip sentinel values from incoming: if a provider's key is the sentinel,
        // keep the existing encrypted value instead of overwriting with the sentinel.
        const merged: AIProvidersBlob = { ...currentBlob, ...incoming }

        if (incoming.providers) {
            const currentProviders = currentBlob.providers ?? {}
            const mergedProviders: Record<string, ProviderEntry> = {}

            for (const [key, entry] of Object.entries(incoming.providers)) {
                const current = currentProviders[key] ?? {}
                const e: ProviderEntry = { ...current, ...entry }

                // If the incoming value is the sentinel, restore the stored encrypted value
                if (e.apiKey === CONFIGURED_SENTINEL) {
                    e.apiKey = (current as ProviderEntry).apiKey
                }
                // '__CLEAR__' means the user explicitly removed the key
                if (e.apiKey === '__CLEAR__') {
                    delete e.apiKey
                    e.status = 'unconfigured'
                }
                if (e.oauthToken === CONFIGURED_SENTINEL) {
                    e.oauthToken = (current as ProviderEntry).oauthToken
                }
                if (e.oauthToken === '__CLEAR__') {
                    delete e.oauthToken
                    e.status = 'unconfigured'
                }

                mergedProviders[key] = e
            }

            merged.providers = mergedProviders
        }

        // Encrypt any plaintext credentials before persisting
        const toWrite = encryptProviders(merged, id)

        const newSettings = { ...currentSettings, aiProviders: toWrite }
        await db.update(workspaces).set({ settings: newSettings }).where(eq(workspaces.id, id))

        const providerCount = Object.keys(toWrite.providers ?? {}).length
        logger.info({ workspaceId: id, providers: providerCount }, 'AI provider credentials updated (encrypted)')
        res.json({ ok: true })
    } catch (err) {
        logger.error({ err, id }, 'PUT ai-providers failed')
        res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to save AI providers' } })
    }
})

// ── Exported helpers for agent-loop.ts and health.ts ─────────────────────────

/**
 * Read and decrypt the aiProviders blob for a workspace.
 * For providers with a keySource (borrowed), verifies the share still exists
 * in workspace_key_shares, then decrypts from the source workspace.
 * Returns null if not configured or if ENCRYPTION_SECRET is missing or wrong.
 */
export async function loadDecryptedAIProviders(workspaceId: string): Promise<AIProvidersBlob | null> {
    try {
        const [ws] = await db
            .select({ settings: workspaces.settings })
            .from(workspaces)
            .where(eq(workspaces.id, workspaceId))
            .limit(1)

        const blob = ((ws?.settings as Record<string, unknown>)?.aiProviders ?? null) as AIProvidersBlob | null
        if (!blob) return null

        // Decrypt locally-stored credentials first
        const decrypted = decryptProviders(blob, workspaceId)

        // Resolve borrowed keys — providers with keySource need the source workspace's key
        const providers = decrypted.providers ?? {}
        for (const [providerKey, entry] of Object.entries(providers)) {
            if (!entry?.keySource?.workspaceId) continue

            const sourceWsId = entry.keySource.workspaceId

            // Verify the share still exists (not revoked)
            const [shareRow] = await db
                .select({ id: workspaceKeyShares.id })
                .from(workspaceKeyShares)
                .where(and(
                    eq(workspaceKeyShares.sourceWsId, sourceWsId),
                    eq(workspaceKeyShares.targetWsId, workspaceId),
                    eq(workspaceKeyShares.providerKey, providerKey),
                ))
                .limit(1)

            if (!shareRow) {
                // Share was revoked — treat as unconfigured
                logger.warn({ workspaceId, providerKey, sourceWsId }, 'key-share: share not found (revoked?) — treating as unconfigured')
                providers[providerKey] = { ...entry, status: 'unconfigured' }
                delete providers[providerKey]!.apiKey
                delete providers[providerKey]!.oauthToken
                continue
            }

            // Decrypt from the source workspace (uses source workspace ID as encryption context)
            try {
                const [srcWs] = await db
                    .select({ settings: workspaces.settings })
                    .from(workspaces)
                    .where(eq(workspaces.id, sourceWsId))
                    .limit(1)

                const srcBlob = ((srcWs?.settings as Record<string, unknown>)?.aiProviders ?? null) as AIProvidersBlob | null
                if (!srcBlob) {
                    logger.warn({ workspaceId, providerKey, sourceWsId }, 'key-share: source workspace has no aiProviders blob')
                    continue
                }

                const srcDecrypted = decryptProviders(srcBlob, sourceWsId)
                const srcProvider = srcDecrypted.providers?.[providerKey]

                if (srcProvider?.apiKey) {
                    // Inject the source key into this provider's entry — in-memory only
                    providers[providerKey] = { ...entry, apiKey: srcProvider.apiKey, status: 'configured' }
                    logger.info({ workspaceId, providerKey, sourceWsId }, 'key-share: borrowed key resolved ✓')
                } else {
                    logger.warn({ workspaceId, providerKey, sourceWsId }, 'key-share: source workspace has no key for this provider')
                }
            } catch (err) {
                logger.error({ err, workspaceId, providerKey, sourceWsId }, 'key-share: failed to decrypt borrowed key')
            }
        }

        return { ...decrypted, providers }
    } catch (err) {
        logger.error({ err, workspaceId }, 'loadDecryptedAIProviders failed')
        return null
    }
}
