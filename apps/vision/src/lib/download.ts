// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Model download + SHA-256 verification.
 *
 * Each model loader registers a `ModelArtifact` describing the expected
 * filename, SHA-256, primary CDN URL (Joeybuilt-hosted bucket when set via
 * MODELS_CDN_URL), and a fallback URL (HuggingFace / GitHub Release / the
 * upstream project host).
 *
 * The loaders call `ensureArtifact()` from their own lazy-init paths. This
 * module never bundles model bytes — files live in `MODEL_CACHE_DIR`
 * (default: `~/.plexo/vision/models/<modelId>/<filename>`).
 *
 * IMPORTANT: this is a bootstrap stub. The CLI entrypoint at the bottom is
 * deliberately a no-op when no artifacts are registered — Phase 4.2 will
 * actually run the downloads against real SHA-256s.
 */

import { createHash } from 'node:crypto'
import { mkdir, stat, writeFile, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { childLogger } from './logger.js'

const logger = childLogger('download')

export interface ModelArtifact {
    /** Logical model bundle, e.g. "openclip-vit-b-32". */
    modelId: string
    /** Local filename inside the model directory, e.g. "image.onnx". */
    filename: string
    /** Lowercase hex SHA-256 of the expected file. */
    sha256: string
    /**
     * Path relative to MODELS_CDN_URL (when set), e.g.
     * "openclip-vit-b-32/image.onnx". The CDN must mirror the same layout.
     */
    cdnPath: string
    /** Upstream fallback URL — used when MODELS_CDN_URL is unset / fails. */
    fallbackUrl: string
}

export function defaultCacheDir(): string {
    return process.env.MODEL_CACHE_DIR || join(homedir(), '.plexo', 'vision', 'models')
}

export function pathFor(artifact: ModelArtifact): string {
    return join(defaultCacheDir(), artifact.modelId, artifact.filename)
}

async function fileExists(p: string): Promise<boolean> {
    try {
        await stat(p)
        return true
    } catch {
        return false
    }
}

async function sha256File(p: string): Promise<string> {
    const buf = await readFile(p)
    return createHash('sha256').update(buf).digest('hex')
}

function urlsFor(artifact: ModelArtifact): string[] {
    const cdn = process.env.MODELS_CDN_URL
    const urls: string[] = []
    if (cdn) urls.push(`${cdn.replace(/\/$/, '')}/${artifact.cdnPath}`)
    urls.push(artifact.fallbackUrl)
    return urls
}

async function downloadOnce(url: string, dest: string): Promise<void> {
    logger.info({ url, dest }, 'Downloading model artifact')
    const res = await fetch(url, {
        redirect: 'follow',
        headers: { 'User-Agent': 'plexo-vision/0.1' },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
    const buf = Buffer.from(await res.arrayBuffer())
    await mkdir(dirname(dest), { recursive: true })
    await writeFile(dest, buf)
}

/**
 * Ensure the artifact exists on disk + matches its SHA-256. Downloads on
 * miss; throws on persistent verification failure.
 */
export async function ensureArtifact(artifact: ModelArtifact): Promise<string> {
    const dest = pathFor(artifact)
    if (await fileExists(dest)) {
        const actual = await sha256File(dest)
        if (actual === artifact.sha256) return dest
        logger.warn(
            { dest, expected: artifact.sha256, actual },
            'Cached artifact failed SHA-256 — redownloading',
        )
    }

    let lastErr: unknown = null
    for (const url of urlsFor(artifact)) {
        try {
            await downloadOnce(url, dest)
            const actual = await sha256File(dest)
            if (actual !== artifact.sha256) {
                throw new Error(
                    `SHA-256 mismatch for ${artifact.filename}: expected ${artifact.sha256}, got ${actual}`,
                )
            }
            return dest
        } catch (err) {
            lastErr = err
            logger.warn({ err, url }, 'Download attempt failed, trying next source')
        }
    }
    throw new Error(
        `Could not fetch ${artifact.modelId}/${artifact.filename}: ${
            lastErr instanceof Error ? lastErr.message : String(lastErr)
        }`,
    )
}

/**
 * CLI: `pnpm --filter @plexo/vision download-models` — pre-warm the cache.
 * Reads the registry from each model loader module.
 */
async function cli(): Promise<void> {
    // Loaders register artifacts when imported. Importing them populates
    // `registeredArtifacts` below.
    await import('../models/clip.js')
    await import('../models/faces.js')
    await import('../models/ocr.js')
    if (registeredArtifacts.length === 0) {
        logger.info('No artifacts registered — model loaders are stubbed (Phase 4.1 bootstrap).')
        return
    }
    for (const a of registeredArtifacts) {
        await ensureArtifact(a)
    }
    logger.info({ count: registeredArtifacts.length }, 'All artifacts ready')
}

export const registeredArtifacts: ModelArtifact[] = []

export function registerArtifact(a: ModelArtifact): void {
    registeredArtifacts.push(a)
}

const isCLI = process.argv[1]?.endsWith('/lib/download.ts') || process.argv[1]?.endsWith('/lib/download.js')
if (isCLI) {
    cli().catch((err) => {
        logger.error({ err }, 'download CLI failed')
        process.exit(1)
    })
}
