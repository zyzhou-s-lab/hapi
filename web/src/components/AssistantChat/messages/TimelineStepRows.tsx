import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
    describeCoalescedTurnStep,
    describeTurnToolStep,
    extractThoughtSummary,
    type TurnCoalescedRow,
    type TurnReasoningRow,
    type TurnRow,
    type TurnStepPreview,
    type TurnToolRow,
} from '@/components/AssistantChat/messages/turnBlockModel'
import { TimelineTodoChecklistCard } from '@/components/AssistantChat/messages/TurnTodoSection'
import { ToolDetailDialogContent } from '@/components/ToolCard/ToolCard'
import { AskUserQuestionFooter } from '@/components/ToolCard/AskUserQuestionFooter'
import { RequestUserInputFooter } from '@/components/ToolCard/RequestUserInputFooter'
import { isAskUserQuestionToolName } from '@/components/ToolCard/askUserQuestion'
import { isRequestUserInputToolName } from '@/components/ToolCard/requestUserInput'
import { PermissionFooter } from '@/components/ToolCard/PermissionFooter'
import { projectToolTodoSnapshot } from '@/chat/projections/todoProjection'
import type { ChecklistItem } from '@/components/ToolCard/checklist'
import type { ToolCallBlock } from '@/chat/types'
import { useOptionalHappyChatStaticContext } from '@/components/AssistantChat/context'
import { SmallChevron } from '@/components/ui/card'
import { cn } from '@/lib/utils'

export { SmallChevron }

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
                window.setTimeout(() => setCopied(false), 1400)
            }}
            className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
            title={label}
            aria-label={label}
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

export function extractToolChecklistItems(
    block: ToolCallBlock,
    allRows?: readonly TurnRow[],
    fallbackItems?: readonly ChecklistItem[]
): ChecklistItem[] {
    const allToolBlocks = allRows
        ? allRows.filter((row): row is TurnToolRow => row.kind === 'tool').map((row) => row.block)
        : undefined
    return [...projectToolTodoSnapshot(block, allToolBlocks, fallbackItems).items]
}

export function StepInlinePreviewCard(props: { preview: TurnStepPreview }) {
    const ctx = useOptionalHappyChatStaticContext()
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

    if (preview.kind === 'file-read') {
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
    if (preview.kind === 'compaction') {
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

    const checklistItems = extractToolChecklistItems(preview.block)
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
                <ToolDetailDialogContent block={preview.block} metadata={ctx?.metadata ?? null} hideTiming />
            </div>
        </div>
    )
}

export function RailStepCompletionMorphBadge(props: { isRunning: boolean; forceMorph?: boolean; color?: string }) {
    const color = props.color ?? '#da7756'
    const wasRunning = useRef(props.isRunning)
    const didForceMorph = useRef(false)
    const [showMorph, setShowMorph] = useState(false)

    useLayoutEffect(() => {
        if (props.isRunning) {
            wasRunning.current = true
            setShowMorph(false)
            return undefined
        }
        if ((wasRunning.current && !props.isRunning) || (props.forceMorph && !didForceMorph.current)) {
            wasRunning.current = false
            didForceMorph.current = true
            setShowMorph(true)
            const timer = window.setTimeout(() => {
                setShowMorph(false)
            }, 980)
            return () => window.clearTimeout(timer)
        }
        return undefined
    }, [props.isRunning, props.forceMorph])
    if (!showMorph && !props.forceMorph) return null

    return (
        <span
            className="turn-step-morph-container pointer-events-none absolute -left-[22.5px] top-[14px] z-20 -translate-y-1/2 flex h-4 w-4 items-center justify-center rounded-full bg-[var(--app-bg)] ring-2 ring-[var(--app-bg)]"
            data-testid="rail-step-checkmark"
            data-indicator-color={color}
            aria-hidden="true"
            style={{ color }}
        >
            <svg
                viewBox="0 0 16 16"
                className="turn-step-ring-closing absolute inset-0 h-4 w-4"
                data-testid="rail-step-closing-ring"
            >
                <circle
                    cx="8"
                    cy="8"
                    r="5.75"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                />
            </svg>
            <span
                className="turn-step-check-badge relative inline-flex h-3.5 w-3.5 items-center justify-center rounded-full shadow-xs"
                data-testid="rail-step-check-pop"
                style={{
                    backgroundColor: color,
                }}
            >
                <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none">
                    <path
                        d="M4.5 8.2L7.0 10.6L11.5 5.6"
                        stroke="#ffffff"
                        strokeWidth="1.95"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className="turn-step-check-path"
                    />
                </svg>
            </span>
        </span>
    )
}

export function RailSlidingActiveSpinner(props: {
    activeRowIndex: number
    offsetY: number
    targetOffsetY: number
    holdingForPrevMorph: boolean
    color?: string
}) {
    const color = props.color ?? '#da7756'
    return (
        <span
            className="pointer-events-none absolute -left-[8.5px] top-0 z-10 flex h-4 w-4 items-center justify-center rounded-full bg-[var(--app-bg)] ring-2 ring-[var(--app-bg)]"
            data-testid="rail-step-spinner"
            data-active-row-index={props.activeRowIndex}
            data-target-offset-y={props.targetOffsetY}
            data-handoff-phase={props.holdingForPrevMorph ? 'completing-prev' : 'sliding'}
            data-indicator-color={color}
            aria-hidden="true"
            style={{
                color,
                opacity: props.holdingForPrevMorph ? 0 : 1,
                transform: props.holdingForPrevMorph
                    ? `translate3d(0, ${props.offsetY}px, 0) translateY(-50%) scale(0.75)`
                    : `translate3d(0, ${props.offsetY}px, 0) translateY(-50%) scale(1)`,
                transition: 'transform 420ms cubic-bezier(0.22, 1, 0.36, 1), opacity 140ms ease',
            }}
        >
            <svg viewBox="0 0 16 16" className="turn-step-spinner-svg h-4 w-4">
                <circle
                    cx="8"
                    cy="8"
                    r="5.75"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeDasharray="16 38"
                    strokeLinecap="round"
                />
            </svg>
        </span>
    )
}

export function RailInlineActiveSpinner(props: {
    activeRowIndex?: number
    color?: string
}) {
    const color = props.color ?? '#da7756'
    return (
        <span
            className="pointer-events-none absolute -left-[22.5px] top-[14px] z-10 -translate-y-1/2 flex h-4 w-4 items-center justify-center rounded-full bg-[var(--app-bg)] ring-2 ring-[var(--app-bg)]"
            data-testid="rail-step-spinner"
            data-active-row-index={props.activeRowIndex}
            data-handoff-phase="sliding"
            data-indicator-color={color}
            aria-hidden="true"
            style={{ color }}
        >
            <svg viewBox="0 0 16 16" className="turn-step-spinner-svg h-4 w-4">
                <circle
                    cx="8"
                    cy="8"
                    r="5.75"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeDasharray="16 38"
                    strokeLinecap="round"
                />
            </svg>
        </span>
    )
}

export function TimelineThoughtRow(props: {
    row: TurnReasoningRow
    isActiveStreaming: boolean
    suppressRunningShimmer?: boolean
    defaultExpanded: boolean
    lang: 'en' | 'zh-CN'
    accentColor?: string
}) {
    const [open, setOpen] = useState(props.defaultExpanded)
    const [hasOpened, setHasOpened] = useState(props.defaultExpanded)
    useEffect(() => {
        setOpen(props.defaultExpanded)
        if (props.defaultExpanded) setHasOpened(true)
    }, [props.defaultExpanded])

    const label = props.lang === 'zh-CN'
        ? (props.isActiveStreaming ? '正在思考...' : '思考过程')
        : (props.isActiveStreaming ? 'Thinking...' : 'Thought')
    const thoughtSummary = useMemo(
        () => (!props.isActiveStreaming ? extractThoughtSummary(props.row.text) : ''),
        [props.isActiveStreaming, props.row.text]
    )

    return (
        <div data-hapi-share-exclude="true" className="relative py-0.5">
            <button
                type="button"
                aria-expanded={open}
                onClick={() => {
                    setHasOpened(true)
                    setOpen((v) => !v)
                }}
                className="group flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[13.5px] leading-5 text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)]/60 hover:text-[var(--app-fg)]"
            >
                <span
                    className={cn(
                        'shrink-0 transition-opacity duration-200',
                        props.isActiveStreaming && props.suppressRunningShimmer
                            ? 'text-[var(--app-hint)] opacity-45'
                            : props.isActiveStreaming
                                ? 'turn-text-shimmer font-medium'
                                : undefined
                    )}
                >
                    {label}
                </span>
                {!props.isActiveStreaming && !open && thoughtSummary ? (
                    <span
                        className="min-w-0 flex-1 truncate text-[var(--app-hint)]/80 group-hover:text-[var(--app-fg)]/85"
                        data-testid="thought-row-summary"
                    >
                        {thoughtSummary}
                    </span>
                ) : (
                    <span className="min-w-0 flex-1" />
                )}
                <SmallChevron open={open} className="shrink-0 opacity-70 group-hover:opacity-100" />
            </button>
            <div
                className="turn-collapsible-shell"
                data-open={open ? 'true' : 'false'}
                aria-hidden={!open}
            >
                <div className="turn-collapsible-body">
                    {open || hasOpened ? (
                        <div className="ml-2 mt-1 mb-1.5 border-l border-[var(--app-border)]/70 pl-3 text-[13px] leading-relaxed text-[var(--app-hint)] whitespace-pre-wrap">
                            {props.row.text}
                        </div>
                    ) : null}
                </div>
            </div>
        </div>
    )
}

export function TimelineToolStepRow(props: {
    row: TurnToolRow
    rowIndex?: number
    defaultExpanded: boolean
    lang: 'en' | 'zh-CN'
    accentColor?: string
    forceMorph?: boolean
    showInlineRailSpinner?: boolean
    suppressRunningShimmer?: boolean
}) {
    const ctx = useOptionalHappyChatStaticContext()
    const [open, setOpen] = useState(props.defaultExpanded)
    const [hasOpened, setHasOpened] = useState(props.defaultExpanded)
    useEffect(() => {
        setOpen(props.defaultExpanded)
        if (props.defaultExpanded) setHasOpened(true)
    }, [props.defaultExpanded])

    const descriptor = useMemo(
        () => describeTurnToolStep(props.row, props.lang),
        [props.row, props.lang]
    )

    const asks = isAskUserQuestionToolName(props.row.block.tool.name)
    const requestsInput = isRequestUserInputToolName(props.row.block.tool.name)
    const interactive = Boolean((asks || requestsInput) && props.row.permission && ctx)

    return (
        <div data-hapi-share-exclude="true" className="relative py-0.5">
            {props.showInlineRailSpinner && descriptor.isRunning && !props.suppressRunningShimmer ? (
                <RailInlineActiveSpinner
                    activeRowIndex={props.rowIndex}
                    color={props.accentColor}
                />
            ) : null}
            <RailStepCompletionMorphBadge
                isRunning={descriptor.isRunning}
                forceMorph={props.forceMorph}
                color={props.accentColor}
            />
            <button
                type="button"
                aria-expanded={open}
                onClick={() => {
                    setHasOpened(true)
                    setOpen((v) => !v)
                }}
                className="group flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[13.5px] leading-5 transition-colors hover:bg-[var(--app-subtle-bg)]/60"
            >
                {props.row.error ? (
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--app-badge-error-text)]" />
                ) : null}
                <span
                    className={cn(
                        'shrink-0 transition-opacity duration-200',
                        props.row.error
                            ? 'text-[var(--app-badge-error-text)]'
                            : descriptor.isRunning && !props.suppressRunningShimmer
                                ? 'turn-text-shimmer font-medium'
                                : descriptor.isQueued || (descriptor.isRunning && props.suppressRunningShimmer)
                                    ? 'text-[var(--app-hint)] opacity-45'
                                    : 'text-[var(--app-hint)] group-hover:text-[var(--app-fg)]'
                    )}
                >
                    {descriptor.verbLabel}
                </span>
                {descriptor.intentLabel ? (
                    <span
                        className={cn(
                            'min-w-0 flex-1 truncate transition-opacity duration-200',
                            descriptor.isRunning && !props.suppressRunningShimmer
                                ? 'turn-text-shimmer font-medium'
                                : descriptor.isQueued || (descriptor.isRunning && props.suppressRunningShimmer)
                                    ? 'text-[var(--app-hint)] opacity-45'
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
            {interactive && ctx ? (
                <div className="mt-1.5 mb-2 pl-2">
                    {asks ? (
                        <AskUserQuestionFooter
                            api={ctx.api}
                            sessionId={ctx.sessionId}
                            tool={props.row.block.tool}
                            disabled={ctx.disabled}
                            onDone={ctx.onRefresh}
                        />
                    ) : (
                        <RequestUserInputFooter
                            api={ctx.api}
                            sessionId={ctx.sessionId}
                            tool={props.row.block.tool}
                            disabled={ctx.disabled}
                            onDone={ctx.onRefresh}
                        />
                    )}
                </div>
            ) : null}
            <div
                className="turn-collapsible-shell"
                data-open={open ? 'true' : 'false'}
                aria-hidden={!open}
            >
                <div className="turn-collapsible-body">
                    {open || hasOpened ? <StepInlinePreviewCard preview={descriptor.preview} /> : null}
                </div>
            </div>
            {props.row.permission && !interactive && ctx ? (
                <div className="mt-1.5 mb-2 pl-2">
                    <PermissionFooter
                        api={ctx.api}
                        sessionId={ctx.sessionId}
                        metadata={ctx.metadata}
                        tool={props.row.block.tool}
                        disabled={ctx.disabled}
                        onDone={ctx.onRefresh}
                    />
                </div>
            ) : null}
        </div>
    )
}

export function TimelineCoalescedStepRow(props: {
    row: TurnCoalescedRow
    lang: 'en' | 'zh-CN'
    accentColor?: string
    forceMorph?: boolean
}) {
    const [open, setOpen] = useState(false)
    const [hasOpened, setHasOpened] = useState(false)
    const descriptor = useMemo(
        () => describeCoalescedTurnStep(props.row, props.lang),
        [props.row, props.lang]
    )

    return (
        <div data-hapi-share-exclude="true" className="relative py-0.5" data-testid={`coalesced-step-${props.row.category}`}>
            <RailStepCompletionMorphBadge
                isRunning={false}
                forceMorph={props.forceMorph}
                color={props.accentColor}
            />
            <button
                type="button"
                aria-expanded={open}
                onClick={() => {
                    setHasOpened(true)
                    setOpen((v) => !v)
                }}
                className="group flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[13.5px] leading-5 transition-colors hover:bg-[var(--app-subtle-bg)]/60"
            >
                <span className="shrink-0 text-[var(--app-hint)] transition-opacity duration-200 group-hover:text-[var(--app-fg)]">
                    {descriptor.verbLabel}
                </span>
                {descriptor.intentLabel ? (
                    <span className="min-w-0 flex-1 truncate text-[var(--app-hint)] transition-opacity duration-200 group-hover:text-[var(--app-fg)]">
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
            <div
                className="turn-collapsible-shell"
                data-open={open ? 'true' : 'false'}
                aria-hidden={!open}
            >
                <div className="turn-collapsible-body">
                    {open || hasOpened ? (
                        <div className="ml-2 mt-1 mb-1.5 border-l border-[var(--app-border)]/70 pl-2.5 space-y-0.5">
                            {props.row.rows.map((member, memberIdx) =>
                                member.kind === 'reasoning' ? (
                                    <TimelineThoughtRow
                                        key={member.key}
                                        row={member}
                                        isActiveStreaming={false}
                                        defaultExpanded={false}
                                        lang={props.lang}
                                        accentColor={props.accentColor}
                                    />
                                ) : (
                                    <TimelineToolStepRow
                                        key={member.key}
                                        row={member}
                                        rowIndex={memberIdx}
                                        defaultExpanded={false}
                                        lang={props.lang}
                                        accentColor={props.accentColor}
                                    />
                                )
                            )}
                        </div>
                    ) : null}
                </div>
            </div>
        </div>
    )
}

export function renderSimpleMarkdownText(text: string): React.ReactNode {
    const tokens = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g)
    return (
        <div className="whitespace-pre-wrap">
            {tokens.map((token, idx) => {
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
            })}
        </div>
    )
}

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
