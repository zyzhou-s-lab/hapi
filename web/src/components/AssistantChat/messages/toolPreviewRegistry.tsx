import { type ComponentType, useState } from 'react'
import { isObject } from '@hapi/protocol'
import {
    extractDomain,
    extractResultText,
    extractWebSearchResults,
    isWebFetchTool,
    isWebSearchTool,
    normalizeReadFilePath,
    parseAgentUriTarget,
    type TurnStepPreview,
    type TurnToolRow,
    type TurnToolStepDescriptor,
    type TurnDiffLine,
} from '@/components/AssistantChat/messages/turnBlockModel'
import { TimelineTodoChecklistCard } from '@/components/AssistantChat/messages/TurnTodoSection'
import { ToolDetailDialogContent } from '@/components/ToolCard/ToolCard'
import { projectToolTodoSnapshot } from '@/chat/projections/todoProjection'
import type { ChatToolCall } from '@/chat/types'
import { getInputStringAny, truncate } from '@/lib/toolInputUtils'
import { cn } from '@/lib/utils'
import type { SessionMetadataSummary } from '@/types/api'

export type ToolStepMatchContext = {
    readonly row: TurnToolRow
    readonly tool: ChatToolCall
    readonly rawName: string
    readonly resolvedName: string
    readonly isRunning: boolean
    readonly isQueued: boolean
    readonly zh: boolean
    readonly activeIntent: string | null
}

export type ToolPreviewRenderProps<P extends TurnStepPreview = TurnStepPreview> = {
    readonly preview: P
    readonly metadata: SessionMetadataSummary | null
}

export interface ToolStepPreviewPlugin<K extends TurnStepPreview['kind'] = TurnStepPreview['kind']> {
    readonly kind: K
    matches(ctx: ToolStepMatchContext): boolean
    describe(ctx: ToolStepMatchContext): TurnToolStepDescriptor & {
        preview: Extract<TurnStepPreview, { kind: K }>
    }
    readonly PreviewComponent: ComponentType<ToolPreviewRenderProps<Extract<TurnStepPreview, { kind: K }>>>
}

function firstLine(text: string): string {
    const line = text.split(/\r?\n/).find((part) => part.trim().length > 0) ?? ''
    return line.trim()
}

function sameText(left: string | null, right: string | null): boolean {
    if (!left || !right) return false
    return left.trim() === right.trim()
}

function intentSentence(tool: ChatToolCall): string | null {
    const command = getInputStringAny(tool.input, ['command', 'cmd', 'file_path', 'path', 'pattern'])
    const candidates = [
        tool.nativeTitle,
        getInputStringAny(tool.input, ['i', 'intent', 'description']),
        tool.description,
    ]
    for (const candidate of candidates) {
        const text = typeof candidate === 'string' ? candidate.trim() : ''
        if (!text || sameText(text, command)) continue
        return firstLine(text)
    }
    return null
}

function basename(path: string): string {
    const parts = path.split(/[\\/]/).filter((part) => part.length > 0)
    return parts[parts.length - 1] ?? path
}

function formatCompactCount(value: number): string {
    if (value >= 1000) return `${Math.round(value / 1000)}k`
    return String(value)
}

export function CopyButton(props: { text: string; label?: string }) {
    const [copied, setCopied] = useState(false)
    const label = props.label ?? 'Copy command'
    return (
        <button
            type="button"
            onClick={(e) => {
                e.stopPropagation()
                void navigator.clipboard?.writeText(props.text)
                setCopied(true)
            }}
            className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
            title={label}
            aria-label={label}
        >
            {copied ? (
                <span
                    className="turn-copy-feedback"
                    onAnimationEnd={() => setCopied(false)}
                >
                    Copied
                </span>
            ) : (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
            )}
        </button>
    )
}

function DomainFaviconBadge(props: { domain: string }) {
    const letter = (props.domain.replace(/^www\./, '')[0] ?? 'W').toUpperCase()
    return (
        <span
            aria-hidden="true"
            className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border border-[var(--app-border)] bg-[var(--app-subtle-bg)] text-[10px] font-semibold text-[var(--app-hint)]"
        >
            {letter}
        </span>
    )
}

function BashPreviewCard({ preview }: ToolPreviewRenderProps<Extract<TurnStepPreview, { kind: 'bash' }>>) {
    return (
        <div
            className="mt-1.5 mb-2 overflow-hidden rounded-lg border border-[var(--app-border)] bg-[var(--app-subtle-bg)]/45 text-xs"
            data-testid="turn-level2-bash"
        >
            <div className="flex items-center justify-between border-b border-[var(--app-border)]/70 px-3 py-1.5 text-[11px] font-medium text-[var(--app-hint)]">
                <span>Bash</span>
                <CopyButton text={preview.command} />
            </div>
            <div className="px-3 py-2 font-mono text-[12px] leading-5 text-[var(--app-fg)] break-all">
                {preview.command}
            </div>
            {preview.output ? (
                <div
                    className={cn(
                        'max-h-48 overflow-y-auto border-t border-[var(--app-border)]/70 bg-black/[0.03] dark:bg-black/25 px-3 py-2 font-mono text-[11.5px] leading-5 whitespace-pre-wrap',
                        preview.isError ? 'text-[var(--app-badge-error-text)]' : 'text-[var(--app-hint)]'
                    )}
                >
                    {preview.output}
                </div>
            ) : null}
        </div>
    )
}

function WebFetchPreviewCard({ preview }: ToolPreviewRenderProps<Extract<TurnStepPreview, { kind: 'web-fetch' }>>) {
    return (
        <div
            className="mt-1.5 mb-2 overflow-hidden rounded-lg border border-[var(--app-border)] bg-[var(--app-subtle-bg)]/45 p-3 text-xs"
            data-testid="turn-level2-webfetch"
        >
            <div className="font-medium text-[13px] text-[var(--app-fg)]">{preview.title}</div>
            {preview.url ? (
                <a
                    href={preview.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-0.5 block truncate text-[12px] text-[var(--app-hint)] hover:text-[var(--app-link)] hover:underline"
                >
                    {preview.url}
                </a>
            ) : null}
            {preview.excerpt ? (
                <div className="mt-2 line-clamp-3 text-[12px] leading-relaxed text-[var(--app-hint)]">
                    {preview.excerpt}
                </div>
            ) : null}
            <div className="mt-2 text-[11px] tabular-nums text-[var(--app-hint)]">
                {preview.sizeLabel}
                {preview.linesCount > 0 ? ` · ${preview.linesCount} lines` : ''}
            </div>
        </div>
    )
}

function WebSearchPreviewCard({ preview }: ToolPreviewRenderProps<Extract<TurnStepPreview, { kind: 'web-search' }>>) {
    return (
        <div
            className="mt-1.5 mb-2 overflow-hidden rounded-lg border border-[var(--app-border)] bg-[var(--app-subtle-bg)]/45 p-1.5 text-xs"
            data-testid="turn-level2-websearch"
        >
            {preview.query ? (
                <div className="border-b border-[var(--app-border)]/60 px-2 py-1 text-[11.5px] font-mono text-[var(--app-hint)]">
                    {preview.query}
                </div>
            ) : null}
            <div className="max-h-48 overflow-y-auto divide-y divide-[var(--app-border)]/30">
                {preview.results.map((item, idx) => (
                    <a
                        key={`${item.url}-${idx}`}
                        href={item.url || '#'}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-2.5 rounded px-2 py-1.5 transition-colors hover:bg-[var(--app-subtle-bg)]"
                    >
                        <DomainFaviconBadge domain={item.domain || item.url} />
                        <span className="min-w-0 flex-1 truncate text-[12.5px] text-[var(--app-fg)]">
                            {item.title}
                        </span>
                        <span className="shrink-0 text-[11.5px] text-[var(--app-hint)]">
                            {item.domain}
                        </span>
                    </a>
                ))}
            </div>
        </div>
    )
}

function FileDiffPreviewCard({ preview }: ToolPreviewRenderProps<Extract<TurnStepPreview, { kind: 'file-diff' }>>) {
    return (
        <div
            className="mt-1.5 mb-2 overflow-hidden rounded-lg border border-[var(--app-border)] bg-[var(--app-subtle-bg)]/45 text-xs"
            data-testid="turn-level2-diff"
        >
            <div className="flex items-center justify-between gap-2 border-b border-[var(--app-border)]/70 px-3 py-1.5 text-[11.5px]">
                <span className="min-w-0 flex-1 truncate font-mono text-[var(--app-fg)]" title={preview.filePath}>
                    {preview.filePath}
                </span>
                <div className="flex shrink-0 items-center gap-1.5">
                    <span className="font-mono tabular-nums text-[11px]">
                        {preview.added > 0 ? <span className="text-[var(--app-badge-success-text)]">+{preview.added}</span> : null}
                        {preview.removed > 0 ? <span className="ml-1.5 text-[var(--app-badge-error-text)]">-{preview.removed}</span> : null}
                    </span>
                    <CopyButton text={preview.filePath} label="Copy file path" />
                </div>
            </div>
            {preview.lines.length > 0 ? (
                <div className="max-h-44 overflow-y-auto py-1 font-mono text-[11.5px] leading-5">
                    {preview.lines.map((line, index) => (
                        <div
                            key={index}
                            className={cn(
                                'px-3 whitespace-pre-wrap',
                                line.type === 'add' && 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
                                line.type === 'del' && 'bg-rose-500/10 text-rose-700 dark:text-rose-300',
                                line.type === 'ctx' && 'text-[var(--app-hint)]'
                            )}
                        >
                            {line.type === 'add' ? `+ ${line.text}` : line.type === 'del' ? `- ${line.text}` : `  ${line.text}`}
                        </div>
                    ))}
                </div>
            ) : null}
        </div>
    )
}

function FileReadPreviewCard({ preview }: ToolPreviewRenderProps<Extract<TurnStepPreview, { kind: 'file-read' }>>) {
    return (
        <div
            className="mt-1.5 mb-2 overflow-hidden rounded-lg border border-[var(--app-border)] bg-[var(--app-subtle-bg)]/45 text-xs"
            data-testid="turn-level2-read"
        >
            <div className="flex items-center justify-between gap-2 border-b border-[var(--app-border)]/70 px-3 py-1.5 text-[11.5px] text-[var(--app-hint)]">
                <span className="min-w-0 flex-1 truncate font-mono text-[var(--app-fg)]" title={preview.filePath}>
                    {preview.filePath}
                </span>
                <div className="flex shrink-0 items-center gap-1.5">
                    {preview.lineCount > 0 ? <span className="tabular-nums">{preview.lineCount} lines</span> : null}
                    <CopyButton text={preview.content || preview.filePath} label="Copy content" />
                </div>
            </div>
            {preview.content ? (
                <pre className="max-h-44 overflow-y-auto px-3 py-2 font-mono text-[11.5px] leading-5 text-[var(--app-hint)] whitespace-pre-wrap">
                    {preview.content}
                </pre>
            ) : null}
        </div>
    )
}

function CompactionPreviewCard({ preview }: ToolPreviewRenderProps<Extract<TurnStepPreview, { kind: 'compaction' }>>) {
    const metaItems = [
        preview.strategy,
        preview.trigger,
        preview.archiveLabel,
        preview.tokensBeforeLabel,
    ].filter((item): item is string => Boolean(item))
    return (
        <div
            className="mt-1.5 mb-2 overflow-hidden rounded-lg border border-[var(--app-border)] bg-[var(--app-subtle-bg)]/45 px-3 py-2 text-xs"
            data-testid="turn-level2-compaction"
        >
            {metaItems.length > 0 ? (
                <div className="flex flex-wrap items-center gap-1.5 text-[11.5px] font-mono text-[var(--app-hint)]">
                    {metaItems.join(' · ')}
                </div>
            ) : null}
            {preview.errorMessage ? (
                <div className="mt-1.5 text-[12px] leading-relaxed text-[var(--app-badge-error-text)] whitespace-pre-wrap">
                    {preview.errorMessage}
                </div>
            ) : null}
            {preview.summary ? (
                <div className="mt-1.5 text-[12.5px] leading-relaxed text-[var(--app-fg)]/90 whitespace-pre-wrap">
                    {preview.summary}
                </div>
            ) : !metaItems.length && !preview.errorMessage ? (
                <div className="text-[12px] text-[var(--app-hint)]">
                    {preview.isRunning ? 'Compacting conversation context...' : 'Conversation context compacted.'}
                </div>
            ) : null}
        </div>
    )
}

function DefaultToolPreviewCard({ preview, metadata }: ToolPreviewRenderProps<Extract<TurnStepPreview, { kind: 'default' }>>) {
    const checklistItems = [...projectToolTodoSnapshot(preview.block).items]
    if (checklistItems.length > 0) {
        return (
            <div className="mt-1.5 mb-2">
                <TimelineTodoChecklistCard items={checklistItems} />
            </div>
        )
    }

    return (
        <div
            className="mt-1.5 mb-2 overflow-hidden rounded-lg border border-[var(--app-border)] bg-[var(--app-subtle-bg)]/45 text-xs"
            data-testid="turn-level2-generic"
        >
            <div className="flex items-center justify-between border-b border-[var(--app-border)]/70 px-3 py-1.5 text-[11px] font-mono text-[var(--app-hint)]">
                <span className="truncate">{preview.block.tool.name}</span>
            </div>
            <div className="max-h-56 overflow-y-auto p-2.5">
                <ToolDetailDialogContent block={preview.block} metadata={metadata} hideTiming />
            </div>
        </div>
    )
}

export const compactionToolPreviewPlugin: ToolStepPreviewPlugin<'compaction'> = {
    kind: 'compaction',
    matches(ctx) {
        return ctx.rawName === 'ContextCompaction' || ctx.row.verb === 'turn.verb.compaction'
    },
    describe({ row, zh, isRunning, isQueued }) {
        const input = row.block.tool.input
        const record = isObject(input) ? input : {}
        const frame = isObject(record.frame) ? record.frame : null
        const strategy = getInputStringAny(record, ['action', 'strategy']) ?? getInputStringAny(frame, ['action', 'strategy'])
        const reason = getInputStringAny(record, ['reason', 'trigger']) ?? getInputStringAny(frame, ['reason', 'trigger'])
        const outcome = typeof record.outcome === 'string'
            ? record.outcome
            : frame?.aborted === true
                ? 'aborted'
                : null
        const result = isObject(record.result) ? record.result : isObject(frame?.result) ? frame.result : null
        const tokensBefore = typeof result?.tokensBefore === 'number'
            ? result.tokensBefore
            : typeof record.tokensBefore === 'number'
                ? record.tokensBefore
                : typeof record.preTokens === 'number'
                    ? record.preTokens
                    : null
        const tokensSaved = typeof record.tokensSaved === 'number' ? record.tokensSaved : null
        const shortSummary = typeof result?.shortSummary === 'string' && result.shortSummary.trim()
            ? result.shortSummary.trim()
            : null
        const errorMessage = getInputStringAny(record, ['errorMessage', 'message']) ?? getInputStringAny(frame, ['errorMessage'])

        const directArchive = isObject(result?.archive) ? result.archive : null
        const preserveData = isObject(result?.preserveData) ? result.preserveData : null
        const legacyArchive = isObject(preserveData?.snapcompact) ? preserveData.snapcompact : null
        const arch = directArchive ?? legacyArchive
        const totalChars = typeof arch?.totalChars === 'number' ? arch.totalChars : null
        const frameCount = typeof arch?.frameCount === 'number'
            ? arch.frameCount
            : Array.isArray(arch?.frames)
                ? arch.frames.length
                : null
        const archiveLabel = totalChars !== null && frameCount !== null
            ? (zh
                ? `已归档 ${formatCompactCount(totalChars)} 字符 · ${frameCount} 帧`
                : `${formatCompactCount(totalChars)} chars archived · ${frameCount} ${frameCount === 1 ? 'frame' : 'frames'}`)
            : null

        const verbLabel = isRunning
            ? (zh ? '正在压缩上下文' : 'Compacting conversation')
            : row.error
                ? (zh ? '上下文压缩失败' : 'Compaction failed')
                : outcome === 'aborted'
                    ? (zh ? '已取消上下文压缩' : 'Compaction cancelled')
                    : (zh ? '已压缩上下文' : 'Compacted conversation')

        const intentLabel = isRunning || isQueued
            ? [strategy, reason?.replaceAll('-', ' ')].filter(Boolean).join(' · ')
            : ''
        const tokensBeforeLabel = tokensSaved !== null && tokensSaved > 0
            ? (zh ? `节省 ${formatCompactCount(tokensSaved)} tokens` : `saved ${formatCompactCount(tokensSaved)} tokens`)
            : tokensBefore !== null && tokensBefore > 0
                ? `${formatCompactCount(tokensBefore)} tokens`
                : null

        return {
            isRunning,
            isQueued,
            verbLabel,
            intentLabel,
            secondaryBadge: !isRunning && !isQueued ? tokensBeforeLabel : null,
            preview: {
                kind: 'compaction',
                strategy,
                trigger: reason ? reason.replaceAll('-', ' ') : null,
                tokensBeforeLabel,
                archiveLabel,
                summary: shortSummary,
                errorMessage: row.error ? errorMessage : null,
                isRunning,
            },
        }
    },
    PreviewComponent: CompactionPreviewCard,
}

export const webFetchToolPreviewPlugin: ToolStepPreviewPlugin<'web-fetch'> = {
    kind: 'web-fetch',
    matches(ctx) {
        return isWebFetchTool(ctx.rawName, ctx.resolvedName)
    },
    describe({ tool, isRunning, isQueued, zh }) {
        const url = getInputStringAny(tool.input, ['url', 'uri']) ?? ''
        const domain = url ? extractDomain(url) : ''
        const pageTitle = intentSentence(tool)
            ?? (isObject(tool.result) && typeof tool.result.title === 'string' ? tool.result.title : null)
            ?? (domain || url || 'page')
        const text = extractResultText(tool.result)
        const linesCount = isObject(tool.result) && typeof tool.result.lines === 'number'
            ? tool.result.lines
            : text
                ? text.split(/\r?\n/).length
                : 0
        const bytes = isObject(tool.result) && typeof tool.result.bytes === 'number'
            ? tool.result.bytes
            : text.length
        const sizeLabel = bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`
        return {
            isRunning,
            isQueued,
            verbLabel: zh
                ? (isRunning ? '正在抓取' : isQueued ? '待抓取' : '已抓取')
                : (isRunning ? 'Fetching' : isQueued ? 'Queued fetch' : 'Fetched'),
            intentLabel: isRunning || isQueued ? pageTitle : (domain || url || ''),
            secondaryBadge: null,
            preview: {
                kind: 'web-fetch',
                title: pageTitle,
                url: url || '',
                domain: domain || '',
                excerpt: text ? truncate(text, 360) : '',
                sizeLabel,
                linesCount,
            },
        }
    },
    PreviewComponent: WebFetchPreviewCard,
}

export const webSearchToolPreviewPlugin: ToolStepPreviewPlugin<'web-search'> = {
    kind: 'web-search',
    matches(ctx) {
        return isWebSearchTool(ctx.rawName, ctx.resolvedName)
    },
    describe({ row, tool, isRunning, isQueued, zh, activeIntent }) {
        const query = getInputStringAny(tool.input, ['query', 'q']) ?? ''
        const cleanQuery = query && query !== 'the web' ? query : ''
        const results = extractWebSearchResults(tool.result)
        const count = results.length
        return {
            isRunning,
            isQueued,
            verbLabel: zh
                ? (isRunning ? '正在搜索网页' : isQueued ? '待搜索网页' : '已搜索网页')
                : (isRunning ? 'Searching the web' : isQueued ? 'Queued web search' : 'Searched the web'),
            intentLabel: isRunning || isQueued ? (activeIntent ?? (cleanQuery || row.intent)) : cleanQuery,
            secondaryBadge: !isRunning && !isQueued && count > 0
                ? (zh ? `${count} 条结果` : `${count} ${count === 1 ? 'result' : 'results'}`)
                : null,
            preview: {
                kind: 'web-search',
                query: cleanQuery,
                results,
            },
        }
    },
    PreviewComponent: WebSearchPreviewCard,
}

export const bashToolPreviewPlugin: ToolStepPreviewPlugin<'bash'> = {
    kind: 'bash',
    matches(ctx) {
        return ctx.resolvedName === 'Bash' || ctx.resolvedName === 'CodexBash'
    },
    describe({ row, tool, isRunning, isQueued, zh }) {
        const command = getInputStringAny(tool.input, ['command', 'cmd']) ?? ''
        const description = intentSentence(tool)
        const output = extractResultText(tool.result)
        return {
            isRunning,
            isQueued,
            verbLabel: zh
                ? (isRunning ? '正在运行' : isQueued ? '待运行' : '已运行')
                : (isRunning ? 'Running' : isQueued ? 'Queued' : 'Ran'),
            intentLabel: isRunning || isQueued
                ? (description ?? (command ? firstLine(command) : row.intent))
                : (command ? firstLine(command) : ''),
            secondaryBadge: null,
            preview: {
                kind: 'bash',
                command: command || row.intent,
                description,
                output,
                isError: row.error,
            },
        }
    },
    PreviewComponent: BashPreviewCard,
}

export const fileReadToolPreviewPlugin: ToolStepPreviewPlugin<'file-read'> = {
    kind: 'file-read',
    matches(ctx) {
        return ctx.resolvedName === 'Read'
    },
    describe({ row, tool, isRunning, isQueued, zh, activeIntent }) {
        const filePath = getInputStringAny(tool.input, ['file_path', 'path']) ?? ''
        const normalized = normalizeReadFilePath(filePath)
        const targetLabel = normalized.fileName || (filePath ? basename(filePath) : '')
        const content = extractResultText(tool.result)
        const lineCount = content ? content.split(/\r?\n/).length : 0
        return {
            isRunning,
            isQueued,
            verbLabel: zh
                ? (isRunning ? '正在查看' : isQueued ? '待查看' : '已查看')
                : (isRunning ? 'Viewing' : isQueued ? 'Queued view' : 'Viewed'),
            intentLabel: isRunning || isQueued ? (activeIntent ?? (targetLabel || row.intent)) : targetLabel,
            secondaryBadge: !isRunning && !isQueued && lineCount > 0 ? (zh ? `${lineCount} 行` : `${lineCount} lines`) : null,
            preview: {
                kind: 'file-read',
                filePath: filePath || row.intent,
                content,
                lineCount,
            },
        }
    },
    PreviewComponent: FileReadPreviewCard,
}

export const fileDiffToolPreviewPlugin: ToolStepPreviewPlugin<'file-diff'> = {
    kind: 'file-diff',
    matches(ctx) {
        if (ctx.resolvedName !== 'Edit' && ctx.resolvedName !== 'MultiEdit' && ctx.resolvedName !== 'Write') {
            return false
        }
        if (ctx.resolvedName === 'Write') {
            const rawTarget = getInputStringAny(ctx.tool.input, ['file_path', 'path'])
            if (parseAgentUriTarget(rawTarget)) {
                return false
            }
        }
        return true
    },
    describe({ row, tool, resolvedName, isRunning, isQueued, zh, activeIntent }) {
        const filePath = getInputStringAny(tool.input, ['file_path', 'path']) ?? row.intent ?? ''
        const oldStr = getInputStringAny(tool.input, ['old_string', 'oldText']) ?? ''
        const newStr = getInputStringAny(tool.input, ['new_string', 'newText', 'content']) ?? ''
        const oldLines = oldStr ? oldStr.split(/\r?\n/) : []
        const newLines = newStr ? newStr.split(/\r?\n/) : []
        const lines: TurnDiffLine[] = [
            ...oldLines.slice(0, 8).map((text): TurnDiffLine => ({ type: 'del', text })),
            ...newLines.slice(0, 10).map((text): TurnDiffLine => ({ type: 'add', text })),
        ]
        const added = newLines.length
        const removed = oldLines.length
        const badge = !isRunning && !isQueued && (added > 0 || removed > 0)
            ? `+${added}${removed > 0 ? ` -${removed}` : ''}`
            : null
        return {
            isRunning,
            isQueued,
            verbLabel: zh
                ? (isRunning
                    ? (resolvedName === 'Write' ? '正在创建' : '正在编辑')
                    : isQueued
                        ? (resolvedName === 'Write' ? '待创建' : '待编辑')
                        : (resolvedName === 'Write' ? '已创建' : '已编辑'))
                : (isRunning
                    ? (resolvedName === 'Write' ? 'Creating' : 'Editing')
                    : isQueued
                        ? (resolvedName === 'Write' ? 'Queued create' : 'Queued edit')
                        : (resolvedName === 'Write' ? 'Created' : 'Edited')),
            intentLabel: isRunning || isQueued
                ? (activeIntent ?? (filePath ? basename(filePath) : row.intent))
                : (filePath ? basename(filePath) : ''),
            secondaryBadge: badge,
            preview: {
                kind: 'file-diff',
                filePath: filePath || row.intent,
                added,
                removed,
                lines,
            },
        }
    },
    PreviewComponent: FileDiffPreviewCard,
}

export const TOOL_STEP_PREVIEW_PLUGINS: readonly ToolStepPreviewPlugin<any>[] = [
    compactionToolPreviewPlugin,
    webFetchToolPreviewPlugin,
    webSearchToolPreviewPlugin,
    bashToolPreviewPlugin,
    fileReadToolPreviewPlugin,
    fileDiffToolPreviewPlugin,
]

export const TOOL_PREVIEW_RENDERERS: {
    readonly [K in TurnStepPreview['kind']]: ComponentType<ToolPreviewRenderProps<Extract<TurnStepPreview, { kind: K }>>>
} = {
    compaction: CompactionPreviewCard,
    'web-fetch': WebFetchPreviewCard,
    'web-search': WebSearchPreviewCard,
    bash: BashPreviewCard,
    'file-read': FileReadPreviewCard,
    'file-diff': FileDiffPreviewCard,
    default: DefaultToolPreviewCard,
}

export function findMatchingToolPreviewPlugin(
    ctx: ToolStepMatchContext
): ToolStepPreviewPlugin<any> | undefined {
    return TOOL_STEP_PREVIEW_PLUGINS.find((plugin) => plugin.matches(ctx))
}

export function getToolPreviewRenderer<K extends TurnStepPreview['kind']>(
    kind: K
): ComponentType<ToolPreviewRenderProps<Extract<TurnStepPreview, { kind: K }>>> {
    return TOOL_PREVIEW_RENDERERS[kind]
}
