interface MarkdownNode {
    type: string
    value?: string
    children?: MarkdownNode[]
    position?: {
        start?: { offset?: number }
        end?: { offset?: number }
    }
    data?: unknown
}

interface MarkdownFile {
    value?: unknown
}

const LATEX_DELIMITER = /\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)/g
const MARKDOWN_ESCAPE = /\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g
const OPAQUE_NODE_TYPES = new Set([
    'code',
    'inlineCode',
    'math',
    'inlineMath',
    'link',
    'linkReference',
    'html',
])

function decodeMarkdownEscapes(value: string): string {
    return value.replace(MARKDOWN_ESCAPE, '$1')
}

function mathNode(type: 'math' | 'inlineMath', value: string): MarkdownNode {
    if (type === 'math') {
        return {
            type,
            value,
            data: {
                hName: 'pre',
                hChildren: [{
                    type: 'element',
                    tagName: 'code',
                    properties: { className: ['language-math', 'math-display'] },
                    children: [{ type: 'text', value }],
                }],
            },
        }
    }

    return {
        type,
        value,
        data: {
            hName: 'code',
            hProperties: { className: ['language-math', 'math-inline'] },
            hChildren: [{ type: 'text', value }],
        },
    }
}

interface MathMatch {
    index: number
    length: number
    type: 'math' | 'inlineMath'
    value: string
}

function isWhitespace(char: string | undefined): boolean {
    return char === undefined || /\s/.test(char)
}

/**
 * Single-dollar inline math with Pandoc `tex_math_dollars` boundaries: the opening `$` is
 * followed by non-whitespace, the closing `$` on the same line is preceded by non-whitespace
 * and not followed by a digit. Prose such as "$200/mo and the bill is $80" therefore stays text.
 */
function findDollarMath(raw: string): MathMatch[] {
    const matches: MathMatch[] = []
    let open = -1
    for (let index = 0; index < raw.length; index += 1) {
        const char = raw[index]
        if (char === '\n') {
            open = -1
            continue
        }
        if (char !== '$') continue
        const prev = raw[index - 1]
        const next = raw[index + 1]
        if (prev === '\\' || prev === '$' || next === '$') continue
        if (open >= 0 && !isWhitespace(prev) && !/[0-9]/.test(next ?? '')) {
            const value = raw.slice(open + 1, index)
            matches.push({ index: open, length: index - open + 1, type: 'inlineMath', value })
            open = -1
            continue
        }
        if (!isWhitespace(next) && !/[\p{L}\p{N}]/u.test(prev ?? '')) open = index
    }
    return matches
}

function findBracketMath(raw: string): MathMatch[] {
    return [...raw.matchAll(LATEX_DELIMITER)].map((match) => {
        const displayValue = match[1]
        return {
            index: match.index,
            length: match[0].length,
            type: displayValue === undefined ? 'inlineMath' : 'math',
            value: displayValue ?? match[2] ?? '',
        }
    })
}

function splitTextNode(node: MarkdownNode, source: string): MarkdownNode[] {
    const start = node.position?.start?.offset
    const end = node.position?.end?.offset
    if (typeof start !== 'number' || typeof end !== 'number') return [node]

    const raw = source.slice(start, end)
    if (!raw.includes('\\[') && !raw.includes('\\(') && !raw.includes('$')) return [node]
    if (decodeMarkdownEscapes(raw) !== node.value) return [node]

    const candidates = [...findBracketMath(raw), ...findDollarMath(raw)].sort((a, b) => a.index - b.index)
    const matches: MathMatch[] = []
    for (const candidate of candidates) {
        const last = matches[matches.length - 1]
        if (last && candidate.index < last.index + last.length) continue
        matches.push(candidate)
    }
    if (matches.length === 0) return [node]

    const children: MarkdownNode[] = []
    let cursor = 0
    for (const match of matches) {
        if (match.index > cursor) {
            children.push({ type: 'text', value: decodeMarkdownEscapes(raw.slice(cursor, match.index)) })
        }
        const value = match.value.trim()
        const literal = raw.slice(match.index, match.index + match.length)
        children.push(value.length > 0
            ? mathNode(match.type, value)
            : { type: 'text', value: decodeMarkdownEscapes(literal) })
        cursor = match.index + match.length
    }

    if (cursor < raw.length) {
        children.push({ type: 'text', value: decodeMarkdownEscapes(raw.slice(cursor)) })
    }
    return children
}

function hoistedDisplayMath(node: MarkdownNode): MarkdownNode[] | null {
    const children = node.children ?? []
    const isDisplayOrWhitespace = (child: MarkdownNode) => child.type === 'math'
        || (child.type === 'text' && (child.value ?? '').trim().length === 0)
    if (!children.some((child) => child.type === 'math')) return null
    if (!children.every(isDisplayOrWhitespace)) return null
    return children.filter((child) => child.type === 'math')
}

function transformContainer(node: MarkdownNode, source: string): void {
    if (!node.children) return

    const children: MarkdownNode[] = []
    for (const child of node.children) {
        if (OPAQUE_NODE_TYPES.has(child.type)) {
            children.push(child)
            continue
        }
        if (child.type === 'text') {
            children.push(...splitTextNode(child, source))
            continue
        }

        transformContainer(child, source)
        const displayMath = child.type === 'paragraph' ? hoistedDisplayMath(child) : null
        children.push(...(displayMath ?? [child]))
    }
    node.children = children
}

/** Convert literal TeX delimiters (`\[..\]`, `\(..\)`, single-line `$..$`) before CommonMark escape handling is lost downstream. */
export default function remarkLatexBracketMath() {
    return (tree: MarkdownNode, file: MarkdownFile): void => {
        if (typeof file.value !== 'string') return
        transformContainer(tree, file.value)
    }
}
