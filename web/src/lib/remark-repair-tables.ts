/**
 * Remark plugin that repairs GFM tables where the separator row has fewer
 * columns than the header row.
 *
 * Background: remark-gfm 4.x follows the GFM spec strictly — if the delimiter
 * row has fewer cells than the header row, the entire block is degraded to a
 * paragraph (no table node is produced at all). The previous approach of
 * visiting `table` AST nodes could never trigger because remark-gfm never
 * produced one. This version operates at the source level: it scans file.value
 * for broken separator rows and pads them BEFORE remark-gfm parses, so the
 * table is preserved with all columns intact.
 */

import type { Processor } from 'unified'
import type { Root } from 'mdast'
import type { VFile } from 'vfile'

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Escape unescaped pipe characters (`|` preceded by an even number of `\`)
 *  inside a backtick code span body so `remark-gfm` does not split the cell
 *  at `|` before inline code spans are parsed (GFM §4.10). `mdast-util-gfm-table`
 *  automatically strips the `\` when constructing the `inlineCode` node value. */
function escapePipesInCodeSpanContent(content: string): string {
    let out = ''
    let backslashes = 0
    for (let i = 0; i < content.length; i++) {
        const ch = content[i]
        if (ch === '\\') {
            backslashes++
            out += ch
            continue
        }
        if (ch === '|' && backslashes % 2 === 0) {
            out += '\\|'
        } else {
            out += ch
        }
        backslashes = 0
    }
    return out
}

/** Walk single-line backtick code spans per CommonMark §6.1 and apply `transformInner`. */
function transformInlineCodeSpans(
    line: string,
    transformInner: (openTicks: string, inner: string, closeTicks: string) => string,
): string {
    if (!line.includes('`')) return line
    let out = ''
    let i = 0
    while (i < line.length) {
        const ch = line[i]
        if (ch === '\\' && i + 1 < line.length) {
            out += line.slice(i, i + 2)
            i += 2
            continue
        }
        if (ch === '`') {
            let openEnd = i
            while (openEnd < line.length && line[openEnd] === '`') {
                openEnd++
            }
            const tickLen = openEnd - i
            let closeStart = -1
            let search = openEnd
            while (search < line.length) {
                if (line[search] !== '`') {
                    search++
                    continue
                }
                let runEnd = search
                while (runEnd < line.length && line[runEnd] === '`') {
                    runEnd++
                }
                if (runEnd - search === tickLen) {
                    closeStart = search
                    break
                }
                search = runEnd
            }
            if (closeStart !== -1) {
                const inner = line.slice(openEnd, closeStart)
                out += transformInner(
                    line.slice(i, openEnd),
                    inner,
                    line.slice(closeStart, closeStart + tickLen),
                )
                i = closeStart + tickLen
                continue
            }
            out += line.slice(i, openEnd)
            i = openEnd
            continue
        }
        out += ch
        i++
    }
    return out
}

/** Escape unescaped `|` inside inline backtick code spans on a single table row line. */
function escapeCodeSpanPipes(line: string): string {
    if (!line.includes('`') || !line.includes('|')) return line
    return transformInlineCodeSpans(
        line,
        (open, inner, close) => open + escapePipesInCodeSpanContent(inner) + close,
    )
}

/** Strip inline math spans (`\[..\]`, `\(..\)`, `$$..$$`, `$..$`) so `|` inside
 *  math (e.g. `$|\Delta|$`) is not counted as a table column delimiter before
 *  `remarkLatexBracketMath` masks it. */
function stripInlineMathSpans(line: string): string {
    return line
        .replace(/\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|(?<!\\)\$\$[^$\n]+?(?<!\\)\$\$/g, '\x00')
        .replace(/(?<!\\)\$(?!\s)(?![0-9]+(?:\.[0-9]+)?(?:\s|$|\|))([^$\n]*?\S)(?<!\\)\$(?![0-9A-Za-z])/g, '\x00')
}

/** Count pipe-delimited cells in one table row line of raw source.
 *  Strips backtick code spans and inline math spans first so pipes inside them
 *  are not counted. Skips escaped pipes (\|) which are literal characters, not cell boundaries. */
function countSourceCells(line: string): number {
    const withoutCode = transformInlineCodeSpans(line.trim(), () => '\x00')
    const withoutMath = stripInlineMathSpans(withoutCode)
    const inner = withoutMath.startsWith('|') ? withoutMath.slice(1) : withoutMath
    const stripped = inner.endsWith('|') ? inner.slice(0, -1) : inner
    let cells = 1
    let escaped = false
    for (const ch of stripped) {
        if (escaped) { escaped = false; continue }
        if (ch === '\\') { escaped = true; continue }
        if (ch === '|') cells++
    }
    return cells
}

/** Returns true if every pipe-delimited cell in the line matches the GFM separator pattern. */
function isSeparatorLine(line: string): boolean {
    const trimmed = line.trim()
    if (!trimmed.includes('-')) return false
    const inner = trimmed.startsWith('|') ? trimmed.slice(1) : trimmed
    const stripped = inner.endsWith('|') ? inner.slice(0, -1) : inner
    const cells = stripped.split('|')
    return cells.length > 0 && cells.every(c => /^\s*:?-+:?\s*$/.test(c))
}

/** Count cells in a separator line (returns null if line is not a separator). */
function countSeparatorCells(line: string): number | null {
    if (!isSeparatorLine(line)) return null
    const trimmed = line.trim()
    const inner = trimmed.startsWith('|') ? trimmed.slice(1) : trimmed
    const stripped = inner.endsWith('|') ? inner.slice(0, -1) : inner
    return stripped.split('|').length
}

/**
 * Pad `sepLine` to have `targetCols` cells, preserving any existing alignment
 * hints in the cells that are already there. Returns the repaired line, or
 * null if the line already has enough cells or is not a valid separator.
 */
function padSeparatorLine(sepLine: string, targetCols: number): string | null {
    const trimmed = sepLine.trim()
    if (!trimmed) return null

    const hasLeading = trimmed.startsWith('|')
    const hasTrailing = trimmed.endsWith('|')

    const inner = hasLeading ? trimmed.slice(1) : trimmed
    const stripped = inner.endsWith('|') ? inner.slice(0, -1) : inner
    const cells = stripped.split('|')

    if (cells.length >= targetCols) return null
    if (!cells.every(c => /^\s*:?-+:?\s*$/.test(c))) return null

    const extra = Array(targetCols - cells.length).fill(' --- ')
    const paddedInner = [...cells, ...extra].join('|')
    return (hasLeading ? '|' : '') + paddedInner + (hasTrailing ? '|' : '')
}

// ── String-level preprocessor ─────────────────────────────────────────────────

/**
 * Scan raw markdown for broken table separators and pad them in-place.
 * This must run before any markdown parser sees the source, because
 * remark-gfm 4.x degrades a mismatched-separator table block to a paragraph.
 *
 * Tracks fenced code blocks so table-like lines inside ``` or ~~~ fences are
 * never modified. Also preserves leading whitespace when replacing the
 * separator line so indented tables are not affected.
 */
export function repairMarkdownTables(source: string): string {
    const lines = source.split('\n')
    let changed = false
    // Track fence character AND opening length: a ```` fence must not be closed
    // by ``` (GFM §4.5: closer must match the opening marker family AND be at
    // least as long). Also ignore the opposite marker family (backtick vs tilde).
    let fenceChar: '`' | '~' | null = null
    let fenceLength = 0

    for (let i = 0; i < lines.length; i++) {
        // Capture marker + everything after so we can check the closing-fence rule:
        // openers may have an info string (```ts), but closers must be whitespace-only.
        const fenceMatch = lines[i].match(/^ {0,3}(`{3,}|~{3,})(.*)$/)
        if (fenceMatch) {
            const ch = fenceMatch[1][0] as '`' | '~'
            const len = fenceMatch[1].length
            const rest = fenceMatch[2]
            if (fenceChar === null) {
                fenceChar = ch
                fenceLength = len
            } else if (ch === fenceChar && len >= fenceLength && /^\s*$/.test(rest)) {
                fenceChar = null
                fenceLength = 0
            }
            continue
        }
        if (fenceChar !== null) continue
        if (i === 0) continue

        const sep = lines[i]
        if (!isSeparatorLine(sep)) continue

        const hdr = lines[i - 1]
        // Only repair when the header row starts with | (the common LLM output form)
        if (!hdr.trim().startsWith('|') || isSeparatorLine(hdr)) continue

        const repairedHdr = escapeCodeSpanPipes(hdr)
        if (repairedHdr !== hdr) {
            lines[i - 1] = repairedHdr
            changed = true
        }

        const headerCols = countSourceCells(repairedHdr)
        const sepCols = countSeparatorCells(sep)
        if (sepCols !== null && sepCols < headerCols) {
            const repaired = padSeparatorLine(sep, headerCols)
            if (repaired !== null) {
                // Preserve original leading whitespace so indented tables are unchanged
                const prefix = sep.match(/^\s*/)?.[0] ?? ''
                lines[i] = prefix + repaired
                changed = true
            }
        }

        // Also escape unescaped pipes inside backtick code spans in contiguous body rows
        for (let j = i + 1; j < lines.length; j++) {
            if (/^ {0,3}(`{3,}|~{3,})/.test(lines[j])) break
            const row = lines[j]
            if (!row.trim().startsWith('|') || isSeparatorLine(row)) break
            const repairedRow = escapeCodeSpanPipes(row)
            if (repairedRow !== row) {
                lines[j] = repairedRow
                changed = true
            }
        }
    }

    return changed ? lines.join('\n') : source
}

// ── Plugin ───────────────────────────────────────────────────────────────────

export default function remarkRepairTables(this: Processor) {
    const processor = this
    return (tree: Root, file: VFile) => {
        const original = String(file.value)
        const repaired = repairMarkdownTables(original)
        if (repaired === original) return

        // Re-parse with the repaired source so remark-gfm produces table nodes
        // processor.parse() runs only the parse phase, not transformers
        file.value = repaired
        const newTree = processor.parse(repaired) as Root
        Object.assign(tree, newTree)
    }
}
