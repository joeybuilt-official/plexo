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
import { invalidateIntrospectCache } from './introspect.js'

export const aiProviderCredsRouter: RouterType = Router({ mergeParams: true })

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Sentinel value written back to clients in place of real key values.
const CONFIGURED_SENTINEL = '__configured__'

// Detect whether a value is already our encrypted ciphertext (iv.ct.tag format).
function isEncrypted(v: string): boolean {
    const parts = v.split('.')
    return parts.length === 3 && parts.every((p) => p.length > 0)
}

type VaultEntry = {
    apiKey?: string
    baseUrl?: string
    status?: string
    keySource?: { workspaceId: string; workspaceName?: string }
}

type ArbiterEntry = {
    selectedModel?: string
    defaultModel?: string
    enabled?: boolean
}

type ProviderEntry = VaultEntry & ArbiterEntry & { [key: string]: unknown }

type AIProvidersBlob = {
    inferenceMode?: 'auto' | 'byok' | 'proxy' | 'override'
    primary?: string
    primaryProvider?: string
    fallbackOrder?: string[]
    fallbackChain?: string[]
    providers?: Record<string, ProviderEntry>
    [key: string]: unknown
}

type VaultBlob = Record<string, VaultEntry>

type ArbiterBlob = {
    inferenceMode?: 'auto' | 'byok' | 'proxy' | 'override'
    primaryProvider?: string
    fallbackChain?: string[]
    providers?: Record<string, ArbiterEntry>
}

export function getDecoupledSettings(workspaceId: string, settings: Record<string, unknown>): { vault: VaultBlob, arbiter: ArbiterBlob, migrated: boolean } {
    const isLegacy = !settings.vault && !settings.arbiter && !!settings.aiProviders
    let vault = (settings.vault ?? {}) as VaultBlob
    let arbiter = (settings.arbiter ?? {}) as ArbiterBlob

    if (isLegacy) {
        const legacy = settings.aiProviders as AIProvidersBlob
        arbiter = {
            inferenceMode: legacy.inferenceMode,
            primaryProvider: legacy.primary ?? legacy.primaryProvider,
            fallbackChain: legacy.fallbackOrder ?? legacy.fallbackChain ?? [],
            providers: {}
        }
        vault = {}
        const legacyProviders = legacy.providers ?? {}
        for (const [k, p] of Object.entries(legacyProviders)) {
            vault[k] = { apiKey: p.apiKey, baseUrl: p.baseUrl, status: p.status, keySource: p.keySource }
            arbiter.providers![k] = { selectedModel: p.selectedModel ?? p.defaultModel, enabled: p.enabled }
        }

        // Persist migration asynchronously
        const newSettings = { ...settings, vault, arbiter } as Record<string, unknown>
        delete newSettings.aiProviders
        db.update(workspaces).set({ settings: newSettings }).where(eq(workspaces.id, workspaceId)).catch(err => {
            logger.error({ err, workspaceId }, 'Failed to persist zero-downtime vault/arbiter migration')
        })
    }

    return { vault, arbiter, migrated: isLegacy }
}

function splitIntoDecoupled(blob: AIProvidersBlob): { vault: VaultBlob, arbiter: ArbiterBlob } {
    const vault: VaultBlob = {}
    const arbiter: ArbiterBlob = {
        inferenceMode: blob.inferenceMode,
        primaryProvider: blob.primary ?? blob.primaryProvider,
        fallbackChain: blob.fallbackOrder ?? blob.fallbackChain ?? [],
        providers: {}
    }
    const blobProviders = blob.providers ?? {}
    for (const [k, p] of Object.entries(blobProviders)) {
        vault[k] = { apiKey: p.apiKey, baseUrl: p.baseUrl, status: p.status, keySource: p.keySource }
        arbiter.providers![k] = { selectedModel: p.selectedModel ?? p.defaultModel, enabled: p.enabled }
    }
    return { vault, arbiter }
}

function mergeDecoupled(vault: VaultBlob, arbiter: ArbiterBlob): AIProvidersBlob {
    const merged: AIProvidersBlob = {
        inferenceMode: arbiter.inferenceMode,
        primaryProvider: arbiter.primaryProvider,
        fallbackChain: arbiter.fallbackChain,
        providers: {}
    }
    const keys = new Set([...Object.keys(vault), ...Object.keys(arbiter.providers ?? {})])
    for (const k of keys) {
        merged.providers![k] = {
            ...(vault[k] ?? {}),
            ...(arbiter.providers?.[k] ?? {})
        }
    }
    return merged
}

/** Encrypt sensitive fields in vault. */
function encryptVault(vault: VaultBlob, workspaceId: string): VaultBlob {
    const encrypted: VaultBlob = {}
    for (const [key, e] of Object.entries(vault)) {
        const out = { ...e }
        if (out.apiKey && out.apiKey !== CONFIGURED_SENTINEL && !isEncrypted(out.apiKey)) {
            out.apiKey = encrypt(out.apiKey, workspaceId)
        }
        encrypted[key] = out
    }
    return encrypted
}

/** Decrypt sensitive fields in vault. */
function decryptVault(vault: VaultBlob, workspaceId: string): VaultBlob {
    const decrypted: VaultBlob = {}
    for (const [key, e] of Object.entries(vault)) {
        const out = { ...e }
        if (out.apiKey && isEncrypted(out.apiKey)) {
            try { out.apiKey = decrypt(out.apiKey, workspaceId) } catch { /* leave as-is */ }
        }
        decrypted[key] = out
    }
    return decrypted
}

/** Redact sensitive fields. */
function redactVault(vault: VaultBlob): VaultBlob {
    const redacted: VaultBlob = {}
    for (const [key, e] of Object.entries(vault)) {
        const out = { ...e }
        if (out.apiKey) out.apiKey = CONFIGURED_SENTINEL
        redacted[key] = out
    }
    return redacted
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

        const rawSettings = ws.settings as Record<string, unknown>
        const { vault, arbiter } = getDecoupledSettings(id, rawSettings)
        
        // Return redacted — clients see presence (sentinel) not values
        res.json({ aiProviders: mergeDecoupled(redactVault(vault), arbiter) })
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
        const { vault: currentVault, arbiter: currentArbiter } = getDecoupledSettings(id, currentSettings)

        // incoming is AIProvidersBlob format. Merge it with current explicitly.
        const currentBlob = mergeDecoupled(currentVault, currentArbiter)
        const merged: AIProvidersBlob = { ...currentBlob, ...incoming }

        if (incoming.providers) {
            const currentProviders = currentBlob.providers ?? {}
            const mergedProviders: Record<string, ProviderEntry> = {}

            for (const [key, entry] of Object.entries(incoming.providers)) {
                const current = currentProviders[key] ?? {}
                const e: ProviderEntry = { ...current, ...entry }

                if (e.apiKey === CONFIGURED_SENTINEL) {
                    e.apiKey = (current as ProviderEntry).apiKey
                }
                if (e.apiKey === '__CLEAR__') {
                    delete e.apiKey
                    e.status = 'unconfigured'
                }

                mergedProviders[key] = e
            }

            merged.providers = mergedProviders
        }

        const { vault: mergedVault, arbiter: mergedArbiter } = splitIntoDecoupled(merged)

        // Encrypt any plaintext credentials before persisting
        const toWriteVault = encryptVault(mergedVault, id)

        const newSettings = { ...currentSettings, vault: toWriteVault, arbiter: mergedArbiter } as Record<string, unknown>
        delete newSettings.aiProviders
        await db.update(workspaces).set({ settings: newSettings }).where(eq(workspaces.id, id))

        const providerCount = Object.keys(toWriteVault).length
        logger.info({ workspaceId: id, providers: providerCount }, 'AI provider credentials updated (encrypted and decoupled)')
        // Invalidate the introspection cache so the Intelligence page shows fresh data
        void invalidateIntrospectCache(id)
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

        const settings = ws?.settings as Record<string, unknown> | null
        if (!settings) return null

        const { vault, arbiter } = getDecoupledSettings(workspaceId, settings)

        // Decrypt locally-stored credentials first
        const decryptedVault = decryptVault(vault, workspaceId)

        // Resolve borrowed keys
        for (const [providerKey, entry] of Object.entries(decryptedVault)) {
            if (!entry?.keySource?.workspaceId) continue

            const sourceWsId = entry.keySource.workspaceId

            // Verify the share still exists
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
                logger.warn({ workspaceId, providerKey, sourceWsId }, 'key-share: share not found (revoked?) — treating as unconfigured')
                decryptedVault[providerKey] = { ...entry, status: 'unconfigured' }
                delete decryptedVault[providerKey]!.apiKey
                continue
            }

            // Decrypt from the source workspace
            try {
                const [srcWs] = await db
                    .select({ settings: workspaces.settings })
                    .from(workspaces)
                    .where(eq(workspaces.id, sourceWsId))
                    .limit(1)

                const srcSettings = srcWs?.settings as Record<string, unknown> | null
                if (!srcSettings) continue

                const { vault: srcVault } = getDecoupledSettings(sourceWsId, srcSettings)
                const srcDecryptedVault = decryptVault(srcVault, sourceWsId)
                const srcProvider = srcDecryptedVault[providerKey]

                if (srcProvider?.apiKey) {
                    decryptedVault[providerKey] = { ...entry, apiKey: srcProvider.apiKey, status: 'configured' }
                    logger.info({ workspaceId, providerKey, sourceWsId }, 'key-share: borrowed key resolved ✓')
                } else {
                    logger.warn({ workspaceId, providerKey, sourceWsId }, 'key-share: source workspace has no key for this provider')
                }
            } catch (err) {
                logger.error({ err, workspaceId, providerKey, sourceWsId }, 'key-share: failed to decrypt borrowed key')
            }
        }

        return mergeDecoupled(decryptedVault, arbiter)
    } catch (err) {
        logger.error({ err, workspaceId }, 'loadDecryptedAIProviders failed')
        return null
    }
}
