import { describe, it, expect, vi, beforeEach } from 'vitest'
import { OllamaAdapter } from './adapter.js'

// Mock fetch globally
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

describe('OllamaAdapter', () => {
    let adapter: OllamaAdapter

    beforeEach(() => {
        vi.clearAllMocks()
        adapter = new OllamaAdapter({
            id: 'test-ollama',
            endpoint: 'http://localhost:11434',
        })
    })

    describe('discoverCapabilities', () => {
        it('classifies models from /api/tags', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({
                    models: [
                        { name: 'llama3.2:3b', size: 2_000_000_000, details: { family: 'llama' } },
                        { name: 'snowflake-arctic-embed:latest', size: 335_000_000, details: { family: 'bert' } },
                        { name: 'mistral-nemo:latest', size: 7_000_000_000, details: { family: 'llama' } },
                    ],
                }),
            })

            const caps = await adapter.discoverCapabilities()

            expect(caps.supportsChat).toBe(true)
            expect(caps.supportsEmbeddings).toBe(true)
            expect(caps.chatModels).toContain('llama3.2:3b')
            expect(caps.chatModels).toContain('mistral-nemo:latest')
            expect(caps.embeddingModels).toContain('snowflake-arctic-embed:latest')
            expect(caps.allModels).toHaveLength(3)
        })

        it('handles unreachable instance', async () => {
            mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'))

            const caps = await adapter.discoverCapabilities()

            expect(caps.supportsChat).toBe(false)
            expect(caps.supportsEmbeddings).toBe(false)
            expect(caps.chatModels).toHaveLength(0)
        })

        it('handles redirect (HTTP→HTTPS)', async () => {
            mockFetch
                .mockResolvedValueOnce({
                    ok: false,
                    status: 301,
                    headers: new Map([['location', 'https://ollama.example.com/api/tags']]),
                })
                .mockResolvedValueOnce({
                    ok: true,
                    status: 200,
                    json: async () => ({
                        models: [
                            { name: 'nomic-embed-text:latest', size: 274_000_000 },
                        ],
                    }),
                })

            const caps = await adapter.discoverCapabilities()
            expect(caps.supportsEmbeddings).toBe(true)
            expect(caps.embeddingModels).toContain('nomic-embed-text:latest')
        })
    })

    describe('embed', () => {
        it('calls /api/embed and returns vector', async () => {
            // First call: discoverCapabilities
            mockFetch.mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({
                    models: [
                        { name: 'snowflake-arctic-embed:latest', size: 335_000_000 },
                    ],
                }),
            })
            // Second call: embed
            mockFetch.mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({
                    embeddings: [[0.1, 0.2, 0.3]],
                }),
            })

            const result = await adapter.embed('hello world')
            expect(result.vector).toEqual([0.1, 0.2, 0.3])
            expect(result.model).toBe('snowflake-arctic-embed:latest')
            expect(result.dimensions).toBe(3)
        })

        it('throws when no embedding model available', async () => {
            mockFetch.mockResolvedValueOnce({
                ok: true,
                status: 200,
                json: async () => ({
                    models: [
                        { name: 'llama3.2:3b', size: 2_000_000_000 },
                    ],
                }),
            })

            await expect(adapter.embed('hello')).rejects.toThrow('No embedding model available')
        })
    })

    describe('isHealthy', () => {
        it('returns true when reachable', async () => {
            mockFetch.mockResolvedValueOnce({ ok: true, status: 200 })
            expect(await adapter.isHealthy()).toBe(true)
        })

        it('returns false when unreachable', async () => {
            mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'))
            expect(await adapter.isHealthy()).toBe(false)
        })
    })
})
