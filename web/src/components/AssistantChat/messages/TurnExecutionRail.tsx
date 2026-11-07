import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { formatDuration } from '@/chat/presentation'
import {
    summarizeTurnActivity,
    type ProjectedSubturn,
    type TurnPartition,
    type TurnReasoningRow,
    type TurnToolRow,
} from '@/components/AssistantChat/messages/turnBlockModel'
import {
    RailSlidingActiveSpinner,
    SmallChevron,
    TimelineCoalescedStepRow,
    TimelineThoughtRow,
    TimelineToolStepRow,
    renderSimpleMarkdownText,
} from '@/components/AssistantChat/messages/TimelineStepRows'
import { cn } from '@/lib/utils'

export function TurnExecutionRail(props: {
    subturn: ProjectedSubturn
    partition: TurnPartition
    streaming: boolean
    durationMs: number | null
    open: boolean
    onOpenChange: (open: boolean) => void
    activeTodoText?: string | null
    viewMode: 'normal' | 'thinking' | 'verbose'
    lang: 'en' | 'zh-CN'
    accentColor: string
    renderTrailingText?: (text: string, streaming: boolean) => React.ReactNode
}) {
    const {
        subturn,
        partition,
        streaming,
        durationMs,
        open,
        onOpenChange,
        activeTodoText,
        viewMode,
        lang,
        accentColor,
        renderTrailingText,
    } = props

    const failed = useMemo(
        () => subturn.nonTrailingRows.some(
            (row) => row.kind === 'tool' && row.error && row.pinned
        ),
        [subturn.nonTrailingRows]
    )

    const summary = useMemo(
        () => summarizeTurnActivity({
            rows: subturn.nonTrailingRows,
            title: partition.title,
            hasFoldable: partition.hasFoldable,
            hasPinned: partition.hasPinned,
            hasActivity: partition.hasActivity,
            streaming: partition.streaming,
        }, {
            activeTodoText,
            lang,
        }),
        [
            subturn.nonTrailingRows,
            partition.title,
            partition.hasFoldable,
            partition.hasPinned,
            partition.hasActivity,
            partition.streaming,
            activeTodoText,
            lang,
        ]
    )

    const { stepRows, nonTrailingRows, hasSteps, collapsedPinnedRailRows, quietTextRows, lastRow } = subturn
    const headerText = streaming ? summary.workingHeader : summary.completedHeader

    const hasRunningOrPendingTool = useMemo(
        () => nonTrailingRows.some(
            (row) => row.kind === 'tool' && (row.block.tool.state === 'running' || row.block.tool.state === 'pending' || row.permission)
        ),
        [nonTrailingRows]
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
            if (transitionedMorphRowIndex < 0 && streaming) {
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
    }, [stepRows, activeRunningRowIndex, streaming])

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

    const keepVisibleKeys = useMemo(() => {
        const set = new Set<string>()
        for (const item of quietTextRows) {
            if (item.keepVisibleWhenCollapsed) {
                set.add(item.row.key)
            }
        }
        return set
    }, [quietTextRows])

    if (!hasSteps) return null

    return (
        <div data-testid="turn-execution-rail" className="w-full">
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
                <span
                    className={cn(
                        'truncate',
                        streaming ? 'turn-text-shimmer font-medium' : 'font-normal'
                    )}
                >
                    {headerText}
                </span>
                <SmallChevron open={open} className="opacity-75 group-hover:opacity-100" />
                {durationMs != null && durationMs > 0 ? (
                    <span className="ml-1 shrink-0 text-[11.5px] tabular-nums text-[var(--app-hint)]/75">
                        {formatDuration(durationMs)}
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
                                            isActiveStreaming={streaming && isLastStep && activeRunningRowIndex === idx}
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
                            if (row.kind === 'text' && !keepVisibleKeys.has(row.key)) {
                                return (
                                    <div
                                        key={row.key}
                                        ref={(el) => {
                                            rowElsRef.current[idx] = el
                                        }}
                                        data-rail-row-index={idx}
                                        className="px-1.5 py-1 text-[13.5px] leading-relaxed text-[var(--app-fg)]"
                                    >
                                        {renderTrailingText ? renderTrailingText(row.text, false) : renderSimpleMarkdownText(row.text)}
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
                    {collapsedPinnedRailRows.length > 0 ? (
                        <div
                            className="relative ml-2.5 mt-1 border-l border-[var(--app-border)] pl-3.5 space-y-1"
                            data-testid="turn-collapsed-pinned-rail"
                        >
                            {collapsedPinnedRailRows.map((row, idx) =>
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
                    {quietTextRows
                        .filter((item) => !item.keepVisibleWhenCollapsed)
                        .map(({ row }) => (
                            <div
                                key={row.key}
                                className="hidden py-1.5 text-[15px] leading-relaxed text-[var(--app-fg)]"
                                data-hapi-turn-quiet="true"
                            >
                                {renderTrailingText ? renderTrailingText(row.text, false) : renderSimpleMarkdownText(row.text)}
                            </div>
                        ))}
                </>
            ) : null}
        </div>
    )
}
