// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

// FUN-034 — Artifact cleanup handled by cron job in apps/api/src/cron.ts (runArtifactCleanup)

/**
 * Asset storage client — Phase C.
 *
 * Uploads agent-produced assets to S3-compatible storage (MinIO in dev,
 * real S3/R2/B2 in production by swapping STORAGE_* env vars).
 *
 * Falls back to /tmp if env vars are not set — so local dev works
 * without running MinIO.
 */
import { S3Client, PutObjectCommand, GetObjectCommand, HeadBucketCommand, CreateBucketCommand, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { readFileSync, promises as fsPromises } from 'node:fs'
import path, { join } from 'node:path'
import { Readable } from 'node:stream'
import { lookup as mimeLookup } from 'mime-types'

// ── Config ─────────────────────────────────────────────────────────────────────

const ENDPOINT = process.env.STORAGE_ENDPOINT ?? ''
const ACCESS_KEY = process.env.STORAGE_ACCESS_KEY ?? ''
const SECRET_KEY = process.env.STORAGE_SECRET_KEY ?? ''
const BUCKET = process.env.STORAGE_BUCKET ?? 'plexo-assets'

const isConfigured = !!ENDPOINT && !!ACCESS_KEY && !!SECRET_KEY

let _client: S3Client | null = null

function getClient(): S3Client {
    if (!_client) {
        _client = new S3Client({
            endpoint: ENDPOINT,
            region: 'us-east-1', // MinIO ignores region but S3 SDK requires it
            credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
            forcePathStyle: true, // Required for MinIO / non-AWS S3
        })
    }
    return _client
}

// ── Bucket init ────────────────────────────────────────────────────────────────

let _bucketChecked = false

async function ensureBucket(): Promise<void> {
    if (_bucketChecked || !isConfigured) return
    const s3 = getClient()
    try {
        await s3.send(new HeadBucketCommand({ Bucket: BUCKET }))
    } catch {
        // Bucket doesn't exist — create it
        await s3.send(new CreateBucketCommand({ Bucket: BUCKET }))
    }
    _bucketChecked = true
}

// ── Public API ─────────────────────────────────────────────────────────────────

export interface UploadResult {
    key: string
    /** Pre-signed download URL valid for 1 hour (or local file path in fallback mode) */
    url: string
    bytes: number
}

/**
 * Upload a file from the local /tmp staging area to storage.
 * key format: tasks/{taskId}/{filename}
 */
export async function uploadAsset(params: {
    taskId: string
    filename: string
    contentType?: string
}): Promise<UploadResult> {
    const { taskId, filename } = params
    const localPath = `/tmp/plexo-assets/${taskId}/${filename}`
    const key = `tasks/${taskId}/${filename}`
    const contentType = params.contentType ?? (mimeLookup(filename) || 'application/octet-stream')

    if (!isConfigured) {
        // Fallback — return local path directly (CI/local dev without MinIO)
        return { key, url: `file://${localPath}`, bytes: 0 }
    }

    await ensureBucket()

    const body = readFileSync(localPath)
    const s3 = getClient()
    await s3.send(new PutObjectCommand({
        Bucket: BUCKET,
        Key: key,
        Body: body,
        ContentType: contentType,
    }))

    const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: key }), { expiresIn: 3600 })

    return { key, url, bytes: body.length }
}

/**
 * Upload raw content (string or Buffer) directly — no local staging needed.
 */
export async function uploadContent(params: {
    taskId: string
    filename: string
    content: string | Buffer
    contentType?: string
}): Promise<UploadResult> {
    const { taskId, filename, content } = params
    const key = `tasks/${taskId}/${filename}`
    const contentType = params.contentType ?? (mimeLookup(filename) || 'text/plain')

    if (!isConfigured) {
        return { key, url: `inline://${key}`, bytes: typeof content === 'string' ? content.length : content.byteLength }
    }

    await ensureBucket()

    const body = typeof content === 'string' ? Buffer.from(content, 'utf8') : content
    const s3 = getClient()
    await s3.send(new PutObjectCommand({
        Bucket: BUCKET,
        Key: key,
        Body: body,
        ContentType: contentType,
    }))

    const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: key }), { expiresIn: 3600 })
    return { key, url, bytes: body.byteLength }
}

/**
 * Get a fresh pre-signed download URL for an existing key.
 */
export async function getDownloadUrl(key: string, expiresIn = 3600): Promise<string> {
    if (!isConfigured) return `file:///tmp/plexo-assets/${key.replace('tasks/', '')}`
    const s3 = getClient()
    return getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: key }), { expiresIn })
}

/**
 * Upload raw content with an arbitrary storage key prefix.
 * Used for memory attachments, chat files, etc.
 */
export async function uploadToKey(params: {
    key: string
    content: Buffer
    contentType?: string
}): Promise<UploadResult> {
    const { key, content } = params
    const contentType = params.contentType ?? 'application/octet-stream'

    if (!isConfigured) {
        return { key, url: `inline://${key}`, bytes: content.byteLength }
    }

    await ensureBucket()

    const s3 = getClient()
    await s3.send(new PutObjectCommand({
        Bucket: BUCKET,
        Key: key,
        Body: content,
        ContentType: contentType,
    }))

    const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: key }), { expiresIn: 3600 })
    return { key, url, bytes: content.byteLength }
}

/**
 * Fetch raw bytes by storage key. Mirror of uploadToKey — returns a Buffer
 * regardless of whether the underlying store is S3/MinIO or filesystem
 * fallback. Throws on not-found; caller decides retry behavior.
 */
export async function getByKey(key: string): Promise<Buffer> {
    if (!isConfigured) {
        const baseDir = path.resolve('/tmp/plexo-assets')
        const resolved = path.resolve(baseDir, key)
        if (!resolved.startsWith(baseDir + path.sep) && resolved !== baseDir) {
            throw new Error(`storage.getByKey: path traversal blocked for key=${key}`)
        }
        return fsPromises.readFile(resolved)
    }

    await ensureBucket()

    const s3 = getClient()
    const out = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }))
    const body = out.Body
    if (!body) throw new Error(`getByKey: empty body for key ${key}`)

    // Body is a Node stream in node runtime — collect into a Buffer.
    if (body instanceof Readable) {
        const chunks: Buffer[] = []
        for await (const chunk of body) {
            chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk))
        }
        return Buffer.concat(chunks)
    }
    // Fallback for environments where Body is a web ReadableStream / Blob-ish
    const anyBody = body as unknown as { transformToByteArray?: () => Promise<Uint8Array> }
    if (typeof anyBody.transformToByteArray === 'function') {
        const arr = await anyBody.transformToByteArray()
        return Buffer.from(arr)
    }
    throw new Error('getByKey: unsupported S3 Body type')
}

/**
 * Delete all S3 objects under a given key prefix.
 * Returns the number of objects deleted (0 if storage not configured or prefix empty).
 * Handles pagination for prefixes with >1000 objects.
 */
export async function deleteByPrefix(prefix: string): Promise<number> {
    if (!isConfigured || !prefix) return 0

    await ensureBucket()
    const s3 = getClient()
    let deleted = 0
    let continuationToken: string | undefined

    do {
        const listed = await s3.send(new ListObjectsV2Command({
            Bucket: BUCKET,
            Prefix: prefix,
            ContinuationToken: continuationToken,
        }))

        if (!listed.Contents?.length) break

        await s3.send(new DeleteObjectsCommand({
            Bucket: BUCKET,
            Delete: { Objects: listed.Contents.map(o => ({ Key: o.Key! })) },
        }))

        deleted += listed.Contents.length
        continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined
    } while (continuationToken)

    return deleted
}

export { BUCKET, isConfigured }
