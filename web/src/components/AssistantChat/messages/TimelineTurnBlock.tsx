import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { formatDuration } from '@/chat/presentation'
import {
    coalesceTurnStepRows,
    describeCoalescedTurnStep,
    describeTurnToolStep,
    extractThoughtSummary,
    summarizeTurnActivity,
    type TurnCoalescedRow,
    type TurnStepPreview,
    type TurnPartition,
    type TurnReasoningRow,
    type TurnRow,
    type TurnToolRow,
} from '@/components/AssistantChat/messages/turnBlockModel'
import { GeneratedFileCard, GeneratedImageCard } from '@/components/AssistantChat/messages/ToolMessage'
import { ToolDetailDialogContent } from '@/components/ToolCard/ToolCard'
import { AskUserQuestionFooter } from '@/components/ToolCard/AskUserQuestionFooter'
import { RequestUserInputFooter } from '@/components/ToolCard/RequestUserInputFooter'
import { isAskUserQuestionToolName } from '@/components/ToolCard/askUserQuestion'
import { isRequestUserInputToolName } from '@/components/ToolCard/requestUserInput'
import { PermissionFooter } from '@/components/ToolCard/PermissionFooter'
import {
    collectOmpTodoTurnContext,
    extractTodoChecklist,
    extractUpdatePlanChecklist,
    type ChecklistItem,
} from '@/components/ToolCard/checklist'
import { resolveToolViewName } from '@/components/ToolCard/toolNameAliases'
import type { ToolCallBlock } from '@/chat/types'
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
        <div className="mt-1.5 mb-2 rounded-lg border border-[var(--app-border)] bg-[var(--app-subtle-bg)]/45 p-2.5">
            <ToolDetailDialogContent block={preview.block} metadata={ctx?.metadata ?? null} hideTiming />
        </div>
    )
}

function extractToolChecklistItems(block: ToolCallBlock, allRows?: readonly TurnRow[]): ChecklistItem[] {
    const resolved = resolveToolViewName(block.tool.name)
    if (resolved !== 'TodoWrite' && resolved !== 'UpdatePlan') return []
    const turnContext = resolved === 'TodoWrite' && allRows
        ? collectOmpTodoTurnContext(
            allRows
                .filter((row): row is TurnToolRow => row.kind === 'tool' && resolveToolViewName(row.block.tool.name) === 'TodoWrite')
                .map((row) => ({ input: row.block.tool.input, result: row.block.tool.result }))
        )
        : undefined
    const rawItems = resolved === 'TodoWrite'
        ? extractTodoChecklist(block.tool.input, block.tool.result, turnContext)
        : extractUpdatePlanChecklist(block.tool.input, block.tool.result)

    let items = rawItems
    if (allRows && block.tool.result == null) {
        let baseItems: ChecklistItem[] = []
        for (const row of allRows) {
            if (row.kind !== 'tool') continue
            if (row.block.id === block.id) break
            if (resolveToolViewName(row.block.tool.name) !== resolved) continue
            const prior = resolved === 'TodoWrite'
                ? extractTodoChecklist(row.block.tool.input, row.block.tool.result, turnContext)
                : extractUpdatePlanChecklist(row.block.tool.input, row.block.tool.result)
            if (prior.length > 0) baseItems = prior
        }
        if (baseItems.length > 0) {
            const merged = baseItems.map((item) => ({ ...item }))
            for (const update of rawItems) {
                const existing = merged.find((item) => item.text === update.text)
                if (existing) {
                    existing.status = update.status
                } else {
                    merged.push({ ...update })
                }
            }
            items = merged
        }
    }

    if (
        block.tool.state === 'running'
        && items.length > 0
        && !items.some((item) => item.status === 'in_progress')
    ) {
        const firstPendingIdx = items.findIndex((item) => item.status === 'pending')
        if (firstPendingIdx >= 0) {
            items = items.map((item, idx) => (idx === firstPendingIdx ? { ...item, status: 'in_progress' } : item))
        }
    }

    return items
}

export function TimelineTodoChecklistCard(props: { items: readonly ChecklistItem[]; className?: string }) {
    return (
        <div
            className={cn(
                'rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] px-3.5 py-2.5 shadow-2xs',
                props.className
            )}
            data-testid="turn-todo-checklist-card"
        >
            <div className="space-y-1">
                {props.items.map((item, index) => {
                    const isRunning = item.status === 'in_progress'
                    const isCompleted = item.status === 'completed'
                    const isBlocked = item.status === 'blocked'
                    return (
                        <div
                            key={item.id ?? `${index}:${item.text}`}
                            className="flex items-center gap-2.5 py-0.5 text-[13.5px] leading-5"
                            data-testid="turn-todo-card-item"
                            data-todo-status={item.status}
                        >
                            {isRunning ? (
                                <span
                                    className="inline-flex h-4 w-4 shrink-0 items-center justify-center text-[var(--app-fg)]"
                                    data-testid="turn-todo-item-spinner"
                                >
                                    <svg className="h-4 w-4 animate-spin" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                                        <circle
                                            cx="8"
                                            cy="8"
                                            r="6.25"
                                            stroke="currentColor"
                                            strokeOpacity="0.2"
                                            strokeWidth="1.6"
                                        />
                                        <path
                                            d="M14.25 8a6.25 6.25 0 0 0-6.25-6.25"
                                            stroke="currentColor"
                                            strokeWidth="1.6"
                                            strokeLinecap="round"
                                        />
                                    </svg>
                                </span>
                            ) : isCompleted ? (
                                <span
                                    className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-[var(--app-fg)] text-[var(--app-bg)]"
                                    data-testid="turn-todo-item-check"
                                >
                                    <svg className="h-2.5 w-2.5" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                                        <path
                                            d="M2.4 6.2L4.9 8.6L9.6 3.5"
                                            stroke="currentColor"
                                            strokeWidth="1.8"
                                            strokeLinecap="round"
                                            strokeLinejoin="round"
                                        />
                                    </svg>
                                </span>
                            ) : isBlocked ? (
                                <span
                                    className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-[var(--app-badge-error-border)] bg-[var(--app-badge-error-bg)] text-[10px] font-bold text-[var(--app-badge-error-text)]"
                                    data-testid="turn-todo-item-blocked"
                                >
                                    !
                                </span>
                            ) : (
                                <span
                                    className="inline-flex h-4 w-4 shrink-0 items-center justify-center"
                                    data-testid="turn-todo-item-pending"
                                >
                                    <span className="h-3.5 w-3.5 rounded-full border border-[var(--app-hint)]/45" />
                                </span>
                            )}
                            <span
                                className={cn(
                                    'min-w-0 flex-1 break-words',
                                    isRunning && 'font-medium text-[var(--app-fg)]',
                                    isCompleted && 'text-[var(--app-fg)]/85',
                                    isBlocked && 'text-[var(--app-badge-error-text)]',
                                    !isRunning && !isCompleted && !isBlocked && 'text-[var(--app-hint)]'
                                )}
                            >
                                {item.text}
                            </span>
                        </div>
                    )
                })}
            </div>
        </div>
    )
}

function RailStepCompletionMorphBadge(props: { isRunning: boolean; forceMorph?: boolean; color?: string }) {
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
            {/* 1. Spinning ring closes its 360° loop and shrinks to center */}
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
            {/* 2. Solid unified-color checkmark badge pops out, holds, then disappears with container */}
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

function RailSlidingActiveSpinner(props: {
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

function RailInlineActiveSpinner(props: {
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

function TimelineThoughtRow(props: {
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

function TimelineToolStepRow(props: {
    row: TurnToolRow
    rowIndex?: number
    defaultExpanded: boolean
    lang: 'en' | 'zh-CN'
    accentColor?: string
    forceMorph?: boolean
    showInlineRailSpinner?: boolean
    suppressRunningShimmer?: boolean
}) {
    const ctx = useOptionalHappyChatContext()
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

function TimelineCoalescedStepRow(props: {
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

function renderSimpleMarkdownText(text: string): React.ReactNode {
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

    const hasPendingInteractive = props.partition.rows.some(
        (row) => row.kind === 'tool' && (row.permission || row.block.tool.state === 'pending')
    )
    const failed = props.partition.rows.some(
        (row) => row.kind === 'tool' && row.error && row.pinned
    )

    useEffect(() => {
        if (sawStream.current && !props.streaming && viewMode !== 'verbose' && !hasPendingInteractive) {
            setOpen(false)
        }
        sawStream.current = props.streaming
    }, [props.streaming, viewMode, hasPendingInteractive])

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

    const trailing = useMemo(
        () => props.partition.rows.filter(
            (row): row is Extract<TurnRow, { kind: 'text' }> => row.kind === 'text' && row.trailing
        ),
        [props.partition.rows]
    )
    const nonTrailingRows = useMemo(
        () => props.partition.rows.filter(
            (row) => !(row.kind === 'text' && row.trailing)
        ),
        [props.partition.rows]
    )
    const rawStepRows = useMemo(
        () => nonTrailingRows.filter(
            (row) => row.kind !== 'image' && row.kind !== 'file'
        ),
        [nonTrailingRows]
    )
    const stepRows = useMemo(
        () => (viewMode === 'verbose'
            ? rawStepRows
            : coalesceTurnStepRows(rawStepRows, { absorbTransitionalThoughts: viewMode === 'normal' })),
        [rawStepRows, viewMode]
    )
    const mediaRows = useMemo(
        () => nonTrailingRows.filter(
            (row): row is Extract<TurnRow, { kind: 'image' | 'file' }> => row.kind === 'image' || row.kind === 'file'
        ),
        [nonTrailingRows]
    )
    const pinnedToolRows = useMemo(
        () => stepRows.filter(
            (row): row is TurnToolRow | TurnCoalescedRow => (row.kind === 'tool' || row.kind === 'coalesced') && row.pinned
        ),
        [stepRows]
    )
    const pinnedChecklistByKey = useMemo(() => {
        const map = new Map<string, ChecklistItem[]>()
        for (const row of pinnedToolRows) {
            if (row.kind !== 'tool') continue
            const items = extractToolChecklistItems(row.block, rawStepRows)
            if (items.length > 0) {
                map.set(row.key, items)
            }
        }
        return map
    }, [pinnedToolRows, rawStepRows])
    const everyPinnedIsChecklistCard =
        pinnedToolRows.length > 0 && pinnedToolRows.every((row) => pinnedChecklistByKey.has(row.key))
    const isInitialStreamingWait = props.streaming && stepRows.length === 0 && mediaRows.length === 0 && trailing.length === 0
    const hasSteps = stepRows.some((row) => row.kind === 'reasoning' || row.kind === 'tool' || row.kind === 'coalesced') || isInitialStreamingWait
    const headerText = props.streaming ? summary.workingHeader : summary.completedHeader
    const accentColor = props.indicatorColor ?? '#da7756'

    const hasRunningOrPendingTool = useMemo(
        () => rawStepRows.some(
            (row) => row.kind === 'tool' && (row.block.tool.state === 'running' || row.block.tool.state === 'pending' || row.permission)
        ),
        [rawStepRows]
    )
    const hasTrailingReasoningStep =
        props.streaming
        && trailing.length === 0
        && stepRows.length > 0
        && stepRows[stepRows.length - 1]?.kind === 'reasoning'
    const showFrontierSlot =
        props.streaming
        && hasSteps
        && trailing.length === 0
        && !hasRunningOrPendingTool
        && !hasTrailingReasoningStep

    const activeRunningRowIndices = useMemo(() => {
        const indices: number[] = []
        for (let i = 0; i < stepRows.length; i += 1) {
            const row = stepRows[i]!
            if (row.kind === 'tool' && (row.block.tool.state === 'running' || (row.block.tool.state === 'pending' && Boolean(row.permission)))) {
                indices.push(i)
            }
        }
        if (indices.length > 0) {
            return indices
        }
        if (hasTrailingReasoningStep) {
            return [stepRows.length - 1]
        }
        if (showFrontierSlot) {
            return [stepRows.length]
        }
        return []
    }, [stepRows, hasTrailingReasoningStep, showFrontierSlot])

    const activeRunningRowIndex = activeRunningRowIndices[0] ?? -1

    const railRef = useRef<HTMLDivElement | null>(null)
    const rowElsRef = useRef<Array<HTMLDivElement | null>>([])
    const seenToolStatesRef = useRef<Map<string, boolean> | null>(null)
    const latestActiveRowIndexRef = useRef<number>(activeRunningRowIndex)
    latestActiveRowIndexRef.current = activeRunningRowIndex
    const holdingForPrevMorphRef = useRef<boolean>(false)
    const handoffTimerRef = useRef<number | undefined>(undefined)
    const fastMorphTimerRef = useRef<number | undefined>(undefined)
    const [fastMorphRowKey, setFastMorphRowKey] = useState<string | null>(null)
    const [spinnerOffsetY, setSpinnerOffsetY] = useState<number>(14)
    const [targetOffsetY, setTargetOffsetY] = useState<number>(14)
    const [holdingForPrevMorph, setHoldingForPrevMorph] = useState<boolean>(false)

    const measureRowY = (rowIndex: number) => {
        const el = rowElsRef.current[rowIndex]
        const measuredTop = el ? el.offsetTop : 0
        return measuredTop > 0 || rowIndex === 0
            ? measuredTop + 14
            : rowIndex * 30 + 14
    }

    useEffect(() => {
        return () => {
            if (handoffTimerRef.current !== undefined) window.clearTimeout(handoffTimerRef.current)
            if (fastMorphTimerRef.current !== undefined) window.clearTimeout(fastMorphTimerRef.current)
        }
    }, [])

    useLayoutEffect(() => {
        const currentTools = new Map<string, { isRunning: boolean; isCompleted: boolean; rowIndex: number; rowKey: string }>()
        for (let i = 0; i < stepRows.length; i += 1) {
            const row = stepRows[i]!
            if (row.kind === 'coalesced') {
                for (const memberKey of row.memberKeys) {
                    currentTools.set(memberKey, {
                        isRunning: false,
                        isCompleted: true,
                        rowIndex: i,
                        rowKey: row.key,
                    })
                }
                continue
            }
            if (row.kind !== 'tool') continue
            const isRunning = row.block.tool.state === 'running' || (row.block.tool.state === 'pending' && row.permission)
            const isQueued = row.block.tool.state === 'pending' && !row.permission
            currentTools.set(row.key, {
                isRunning,
                isCompleted: !isRunning && !isQueued,
                rowIndex: i,
                rowKey: row.key,
            })
        }

        let transitionedMorphRowIndex = -1
        let fastArrivedKey: string | null = null
        let fastArrivedRowIndex = -1
        const activeRowKey = activeRunningRowIndex >= 0 && activeRunningRowIndex < stepRows.length
            ? stepRows[activeRunningRowIndex]?.key ?? null
            : null
        const targetWasAlreadyRunning = activeRowKey !== null
            && seenToolStatesRef.current?.get(activeRowKey) === true

        if (seenToolStatesRef.current === null) {
            const initialMap = new Map<string, boolean>()
            for (const [key, info] of currentTools.entries()) {
                initialMap.set(key, info.isRunning)
            }
            seenToolStatesRef.current = initialMap
        } else {
            for (const [key, info] of currentTools.entries()) {
                const wasRunning = seenToolStatesRef.current.get(key) === true
                if (wasRunning && !info.isRunning) {
                    transitionedMorphRowIndex = info.rowIndex
                }
            }
            if (transitionedMorphRowIndex < 0 && props.streaming) {
                for (const [key, info] of currentTools.entries()) {
                    if (!seenToolStatesRef.current.has(key) && info.isCompleted) {
                        fastArrivedKey = info.rowKey
                        fastArrivedRowIndex = info.rowIndex
                    }
                }
            }
            const nextMap = new Map<string, boolean>()
            for (const [key, info] of currentTools.entries()) {
                nextMap.set(key, info.isRunning)
            }
            seenToolStatesRef.current = nextMap
        }

        if (fastArrivedKey !== null) {
            if (fastMorphTimerRef.current !== undefined) window.clearTimeout(fastMorphTimerRef.current)
            setFastMorphRowKey(fastArrivedKey)
            fastMorphTimerRef.current = window.setTimeout(() => {
                setFastMorphRowKey(null)
                fastMorphTimerRef.current = undefined
            }, 980)
        }

        if (activeRunningRowIndex < 0) {
            if (handoffTimerRef.current !== undefined) {
                window.clearTimeout(handoffTimerRef.current)
                handoffTimerRef.current = undefined
            }
            holdingForPrevMorphRef.current = false
            setHoldingForPrevMorph(false)
            return
        }

        const nextTargetY = measureRowY(activeRunningRowIndex)
        setTargetOffsetY(nextTargetY)

        const morphSourceIndex = transitionedMorphRowIndex >= 0
            ? transitionedMorphRowIndex
            : fastArrivedRowIndex

        if (morphSourceIndex >= 0 && morphSourceIndex !== activeRunningRowIndex && !targetWasAlreadyRunning) {
            if (handoffTimerRef.current !== undefined) {
                window.clearTimeout(handoffTimerRef.current)
            }
            const startY = measureRowY(morphSourceIndex)
            holdingForPrevMorphRef.current = true
            setSpinnerOffsetY(startY)
            setHoldingForPrevMorph(true)
            handoffTimerRef.current = window.setTimeout(() => {
                handoffTimerRef.current = undefined
                const currentIdx = latestActiveRowIndexRef.current
                const latestTargetY = currentIdx >= 0 ? measureRowY(currentIdx) : nextTargetY
                holdingForPrevMorphRef.current = false
                setTargetOffsetY(latestTargetY)
                setHoldingForPrevMorph(false)
                setSpinnerOffsetY(latestTargetY)
            }, 820)
        } else if (!holdingForPrevMorphRef.current) {
            setHoldingForPrevMorph(false)
            setSpinnerOffsetY(nextTargetY)
        }
    }, [stepRows, activeRunningRowIndex, props.streaming])

    useLayoutEffect(() => {
        const currentIdx = latestActiveRowIndexRef.current
        if (currentIdx >= 0) {
            const updatedY = measureRowY(currentIdx)
            setTargetOffsetY(updatedY)
            if (!holdingForPrevMorphRef.current) {
                setSpinnerOffsetY(updatedY)
            }
        }
        const railEl = railRef.current
        if (!railEl || typeof ResizeObserver === 'undefined') {
            return undefined
        }
        const observer = new ResizeObserver(() => {
            const idx = latestActiveRowIndexRef.current
            if (idx < 0) return
            const updatedY = measureRowY(idx)
            setTargetOffsetY(updatedY)
            if (!holdingForPrevMorphRef.current) {
                setSpinnerOffsetY(updatedY)
            }
        })
        observer.observe(railEl)
        return () => observer.disconnect()
    }, [open, stepRows.length, showFrontierSlot])
    if (!props.partition.hasActivity && !isInitialStreamingWait) {
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
                        data-hapi-share-exclude="true"
                        className="group inline-flex max-w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left text-[13.5px] leading-5 text-[var(--app-hint)] transition-colors hover:text-[var(--app-fg)]"
                    >
                        {failed ? (
                            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--app-badge-error-text)]" />
                        ) : null}
                        <span
                            className={cn(
                                'truncate',
                                props.streaming ? 'turn-text-shimmer font-medium' : 'font-normal'
                            )}
                        >
                            {headerText}
                        </span>
                        <SmallChevron open={open} className="opacity-75 group-hover:opacity-100" />
                        {props.durationMs != null && props.durationMs > 0 ? (
                            <span className="ml-1 shrink-0 text-[11.5px] tabular-nums text-[var(--app-hint)]/75">
                                {formatDuration(props.durationMs)}
                            </span>
                        ) : null}
                    </button>

                    {/* Level 1: Left-indented vertical timeline rail */}
                    <div
                        className="turn-collapsible-shell"
                        data-open={open ? 'true' : 'false'}
                        aria-hidden={!open}
                        data-testid="turn-level1-shell"
                    >
                        <div className="turn-collapsible-body">
                            <div
                                ref={railRef}
                                className="relative ml-2.5 mt-1 border-l border-[var(--app-border)] pl-3.5 space-y-0.5"
                                data-testid="turn-level1-rail"
                            >
                                {activeRunningRowIndex >= 0 ? (
                                    <RailSlidingActiveSpinner
                                        activeRowIndex={activeRunningRowIndex}
                                        offsetY={spinnerOffsetY}
                                        targetOffsetY={targetOffsetY}
                                        holdingForPrevMorph={holdingForPrevMorph}
                                        color={accentColor}
                                    />
                                ) : null}
                                {stepRows.map((row, idx) => {
                                    const isLastStep = idx === stepRows.length - 1
                                    if (row.kind === 'reasoning') {
                                        return (
                                            <div
                                                key={row.key}
                                                ref={(el) => {
                                                    rowElsRef.current[idx] = el
                                                }}
                                                data-rail-row-index={idx}
                                            >
                                                <TimelineThoughtRow
                                                    row={row}
                                                    isActiveStreaming={props.streaming && isLastStep && activeRunningRowIndex === idx}
                                                    suppressRunningShimmer={holdingForPrevMorph && activeRunningRowIndex === idx}
                                                    defaultExpanded={viewMode === 'thinking' || viewMode === 'verbose'}
                                                    lang={lang}
                                                    accentColor={accentColor}
                                                />
                                            </div>
                                        )
                                    }
                                    if (row.kind === 'coalesced') {
                                        return (
                                            <div
                                                key={row.key}
                                                ref={(el) => {
                                                    rowElsRef.current[idx] = el
                                                }}
                                                data-rail-row-index={idx}
                                            >
                                                <TimelineCoalescedStepRow
                                                    row={row}
                                                    lang={lang}
                                                    accentColor={accentColor}
                                                    forceMorph={row.key === fastMorphRowKey}
                                                />
                                            </div>
                                        )
                                    }
                                    if (row.kind === 'tool') {
                                        return (
                                            <div
                                                key={row.key}
                                                ref={(el) => {
                                                    rowElsRef.current[idx] = el
                                                }}
                                                data-rail-row-index={idx}
                                            >
                                                <TimelineToolStepRow
                                                    row={row}
                                                    rowIndex={idx}
                                                    defaultExpanded={viewMode === 'verbose'}
                                                    lang={lang}
                                                    accentColor={accentColor}
                                                    forceMorph={row.key === fastMorphRowKey}
                                                    showInlineRailSpinner={idx !== activeRunningRowIndex}
                                                    suppressRunningShimmer={holdingForPrevMorph && activeRunningRowIndex === idx}
                                                />
                                            </div>
                                        )
                                    }
                                    if (row.kind === 'text') {
                                        return (
                                            <div
                                                key={row.key}
                                                ref={(el) => {
                                                    rowElsRef.current[idx] = el
                                                }}
                                                data-rail-row-index={idx}
                                                className="px-1.5 py-1 text-[13.5px] leading-relaxed text-[var(--app-fg)]"
                                            >
                                                {props.renderTrailingText ? props.renderTrailingText(row.text, false) : renderSimpleMarkdownText(row.text)}
                                            </div>
                                        )
                                    }
                                    return null
                                })}
                                {showFrontierSlot ? (
                                    <div
                                        key="__turn_frontier__"
                                        ref={(el) => {
                                            rowElsRef.current[stepRows.length] = el
                                        }}
                                        data-rail-row-index={stepRows.length}
                                        data-testid="rail-frontier-row"
                                    >
                                        <div data-hapi-share-exclude="true" className="relative py-0.5">
                                            <div className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[13.5px] leading-5 text-[var(--app-hint)]">
                                                <span
                                                    className={cn(
                                                        'transition-opacity duration-200',
                                                        holdingForPrevMorph && activeRunningRowIndex === stepRows.length
                                                            ? 'text-[var(--app-hint)] opacity-45'
                                                            : 'turn-text-shimmer font-medium'
                                                    )}
                                                >
                                                    {lang === 'zh-CN' ? '正在思考...' : 'Thinking...'}
                                                </span>
                                            </div>
                                        </div>
                                    </div>
                                ) : null}
                            </div>
                        </div>
                    </div>

                    {open && pinnedChecklistByKey.size > 0 ? (
                        <div className="mt-2 space-y-2" data-testid="turn-live-todo-cards">
                            {Array.from(pinnedChecklistByKey.entries()).map(([key, items]) => (
                                <TimelineTodoChecklistCard key={key} items={items} />
                            ))}
                        </div>
                    ) : null}

                    {!open ? (
                        <>
                            {viewMode === 'thinking' ? (
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
                            {pinnedToolRows.length > 0 ? (
                                <div
                                    className={cn(
                                        everyPinnedIsChecklistCard
                                            ? 'mt-2 space-y-2'
                                            : 'relative ml-2.5 mt-1 border-l border-[var(--app-border)] pl-3.5 space-y-1'
                                    )}
                                    data-testid="turn-collapsed-pinned-rail"
                                >
                                    {pinnedToolRows.map((row, idx) => {
                                        const checklistItems = pinnedChecklistByKey.get(row.key)
                                        if (checklistItems) {
                                            return <TimelineTodoChecklistCard key={row.key} items={checklistItems} />
                                        }
                                        return row.kind === 'coalesced' ? (
                                            <TimelineCoalescedStepRow
                                                key={row.key}
                                                row={row}
                                                lang={lang}
                                                accentColor={accentColor}
                                            />
                                        ) : (
                                            <TimelineToolStepRow
                                                key={row.key}
                                                row={row}
                                                rowIndex={idx}
                                                defaultExpanded={false}
                                                lang={lang}
                                                accentColor={accentColor}
                                                showInlineRailSpinner={true}
                                            />
                                        )
                                    })}
                                </div>
                            ) : null}
                            {nonTrailingRows.map((row, idx) => {
                                if (row.kind !== 'text') return null
                                const laterRows = nonTrailingRows.slice(idx + 1)
                                const keepVisible =
                                    laterRows.some((later) => later.kind === 'image' || later.kind === 'file')
                                    || (
                                        trailing.length === 0
                                        && laterRows.length > 0
                                        && laterRows.every((later) => later.kind === 'tool' && later.block.tool.name === 'ContextCompaction')
                                    )
                                return (
                                    <div
                                        key={row.key}
                                        className={cn(!keepVisible && 'hidden', 'py-1.5 text-[15px] leading-relaxed text-[var(--app-fg)]')}
                                        data-hapi-turn-quiet={!keepVisible ? 'true' : undefined}
                                    >
                                        {props.renderTrailingText ? props.renderTrailingText(row.text, false) : renderSimpleMarkdownText(row.text)}
                                    </div>
                                )
                            })}
                        </>
                    ) : null}

                </div>
            ) : (
                stepRows.some((row) => row.kind === 'text') ? (
                    <div className="space-y-2">
                        {stepRows.map((row) => {
                            if (row.kind === 'text') {
                                return (
                                    <div key={row.key} className="text-[15px] leading-relaxed text-[var(--app-fg)]">
                                        {props.renderTrailingText ? props.renderTrailingText(row.text, false) : renderSimpleMarkdownText(row.text)}
                                    </div>
                                )
                            }
                            return null
                        })}
                    </div>
                ) : null
            )}

            {/* Media & file deliverables: rendered outside and below the timeline rail */}
            {mediaRows.length > 0 ? (
                <div
                    className={cn(hasSteps ? 'mt-2.5' : '', 'space-y-2.5')}
                    data-testid="turn-media-deliverables"
                >
                    {mediaRows.map((row) => {
                        if (row.kind === 'image') {
                            return <GeneratedImageCard key={row.key} block={row.block} />
                        }
                        if (row.kind === 'file') {
                            return <GeneratedFileCard key={row.key} block={row.block} />
                        }
                        return null
                    })}
                </div>
            ) : null}

            {/* Trailing final assistant response */}
            {trailing.map((row) => (
                <div
                    key={row.key}
                    className="mt-3 text-[15px] leading-relaxed text-[var(--app-fg)]"
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

            <div
                className="turn-collapsible-shell"
                data-open={expanded ? 'true' : 'false'}
                aria-hidden={!expanded}
            >
                <div className="turn-collapsible-body">
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
                </div>
            </div>
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
                            data-testid={`question-option-${idx + 1}`}
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
