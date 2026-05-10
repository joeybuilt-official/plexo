import { describe, it, expect } from 'vitest'
import { classifyModel, getEmbeddingDimensions } from './classify-model.js'

describe('classifyModel', () => {
    it('classifies embedding models', () => {
        expect(classifyModel('nomic-embed-text:latest')).toBe('embedding')
        expect(classifyModel('mxbai-embed-large:latest')).toBe('embedding')
        expect(classifyModel('snowflake-arctic-embed:latest')).toBe('embedding')
        expect(classifyModel('bge-large:latest')).toBe('embedding')
        expect(classifyModel('all-minilm:latest')).toBe('embedding')
    })

    it('classifies chat models', () => {
        expect(classifyModel('llama3.2:3b')).toBe('chat')
        expect(classifyModel('mistral-nemo:latest')).toBe('chat')
        expect(classifyModel('qwen2.5:14b')).toBe('chat')
        expect(classifyModel('deepseek-r1:32b')).toBe('chat')
        expect(classifyModel('gemma3:12b')).toBe('chat')
        expect(classifyModel('codellama:34b-instruct-q4_0')).toBe('chat')
        expect(classifyModel('command-r:35b')).toBe('chat')
        expect(classifyModel('phi:latest')).toBe('chat')
    })

    it('defaults unknown models to chat', () => {
        expect(classifyModel('some-unknown-model:latest')).toBe('chat')
        expect(classifyModel('custom-finetune:v2')).toBe('chat')
    })

    it('handles bare names without tags', () => {
        expect(classifyModel('snowflake-arctic-embed')).toBe('embedding')
        expect(classifyModel('llama3.2')).toBe('chat')
    })
})

describe('getEmbeddingDimensions', () => {
    it('returns dimensions for known embedding models', () => {
        expect(getEmbeddingDimensions('snowflake-arctic-embed:latest')).toBe(1024)
        expect(getEmbeddingDimensions('mxbai-embed-large:latest')).toBe(1024)
        expect(getEmbeddingDimensions('nomic-embed-text:latest')).toBe(768)
        expect(getEmbeddingDimensions('bge-large:latest')).toBe(1024)
        expect(getEmbeddingDimensions('all-minilm:latest')).toBe(384)
    })

    it('returns null for unknown models', () => {
        expect(getEmbeddingDimensions('llama3.2:3b')).toBeNull()
        expect(getEmbeddingDimensions('custom-model')).toBeNull()
    })
})
