import { describe, it, expect, vi } from 'vitest'

// Mock the SSH client functions
vi.mock('../../ssh/client.js', () => ({
    sshExec: vi.fn().mockResolvedValue({ stdout: 'hello', stderr: '', exitCode: 0, durationMs: 42 }),
    sshUpload: vi.fn().mockResolvedValue({ durationMs: 15 }),
    sshDownload: vi.fn().mockResolvedValue({ content: 'file content', durationMs: 20 }),
    sshListDir: vi.fn().mockResolvedValue({
        entries: [
            { name: 'test.txt', type: 'file', size: 1024, modifyTime: new Date() },
            { name: 'subdir', type: 'directory', size: 4096, modifyTime: new Date() },
        ],
        durationMs: 10,
    }),
}))

import { SSH_TOOLS } from './ssh.js'

const creds = {
    host: '192.168.1.100',
    port: '22',
    username: 'deploy',
    private_key: '-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n-----END OPENSSH PRIVATE KEY-----',
    mode: 'full',
}

const opts = { connectionId: 'conn-1', workspaceId: 'ws-1' }

describe('SSH Tool Factory', () => {
    it('produces all 4 tools in full mode', () => {
        const tools = SSH_TOOLS(creds, opts)
        expect(tools).toHaveProperty('ssh__exec')
        expect(tools).toHaveProperty('ssh__upload')
        expect(tools).toHaveProperty('ssh__download')
        expect(tools).toHaveProperty('ssh__list_dir')
    })

    it('excludes ssh__upload in readonly mode', () => {
        const tools = SSH_TOOLS({ ...creds, mode: 'readonly' }, opts)
        expect(tools).toHaveProperty('ssh__exec')
        expect(tools).toHaveProperty('ssh__download')
        expect(tools).toHaveProperty('ssh__list_dir')
        expect(tools).not.toHaveProperty('ssh__upload')
    })

    it('excludes ssh__upload in "Read Only" mode (UI label)', () => {
        const tools = SSH_TOOLS({ ...creds, mode: 'Read Only' }, opts)
        expect(tools).not.toHaveProperty('ssh__upload')
    })

    it('ssh__exec returns formatted output', async () => {
        const tools = SSH_TOOLS(creds, opts)
        const result = await tools.ssh__exec.execute({ command: 'echo hello' }, {} as any)
        expect(result).toContain('hello')
        expect(result).toContain('exit code: 0')
    })

    it('ssh__list_dir returns formatted listing', async () => {
        const tools = SSH_TOOLS(creds, opts)
        const result = await tools.ssh__list_dir.execute({ path: '/tmp' }, {} as any)
        expect(result).toContain('test.txt')
        expect(result).toContain('subdir')
    })

    it('ssh__download returns file content', async () => {
        const tools = SSH_TOOLS(creds, opts)
        const result = await tools.ssh__download.execute({ remotePath: '/tmp/test.txt' }, {} as any)
        expect(result).toBe('file content')
    })

    it('ssh__upload returns confirmation', async () => {
        const tools = SSH_TOOLS(creds, opts)
        const result = await tools.ssh__upload.execute({ content: 'data', remotePath: '/tmp/out.txt' }, {} as any)
        expect(result).toContain('Uploaded')
        expect(result).toContain('/tmp/out.txt')
    })

    it('enforces rate limit', async () => {
        const tools = SSH_TOOLS({ ...creds, maxCallsPerTask: '2' }, opts)
        await tools.ssh__exec.execute({ command: 'cmd1' }, {} as any)
        await tools.ssh__exec.execute({ command: 'cmd2' }, {} as any)
        const result = await tools.ssh__exec.execute({ command: 'cmd3' }, {} as any)
        expect(result).toContain('call limit reached')
    })

    it('enforces command denylist', async () => {
        const tools = SSH_TOOLS({ ...creds, denylist: ['rm -rf'] }, opts)
        const result = await tools.ssh__exec.execute({ command: 'rm -rf /' }, {} as any)
        expect(result).toContain('blocked by denylist')
    })
})
