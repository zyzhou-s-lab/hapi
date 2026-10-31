import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager'
import { registerFileHandlers } from './files'

type FileResponse = {
    success: boolean
    content?: string
    hash?: string
    size?: number
    modified?: number
    error?: string
}

describe('file RPC handlers', () => {
    let rootDir: string
    let rpc: RpcHandlerManager

    beforeEach(async () => {
        rootDir = await mkdtemp(join(tmpdir(), 'hapi-file-handler-'))
        await writeFile(join(rootDir, 'note.txt'), 'original')
        rpc = new RpcHandlerManager({ scopePrefix: 'session-test' })
        registerFileHandlers(rpc, rootDir)
    })

    afterEach(async () => {
        await rm(rootDir, { recursive: true, force: true })
    })

    async function request(method: 'readFile' | 'writeFile', params: object): Promise<FileResponse> {
        const response = await rpc.handleRequest({
            method: `session-test:${method}`,
            params: JSON.stringify(params)
        })
        return JSON.parse(response) as FileResponse
    }

    it('returns file metadata alongside content', async () => {
        const filePath = join(rootDir, 'README.md')
        await writeFile(filePath, '# test')
        const expectedStats = await stat(filePath)
        const expectedHash = createHash('sha256').update('# test').digest('hex')

        const response = await request('readFile', { path: 'README.md' })

        expect(response.success).toBe(true)
        expect(response.content).toBe(Buffer.from('# test').toString('base64'))
        expect(response.hash).toBe(expectedHash)
        expect(response.size).toBe(expectedStats.size)
        expect(response.modified).toBe(expectedStats.mtime.getTime())
    })

    it('returns the content hash and writes relative to the session directory', async () => {
        const originalHash = createHash('sha256').update('original').digest('hex')
        const read = await request('readFile', { path: 'note.txt' })
        expect(read.success).toBe(true)
        expect(read.content).toBe(Buffer.from('original').toString('base64'))
        expect(read.hash).toBe(originalHash)

        const write = await request('writeFile', {
            path: 'note.txt',
            content: Buffer.from('updated').toString('base64'),
            expectedHash: originalHash
        })

        expect(write.success).toBe(true)
        expect(await readFile(join(rootDir, 'note.txt'), 'utf8')).toBe('updated')
    })

    it('rejects a stale write without changing the file', async () => {
        const result = await request('writeFile', {
            path: 'note.txt',
            content: Buffer.from('updated').toString('base64'),
            expectedHash: '0'.repeat(64)
        })

        expect(result.error).toContain('File hash mismatch')
        expect(await readFile(join(rootDir, 'note.txt'), 'utf8')).toBe('original')
    })

    it('rejects a symlink that leaves the working directory', async () => {
        const outside = await mkdtemp(join(tmpdir(), 'hapi-file-outside-'))
        try {
            await writeFile(join(outside, 'secret'), 'hidden')
            await symlink(join(outside, 'secret'), join(rootDir, 'link'))
            const response = await request('readFile', { path: 'link' })
            expect(response.success).toBe(false)
            expect(response.error).toContain('outside the working directory')
        } finally {
            await rm(outside, { recursive: true, force: true })
        }
    })

    it('reads a whitelisted config file outside the working directory and nothing else', async () => {
        const outside = await mkdtemp(join(tmpdir(), 'hapi-file-allow-'))
        const allowedFile = join(outside, 'CLAUDE.md')
        const otherFile = join(outside, 'secret')
        await writeFile(allowedFile, 'project rules')
        await writeFile(otherFile, 'hidden')
        const allowedReal = await realpath(allowedFile)
        const rpcWithAllow = new RpcHandlerManager({ scopePrefix: 'session-allow' })
        registerFileHandlers(rpcWithAllow, rootDir, async () => new Set([allowedReal]))
        const readAllowed = async (path: string): Promise<FileResponse> => {
            const response = await rpcWithAllow.handleRequest({
                method: 'session-allow:readFile',
                params: JSON.stringify({ path }),
            })
            return JSON.parse(response) as FileResponse
        }
        try {
            const allowed = await readAllowed(allowedFile)
            expect(allowed.success).toBe(true)
            expect(Buffer.from(allowed.content ?? '', 'base64').toString('utf8')).toBe('project rules')
            const denied = await readAllowed(otherFile)
            expect(denied.success).toBe(false)
        } finally {
            await rm(outside, { recursive: true, force: true })
        }
    })

    it('does not write a whitelisted file outside the working directory', async () => {
        const outside = await mkdtemp(join(tmpdir(), 'hapi-file-write-'))
        const allowedFile = join(outside, 'CLAUDE.md')
        await writeFile(allowedFile, 'project rules')
        const allowedReal = await realpath(allowedFile)
        const rpcWithAllow = new RpcHandlerManager({ scopePrefix: 'session-write' })
        registerFileHandlers(rpcWithAllow, rootDir, async () => new Set([allowedReal]))
        try {
            const response = await rpcWithAllow.handleRequest({
                method: 'session-write:writeFile',
                params: JSON.stringify({
                    path: allowedFile,
                    content: Buffer.from('pwned').toString('base64'),
                    expectedHash: createHash('sha256').update('project rules').digest('hex'),
                }),
            })
            const parsed = JSON.parse(response) as FileResponse
            expect(parsed.success).toBe(false)
            expect(parsed.error).toContain('outside the working directory')
            expect(await readFile(allowedFile, 'utf8')).toBe('project rules')
        } finally {
            await rm(outside, { recursive: true, force: true })
        }
    })

    it('reuses the outside-file whitelist for a short time', async () => {
        const outside = await mkdtemp(join(tmpdir(), 'hapi-file-cache-'))
        const allowedFile = join(outside, 'CLAUDE.md')
        await writeFile(allowedFile, 'project rules')
        const allowedReal = await realpath(allowedFile)
        let calls = 0
        const rpcWithAllow = new RpcHandlerManager({ scopePrefix: 'session-cache' })
        registerFileHandlers(rpcWithAllow, rootDir, async () => {
            calls += 1
            return new Set([allowedReal])
        })
        const read = async () => {
            const response = await rpcWithAllow.handleRequest({
                method: 'session-cache:readFile',
                params: JSON.stringify({ path: allowedFile }),
            })
            return JSON.parse(response) as FileResponse
        }
        try {
            expect((await read()).success).toBe(true)
            expect((await read()).success).toBe(true)
            expect(calls).toBe(1)
        } finally {
            await rm(outside, { recursive: true, force: true })
        }
    })
})
