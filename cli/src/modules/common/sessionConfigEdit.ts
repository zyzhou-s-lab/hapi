import { renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const NOT_FOUND = 'Config entry not found'

function skip(text: string, index: number): number {
    let i = index
    while (i < text.length) {
        const ch = text[i]
        if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
            i++
            continue
        }
        if (text.startsWith('//', i)) {
            i += 2
            while (i < text.length && text[i] !== '\n') i++
            continue
        }
        if (text.startsWith('/*', i)) {
            const end = text.indexOf('*/', i + 2)
            i = end === -1 ? text.length : end + 2
            continue
        }
        break
    }
    return i
}

function readString(text: string, index: number): { end: number; value: string } {
    if (text[index] !== '"') throw new Error(NOT_FOUND)
    let i = index + 1
    let value = ''
    while (i < text.length) {
        if (text[i] === '\\') {
            value += text[i + 1] ?? ''
            i += 2
            continue
        }
        if (text[i] === '"') return { end: i + 1, value }
        value += text[i]
        i++
    }
    throw new Error(NOT_FOUND)
}

function readAtom(text: string, index: number): number {
    const match = /^(?:true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(index))
    if (!match) throw new Error(NOT_FOUND)
    return index + match[0].length
}

type PathPart = string | number

function insertBoolean(interior: string, field: string, value: boolean): string {
    const entry = `"${field}": ${value ? 'true' : 'false'}`
    const trimmed = interior.trimEnd()
    if (trimmed.length === 0) return entry
    const comma = trimmed.endsWith(',') ? '' : ', '
    if (!interior.includes('\n')) {
        return `${trimmed}${comma}${entry}${interior.slice(trimmed.length)}`
    }
    const indent = interior.match(/\n([ \t]+)\S/)?.[1] ?? '  '
    const breakComma = trimmed.endsWith(',') ? '' : ','
    return `${trimmed}${breakComma}\n${indent}${entry}${interior.slice(trimmed.length)}`
}

function parseArray(text: string, index: number, visit: (start: number, end: number, path: PathPart[]) => void, path: PathPart[]): number {
    let i = index + 1
    let item = 0
    while (i < text.length) {
        i = skip(text, i)
        if (text[i] === ']') return i + 1
        const start = i
        i = parseValue(text, i, visit, [...path, item])
        visitObjectEnd(text, start, i, [...path, item], visit)
        item++
        i = skip(text, i)
        if (text[i] === ',') i++
    }
    throw new Error(NOT_FOUND)
}

function visitObjectEnd(text: string, start: number, end: number, path: PathPart[], visit: (start: number, end: number, path: PathPart[]) => void): void {
    if (text[start] === '{') visit(start, end, path)
}

function parseObject(text: string, index: number, visit: (start: number, end: number, path: PathPart[]) => void, path: PathPart[]): number {
    let i = index + 1
    while (i < text.length) {
        i = skip(text, i)
        if (text[i] === '}') return i + 1
        const key = readString(text, i)
        i = skip(text, key.end)
        if (text[i] !== ':') throw new Error(NOT_FOUND)
        i = skip(text, i + 1)
        const start = i
        i = parseValue(text, i, visit, [...path, key.value])
        visitObjectEnd(text, start, i, [...path, key.value], visit)
        i = skip(text, i)
        if (text[i] === ',') i++
    }
    throw new Error(NOT_FOUND)
}

function parseValue(text: string, index: number, visit: (start: number, end: number, path: PathPart[]) => void, path: PathPart[]): number {
    const i = skip(text, index)
    if (text[i] === '{') return parseObject(text, i, visit, path)
    if (text[i] === '[') return parseArray(text, i, visit, path)
    if (text[i] === '"') return readString(text, i).end
    return readAtom(text, i)
}

export function collectJsonObjects(text: string): Array<{ start: number; end: number; path: PathPart[] }> {
    const objects: Array<{ start: number; end: number; path: PathPart[] }> = []
    const start = skip(text, 0)
    if (text[start] !== '{' && text[start] !== '[') return objects
    const end = parseValue(text, start, (objectStart, objectEnd, path) => {
        objects.push({ start: objectStart, end: objectEnd, path })
    }, [])
    if (text[start] === '{') objects.push({ start, end, path: [] })
    return objects
}

export function jsonStringField(objectText: string, field: string): string | undefined {
    if (!objectText.startsWith('{')) return undefined
    let i = 1
    while (i < objectText.length) {
        i = skip(objectText, i)
        if (objectText[i] === '}') return undefined
        const key = readString(objectText, i)
        i = skip(objectText, key.end)
        if (objectText[i] !== ':') return undefined
        i = skip(objectText, i + 1)
        if (key.value === field && objectText[i] === '"') return readString(objectText, i).value
        i = parseValue(objectText, i, () => undefined, [])
        i = skip(objectText, i)
        if (objectText[i] === ',') i++
    }
    return undefined
}

export function setJsonBoolean(text: string, path: readonly string[], field: string, value: boolean): string {
    const objects = collectJsonObjects(text)
    const hit = objects.find((object) => (
        object.path.length === path.length
        && object.path.every((part, index) => part === path[index])
    ))
    if (!hit) throw new Error(NOT_FOUND)
    return replaceObjectBoolean(text, hit.start, hit.end, field, value)
}

export function setJsonBooleanWhere(
    text: string,
    match: (objectText: string, path: readonly PathPart[]) => boolean,
    field: string,
    value: boolean,
): string {
    const done = new Set<string>()
    let next = text
    for (let guard = 0; guard < 100; guard++) {
        const hits = collectJsonObjects(next).filter((object) => {
            const key = object.path.map(String).join('\0')
            return !done.has(key) && match(next.slice(object.start, object.end), object.path)
        })
        if (hits.length === 0) {
            if (done.size === 0) throw new Error(NOT_FOUND)
            return next
        }
        const hit = hits.reduce((best, item) => item.start > best.start ? item : best)
        done.add(hit.path.map(String).join('\0'))
        next = replaceObjectBoolean(next, hit.start, hit.end, field, value)
    }
    throw new Error(NOT_FOUND)
}

function replaceObjectBoolean(text: string, start: number, end: number, field: string, value: boolean): string {
    const objectText = text.slice(start, end)
    const literal = value ? 'true' : 'false'
    let i = 1
    while (i < objectText.length) {
        i = skip(objectText, i)
        if (objectText[i] === '}') break
        const key = readString(objectText, i)
        i = skip(objectText, key.end)
        if (objectText[i] !== ':') throw new Error(NOT_FOUND)
        const valueAt = skip(objectText, i + 1)
        if (key.value === field) {
            if (objectText.startsWith('true', valueAt) || objectText.startsWith('false', valueAt)) {
                const width = objectText.startsWith('true', valueAt) ? 4 : 5
                const at = start + valueAt
                return text.slice(0, at) + literal + text.slice(at + width)
            }
            throw new Error(NOT_FOUND)
        }
        i = parseValue(objectText, valueAt, () => undefined, [])
        i = skip(objectText, i)
        if (objectText[i] === ',') i++
    }
    const interior = insertBoolean(objectText.slice(1, -1), field, value)
    return text.slice(0, start + 1) + interior + text.slice(end - 1)
}

export function setTomlBoolean(
    text: string,
    header: string,
    field: string,
    value: boolean,
    pick?: (section: string) => boolean,
): string {
    const newline = text.includes('\r\n') ? '\r\n' : '\n'
    const lines = text.split(/\r?\n/)
    const headers = new Set([`[${header}]`, `[[${header}]]`])
    const fieldLine = new RegExp(`^(\\s*${field}\\s*=\\s*)(true|false)(\\s*(?:#.*)?)?$`)
    const hits: number[] = []
    for (let index = 0; index < lines.length; index++) {
        if (!headers.has(lines[index].trim())) continue
        let end = index + 1
        while (end < lines.length && !/^\s*\[\[?[^\]]+\]\]?\s*(?:#.*)?$/.test(lines[end])) end++
        const section = lines.slice(index, end).join('\n')
        if (!pick || pick(section)) hits.push(index)
    }
    if (hits.length === 0) throw new Error(NOT_FOUND)
    for (const index of hits.reverse()) {
        let end = index + 1
        while (end < lines.length && !/^\s*\[\[?[^\]]+\]\]?\s*(?:#.*)?$/.test(lines[end])) end++
        let replaced = false
        for (let line = index + 1; line < end; line++) {
            const match = fieldLine.exec(lines[line])
            if (!match) continue
            lines[line] = `${match[1]}${value ? 'true' : 'false'}${match[3] ?? ''}`
            replaced = true
            break
        }
        if (!replaced) lines.splice(index + 1, 0, `${field} = ${value ? 'true' : 'false'}`)
    }
    return lines.join(newline)
}

export function setFrontmatterBoolean(text: string, field: string, value: boolean): string {
    const literal = value ? 'true' : 'false'
    const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
    if (!match || match.index !== 0) {
        return `---\n${field}: ${literal}\n---\n${text}`
    }
    const block = match[1] ?? ''
    const line = new RegExp(`^(${field}:\\s*)(?:true|false)\\s*$`, 'm')
    const nextBlock = line.test(block) ? block.replace(line, `$1${literal}`) : `${block}\n${field}: ${literal}`
    return `${text.slice(0, match.index)}---\n${nextBlock}\n---${text.slice(match.index + match[0].length)}`
}

export function writeTextAtomic(path: string, text: string): void {
    const tmp = join(dirname(path), `.${process.pid}-${Date.now()}.tmp`)
    try {
        writeFileSync(tmp, text, 'utf8')
        renameSync(tmp, path)
    } catch (error) {
        rmSync(tmp, { force: true })
        throw error
    }
}
