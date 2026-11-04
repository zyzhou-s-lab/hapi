interface MarkdownNode {
    type: string
    value?: string
    url?: string
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

interface MarkdownProcessor {
    parse?: (value: string) => MarkdownNode
}

interface OffsetRange {
    start: number
    end: number
}

interface MathMatch {
    index: number
    length: number
    type: 'math' | 'inlineMath'
    value: string
}

const EXPLICIT_MATH_DELIMITER = /\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|(?<!\\)\$\$([\s\S]+?)(?<!\\)\$\$/g
const PLACEHOLDER_PATTERN = /\uE000HAPIMATH(\d+)\uE000/g
const CURRENCY_PROSE_PREFIX = /^[0-9][0-9,]*(?:\.[0-9]+)?(?:\/[a-zA-Z]+|[kKmMbB])?(?:[,.;:!?)）(（\]}—–-]|\s+(?:[a-zA-Z]{2,}|[,.;:!?(（\[—–-]))/
const NON_CLOSING_PREV_CHAR = /^[([（【「『“‘，：；,:;*]$/
const STANDALONE_LINE_PREFIX = /^\s*(?:>\s*)*(?:(?:[-*+]|\d+[.)])\s+)?$/
const STANDALONE_LINE_SUFFIX = /^\s*[，。；：,.;:]?\s*$/
const CLAUSE_BOUNDARY_PREFIX = /(?:^\s*(?:>\s*)*(?:(?:[-*+]|\d+[.)])\s+)?|[：:，,。.;；]\s*|(?:为|即|有|满足|记为|定义为|写作|等于)\s*)$/
const CLAUSE_BOUNDARY_SUFFIX = /^\s*(?:$|[，,。.;；：:!！?？])/
const EQUATION_RELATION = /=|\\(?:approx|equiv|sim|simeq|cong|neq|ne|le|leq|ge|geq|propto|to|rightarrow|Rightarrow|mapsto)\b/
const DISPLAY_HEAVY_OPERATOR = /\\(?:d?frac|binom|sum|prod|int|oint|bigcup|bigcap|lim|begin\{)(?![a-zA-Z])/
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

function isWhitespace(char: string | undefined): boolean {
    return char === undefined || /\s/.test(char)
}

function isEscaped(raw: string, index: number): boolean {
    let backslashes = 0
    for (let cursor = index - 1; cursor >= 0 && raw[cursor] === '\\'; cursor -= 1) {
        backslashes += 1
    }
    return backslashes % 2 === 1
}

function hasUnclosedInlineWrapper(before: string, after: string): boolean {
    let parens = 0
    for (const char of before) {
        if (char === '(' || char === '（' || char === '[' || char === '【') parens += 1
        else if ((char === ')' || char === '）' || char === ']' || char === '】') && parens > 0) parens -= 1
    }
    if (parens > 0) return true
    const boldBefore = (before.match(/\*\*/g) ?? []).length
    const boldAfter = (after.match(/\*\*/g) ?? []).length
    return boldBefore % 2 === 1 && boldAfter > 0
}

function shouldPromoteToDisplayMath(value: string, line: string, openIndex: number, closeIndex: number): boolean {
    const trimmed = value.trim()
    if (trimmed.length < 12) return false

    const before = line.slice(0, openIndex)
    const after = line.slice(closeIndex)
    if (
        STANDALONE_LINE_PREFIX.test(before)
        && STANDALONE_LINE_SUFFIX.test(after)
        && (EQUATION_RELATION.test(trimmed) || DISPLAY_HEAVY_OPERATOR.test(trimmed))
    ) {
        return true
    }

    if (hasUnclosedInlineWrapper(before, after)) return false
    if (!CLAUSE_BOUNDARY_PREFIX.test(before) || !CLAUSE_BOUNDARY_SUFFIX.test(after)) return false
    if (!EQUATION_RELATION.test(trimmed) || !DISPLAY_HEAVY_OPERATOR.test(trimmed)) return false
    return trimmed.length >= 45
}

function canOpenDollarMath(line: string, index: number): boolean {
    const prev = line[index - 1]
    const next = line[index + 1]
    if (isWhitespace(next) || /^[A-Za-z0-9]$/.test(prev ?? '')) return false
    if (/[0-9]/.test(next ?? '') && CURRENCY_PROSE_PREFIX.test(line.slice(index + 1))) return false
    return true
}

function findDollarMathInSegment(segment: string, segmentOffset: number): MathMatch[] {
    const matches: MathMatch[] = []
    let lineStart = 0
    for (let cursor = 0; cursor <= segment.length; cursor += 1) {
        if (cursor < segment.length && segment[cursor] !== '\n') continue
        const line = segment.slice(lineStart, cursor)
        let open = -1
        for (let index = 0; index < line.length; index += 1) {
            if (line[index] !== '$' || isEscaped(line, index)) continue
            const prev = line[index - 1]
            const next = line[index + 1]
            if (prev === '$' || next === '$') continue

            if (
                open >= 0
                && !isWhitespace(prev)
                && !NON_CLOSING_PREV_CHAR.test(prev ?? '')
                && !/^[0-9A-Za-z]$/.test(next ?? '')
            ) {
                const value = line.slice(open + 1, index)
                if (value.trim().length > 0) {
                    const type = shouldPromoteToDisplayMath(value, line, open, index + 1) ? 'math' : 'inlineMath'
                    matches.push({
                        index: segmentOffset + lineStart + open,
                        length: index - open + 1,
                        type,
                        value,
                    })
                }
                open = -1
                continue
            }

            if (canOpenDollarMath(line, index)) {
                open = index
            }
        }
        lineStart = cursor + 1
    }
    return matches
}

function findMathInUnexcludedSlice(raw: string, baseOffset: number): MathMatch[] {
    const matches: MathMatch[] = []
    let cursor = 0
    EXPLICIT_MATH_DELIMITER.lastIndex = 0
    for (const match of raw.matchAll(EXPLICIT_MATH_DELIMITER)) {
        const matchIndex = match.index ?? 0
        if (isEscaped(raw, matchIndex)) continue
        if (matchIndex > cursor) {
            matches.push(...findDollarMathInSegment(raw.slice(cursor, matchIndex), baseOffset + cursor))
        }
        const bracketDisplay = match[1]
        const parenInline = match[2]
        const doubleDollar = match[3]
        const value = bracketDisplay ?? parenInline ?? doubleDollar ?? ''
        if (value.trim().length > 0) {
            const isInlineParen = parenInline !== undefined
            const type = !isInlineParen ? 'math' : 'inlineMath'
            matches.push({
                index: baseOffset + matchIndex,
                length: match[0].length,
                type,
                value,
            })
        }
        cursor = matchIndex + match[0].length
    }
    if (cursor < raw.length) {
        matches.push(...findDollarMathInSegment(raw.slice(cursor), baseOffset + cursor))
    }
    return matches
}

function collectExcludedRanges(node: MarkdownNode, ranges: OffsetRange[]): void {
    const start = node.position?.start?.offset
    const end = node.position?.end?.offset
    if (
        typeof start === 'number'
        && typeof end === 'number'
        && (node.type === 'code' || node.type === 'inlineCode' || node.type === 'html')
    ) {
        ranges.push({ start, end })
        return
    }

    if (
        node.type === 'link'
        && typeof node.url === 'string'
        && /^(?:https?:|mailto:|\/|\.\.?\/)/i.test(node.url)
        && typeof start === 'number'
        && typeof end === 'number'
    ) {
        const lastChildEnd = node.children?.[node.children.length - 1]?.position?.end?.offset
        const firstChild = node.children?.[0]
        const isAutolink = node.children?.length === 1 && firstChild?.type === 'text' && firstChild.value === node.url
        if (isAutolink) {
            ranges.push({ start, end })
            return
        }
        if (typeof lastChildEnd === 'number' && lastChildEnd < end) {
            ranges.push({ start: lastChildEnd, end })
        }
    }

    for (const child of node.children ?? []) {
        collectExcludedRanges(child, ranges)
    }
}

function findAllMathMatches(tree: MarkdownNode, source: string): MathMatch[] {
    const rawRanges: OffsetRange[] = []
    collectExcludedRanges(tree, rawRanges)
    rawRanges.sort((a, b) => a.start - b.start)

    const mergedRanges: OffsetRange[] = []
    for (const range of rawRanges) {
        const last = mergedRanges[mergedRanges.length - 1]
        if (last && range.start <= last.end) {
            last.end = Math.max(last.end, range.end)
        } else {
            mergedRanges.push({ ...range })
        }
    }

    const matches: MathMatch[] = []
    let cursor = 0
    for (const range of mergedRanges) {
        if (range.start > cursor) {
            matches.push(...findMathInUnexcludedSlice(source.slice(cursor, range.start), cursor))
        }
        cursor = Math.max(cursor, range.end)
    }
    if (cursor < source.length) {
        matches.push(...findMathInUnexcludedSlice(source.slice(cursor), cursor))
    }
    return matches
}

function splitPlaceholderText(value: string, matches: MathMatch[]): MarkdownNode[] | null {
    if (!value.includes('\uE000HAPIMATH')) return null
    const nodes: MarkdownNode[] = []
    let cursor = 0
    PLACEHOLDER_PATTERN.lastIndex = 0
    for (const match of value.matchAll(PLACEHOLDER_PATTERN)) {
        const matchIndex = match.index ?? 0
        if (matchIndex > cursor) {
            nodes.push({ type: 'text', value: value.slice(cursor, matchIndex) })
        }
        const mathEntry = matches[Number(match[1])]
        if (mathEntry) {
            nodes.push(mathNode(mathEntry.type, mathEntry.value.trim()))
        } else {
            nodes.push({ type: 'text', value: match[0] })
        }
        cursor = matchIndex + match[0].length
    }
    if (cursor < value.length) {
        nodes.push({ type: 'text', value: value.slice(cursor) })
    }
    return nodes
}

function trimParagraphSegment(children: MarkdownNode[], trimLeadingPunctuation: boolean): MarkdownNode[] {
    const cloned = children.map((child) => ({ ...child }))
    while (cloned.length > 0) {
        const first = cloned[0]
        if (first.type !== 'text') break
        const pattern = trimLeadingPunctuation ? /^[\s，。；、,.;:]+/ : /^\s+/
        const nextValue = (first.value ?? '').replace(pattern, '')
        if (nextValue.length === 0) {
            cloned.shift()
            continue
        }
        first.value = nextValue
        break
    }
    while (cloned.length > 0) {
        const last = cloned[cloned.length - 1]
        if (last.type !== 'text') break
        const nextValue = (last.value ?? '').replace(/\s+$/, '')
        if (nextValue.length === 0) {
            cloned.pop()
            continue
        }
        last.value = nextValue
        break
    }
    return cloned
}

function splitParagraphOnDisplayMath(paragraph: MarkdownNode): MarkdownNode[] {
    const children = paragraph.children ?? []
    if (!children.some((child) => child.type === 'math')) return [paragraph]

    const blocks: MarkdownNode[] = []
    let currentSegment: MarkdownNode[] = []
    let afterDisplayMath = false

    for (const child of children) {
        if (child.type === 'math') {
            const trimmed = trimParagraphSegment(currentSegment, afterDisplayMath)
            if (trimmed.length > 0) {
                blocks.push({ type: 'paragraph', children: trimmed })
            }
            blocks.push(child)
            currentSegment = []
            afterDisplayMath = true
            continue
        }
        currentSegment.push(child)
    }

    const trailing = trimParagraphSegment(currentSegment, afterDisplayMath)
    if (trailing.length > 0) {
        blocks.push({ type: 'paragraph', children: trailing })
    }
    return blocks
}

function restorePlaceholdersInTree(node: MarkdownNode, matches: MathMatch[]): void {
    if (!node.children) return

    const nextChildren: MarkdownNode[] = []
    for (const child of node.children) {
        if (child.type === 'text' && typeof child.value === 'string') {
            const expanded = splitPlaceholderText(child.value, matches)
            if (expanded) {
                nextChildren.push(...expanded)
                continue
            }
        }
        restorePlaceholdersInTree(child, matches)
        if (child.type === 'paragraph') {
            nextChildren.push(...splitParagraphOnDisplayMath(child))
            continue
        }
        nextChildren.push(child)
    }
    node.children = nextChildren
}

/** Convert literal TeX delimiters (`\[..\]`, `\(..\)`, `$$..$$`, single-line `$..$`) before CommonMark emphasis/escape handling corrupts TeX syntax. */
export default function remarkLatexBracketMath(this: MarkdownProcessor | void) {
    const processor = this
    return (tree: MarkdownNode, file: MarkdownFile): void => {
        if (typeof file.value !== 'string') return
        const source = file.value
        if (!source.includes('\\[') && !source.includes('\\(') && !source.includes('$')) return

        const matches = findAllMathMatches(tree, source)
        if (matches.length === 0) return

        let masked = ''
        let cursor = 0
        for (let i = 0; i < matches.length; i += 1) {
            const match = matches[i]
            masked += source.slice(cursor, match.index)
            masked += `\uE000HAPIMATH${i}\uE000`
            cursor = match.index + match.length
        }
        masked += source.slice(cursor)

        if (typeof processor?.parse === 'function') {
            const reparsed = processor.parse(masked)
            Object.assign(tree, reparsed)
        }
        restorePlaceholdersInTree(tree, matches)
    }
}
