import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { formatDuration } from '@/chat/presentation'
import {
    type ProjectedSubturn,
    type TurnPartition,
    type TurnReasoningRow,
    type TurnTextRow,
    type TurnToolRow,
} from '@/components/AssistantChat/messages/turnBlockModel'
import {
    RailSlidingActiveSpinner,
    resolveTurnStepBlockId,
    SmallChevron,
    TimelineCoalescedStepRow,
    TimelineThoughtRow,
    TimelineToolStepRow,
} from '@/components/AssistantChat/messages/TimelineStepRows'
import { useOptionalSessionVisibleEntity } from '@/hooks/useSessionEntityStore'
import { cn } from '@/lib/utils'
import { MarkdownRenderer } from '@/components/MarkdownRenderer'
import { TurnRailSummary } from './TurnRailSummary'
import { useLiveTurnStepRows } from './useLiveTurnRows'
const railCaptureRendererRegistry = new WeakMap<HTMLElement, () => ReactNode>()

export function renderCollapsedRailForShareCapture(railElement: HTMLElement): ReactNode {
    return railCaptureRendererRegistry.get(railElement)?.() ?? null
}


function RailEntityTextBody(props: {
    row: TurnTextRow
    streaming: boolean
    renderTrailingText?: (text: string, streaming: boolean) => React.ReactNode
}) {
    const entity = useOptionalSessionVisibleEntity(props.row.blockId ?? null)
    const liveText = entity?.kind === 'agent-text' ? entity.text : props.row.text
    if (props.renderTrailingText) {
        return <>{props.renderTrailingText(liveText, props.streaming)}</>
    }
    return <MarkdownRenderer content={liveText} />
}

function TurnDurationBadge(props: {
    durationMs: number | null
    streaming: boolean
    streamingStartedAt?: number | null
}) {
    const liveTick = props.streaming && typeof props.streamingStartedAt === 'number' && Number.isFinite(props.streamingStartedAt)
    const [now, setNow] = useState(() => Date.now())
    useEffect(() => {
        if (!liveTick) return
        setNow(Date.now())
        const timer = window.setInterval(() => setNow(Date.now()), 1000)
        return () => window.clearInterval(timer)
    }, [liveTick, props.streamingStartedAt])
    const effectiveDurationMs = liveTick
        ? Math.max(0, now - props.streamingStartedAt!)
        : props.durationMs
    if (effectiveDurationMs == null || effectiveDurationMs <= 0) return null
    return (
        <span className="ml-1 shrink-0 text-[11.5px] tabular-nums text-[var(--app-hint)]/75">
            {formatDuration(effectiveDurationMs)}
        </span>
    )
}

export function TurnExecutionRail(props: {
    subturn: ProjectedSubturn
    partition: TurnPartition
    streaming: boolean
    durationMs: number | null
    streamingStartedAt?: number | null
    open: boolean
    onOpenChange: (open: boolean) => void
    activeTodoText?: string | null
    viewMode: 'normal' | 'thinking' | 'verbose'
    lang: 'en' | 'zh-CN'
    accentColor: string
    renderTrailingText?: (text: string, streaming: boolean) => React.ReactNode
    shareCapture?: boolean
}) {
    const {
        subturn,
        partition,
        streaming,
        durationMs,
        streamingStartedAt,
        open,
        onOpenChange,
        activeTodoText,
        viewMode,
        lang,
        accentColor,
        renderTrailingText,
        shareCapture = false,
    } = props

    const failed = useMemo(
        () => subturn.nonTrailingRows.some(
            (row) => row.kind === 'tool' && row.error && row.pinned
        ),
        [subturn.nonTrailingRows]
    )

    const summaryRows = subturn.nonTrailingRows
    const { stepRows: rawStepRows, hasSteps, collapsedPinnedRailRows, quietTextRows, lastRow } = subturn
    const stepRows = useLiveTurnStepRows(rawStepRows)

    const hasRunningOrPendingTool = useMemo(
        () => stepRows.some(
            (row) => row.kind === 'tool' && (row.block.tool.state === 'running' || row.block.tool.state === 'pending' || row.permission)
        ),
        [stepRows]
    )
    const endsWithTrailingText = Boolean(lastRow && lastRow.kind === 'text' && lastRow.trailing)
    const hasTrailingReasoningStep =
        streaming
        && !endsWithTrailingText
        && stepRows.length > 0
        && stepRows[stepRows.length - 1]?.kind === 'reasoning'
    const showFrontierSlot =
        streaming
        && hasSteps
        && !endsWithTrailingText
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
    const effectiveOpen = open || shareCapture
    const rootRailRef = useRef<HTMLDivElement | null>(null)
    const railRef = useRef<HTMLDivElement | null>(null)
    const rowElsRef = useRef<Array<HTMLDivElement | null>>([])
    const seenToolStatesRef = useRef<Map<string, boolean> | null>(null)
    const fastMorphRowKeysRef = useRef<Set<string>>(new Set())
    const prevLiveCountRef = useRef<number>(activeRunningRowIndices.length)
    const railCompletedPulseRef = useRef<boolean>(false)
    const latestActiveRowIndexRef = useRef<number>(activeRunningRowIndex)
    latestActiveRowIndexRef.current = activeRunningRowIndex
    const [spinnerOffsetY, setSpinnerOffsetY] = useState<number>(14)
    const [targetOffsetY, setTargetOffsetY] = useState<number>(14)

    const liveCount = activeRunningRowIndices.length
    if (liveCount > 0) {
        railCompletedPulseRef.current = false
    } else if (prevLiveCountRef.current > 0) {
        railCompletedPulseRef.current = true
    }
    prevLiveCountRef.current = liveCount

    const currentTools = new Map<string, { isRunning: boolean; isCompleted: boolean; rowKey: string }>()
    for (let i = 0; i < stepRows.length; i += 1) {
        const row = stepRows[i]!
        if (row.kind === 'coalesced') {
            for (const memberKey of row.memberKeys) {
                currentTools.set(memberKey, {
                    isRunning: false,
                    isCompleted: true,
                    rowKey: row.key,
                })
            }
            continue
        }
        if (row.kind !== 'tool') continue
        const isRunning = row.block.tool.state === 'running' || (row.block.tool.state === 'pending' && Boolean(row.permission))
        const isQueued = row.block.tool.state === 'pending' && !row.permission
        currentTools.set(row.key, {
            isRunning,
            isCompleted: !isRunning && !isQueued,
            rowKey: row.key,
        })
    }

    if (seenToolStatesRef.current === null) {
        const initialMap = new Map<string, boolean>()
        for (const [key, info] of currentTools.entries()) {
            initialMap.set(key, info.isRunning)
        }
        seenToolStatesRef.current = initialMap
    } else {
        for (const [key, info] of currentTools.entries()) {
            if (info.isRunning) {
                fastMorphRowKeysRef.current.delete(info.rowKey)
            } else if (streaming && !seenToolStatesRef.current.has(key) && info.isCompleted) {
                fastMorphRowKeysRef.current.add(info.rowKey)
            }
        }
        const nextMap = new Map<string, boolean>()
        for (const [key, info] of currentTools.entries()) {
            nextMap.set(key, info.isRunning)
        }
        seenToolStatesRef.current = nextMap
    }
    const measureRowY = (rowIndex: number) => {
        const el = rowElsRef.current[rowIndex]
        const measuredTop = el ? el.offsetTop : 0
        return measuredTop > 0 || rowIndex === 0
            ? measuredTop + 14
            : rowIndex * 30 + 14
    }

    useLayoutEffect(() => {
        if (activeRunningRowIndex < 0) {
            return
        }
        const nextTargetY = measureRowY(activeRunningRowIndex)
        setTargetOffsetY(nextTargetY)
        setSpinnerOffsetY(nextTargetY)
    }, [stepRows, activeRunningRowIndex])

    useLayoutEffect(() => {
        const currentIdx = latestActiveRowIndexRef.current
        if (currentIdx >= 0) {
            const updatedY = measureRowY(currentIdx)
            setTargetOffsetY(updatedY)
            setSpinnerOffsetY(updatedY)
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
            setSpinnerOffsetY(updatedY)
        })
        observer.observe(railEl)
        return () => observer.disconnect()
    }, [open, stepRows.length, showFrontierSlot])

    const keepVisibleKeys = useMemo(() => {
        const set = new Set<string>()
        for (const item of quietTextRows) {
            if (item.keepVisibleWhenCollapsed) {
                set.add(item.row.key)
            }
        }
        return set
    }, [quietTextRows])

    const railRootBlockId = useMemo(() => {
        for (const row of subturn.rows) {
            const id = resolveTurnStepBlockId(row)
            if (id) return id
        }
        return undefined
    }, [subturn.rows])

    const collapsedRows = useMemo(() => {
        const pinnedSet = new Set(collapsedPinnedRailRows)
        return stepRows.filter((row): row is TurnToolRow | (typeof collapsedPinnedRailRows)[number] => {
            if (row.kind === 'coalesced') {
                return pinnedSet.has(row)
            }
            if (row.kind === 'tool') {
                return pinnedSet.has(row)
                    || row.permission
                    || row.block.tool.state === 'running'
                    || row.block.tool.state === 'pending'
            }
            return false
        })
    }, [stepRows, collapsedPinnedRailRows])

    const collapsedQuietRows = useMemo(
        () => (shareCapture ? quietTextRows.filter((item) => !item.keepVisibleWhenCollapsed) : []),
        [shareCapture, quietTextRows]
    )

    useLayoutEffect(() => {
        const rootEl = rootRailRef.current
        if (!rootEl || shareCapture || !hasSteps) {
            return undefined
        }
        railCaptureRendererRegistry.set(rootEl, () => <TurnExecutionRail {...props} shareCapture={true} />)
        return () => {
            railCaptureRendererRegistry.delete(rootEl)
        }
    })

    if (!hasSteps) return null

    return (
        <div ref={rootRailRef} data-testid="turn-execution-rail" data-block-id={railRootBlockId} className="w-full">
            {/* Level 0: Lightweight borderless summary header */}
            <button
                type="button"
                aria-expanded={open}
                onClick={() => onOpenChange(!open)}
                data-testid="turn-level0-header"
                data-hapi-share-exclude="true"
                className="group inline-flex max-w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left text-[13.5px] leading-5 text-[var(--app-hint)] transition-colors hover:text-[var(--app-fg)]"
            >
                {failed ? (
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--app-badge-error-text)]" />
                ) : null}
                <TurnRailSummary rows={summaryRows} partition={partition} streaming={streaming} activeTodoText={activeTodoText} lang={lang} />
                <SmallChevron open={open} className="opacity-75 group-hover:opacity-100" />
                <TurnDurationBadge
                    durationMs={durationMs}
                    streaming={streaming}
                    streamingStartedAt={streamingStartedAt}
                />
            </button>

            {/* Level 1: Left-indented vertical timeline rail */}
            <div
                className="turn-collapsible-shell"
                data-open={effectiveOpen ? 'true' : 'false'}
                aria-hidden={!effectiveOpen}
                data-testid="turn-level1-shell"
            >
                <div className="turn-collapsible-body">
                    <div
                        ref={railRef}
                        className={cn(
                            'relative ml-2.5 mt-1 border-l border-[var(--app-border)] pl-3.5 space-y-0.5',
                            railCompletedPulseRef.current && 'turn-rail-completion-pulse'
                        )}
                        data-rail-transition={railCompletedPulseRef.current ? 'just-completed' : 'idle'}
                        data-testid="turn-level1-rail"
                        data-block-id={railRootBlockId}
                    >
                        {effectiveOpen ? (
                            <>
                                {activeRunningRowIndex >= 0 ? (
                                    <RailSlidingActiveSpinner
                                        activeRowIndex={activeRunningRowIndex}
                                        offsetY={spinnerOffsetY}
                                        targetOffsetY={targetOffsetY}
                                        color={accentColor}
                                    />
                                ) : null}
                                {stepRows.map((row, idx) => {
                                    const isLastStep = idx === stepRows.length - 1
                                    const stepBlockId = resolveTurnStepBlockId(row)
                                    if (row.kind === 'reasoning') {
                                        return (
                                            <div
                                                key={row.key}
                                                ref={(el) => {
                                                    rowElsRef.current[idx] = el
                                                }}
                                                data-rail-row-index={idx}
                                                data-block-id={stepBlockId}
                                            >
                                                <TimelineThoughtRow
                                                    row={row}
                                                    isActiveStreaming={streaming && isLastStep && activeRunningRowIndex === idx}
                                                    suppressRunningShimmer={false}
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
                                                data-block-id={stepBlockId}
                                            >
                                                <TimelineCoalescedStepRow
                                                    row={row}
                                                    lang={lang}
                                                    accentColor={accentColor}
                                                    forceMorph={fastMorphRowKeysRef.current.has(row.key)}
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
                                                data-block-id={stepBlockId}
                                            >
                                                <TimelineToolStepRow
                                                    row={row}
                                                    rowIndex={idx}
                                                    defaultExpanded={viewMode === 'verbose'}
                                                    lang={lang}
                                                    accentColor={accentColor}
                                                    forceMorph={fastMorphRowKeysRef.current.has(row.key)}
                                                    showInlineRailSpinner={idx !== activeRunningRowIndex}
                                                    suppressRunningShimmer={false}
                                                />
                                            </div>
                                        )
                                    }
                                    if (row.kind === 'text' && !keepVisibleKeys.has(row.key) && !shareCapture) {
                                        return (
                                            <div
                                                key={row.key}
                                                ref={(el) => {
                                                    rowElsRef.current[idx] = el
                                                }}
                                                data-rail-row-index={idx}
                                                data-block-id={stepBlockId}
                                                className="px-1.5 py-1 text-[13.5px] leading-relaxed text-[var(--app-fg)]"
                                            >
                                                <RailEntityTextBody
                                                    row={row}
                                                    streaming={false}
                                                    renderTrailingText={renderTrailingText}
                                                />
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
                                        data-block-id={railRootBlockId ? `${railRootBlockId}:frontier` : undefined}
                                        data-testid="rail-frontier-row"
                                    >
                                        <div data-hapi-share-exclude="true" className="relative py-0.5">
                                            <div className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[13.5px] leading-5 text-[var(--app-hint)]">
                                                <span
                                                    className="turn-text-shimmer font-medium transition-opacity duration-200"
                                                >
                                                    {lang === 'zh-CN' ? '正在思考...' : 'Thinking...'}
                                                </span>
                                            </div>
                                        </div>
                                    </div>
                                ) : null}
                            </>
                        ) : null}
                    </div>
                </div>
            </div>

            {!effectiveOpen ? (
                <>
                    {viewMode === 'thinking' || hasTrailingReasoningStep ? (
                        <div
                            className="ml-2 mt-1 border-l border-[var(--app-border)] pl-3.5 space-y-1"
                            data-block-id={railRootBlockId ? `${railRootBlockId}:thinking` : undefined}
                        >
                            {stepRows
                                .filter(
                                    (row): row is TurnReasoningRow =>
                                        row.kind === 'reasoning'
                                        && (viewMode === 'thinking' || row === stepRows[stepRows.length - 1])
                                )
                                .map((row) => {
                                    const isActiveTrailing = hasTrailingReasoningStep && row === stepRows[stepRows.length - 1]
                                    return (
                                        <TimelineThoughtRow
                                            key={row.key}
                                            row={row}
                                            isActiveStreaming={isActiveTrailing}
                                            defaultExpanded={viewMode === 'thinking'}
                                            lang={lang}
                                            accentColor={accentColor}
                                        />
                                    )
                                })}
                        </div>
                    ) : null}
                    {collapsedRows.length > 0 ? (
                        <div
                            className="relative ml-2.5 mt-1 border-l border-[var(--app-border)] pl-3.5 space-y-1"
                            data-testid="turn-collapsed-pinned-rail"
                            data-block-id={resolveTurnStepBlockId(collapsedRows[0]!)}
                        >
                            {collapsedRows.map((row, idx) =>
                                row.kind === 'coalesced' ? (
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
                            )}
                        </div>
                    ) : null}
                    {showFrontierSlot ? (
                        <div
                            data-testid="rail-frontier-row"
                            data-block-id={railRootBlockId ? `${railRootBlockId}:frontier` : undefined}
                            className="relative ml-2.5 mt-1 border-l border-[var(--app-border)] pl-3.5 py-0.5"
                            data-hapi-share-exclude="true"
                        >
                            <RailSlidingActiveSpinner
                                activeRowIndex={stepRows.length}
                                offsetY={14}
                                targetOffsetY={14}
                                color={accentColor}
                            />
                            <div className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[13.5px] leading-5 text-[var(--app-hint)]">
                                <span className="turn-text-shimmer font-medium transition-opacity duration-200">
                                    {lang === 'zh-CN' ? '正在思考...' : 'Thinking...'}
                                </span>
                            </div>
                        </div>
                    ) : null}
                </>
            ) : null}
            {collapsedQuietRows.map(({ row }) => (
                <div
                    key={row.key}
                    data-block-id={resolveTurnStepBlockId(row)}
                    className="hidden py-1.5 text-[15px] leading-relaxed text-[var(--app-fg)]"
                    data-hapi-turn-quiet="true"
                >
                    <RailEntityTextBody
                        row={row}
                        streaming={false}
                        renderTrailingText={renderTrailingText}
                    />
                </div>
            ))}
        </div>
    )
}
