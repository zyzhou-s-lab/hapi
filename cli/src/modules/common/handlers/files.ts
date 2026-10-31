import { logger } from '@/ui/logger'
import { readFile, realpath, stat, writeFile } from 'fs/promises'
import { createHash } from 'crypto'
import { resolve } from 'path'
import type { FileReadResponse, FileWriteResponse, GeneratedFileResponse, GeneratedImageResponse } from '@hapi/protocol/apiTypes'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager'
import { validatePath } from '../pathSecurity'
import { getGeneratedImage } from '../generatedImages'
import { getGeneratedFile } from '../generatedFiles'
import { getErrorMessage, rpcError } from '../rpcResponses'

interface ReadFileRequest {
    path: string
    authorized?: boolean
}

type ReadFileResponse = FileReadResponse

interface ReadGeneratedImageRequest {
    id: string
}

type ReadGeneratedImageResponse = GeneratedImageResponse

interface ReadGeneratedFileRequest {
    id: string
}

type ReadGeneratedFileResponse = GeneratedFileResponse

interface WriteFileRequest {
    path: string
    content: string
    expectedHash?: string | null
}

export function registerFileHandlers(
    rpcHandlerManager: RpcHandlerManager,
    workingDirectory: string,
    listedConfigPaths?: () => Promise<ReadonlySet<string>>,
): void {
    const listedRealpath = async (requested: string): Promise<string | { error: string }> => {
        if (!listedConfigPaths) return { error: 'Reading files outside the working directory is not allowed' }
        let real: string
        try {
            real = await realpath(resolve(requested))
        } catch (error) {
            return { error: getErrorMessage(error, 'Invalid file path') }
        }
        const allowed = await listedConfigPaths()
        return allowed.has(real) ? real : { error: 'Reading files outside the working directory is not allowed' }
    }
    const resolveWritable = (requested: string): { path: string } | { error: string } => {
        const validation = validatePath(requested, workingDirectory)
        if (!validation.valid) return { error: validation.error ?? 'Invalid file path' }
        return { path: resolve(workingDirectory, requested) }
    }
    rpcHandlerManager.registerHandler<{ path: string }, { success: true; realpath: string } | { success: false; error: string }>(RPC_METHODS.ResolveListedConfigFile, async (data) => {
        const listed = await listedRealpath(data.path)
        return typeof listed === 'string' ? { success: true, realpath: listed } : rpcError(listed.error)
    })
    rpcHandlerManager.registerHandler<ReadFileRequest, ReadFileResponse>(RPC_METHODS.ReadFile, async (data) => {
        logger.debug('Read file request:', data.path)

        const validation = validatePath(data.path, workingDirectory)
        const readable = validation.valid
            ? { path: resolve(workingDirectory, data.path) }
            : await listedRealpath(data.path)
        const allowed = typeof readable === 'string'
            ? data.authorized === true
                ? { path: readable }
                : { error: 'authorization_required' as const }
            : readable
        if ('error' in allowed) return rpcError(allowed.error)

        try {
            const resolvedPath = allowed.path
            const stats = await stat(resolvedPath)
            const buffer = await readFile(resolvedPath)
            const content = buffer.toString('base64')
            const hash = createHash('sha256').update(buffer).digest('hex')
            return {
                success: true,
                content,
                hash,
                size: stats.size,
                modified: stats.mtime.getTime()
            }
        } catch (error) {
            logger.debug('Failed to read file:', error)
            return rpcError(getErrorMessage(error, 'Failed to read file'))
        }
    })

    rpcHandlerManager.registerHandler<ReadGeneratedImageRequest, ReadGeneratedImageResponse>(RPC_METHODS.ReadGeneratedImage, async (data) => {
        logger.debug('Read generated image request:', data.id)

        const image = getGeneratedImage(data.id)
        if (!image) {
            return rpcError('Generated image not found')
        }

        try {
            return {
                success: true,
                content: image.content.toString('base64'),
                mimeType: image.mimeType,
                fileName: image.fileName
            }
        } catch (error) {
            logger.debug('Failed to read generated image:', error)
            return rpcError(getErrorMessage(error, 'Failed to read generated image'))
        }
    })

    rpcHandlerManager.registerHandler<ReadGeneratedFileRequest, ReadGeneratedFileResponse>(RPC_METHODS.ReadGeneratedFile, async (data) => {
        logger.debug('Read generated file request:', data.id)

        const file = getGeneratedFile(data.id)
        if (!file) {
            return rpcError('Sent file not found')
        }

        try {
            const buffer = await readFile(file.snapshotPath)
            return {
                success: true,
                content: buffer.toString('base64'),
                mimeType: file.mimeType,
                fileName: file.fileName,
                size: file.size
            }
        } catch (error) {
            logger.debug('Failed to read generated file:', error)
            return rpcError(getErrorMessage(error, 'Failed to read sent file'))
        }
    })

    rpcHandlerManager.registerHandler<WriteFileRequest, FileWriteResponse>(RPC_METHODS.WriteFile, async (data) => {
        logger.debug('Write file request:', data.path)

        const allowed = resolveWritable(data.path)
        if ('error' in allowed) return rpcError(allowed.error)

        try {
            const resolvedPath = allowed.path
            if (data.expectedHash !== null && data.expectedHash !== undefined) {
                try {
                    const existingBuffer = await readFile(resolvedPath)
                    const existingHash = createHash('sha256').update(existingBuffer).digest('hex')

                    if (existingHash !== data.expectedHash) {
                        return rpcError(`File hash mismatch. Expected: ${data.expectedHash}, Actual: ${existingHash}`)
                    }
                } catch (error) {
                    const nodeError = error as NodeJS.ErrnoException
                    if (nodeError.code !== 'ENOENT') {
                        throw error
                    }
                    return rpcError('File does not exist but hash was provided')
                }
            } else {
                try {
                    await stat(resolvedPath)
                    return rpcError('File already exists but was expected to be new')
                } catch (error) {
                    const nodeError = error as NodeJS.ErrnoException
                    if (nodeError.code !== 'ENOENT') {
                        throw error
                    }
                }
            }

            const buffer = Buffer.from(data.content, 'base64')
            await writeFile(resolvedPath, buffer)

            const hash = createHash('sha256').update(buffer).digest('hex')

            return { success: true, hash }
        } catch (error) {
            logger.debug('Failed to write file:', error)
            return rpcError(getErrorMessage(error, 'Failed to write file'))
        }
    })
}
