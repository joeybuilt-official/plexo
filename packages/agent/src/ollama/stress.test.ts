import { describe, it, expect, vi, beforeEach } from 'vitest'
import { OllamaAdapter } from './adapter.js'
import { classifyModel, getEmbeddingDimensions } from './classify-model.js'

// Mock fetch
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

describe('OllamaAdapter: concurrent stress', () => {
    let adapter: OllamaAdapter

    beforeEach(() => {
        vi.clearAllMocks()
        adapter = new OllamaAdapter({ id: 'stress-test', endpoint: 'http://localhost:11434' })
    })

    it('handles 50 concurrent embed calls without corruption', async () => {
        // All fetch calls return appropriate responses
        mockFetch.mockImplementation(async (url: string) => {
            if (typeof url === 'string' && url.includes('/api/tags')) {
                return {
                    ok: true, status: 200,
                    json: async () => ({ models: [{ name: 'snowflake-arctic-embed:latest', size: 335_000_000 }] }),
                }
            }
            return {
                ok: true, status: 200,
                json: async () => ({ embeddings: [[Math.random(), Math.random(), Math.random()]] }),
            }
        })

        const promises = Array.from({ length: 50 }, (_, i) =>
            adapter.embed(`test text number ${i}`)
        )

        const results = await Promise.all(promises)
        expect(results).toHaveLength(50)
        for (const r of results) {
            expect(r.vector).toHaveLength(3)
            expect(r.model).toBe('snowflake-arctic-embed:latest')
        }
    })

    it('handles mixed success/failure in concurrent calls', async () => {
        let callCount = 0
        mockFetch.mockImplementation(async (url: string) => {
            if (typeof url === 'string' && url.includes('/api/tags')) {
                return {
                    ok: true, status: 200,
                    json: async () => ({ models: [{ name: 'snowflake-arctic-embed:latest', size: 335_000_000 }] }),
                }
            }
            callCount++
            // Every 5th embed call fails
            if (callCount % 5 === 0) {
                throw new Error('ECONNRESET')
            }
            return {
                ok: true, status: 200,
                json: async () => ({ embeddings: [[0.1, 0.2]] }),
            }
        })

        const results = await Promise.allSettled(
            Array.from({ length: 20 }, (_, i) => adapter.embed(`text ${i}`))
        )

        const fulfilled = results.filter(r => r.status === 'fulfilled')
        const rejected = results.filter(r => r.status === 'rejected')
        // Some should succeed, some should fail
        expect(fulfilled.length).toBeGreaterThan(0)
        expect(rejected.length).toBeGreaterThan(0)
        expect(fulfilled.length + rejected.length).toBe(20)
    })

    it('capability discovery is idempotent under concurrent calls', async () => {
        // First call triggers discovery
        mockFetch.mockResolvedValue({
            ok: true, status: 200,
            json: async () => ({
                models: [
                    { name: 'llama3.2:3b', size: 2_000_000_000 },
                    { name: 'snowflake-arctic-embed:latest', size: 335_000_000 },
                ],
            }),
        })

        // 10 concurrent ensureFresh calls
        const caps = await Promise.all(
            Array.from({ length: 10 }, () => adapter.ensureFresh())
        )

        // All should return the same result
        for (const c of caps) {
            expect(c.supportsChat).toBe(true)
            expect(c.supportsEmbeddings).toBe(true)
            expect(c.chatModels).toContain('llama3.2:3b')
            expect(c.embeddingModels).toContain('snowflake-arctic-embed:latest')
        }
    })
})

describe('classifyModel: exhaustive coverage', () => {
    it('classifies all known embedding patterns', () => {
        const embeddings = [
            'nomic-embed-text', 'nomic-embed-text:latest', 'nomic-embed-text:v1.5',
            'mxbai-embed-large', 'mxbai-embed-large:latest',
            'snowflake-arctic-embed', 'snowflake-arctic-embed:latest', 'snowflake-arctic-embed:335m',
            'bge-large', 'bge-base', 'bge-small', 'bge-m3',
            'all-minilm', 'all-minilm:latest',
            'gte-large', 'gte-base',
            'e5-large', 'e5-base',
            'jina-embeddings-v2',
        ]
        for (const m of embeddings) {
            expect(classifyModel(m)).toBe('embedding')
        }
    })

    it('classifies all known chat families', () => {
        const chats = [
            'llama3.2:3b', 'llama3.1:8b', 'llama2:7b',
            'mistral:latest', 'mistral-nemo:latest', 'mixtral:latest',
            'qwen2.5:14b', 'qwen3:32b',
            'phi:latest', 'phi3:latest',
            'gemma3:12b', 'gemma2:27b',
            'deepseek-r1:32b', 'deepseek-coder:33b',
            'codellama:34b',
            'command-r:35b',
            'gpt-oss:20b',
            'wizardlm:latest',
            'vicuna:latest',
            'orca:latest',
            'dolphin:latest',
            'openchat:latest',
            'solar:latest',
            'yi:latest',
            'falcon:latest',
            'internlm:latest',
            'tinyllama:latest',
            'stablelm:latest',
        ]
        for (const m of chats) {
            expect(classifyModel(m)).toBe('chat')
        }
    })

    it('defaults unknown models to chat (conservative)', () => {
        const unknowns = ['custom-model:v1', 'my-finetune:latest', 'weird-name', 'abc123']
        for (const m of unknowns) {
            expect(classifyModel(m)).toBe('chat')
        }
    })
})

describe('getEmbeddingDimensions: completeness', () => {
    it('returns correct dimensions for all known models', () => {
        const known: [string, number][] = [
            ['snowflake-arctic-embed', 1024],
            ['mxbai-embed-large', 1024],
            ['nomic-embed-text', 768],
            ['bge-large', 1024],
            ['bge-base', 768],
            ['bge-small', 384],
            ['all-minilm', 384],
            ['gte-large', 1024],
            ['gte-base', 768],
            ['e5-large', 1024],
            ['e5-base', 768],
        ]
        for (const [model, expected] of known) {
            expect(getEmbeddingDimensions(model)).toBe(expected)
        }
    })

    it('returns null for unknown models', () => {
        expect(getEmbeddingDimensions('llama3.2:3b')).toBeNull()
        expect(getEmbeddingDimensions('custom-embed:latest')).toBeNull()
    })
})
