import { useEffect, useMemo, useRef, useState } from 'react'
import { formatDuration } from '@/chat/presentation'
import {
    describeTurnToolStep,
    summarizeTurnActivity,
    type TurnStepPreview,
    type TurnPartition,
    type TurnReasoningRow,
    type TurnRow,
    type TurnToolRow,
} from '@/components/AssistantChat/messages/turnBlockModel'
import { GeneratedFileCard, GeneratedImageCard } from '@/components/AssistantChat/messages/ToolMessage'
import { ToolDetailDialogContent } from '@/components/ToolCard/ToolCard'
import { useOptionalHappyChatContext } from '@/components/AssistantChat/context'
import { cn } from '@/lib/utils'

export type TranscriptViewMode = 'normal' | 'thinking' | 'verbose'

export type TurnActivityIndicatorVariant =
    | 'equalizer-bars'
    | 'eq-5bars-spectrum'
    | 'eq-3bars-bold'
    | 'eq-6bars-ribbon'
    | 'pulse-orb'
    | 'orbit-ring'
    | 'morph-diamond'
    | 'terminal-cursor'
    | 'wave-dots'
    | 'sparkle'
export type DockedTodoItem = {
    id: string
    content: string
    activeForm?: string
    status: 'pending' | 'in_progress' | 'completed'
}

export type DockedQuestionItem = {
    id: string
    question: string
    options: Array<{ label: string; description?: string }>
}

function SmallChevron(props: { open: boolean; direction?: 'right' | 'up'; className?: string }) {
    const baseRotation = props.direction === 'up'
        ? (props.open ? 'rotate-180' : 'rotate-0')
        : (props.open ? 'rotate-90' : 'rotate-0')
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={cn('shrink-0 transition-transform duration-150', baseRotation, props.className)}
            aria-hidden="true"
        >
            {props.direction === 'up' ? (
                <polyline points="18 15 12 9 6 15" />
            ) : (
                <polyline points="9 18 15 12 9 6" />
            )}
        </svg>
    )
}

export function TurnActivitySparkleIcon(props: { className?: string; size?: number }) {
    const size = props.size ?? 16
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            className={cn('turn-sparkle-icon shrink-0', props.className)}
            aria-hidden="true"
        >
            <path
                d="M12 2.5V21.5M2.5 12H21.5M5.3 5.3L18.7 18.7M18.7 5.3L5.3 18.7"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
            />
        </svg>
    )
}

export function TurnActivityIndicator(props: {
    variant?: TurnActivityIndicatorVariant
    color?: string
    size?: number
    className?: string
}) {
    const variant = props.variant ?? 'equalizer-bars'
    const color = props.color ?? '#da7756'
    const size = props.size ?? 16
    if (variant === 'pulse-orb') {
        return (
            <span
                className={cn('relative inline-flex items-center justify-center shrink-0', props.className)}
                style={{ width: size, height: size, color }}
                aria-hidden="true"
                data-indicator-variant="pulse-orb"
            >
                <span
                    className="absolute inline-flex h-3 w-3 animate-ping rounded-full opacity-55"
                    style={{ backgroundColor: color }}
                />
                <span
                    className="relative inline-flex h-2 w-2 rounded-full"
                    style={{ backgroundColor: color }}
                />
            </span>
        )
    }

    if (variant === 'equalizer-bars') {
        return (
            <span
                className={cn('inline-flex items-end justify-center gap-[3.5px] shrink-0', props.className)}
                style={{ height: size - 1, color }}
                aria-hidden="true"
                data-indicator-variant="equalizer-bars"
            >
                <span className="turn-eq-bar-1 w-[3px] h-full rounded-full" style={{ backgroundColor: color }} />
                <span className="turn-eq-bar-2 w-[3px] h-full rounded-full" style={{ backgroundColor: color }} />
                <span className="turn-eq-bar-3 w-[3px] h-full rounded-full" style={{ backgroundColor: color }} />
                <span className="turn-eq-bar-4 w-[3px] h-full rounded-full" style={{ backgroundColor: color }} />
            </span>
        )
    }

    if (variant === 'eq-5bars-spectrum') {
        return (
            <span
                className={cn('inline-flex items-end justify-center gap-[3px] shrink-0', props.className)}
                style={{ height: size - 1, color }}
                aria-hidden="true"
                data-indicator-variant="eq-5bars-spectrum"
            >
                <span className="turn-eq-bar-3 w-[2.8px] h-full rounded-full" style={{ backgroundColor: color }} />
                <span className="turn-eq-bar-2 w-[2.8px] h-full rounded-full" style={{ backgroundColor: color }} />
                <span className="turn-eq-bar-1 w-[2.8px] h-full rounded-full" style={{ backgroundColor: color }} />
                <span className="turn-eq-bar-2 w-[2.8px] h-full rounded-full" style={{ backgroundColor: color }} />
                <span className="turn-eq-bar-4 w-[2.8px] h-full rounded-full" style={{ backgroundColor: color }} />
            </span>
        )
    }

    if (variant === 'eq-3bars-bold') {
        return (
            <span
                className={cn('inline-flex items-end justify-center gap-[4px] shrink-0', props.className)}
                style={{ height: size - 1, color }}
                aria-hidden="true"
                data-indicator-variant="eq-3bars-bold"
            >
                <span className="turn-eq-bar-1 w-[3.5px] h-full rounded-full" style={{ backgroundColor: color }} />
                <span className="turn-eq-bar-2 w-[3.5px] h-full rounded-full" style={{ backgroundColor: color }} />
                <span className="turn-eq-bar-3 w-[3.5px] h-full rounded-full" style={{ backgroundColor: color }} />
            </span>
        )
    }

    if (variant === 'eq-6bars-ribbon') {
        return (
            <span
                className={cn('inline-flex items-end justify-center gap-[3px] shrink-0', props.className)}
                style={{ height: size - 2, color }}
                aria-hidden="true"
                data-indicator-variant="eq-6bars-ribbon"
            >
                <span className="turn-eq-bar-1 w-[2.5px] h-full rounded-full" style={{ backgroundColor: color }} />
                <span className="turn-eq-bar-2 w-[2.5px] h-full rounded-full" style={{ backgroundColor: color }} />
                <span className="turn-eq-bar-3 w-[2.5px] h-full rounded-full" style={{ backgroundColor: color }} />
                <span className="turn-eq-bar-4 w-[2.5px] h-full rounded-full" style={{ backgroundColor: color }} />
                <span className="turn-eq-bar-5 w-[2.5px] h-full rounded-full" style={{ backgroundColor: color }} />
                <span className="turn-eq-bar-6 w-[2.5px] h-full rounded-full" style={{ backgroundColor: color }} />
            </span>
        )
    }

    if (variant === 'orbit-ring') {
        return (
            <span
                className={cn('relative inline-flex items-center justify-center shrink-0', props.className)}
                style={{ width: size, height: size, color }}
                aria-hidden="true"
                data-indicator-variant="orbit-ring"
            >
                <svg
                    width={size}
                    height={size}
                    viewBox="0 0 24 24"
                    fill="none"
                    className="animate-spin"
                >
                    <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2.4" />
                    <path
                        d="M21 12a9 9 0 0 0-9-9"
                        stroke="currentColor"
                        strokeWidth="2.4"
                        strokeLinecap="round"
                    />
                </svg>
                <span
                    className="absolute h-1.5 w-1.5 rounded-full animate-pulse"
                    style={{ backgroundColor: color }}
                />
            </span>
        )
    }

    if (variant === 'morph-diamond') {
        return (
            <svg
                width={size}
                height={size}
                viewBox="0 0 24 24"
                fill="none"
                className={cn('turn-diamond-icon shrink-0', props.className)}
                style={{ color }}
                aria-hidden="true"
                data-indicator-variant="morph-diamond"
            >
                <path
                    d="M12 2.5C12 8.2 15.8 12 21.5 12C15.8 12 12 15.8 12 21.5C12 15.8 8.2 12 2.5 12C8.2 12 12 8.2 12 2.5Z"
                    fill="currentColor"
                />
            </svg>
        )
    }

    if (variant === 'terminal-cursor') {
        return (
            <span
                className={cn('inline-flex items-center gap-0.5 font-mono text-[11px] font-bold leading-none shrink-0', props.className)}
                style={{ color }}
                aria-hidden="true"
                data-indicator-variant="terminal-cursor"
            >
                <span className="opacity-75">&gt;</span>
                <span
                    className="turn-caret-block inline-block h-3 w-1.5 rounded-[1px]"
                    style={{ backgroundColor: color }}
                />
            </span>
        )
    }

    if (variant === 'wave-dots') {
        return (
            <span
                className={cn('inline-flex items-center gap-1 shrink-0', props.className)}
                style={{ height: size, color }}
                aria-hidden="true"
                data-indicator-variant="wave-dots"
            >
                <span className="turn-wave-dot-1 h-1.5 w-1.5 rounded-full" style={{ backgroundColor: color }} />
                <span className="turn-wave-dot-2 h-1.5 w-1.5 rounded-full" style={{ backgroundColor: color }} />
                <span className="turn-wave-dot-3 h-1.5 w-1.5 rounded-full" style={{ backgroundColor: color }} />
            </span>
        )
    }

    return (
        <span style={{ color }} className="inline-flex items-center" data-indicator-variant="sparkle">
            <TurnActivitySparkleIcon size={size} className={props.className} />
        </span>
    )
}

function CopyButton(props: { text: string }) {
    const [copied, setCopied] = useState(false)
    return (
        <button
            type="button"
            onClick={(e) => {
                e.stopPropagation()
                void navigator.clipboard?.writeText(props.text)
                setCopied(true)
                window.setTimeout(() => setCopied(false), 1400)
            }}
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
            title="Copy command"
            aria-label="Copy command"
        >
            {copied ? (
                <span>Copied</span>
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

function StepInlinePreviewCard(props: { preview: TurnStepPreview }) {
    const ctx = useOptionalHappyChatContext()
    const { preview } = props

    if (preview.kind === 'bash') {
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

    if (preview.kind === 'web-fetch') {
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

    if (preview.kind === 'web-search') {
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

    if (preview.kind === 'file-diff') {
        return (
            <div
                className="mt-1.5 mb-2 overflow-hidden rounded-lg border border-[var(--app-border)] bg-[var(--app-subtle-bg)]/45 text-xs"
                data-testid="turn-level2-diff"
            >
                <div className="flex items-center justify-between border-b border-[var(--app-border)]/70 px-3 py-1.5 text-[11.5px]">
                    <span className="font-mono text-[var(--app-fg)] truncate">{preview.filePath}</span>
                    <span className="shrink-0 font-mono tabular-nums text-[11px]">
                        {preview.added > 0 ? <span className="text-emerald-600 dark:text-emerald-400">+{preview.added}</span> : null}
                        {preview.removed > 0 ? <span className="ml-1.5 text-rose-600 dark:text-rose-400">-{preview.removed}</span> : null}
                    </span>
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

    if (preview.kind === 'file-read') {
        return (
            <div
                className="mt-1.5 mb-2 overflow-hidden rounded-lg border border-[var(--app-border)] bg-[var(--app-subtle-bg)]/45 text-xs"
                data-testid="turn-level2-read"
            >
                <div className="flex items-center justify-between border-b border-[var(--app-border)]/70 px-3 py-1.5 text-[11.5px] text-[var(--app-hint)]">
                    <span className="font-mono text-[var(--app-fg)] truncate">{preview.filePath}</span>
                    {preview.lineCount > 0 ? <span className="shrink-0 tabular-nums">{preview.lineCount} lines</span> : null}
                </div>
                {preview.content ? (
                    <pre className="max-h-44 overflow-y-auto px-3 py-2 font-mono text-[11.5px] leading-5 text-[var(--app-hint)] whitespace-pre-wrap">
                        {preview.content}
                    </pre>
                ) : null}
            </div>
        )
    }

    return (
        <div className="mt-1.5 mb-2 rounded-lg border border-[var(--app-border)] bg-[var(--app-subtle-bg)]/45 p-2.5">
            <ToolDetailDialogContent block={preview.block} metadata={ctx?.metadata ?? null} hideTiming />
        </div>
    )
}

function TimelineThoughtRow(props: {
    row: TurnReasoningRow
    isActiveStreaming: boolean
    defaultExpanded: boolean
    lang: 'en' | 'zh-CN'
}) {
    const [open, setOpen] = useState(props.defaultExpanded)
    useEffect(() => {
        setOpen(props.defaultExpanded)
    }, [props.defaultExpanded])

    const label = props.lang === 'zh-CN'
        ? (props.isActiveStreaming ? '正在思考...' : '思考过程')
        : (props.isActiveStreaming ? 'Thinking...' : 'Thought')

    return (
        <div data-hapi-share-exclude="true" className="py-0.5">
            <button
                type="button"
                aria-expanded={open}
                onClick={() => setOpen((v) => !v)}
                className="group flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[13.5px] leading-5 text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)]/60 hover:text-[var(--app-fg)]"
            >
                <span className={cn(props.isActiveStreaming && 'turn-text-shimmer font-medium')}>
                    {label}
                </span>
                <SmallChevron open={open} className="opacity-70 group-hover:opacity-100" />
            </button>
            {open ? (
                <div className="ml-2 mt-1 mb-1.5 border-l border-[var(--app-border)]/70 pl-3 text-[13px] leading-relaxed text-[var(--app-hint)] whitespace-pre-wrap">
                    {props.row.text}
                </div>
            ) : null}
        </div>
    )
}

function TimelineToolStepRow(props: {
    row: TurnToolRow
    defaultExpanded: boolean
    lang: 'en' | 'zh-CN'
}) {
    const [open, setOpen] = useState(props.defaultExpanded)
    useEffect(() => {
        setOpen(props.defaultExpanded)
    }, [props.defaultExpanded])

    const descriptor = useMemo(
        () => describeTurnToolStep(props.row, props.lang),
        [props.row, props.lang]
    )

    return (
        <div data-hapi-share-exclude="true" className="py-0.5">
            <button
                type="button"
                aria-expanded={open}
                onClick={() => setOpen((v) => !v)}
                className="group flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[13.5px] leading-5 transition-colors hover:bg-[var(--app-subtle-bg)]/60"
            >
                {props.row.error ? (
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--app-badge-error-text)]" />
                ) : null}
                <span
                    className={cn(
                        'shrink-0',
                        props.row.error
                            ? 'text-[var(--app-badge-error-text)]'
                            : descriptor.isRunning
                                ? 'turn-text-shimmer font-medium'
                                : 'text-[var(--app-hint)] group-hover:text-[var(--app-fg)]'
                    )}
                >
                    {descriptor.verbLabel}
                </span>
                {descriptor.intentLabel ? (
                    <span
                        className={cn(
                            'min-w-0 flex-1 truncate',
                            descriptor.isRunning
                                ? 'turn-text-shimmer font-medium'
                                : 'text-[var(--app-hint)] group-hover:text-[var(--app-fg)]'
                        )}
                    >
                        {descriptor.intentLabel}
                    </span>
                ) : (
                    <span className="min-w-0 flex-1" />
                )}
                {descriptor.secondaryBadge ? (
                    <span className="shrink-0 text-[12px] tabular-nums text-[var(--app-hint)]/85">
                        {descriptor.secondaryBadge}
                    </span>
                ) : null}
                <SmallChevron open={open} className="text-[var(--app-hint)] opacity-75 group-hover:opacity-100" />
            </button>
            {open ? <StepInlinePreviewCard preview={descriptor.preview} /> : null}
        </div>
    )
}

function renderSimpleMarkdownText(text: string): React.ReactNode {
    const tokens = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g)
    return tokens.map((token, idx) => {
        if (token.startsWith('**') && token.endsWith('**') && token.length > 4) {
            return <strong key={idx} className="font-semibold text-[var(--app-fg)]">{token.slice(2, -2)}</strong>
        }
        if (token.startsWith('`') && token.endsWith('`') && token.length > 2) {
            return (
                <code
                    key={idx}
                    className="rounded bg-[var(--app-subtle-bg)] px-1.5 py-0.5 font-mono text-[13px] text-[var(--app-fg)]"
                >
                    {token.slice(1, -1)}
                </code>
            )
        }
        return token
    })
}

export function TimelineTurnBlockView(props: {
    partition: TurnPartition
    streaming: boolean
    durationMs: number | null
    initiallyOpen?: boolean
    activeTodoText?: string | null
    viewMode?: TranscriptViewMode
    lang?: 'en' | 'zh-CN'
    indicatorVariant?: TurnActivityIndicatorVariant
    indicatorColor?: string
    renderTrailingText?: (text: string, streaming: boolean) => React.ReactNode
}) {
    const lang = props.lang ?? 'en'
    const viewMode = props.viewMode ?? 'normal'
    const [open, setOpen] = useState(
        props.initiallyOpen ?? (viewMode === 'verbose')
    )
    const sawStream = useRef(props.streaming)

    useEffect(() => {
        if (sawStream.current && !props.streaming && viewMode !== 'verbose') {
            setOpen(false)
        }
        sawStream.current = props.streaming
    }, [props.streaming, viewMode])

    useEffect(() => {
        if (viewMode === 'verbose') setOpen(true)
    }, [viewMode])

    const summary = useMemo(
        () => summarizeTurnActivity(props.partition, {
            activeTodoText: props.activeTodoText,
            lang,
        }),
        [props.partition, props.activeTodoText, lang]
    )

    const trailing = props.partition.rows.filter(
        (row): row is Extract<TurnRow, { kind: 'text' }> => row.kind === 'text' && row.trailing
    )
    const stepRows = props.partition.rows.filter(
        (row) => !(row.kind === 'text' && row.trailing)
    )
    const hasSteps = stepRows.some((row) => row.kind === 'reasoning' || row.kind === 'tool')
    const headerText = props.streaming ? summary.workingHeader : summary.completedHeader

    if (!props.partition.hasActivity) {
        if (trailing.length === 0) return null
        return (
            <div className="my-2 space-y-3">
                {trailing.map((row) => (
                    <div key={row.key} className="text-[15px] leading-relaxed text-[var(--app-fg)] whitespace-pre-wrap">
                        {props.renderTrailingText ? props.renderTrailingText(row.text, props.streaming) : renderSimpleMarkdownText(row.text)}
                    </div>
                ))}
            </div>
        )
    }

    return (
        <div className="my-2.5" data-testid="turn-timeline-block">
            {hasSteps ? (
                <div>
                    {/* Level 0: Lightweight borderless summary header */}
                    <button
                        type="button"
                        aria-expanded={open}
                        onClick={() => setOpen((v) => !v)}
                        data-testid="turn-level0-header"
                        className="group inline-flex max-w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left text-[13.5px] leading-5 text-[var(--app-hint)] transition-colors hover:text-[var(--app-fg)]"
                    >
                        <span
                            key={headerText}
                            className={cn(
                                'turn-timeline-status-enter truncate',
                                props.streaming ? 'turn-text-shimmer font-medium' : 'font-normal'
                            )}
                        >
                            {headerText}
                        </span>
                        <SmallChevron open={open} className="opacity-75 group-hover:opacity-100" />
                        {!props.streaming && props.durationMs != null && props.durationMs > 0 ? (
                            <span className="ml-1 shrink-0 text-[11.5px] tabular-nums text-[var(--app-hint)]/75">
                                {formatDuration(props.durationMs)}
                            </span>
                        ) : null}
                    </button>

                    {/* Level 1: Left-indented vertical timeline rail */}
                    {open ? (
                        <div
                            className="ml-2 mt-1 border-l border-[var(--app-border)] pl-3.5 space-y-0.5"
                            data-testid="turn-level1-rail"
                        >
                            {stepRows.map((row, idx) => {
                                const isLastStep = idx === stepRows.length - 1
                                if (row.kind === 'reasoning') {
                                    return (
                                        <TimelineThoughtRow
                                            key={row.key}
                                            row={row}
                                            isActiveStreaming={props.streaming && isLastStep}
                                            defaultExpanded={viewMode === 'thinking' || viewMode === 'verbose'}
                                            lang={lang}
                                        />
                                    )
                                }
                                if (row.kind === 'tool') {
                                    return (
                                        <TimelineToolStepRow
                                            key={row.key}
                                            row={row}
                                            defaultExpanded={viewMode === 'verbose'}
                                            lang={lang}
                                        />
                                    )
                                }
                                if (row.kind === 'text') {
                                    return (
                                        <div key={row.key} className="px-1.5 py-1 text-[13.5px] leading-relaxed text-[var(--app-fg)]">
                                            {row.text}
                                        </div>
                                    )
                                }
                                if (row.kind === 'image') {
                                    return (
                                        <div key={row.key} className="py-1.5">
                                            <GeneratedImageCard block={row.block} />
                                        </div>
                                    )
                                }
                                if (row.kind === 'file') {
                                    return (
                                        <div key={row.key} className="py-1.5">
                                            <GeneratedFileCard block={row.block} />
                                        </div>
                                    )
                                }
                                return null
                            })}
                        </div>
                    ) : viewMode === 'thinking' ? (
                        <div className="ml-2 mt-1 border-l border-[var(--app-border)] pl-3.5 space-y-1">
                            {stepRows
                                .filter((row): row is TurnReasoningRow => row.kind === 'reasoning')
                                .map((row) => (
                                    <TimelineThoughtRow
                                        key={row.key}
                                        row={row}
                                        isActiveStreaming={false}
                                        defaultExpanded={true}
                                        lang={lang}
                                    />
                                ))}
                        </div>
                    ) : null}

                    {/* Active working indicator */}
                    {props.streaming ? (
                        <div className="mt-2 flex items-center gap-2 pl-0.5" data-testid="turn-working-sparkle">
                            <TurnActivityIndicator
                                variant={props.indicatorVariant ?? 'equalizer-bars'}
                                color={props.indicatorColor}
                                size={16}
                            />
                        </div>
                    ) : null}
                </div>
            ) : null}

            {/* Trailing final assistant response */}
            {trailing.map((row) => (
                <div
                    key={row.key}
                    className="mt-3 text-[15px] leading-relaxed text-[var(--app-fg)] whitespace-pre-wrap"
                    data-testid="turn-trailing-answer"
                >
                    {props.renderTrailingText ? props.renderTrailingText(row.text, props.streaming) : renderSimpleMarkdownText(row.text)}
                </div>
            ))}
        </div>
    )
}

export function DockedTodoProgressBar(props: {
    todos: DockedTodoItem[]
    defaultExpanded?: boolean
    lang?: 'en' | 'zh-CN'
}) {
    const [expanded, setExpanded] = useState(props.defaultExpanded ?? false)
    const lang = props.lang ?? 'en'
    if (props.todos.length === 0) return null

    const total = props.todos.length
    const completedCount = props.todos.filter((t) => t.status === 'completed').length
    const activeIndex = props.todos.findIndex((t) => t.status === 'in_progress')
    const activeItem = activeIndex >= 0 ? props.todos[activeIndex] : null
    const allDone = completedCount === total

    const progressCounter = allDone
        ? (lang === 'zh-CN' ? `${total} / ${total}` : `${total} of ${total}`)
        : activeIndex >= 0
            ? (lang === 'zh-CN' ? `${activeIndex + 1} / ${total}` : `${activeIndex + 1} of ${total}`)
            : (lang === 'zh-CN' ? `${completedCount} / ${total}` : `${completedCount} of ${total}`)

    const summaryLabel = allDone
        ? (lang === 'zh-CN' ? '已完成' : 'Done')
        : (activeItem?.activeForm || activeItem?.content || props.todos[0]?.content || '')

    return (
        <div
            className="composer-dock-card overflow-hidden rounded-t-xl border border-b-0 border-[var(--app-border)] bg-[var(--app-subtle-bg)]/70"
            data-testid="docked-todo-bar"
        >
            <button
                type="button"
                aria-expanded={expanded}
                onClick={() => setExpanded((v) => !v)}
                className="flex w-full items-center gap-3 px-3.5 py-2 text-left text-[13px] transition-colors hover:bg-[var(--app-subtle-bg)]"
            >
                <span className="shrink-0 tabular-nums text-[12px] font-medium text-[var(--app-hint)]">
                    {progressCounter}
                </span>
                <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate font-medium text-[var(--app-fg)]">
                    {allDone ? (
                        <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
                            ✓
                        </span>
                    ) : null}
                    <span className="truncate">{summaryLabel}</span>
                </span>
                <SmallChevron open={expanded} direction="up" className="text-[var(--app-hint)]" />
            </button>

            {expanded ? (
                <div className="border-t border-[var(--app-border)]/70 px-3.5 py-2.5 space-y-2">
                    {props.todos.map((item, idx) => {
                        const isDone = item.status === 'completed'
                        const isRunning = item.status === 'in_progress'
                        return (
                            <div
                                key={item.id}
                                className="flex items-start gap-2.5 text-[13px] leading-5"
                            >
                                <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">
                                    {isDone ? (
                                        <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-emerald-500/20 text-[10px] font-bold text-emerald-600 dark:text-emerald-400">
                                            ✓
                                        </span>
                                    ) : isRunning ? (
                                        <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-[#da7756] border-t-transparent" />
                                    ) : (
                                        <span className="inline-block h-3.5 w-3.5 rounded-full border border-[var(--app-hint)]/50" />
                                    )}
                                </span>
                                <span className="shrink-0 tabular-nums text-[12px] text-[var(--app-hint)]">
                                    {idx + 1}.
                                </span>
                                <span
                                    className={cn(
                                        'min-w-0 flex-1',
                                        isDone && 'text-[var(--app-hint)] line-through decoration-[var(--app-hint)]/50',
                                        isRunning && 'font-medium text-[var(--app-fg)]',
                                        !isDone && !isRunning && 'text-[var(--app-hint)]'
                                    )}
                                >
                                    {isRunning && item.activeForm ? item.activeForm : item.content}
                                </span>
                            </div>
                        )
                    })}
                </div>
            ) : null}
        </div>
    )
}

export function DockedQuestionWizard(props: {
    questions: DockedQuestionItem[]
    onSubmit: (answers: Record<string, string>) => void
    onSkip?: () => void
}) {
    const [stepIndex, setStepIndex] = useState(0)
    const [answers, setAnswers] = useState<Record<string, string>>({})
    const [customText, setCustomText] = useState('')
    const [editingCustom, setEditingCustom] = useState(false)

    const total = props.questions.length
    const current = props.questions[stepIndex]
    if (!current) return null

    const selectOption = (value: string) => {
        const nextAnswers = { ...answers, [current.id]: value }
        setAnswers(nextAnswers)
        setEditingCustom(false)
        setCustomText('')
        if (stepIndex < total - 1) {
            setStepIndex(stepIndex + 1)
        } else {
            props.onSubmit(nextAnswers)
        }
    }

    return (
        <div
            className="composer-dock-card overflow-hidden rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] p-3.5 shadow-sm"
            data-testid="docked-question-wizard"
        >
            <div className="flex items-start justify-between gap-3">
                <div className="text-[14px] font-medium leading-5 text-[var(--app-fg)]">
                    {current.question}
                </div>
                <div className="flex shrink-0 items-center gap-1 text-[12px] tabular-nums text-[var(--app-hint)]">
                    <button
                        type="button"
                        disabled={stepIndex === 0}
                        onClick={() => setStepIndex((i) => Math.max(0, i - 1))}
                        className="rounded p-1 hover:bg-[var(--app-subtle-bg)] disabled:opacity-30"
                        aria-label="Previous question"
                    >
                        ‹
                    </button>
                    <span>
                        {stepIndex + 1} of {total}
                    </span>
                    <button
                        type="button"
                        disabled={stepIndex >= total - 1}
                        onClick={() => setStepIndex((i) => Math.min(total - 1, i + 1))}
                        className="rounded p-1 hover:bg-[var(--app-subtle-bg)] disabled:opacity-30"
                        aria-label="Next question"
                    >
                        ›
                    </button>
                </div>
            </div>

            <div className="mt-2.5 space-y-1.5">
                {current.options.map((opt, idx) => {
                    const selected = answers[current.id] === opt.label
                    return (
                        <button
                            key={opt.label}
                            type="button"
                            onClick={() => selectOption(opt.label)}
                            className={cn(
                                'flex w-full items-center gap-2.5 rounded-lg border px-3 py-2 text-left text-[13px] transition-colors',
                                selected
                                    ? 'border-[#da7756] bg-[#da7756]/10 text-[var(--app-fg)]'
                                    : 'border-[var(--app-border)]/70 bg-[var(--app-subtle-bg)]/40 text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)]'
                            )}
                        >
                            <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded border border-[var(--app-border)] bg-[var(--app-bg)] text-[11px] font-medium tabular-nums text-[var(--app-hint)]">
                                {idx + 1}
                            </span>
                            <div className="min-w-0 flex-1">
                                <div className="font-medium">{opt.label}</div>
                                {opt.description ? (
                                    <div className="text-[11.5px] text-[var(--app-hint)]">{opt.description}</div>
                                ) : null}
                            </div>
                        </button>
                    )
                })}

                <div className="flex items-center gap-2">
                    {editingCustom ? (
                        <form
                            className="flex flex-1 items-center gap-2"
                            onSubmit={(e) => {
                                e.preventDefault()
                                if (customText.trim()) selectOption(customText.trim())
                            }}
                        >
                            <input
                                type="text"
                                value={customText}
                                onChange={(e) => setCustomText(e.target.value)}
                                placeholder="Type something else..."
                                className="flex-1 rounded-lg border border-[var(--app-border)] bg-[var(--app-subtle-bg)]/50 px-3 py-1.5 text-[13px] text-[var(--app-fg)] outline-none focus:border-[#da7756]"
                                autoFocus
                            />
                            <button
                                type="submit"
                                className="rounded-lg bg-[#da7756] px-3 py-1.5 text-[12px] font-medium text-white"
                            >
                                Submit
                            </button>
                        </form>
                    ) : (
                        <button
                            type="button"
                            onClick={() => setEditingCustom(true)}
                            className="flex flex-1 items-center gap-2.5 rounded-lg border border-dashed border-[var(--app-border)] px-3 py-2 text-left text-[13px] text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)]/50 hover:text-[var(--app-fg)]"
                        >
                            <span aria-hidden="true" className="inline-flex h-5 w-5 items-center justify-center text-xs">
                                ✎
                            </span>
                            <span>Something else</span>
                        </button>
                    )}

                    {props.onSkip ? (
                        <button
                            type="button"
                            onClick={props.onSkip}
                            className="shrink-0 rounded-lg border border-[var(--app-border)] px-3 py-2 text-[12.5px] text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
                        >
                            Skip
                        </button>
                    ) : null}
                </div>
            </div>
        </div>
    )
}

export function SubmittedQuestionSummaryBubble(props: {
    questions: DockedQuestionItem[]
    answers: Record<string, string>
}) {
    return (
        <div className="my-3 flex justify-end" data-testid="submitted-qa-bubble">
            <div className="max-w-lg space-y-2.5 rounded-2xl border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-4 py-3 text-[13.5px]">
                {props.questions.map((q) => (
                    <div key={q.id} className="space-y-0.5">
                        <div className="text-[12px] text-[var(--app-hint)]">{q.question}</div>
                        <div className="font-medium text-[var(--app-fg)]">
                            {props.answers[q.id] ?? 'Skipped'}
                        </div>
                    </div>
                ))}
            </div>
        </div>
    )
}
