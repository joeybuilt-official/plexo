import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock ssh2 Client
const mockExec = vi.fn()
const mockSftp = vi.fn()
const mockEnd = vi.fn()
const mockOn = vi.fn()
const mockConnect = vi.fn()

vi.mock('ssh2', () => ({
    Client: vi.fn().mockImplementation(() => ({
        on: mockOn,
        connect: mockConnect,
        exec: mockExec,
        sftp: mockSftp,
        end: mockEnd,
    })),
}))

// After mocking, we can import the functions
import { sshExec, sshTest } from './client.js'

describe('SSH Client', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        // Default: connection succeeds
        mockOn.mockImplementation((event: string, cb: Function) => {
            if (event === 'ready') setTimeout(() => cb(), 1)
        })
    })

    const opts = { host: '192.168.1.1', username: 'testuser', password: 'testpass' }

    describe('sshExec', () => {
        it('returns stdout, stderr, and exit code', async () => {
            mockExec.mockImplementation((_cmd: string, _opts: unknown, cb: Function) => {
                const stream = {
                    on: vi.fn((event: string, handler: Function) => {
                        if (event === 'data') handler(Buffer.from('hello world'))
                        if (event === 'close') setTimeout(() => handler(0), 1)
                    }),
                    stderr: {
                        on: vi.fn((event: string, handler: Function) => {
                            if (event === 'data') handler(Buffer.from(''))
                        }),
                    },
                }
                cb(null, stream)
            })

            const result = await sshExec(opts, 'echo hello')
            expect(result.stdout).toContain('hello world')
            expect(result.exitCode).toBe(0)
            expect(result.durationMs).toBeGreaterThanOrEqual(0)
            expect(mockEnd).toHaveBeenCalled()
        })

        it('sanitizes PEM keys from output', async () => {
            const keyOutput = '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----'
            mockExec.mockImplementation((_cmd: string, _opts: unknown, cb: Function) => {
                const stream = {
                    on: vi.fn((event: string, handler: Function) => {
                        if (event === 'data') handler(Buffer.from(keyOutput))
                        if (event === 'close') setTimeout(() => handler(0), 1)
                    }),
                    stderr: { on: vi.fn() },
                }
                cb(null, stream)
            })

            const result = await sshExec(opts, 'cat /etc/some-key')
            expect(result.stdout).not.toContain('BEGIN RSA PRIVATE KEY')
            expect(result.stdout).toContain('[REDACTED:KEY]')
        })

        it('throws clear error on connection failure', async () => {
            mockOn.mockImplementation((event: string, cb: Function) => {
                if (event === 'error') setTimeout(() => cb(new Error('Connection refused')), 1)
            })

            await expect(sshExec(opts, 'echo test')).rejects.toThrow(/connection/i)
        })
    })

    describe('sshTest', () => {
        it('returns ok:true when echo ok succeeds', async () => {
            mockExec.mockImplementation((_cmd: string, _opts: unknown, cb: Function) => {
                const stream = {
                    on: vi.fn((event: string, handler: Function) => {
                        if (event === 'data') handler(Buffer.from('ok'))
                        if (event === 'close') setTimeout(() => handler(0), 1)
                    }),
                    stderr: { on: vi.fn() },
                }
                cb(null, stream)
            })

            const result = await sshTest(opts)
            expect(result.ok).toBe(true)
            expect(result.message).toContain('Connected to 192.168.1.1')
        })

        it('returns ok:false when connection fails', async () => {
            mockOn.mockImplementation((event: string, cb: Function) => {
                if (event === 'error') setTimeout(() => cb(new Error('ECONNREFUSED')), 1)
            })

            const result = await sshTest(opts)
            expect(result.ok).toBe(false)
            expect(result.message).toContain('ECONNREFUSED')
        })
    })
})
