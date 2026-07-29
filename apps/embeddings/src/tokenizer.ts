// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Joeybuilt LLC

/**
 * Minimal BERT WordPiece tokenizer.
 *
 * Loads the HuggingFace tokenizer.json (WordPiece format) and provides
 * encode() that returns input_ids and attention_mask tensors compatible
 * with snowflake-arctic-embed ONNX models.
 *
 * This avoids pulling in heavy Python-bridge or full tokenizer libraries.
 */

import { readFile } from 'fs/promises'
import pino from 'pino'

const logger = pino({ name: 'tokenizer' })

interface TokenizerConfig {
    vocab: Map<string, number>
    unkTokenId: number
    clsTokenId: number
    sepTokenId: number
    padTokenId: number
    maxLength: number
}

let config: TokenizerConfig | null = null

/**
 * Load tokenizer from a HuggingFace tokenizer.json file.
 */
export async function loadTokenizer(tokenizerPath: string): Promise<void> {
    const raw = await readFile(tokenizerPath, 'utf-8')
    const data = JSON.parse(raw) as {
        model: { vocab: Record<string, number> }
        added_tokens?: Array<{ id: number; content: string }>
        truncation?: { max_length?: number } | null
    }

    const vocab = new Map<string, number>()
    for (const [token, id] of Object.entries(data.model.vocab)) {
        vocab.set(token, id)
    }

    // Also add any added_tokens (like [CLS], [SEP], [PAD], [UNK], [MASK])
    if (data.added_tokens) {
        for (const t of data.added_tokens) {
            vocab.set(t.content, t.id)
        }
    }

    const unkTokenId = vocab.get('[UNK]') ?? 100
    const clsTokenId = vocab.get('[CLS]') ?? 101
    const sepTokenId = vocab.get('[SEP]') ?? 102
    const padTokenId = vocab.get('[PAD]') ?? 0

    const maxLength = data.truncation?.max_length ?? 512

    config = { vocab, unkTokenId, clsTokenId, sepTokenId, padTokenId, maxLength }
    logger.info({ vocabSize: vocab.size, maxLength }, 'Tokenizer loaded')
}

/**
 * Basic pre-tokenization: lowercase, split on whitespace and punctuation.
 */
function preTokenize(text: string): string[] {
    const lower = text.toLowerCase()
    // Split on whitespace, then separate punctuation as individual tokens
    const tokens: string[] = []
    for (const word of lower.split(/\s+/)) {
        if (!word) continue
        // Split punctuation from words
        let current = ''
        for (const ch of word) {
            if (/[a-z0-9]/.test(ch) || ch === "'") {
                current += ch
            } else {
                if (current) { tokens.push(current); current = '' }
                tokens.push(ch)
            }
        }
        if (current) tokens.push(current)
    }
    return tokens
}

/**
 * WordPiece tokenization of a single pre-tokenized word.
 */
function wordPieceTokenize(word: string, vocab: Map<string, number>, unkId: number): number[] {
    if (vocab.has(word)) return [vocab.get(word)!]

    const ids: number[] = []
    let start = 0

    while (start < word.length) {
        let end = word.length
        let found = false

        while (start < end) {
            const substr = start === 0 ? word.slice(start, end) : `##${word.slice(start, end)}`
            if (vocab.has(substr)) {
                ids.push(vocab.get(substr)!)
                start = end
                found = true
                break
            }
            end--
        }

        if (!found) {
            ids.push(unkId)
            start++
        }
    }

    return ids
}

export interface TokenizedInput {
    inputIds: BigInt64Array
    attentionMask: BigInt64Array
    tokenTypeIds: BigInt64Array
    tokenCount: number
}

/**
 * Encode text into BERT-compatible token IDs.
 * Returns [CLS] + tokens + [SEP], padded/truncated to maxLength.
 */
export function encode(text: string, maxLength?: number): TokenizedInput {
    if (!config) throw new Error('Tokenizer not loaded. Call loadTokenizer() first.')

    const seqLen = maxLength ?? config.maxLength
    const words = preTokenize(text)
    const tokenIds: number[] = [config.clsTokenId]

    for (const word of words) {
        const wpIds = wordPieceTokenize(word, config.vocab, config.unkTokenId)
        tokenIds.push(...wpIds)
        if (tokenIds.length >= seqLen - 1) break
    }

    // Truncate to maxLength - 1 (leave room for [SEP])
    if (tokenIds.length > seqLen - 1) {
        tokenIds.length = seqLen - 1
    }
    tokenIds.push(config.sepTokenId)

    const tokenCount = tokenIds.length

    // Pad to seqLen
    const inputIds = new BigInt64Array(seqLen)
    const attentionMask = new BigInt64Array(seqLen)
    const tokenTypeIds = new BigInt64Array(seqLen) // all zeros for single-segment

    for (let i = 0; i < seqLen; i++) {
        if (i < tokenIds.length) {
            inputIds[i] = BigInt(tokenIds[i]!)
            attentionMask[i] = 1n
        } else {
            inputIds[i] = BigInt(config.padTokenId)
            attentionMask[i] = 0n
        }
        tokenTypeIds[i] = 0n
    }

    return { inputIds, attentionMask, tokenTypeIds, tokenCount }
}

/**
 * Get the configured max sequence length.
 */
export function getMaxLength(): number {
    if (!config) throw new Error('Tokenizer not loaded')
    return config.maxLength
}
