import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join, resolve, sep } from 'node:path'
import { getHapiHomeDir } from '../scratchlistAttachments/storage'

const IMAGE_ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/

export type StoredGeneratedImage = {
    imageId: string
    fileName: string
    mimeType: string
    bytes: Buffer
}

type StoredGeneratedImageManifest = {
    fileName: string
    mimeType: string
    createdAt: number
}

function sanitizeSegment(segment: string): string {
    return segment.replace(/[/\\]/g, '_').replace(/\.\./g, '_').slice(0, 128) || 'default'
}

function sanitizeFilename(filename: string): string {
    const sanitized = filename
        .replace(/[/\\]/g, '_')
        .replace(/\.\./g, '_')
        .replace(/[\r\n\0"\\]/g, '_')
        .replace(/[\u0000-\u001f\u007f]/g, '_')
        .slice(0, 255)
    return sanitized || 'generated-media'
}

export function getGeneratedImagesRoot(hapiHome: string = getHapiHomeDir()): string {
    return join(hapiHome, 'generated-images')
}

function resolveImagePaths(
    hapiHome: string,
    namespace: string,
    imageId: string
): { dir: string; binPath: string; metaPath: string } | null {
    if (!IMAGE_ID_PATTERN.test(imageId)) {
        return null
    }
    const root = resolve(getGeneratedImagesRoot(hapiHome))
    const dir = resolve(root, sanitizeSegment(namespace))
    const prefix = root.endsWith(sep) ? root : `${root}${sep}`
    if (!dir.startsWith(prefix)) {
        return null
    }
    const binPath = resolve(dir, `${imageId}.bin`)
    const metaPath = resolve(dir, `${imageId}.json`)
    const dirPrefix = dir.endsWith(sep) ? dir : `${dir}${sep}`
    if (!binPath.startsWith(dirPrefix) || !metaPath.startsWith(dirPrefix)) {
        return null
    }
    return { dir, binPath, metaPath }
}

export async function writeStoredGeneratedImage(
    hapiHome: string,
    namespace: string,
    imageId: string,
    input: {
        fileName: string
        mimeType: string
        bytes: Uint8Array
    }
): Promise<boolean> {
    const paths = resolveImagePaths(hapiHome, namespace, imageId)
    if (!paths) {
        return false
    }
    await mkdir(paths.dir, { recursive: true })
    const tmpSuffix = `.tmp-${randomUUID()}`
    const tmpBin = `${paths.binPath}${tmpSuffix}`
    const tmpMeta = `${paths.metaPath}${tmpSuffix}`
    const manifest: StoredGeneratedImageManifest = {
        fileName: sanitizeFilename(input.fileName),
        mimeType: input.mimeType || 'application/octet-stream',
        createdAt: Date.now()
    }
    try {
        await writeFile(tmpBin, input.bytes)
        await writeFile(tmpMeta, JSON.stringify(manifest), 'utf8')
        await rename(tmpBin, paths.binPath)
        await rename(tmpMeta, paths.metaPath)
        return true
    } catch (error) {
        await rm(tmpBin, { force: true }).catch(() => {})
        await rm(tmpMeta, { force: true }).catch(() => {})
        throw error
    }
}

export async function readStoredGeneratedImage(
    hapiHome: string,
    namespace: string,
    imageId: string
): Promise<StoredGeneratedImage | null> {
    const paths = resolveImagePaths(hapiHome, namespace, imageId)
    if (!paths) {
        return null
    }
    try {
        const [rawMeta, bytes] = await Promise.all([
            readFile(paths.metaPath, 'utf8'),
            readFile(paths.binPath)
        ])
        const parsed = JSON.parse(rawMeta) as Partial<StoredGeneratedImageManifest>
        const fileName = typeof parsed.fileName === 'string' && parsed.fileName.length > 0
            ? sanitizeFilename(parsed.fileName)
            : 'generated-media'
        const mimeType = typeof parsed.mimeType === 'string' && parsed.mimeType.length > 0
            ? parsed.mimeType
            : 'application/octet-stream'
        return {
            imageId,
            fileName,
            mimeType,
            bytes
        }
    } catch {
        return null
    }
}
