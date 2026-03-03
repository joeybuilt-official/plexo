/**
 * Redis-backed PKCE state store for Anthropic OAuth flow.
 *
 * Each OAuth start generates a state token and code verifier.
 * Stored in Redis with a 10-minute TTL, consumed atomically on callback
 * to prevent replay and ensure PKCE challenge integrity.
 */
import { createClient, type RedisClientType } from 'redis'

const PKCE_TTL_SECONDS = 600 // 10 minutes

let _redis: RedisClientType | null = null

async function getRedis(): Promise<RedisClientType> {
    if (!_redis) {
        _redis = createClient({
            url: process.env.REDIS_URL ?? 'redis://localhost:6379',
        }) as RedisClientType
        _redis.on('error', (err: Error) => {
            console.error('[pkce-store] Redis error:', err.message)
        })
        await _redis.connect()
    }
    return _redis
}

export interface PkceRecord {
    codeVerifier: string
    workspaceId: string
    redirectUri: string
    createdAt: number
}

function key(state: string): string {
    return `pkce:${state}`
}

export async function storePkce(state: string, record: PkceRecord): Promise<void> {
    const redis = await getRedis()
    await redis.setEx(key(state), PKCE_TTL_SECONDS, JSON.stringify(record))
}

/** Retrieves and atomically deletes the PKCE record (one-time use) */
export async function consumePkce(state: string): Promise<PkceRecord | null> {
    const redis = await getRedis()
    const k = key(state)

    // Lua: GET + DEL atomic, one round-trip
    const result = await redis.eval(
        `local v = redis.call('GET', KEYS[1])
     if v then redis.call('DEL', KEYS[1]) end
     return v`,
        { keys: [k], arguments: [] },
    ) as string | null

    if (!result) return null
    try {
        return JSON.parse(result) as PkceRecord
    } catch {
        return null
    }
}

export async function hasPkce(state: string): Promise<boolean> {
    const redis = await getRedis()
    return (await redis.exists(key(state))) === 1
}
