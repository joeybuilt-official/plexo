// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Download snowflake-arctic-embed ONNX model + tokenizer from HuggingFace.
 *
 * Usage:
 *   tsx src/download-model.ts [model-id] [output-dir]
 *
 * Defaults:
 *   model-id:  Snowflake/snowflake-arctic-embed-s
 *   output-dir: ./models/snowflake-arctic-embed-s
 *
 * Downloads: model.onnx, tokenizer.json, config.json
 */

import { mkdir, writeFile, stat } from 'fs/promises'
import { join } from 'path'
import pino from 'pino'

const logger = pino({ name: 'model-download' })

const HF_BASE = 'https://huggingface.co'

const FILES_TO_DOWNLOAD = [
    'onnx/model.onnx',
    'tokenizer.json',
    'config.json',
]

async function fileExists(path: string): Promise<boolean> {
    try {
        await stat(path)
        return true
    } catch {
        return false
    }
}

async function downloadFile(url: string, dest: string): Promise<void> {
    logger.info({ url, dest }, 'Downloading...')
    const res = await fetch(url, {
        redirect: 'follow',
        headers: {
            'User-Agent': 'plexo-embeddings/1.0',
        },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status} downloading ${url}: ${await res.text().catch(() => '')}`)

    const buffer = Buffer.from(await res.arrayBuffer())
    await writeFile(dest, buffer)
    const sizeMB = (buffer.length / 1024 / 1024).toFixed(1)
    logger.info({ dest, sizeMB: `${sizeMB}MB` }, 'Download complete')
}

export async function downloadModel(modelId: string, outputDir: string): Promise<void> {
    await mkdir(outputDir, { recursive: true })

    for (const file of FILES_TO_DOWNLOAD) {
        const localName = file.includes('/') ? file.split('/').pop()! : file
        const destPath = join(outputDir, localName)

        if (await fileExists(destPath)) {
            logger.info({ file: localName }, 'Already exists, skipping')
            continue
        }

        const url = `${HF_BASE}/${modelId}/resolve/main/${file}`
        await downloadFile(url, destPath)
    }

    logger.info({ modelId, outputDir }, 'Model download complete')
}

// CLI entry point — only runs when executed directly
const isCLI = process.argv[1]?.includes('download-model')
if (isCLI) {
    const modelId = process.argv[2] || 'Snowflake/snowflake-arctic-embed-s'
    const outputDir = process.argv[3] || join(import.meta.dirname ?? '.', '..', 'models', 'snowflake-arctic-embed-s')

    downloadModel(modelId, outputDir).catch((err) => {
        logger.error({ err }, 'Model download failed')
        process.exit(1)
    })
}
