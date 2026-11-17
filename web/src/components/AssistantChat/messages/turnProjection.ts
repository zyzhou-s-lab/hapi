import type { TodoItem } from '@/types/api'
import { projectSessionTodoSnapshot, projectToolTodoSnapshot, resolveTodoToolKind } from '@/chat/projections/todoProjection'
import type { TodoCardItem } from '@/components/ToolCard/checklist'
import { classifyToolPresentation } from '@/components/AssistantChat/messages/toolPresentationManifest'
import {
    areTurnRowsEqual,
    coalesceTurnStepRows,
    isSameRefArray,
    projectActivitySteps,
    type TurnCoalescedRow,
    type TurnDisplayStepRow,
    type TurnFileRow,
    type TurnImageRow,
    type TurnPartition,
    type TurnRow,
    type TurnTextRow,
    type TurnToolRow,
} from './turnBlockModel'

export interface ProjectedTodoChecklist {
    readonly key: string
    readonly items: TodoCardItem[]
}

export interface ProjectedQuietTextRow {
    readonly row: TurnTextRow
    readonly keepVisibleWhenCollapsed: boolean
}

export interface ProjectedSubturn {
    readonly key: string
    readonly rows: TurnRow[]
    readonly nonTrailingRows: TurnRow[]
    readonly stepRows: TurnDisplayStepRow[]
    readonly collapsedPinnedRailRows: Array<TurnToolRow | TurnCoalescedRow>
    readonly todoChecklists: ProjectedTodoChecklist[]
    readonly quietTextRows: ProjectedQuietTextRow[]
    readonly mediaRows: Array<TurnImageRow | TurnFileRow>
    readonly answerRows: TurnTextRow[]
    readonly hasSteps: boolean
    readonly lastRow: TurnRow | undefined
}

export interface ProjectedTurn {
    readonly subturns: ProjectedSubturn[]
}

function areTodoCardItemsEqual(a: readonly TodoCardItem[], b: readonly TodoCardItem[]): boolean {
    if (a === b) return true
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i += 1) {
        const left = a[i]!
        const right = b[i]!
        if (
            left.id !== right.id
            || left.text !== right.text
            || left.activeForm !== right.activeForm
            || left.status !== right.status
        ) {
            return false
        }
    }
    return true
}

function areDisplayStepRowsEqual(a: TurnDisplayStepRow, b: TurnDisplayStepRow): boolean {
    if (a === b) return true
    if (a.kind !== b.kind || a.key !== b.key) return false
    if (a.kind === 'coalesced' && b.kind === 'coalesced') {
        return a.category === b.category
            && a.pinned === b.pinned
            && isSameRefArray(a.rows, b.rows)
            && isSameRefArray(a.toolRows, b.toolRows)
    }
    if (a.kind === 'activity' && b.kind === 'activity') return isSameRefArray(a.toolRows, b.toolRows)
    if (a.kind === 'subagent' && b.kind === 'subagent') {
        return a.activity.status === b.activity.status
            && a.activity.name === b.activity.name
            && a.activity.startedAt === b.activity.startedAt
            && a.activity.completedAt === b.activity.completedAt
            && a.activity.resultExcerpt === b.activity.resultExcerpt
            && isSameRefArray(a.activity.tools, b.activity.tools)
    }
    return areTurnRowsEqual(a as TurnRow, b as TurnRow)
}

export function projectSubturnTodoChecklists(
    rows: readonly TurnRow[],
    options?: {
        readonly streaming?: boolean
        readonly fallbackTodos?: readonly TodoItem[] | null
    },
    previousChecklists?: readonly ProjectedTodoChecklist[] | null
): {
    readonly todoChecklists: ProjectedTodoChecklist[]
    readonly pinnedChecklistKeys: ReadonlySet<string>
} {
    const streaming = options?.streaming ?? false
    const rawFallbackChecklistItems: TodoCardItem[] =
        options?.fallbackTodos && options.fallbackTodos.length > 0
            ? [...projectSessionTodoSnapshot(options.fallbackTodos).items]
            : []
    const fallbackChecklistItems: TodoCardItem[] =
        rawFallbackChecklistItems.length > 0 && !rawFallbackChecklistItems.every((item) => item.status === 'blocked')
            ? rawFallbackChecklistItems
            : []
    const toolRowsInTurn = rows.filter((row): row is TurnToolRow => row.kind === 'tool')
    const allToolBlocks = toolRowsInTurn.map((row) => row.block)

    const pinnedChecklistByKey = new Map<string, TodoCardItem[]>()
    for (const row of toolRowsInTurn) {
        if (!row.pinned || row.error) continue
        const checklist = [...projectToolTodoSnapshot(row.block, allToolBlocks, fallbackChecklistItems).items]
        const rule = classifyToolPresentation(row.block, {
            hasValidTodoChecklist: checklist.length > 0,
            errorRecovered: false,
        })
        if (rule.slot === 'turn-todo-section' && checklist.length > 0) {
            pinnedChecklistByKey.set(row.key, checklist)
        }
    }

    const rawChecklists: ProjectedTodoChecklist[] = []
    if (pinnedChecklistByKey.size > 0) {
        for (const [key, items] of pinnedChecklistByKey.entries()) {
            rawChecklists.push({ key, items })
        }
    } else if (
        fallbackChecklistItems.length > 0
        && (
            (streaming && fallbackChecklistItems.some((item) => item.status === 'in_progress' || item.status === 'pending'))
            || (previousChecklists?.some((checklist) => checklist.key === 'session-fallback-todos')
                && !fallbackChecklistItems.every((item) => item.status === 'blocked' || item.status === 'completed')
                || previousChecklists?.some((checklist) => checklist.key === 'session-fallback-todos')
                    && fallbackChecklistItems.every((item) => item.status === 'completed'))
        )
    ) {
        rawChecklists.push({ key: 'session-fallback-todos', items: fallbackChecklistItems })
    }

    const mappedChecklists = rawChecklists.map((checklist) => {
        const prevChecklist = previousChecklists?.find((c) => c.key === checklist.key)
        return prevChecklist && areTodoCardItemsEqual(prevChecklist.items, checklist.items)
            ? prevChecklist
            : checklist
    })
    const stableTodoChecklists = previousChecklists && isSameRefArray(mappedChecklists, previousChecklists)
        ? [...previousChecklists]
        : mappedChecklists
    return {
        todoChecklists: stableTodoChecklists,
        pinnedChecklistKeys: new Set(pinnedChecklistByKey.keys()),
    }
}

export function projectTurn(
    partition: TurnPartition,
    options?: {
        readonly viewMode?: 'normal' | 'thinking' | 'verbose'
        readonly streaming?: boolean
        readonly fallbackTodos?: readonly TodoItem[] | null
    },
    previousProjected?: ProjectedTurn | null
): ProjectedTurn {
    const viewMode = options?.viewMode ?? 'normal'
    const streaming = options?.streaming ?? false
    const rows = partition.rows
    const isInitialStreamingWait = streaming && rows.length === 0
    const answerRows = rows.filter((row): row is TurnTextRow => row.kind === 'text' && row.trailing)
    const nonTrailingRows = rows.filter((row) => !(row.kind === 'text' && row.trailing))
    const mediaRows = nonTrailingRows.filter(
        (row): row is TurnImageRow | TurnFileRow => row.kind === 'image' || row.kind === 'file'
    )
    const stepCandidates = nonTrailingRows.filter(
        (row): row is Exclude<TurnRow, TurnImageRow | TurnFileRow> => row.kind !== 'image' && row.kind !== 'file'
    )
    const stepRows: TurnDisplayStepRow[] = viewMode === 'normal'
        ? projectActivitySteps(nonTrailingRows)
        : viewMode === 'verbose' ? stepCandidates : coalesceTurnStepRows(stepCandidates, { absorbTransitionalThoughts: false })
    const hasSteps = stepRows.some((row) => row.kind !== 'text' || row.phase === 'execution') || isInitialStreamingWait

    const { todoChecklists, pinnedChecklistKeys } = projectSubturnTodoChecklists(
        stepCandidates,
        { streaming, fallbackTodos: options?.fallbackTodos },
        previousProjected?.subturns[0]?.todoChecklists
    )

    const collapsedPinnedRailRows = stepRows.flatMap((row): Array<TurnToolRow | TurnCoalescedRow> => {
        if (row.kind === 'activity') return row.toolRows.filter((member) => member.pinned)
        if (row.kind === 'subagent') return []
        return row.kind === 'tool' || row.kind === 'coalesced' ? [row] : []
    }).filter((row) => {
        if (row.kind === 'coalesced') {
            return row.rows.some(
                (r) => r.kind === 'tool' && r.pinned && !pinnedChecklistKeys.has(r.key)
            )
        }
        if (row.kind === 'tool') {
            if (!row.error && !row.permission && resolveTodoToolKind(row.block.tool.name) !== null) {
                return false
            }
            const rule = classifyToolPresentation(row.block, {
                hasValidTodoChecklist: pinnedChecklistKeys.has(row.key),
                errorRecovered: !row.pinned && row.error,
            })
            return rule.slot === 'rail' && row.pinned && !pinnedChecklistKeys.has(row.key)
        }
        return false
    })

    const quietTextRows: ProjectedQuietTextRow[] = []
    nonTrailingRows.forEach((row, idx) => {
        if (row.kind !== 'text') return
        const laterRows = nonTrailingRows.slice(idx + 1)
        const keepVisibleWhenCollapsed =
            laterRows.some((later) => later.kind === 'image' || later.kind === 'file')
            || (
                answerRows.length === 0
                && laterRows.length > 0
                && laterRows.every((later) => later.kind === 'tool' && later.block.tool.name === 'ContextCompaction')
            )
        quietTextRows.push({ row, keepVisibleWhenCollapsed })
    })

    const firstStableKey = rows[0]?.key ?? 'subturn:initial'
    const prevSubturn = previousProjected?.subturns[0] ?? null
    const stableRows = prevSubturn && isSameRefArray(rows, prevSubturn.rows) ? prevSubturn.rows : rows
    const stableNonTrailingRows = prevSubturn && isSameRefArray(nonTrailingRows, prevSubturn.nonTrailingRows)
        ? prevSubturn.nonTrailingRows
        : nonTrailingRows
    const prevStepByKey = new Map<string, TurnDisplayStepRow>()
    if (prevSubturn) {
        for (const prevStep of prevSubturn.stepRows) {
            prevStepByKey.set(prevStep.key, prevStep)
        }
    }
    const mappedStepRows = stepRows.map((step) => {
        const prevStep = prevStepByKey.get(step.key)
        return prevStep && areDisplayStepRowsEqual(prevStep, step) ? prevStep : step
    })
    const stableStepRows = prevSubturn && isSameRefArray(mappedStepRows, prevSubturn.stepRows)
        ? prevSubturn.stepRows
        : mappedStepRows
    const mappedCollapsedPinned = collapsedPinnedRailRows.map((row) => {
        const prevStep = prevStepByKey.get(row.key)
        return (prevStep && areDisplayStepRowsEqual(prevStep, row) ? prevStep : row) as TurnToolRow | TurnCoalescedRow
    })
    const stableCollapsedPinnedRailRows = prevSubturn && isSameRefArray(mappedCollapsedPinned, prevSubturn.collapsedPinnedRailRows)
        ? prevSubturn.collapsedPinnedRailRows
        : mappedCollapsedPinned
    const mappedChecklists = todoChecklists.map((checklist) => {
        const prevChecklist = prevSubturn?.todoChecklists.find((c) => c.key === checklist.key)
        return prevChecklist && areTodoCardItemsEqual(prevChecklist.items, checklist.items)
            ? prevChecklist
            : checklist
    })
    const stableTodoChecklists = prevSubturn && isSameRefArray(mappedChecklists, prevSubturn.todoChecklists)
        ? prevSubturn.todoChecklists
        : mappedChecklists
    const mappedQuietTextRows = quietTextRows.map((entry) => {
        const prevEntry = prevSubturn?.quietTextRows.find((q) => q.row.key === entry.row.key)
        return prevEntry && prevEntry.row === entry.row && prevEntry.keepVisibleWhenCollapsed === entry.keepVisibleWhenCollapsed
            ? prevEntry
            : entry
    })
    const stableQuietTextRows = prevSubturn && isSameRefArray(mappedQuietTextRows, prevSubturn.quietTextRows)
        ? prevSubturn.quietTextRows
        : mappedQuietTextRows
    const stableMediaRows = prevSubturn && isSameRefArray(mediaRows, prevSubturn.mediaRows)
        ? prevSubturn.mediaRows
        : mediaRows
    const stableAnswerRows = prevSubturn && isSameRefArray(answerRows, prevSubturn.answerRows)
        ? prevSubturn.answerRows
        : answerRows
    const subturnKey = `subturn:${firstStableKey}`
    const lastRow = stableRows[stableRows.length - 1]
    if (
        prevSubturn
        && prevSubturn.key === subturnKey
        && prevSubturn.rows === stableRows
        && prevSubturn.nonTrailingRows === stableNonTrailingRows
        && prevSubturn.stepRows === stableStepRows
        && prevSubturn.collapsedPinnedRailRows === stableCollapsedPinnedRailRows
        && prevSubturn.todoChecklists === stableTodoChecklists
        && prevSubturn.quietTextRows === stableQuietTextRows
        && prevSubturn.mediaRows === stableMediaRows
        && prevSubturn.answerRows === stableAnswerRows
        && prevSubturn.hasSteps === hasSteps
        && prevSubturn.lastRow === lastRow
        && previousProjected
    ) {
        return previousProjected
    }
    return {
        subturns: [
            {
                key: subturnKey,
                rows: stableRows,
                nonTrailingRows: stableNonTrailingRows,
                stepRows: stableStepRows,
                collapsedPinnedRailRows: stableCollapsedPinnedRailRows,
                todoChecklists: stableTodoChecklists,
                quietTextRows: stableQuietTextRows,
                mediaRows: stableMediaRows,
                answerRows: stableAnswerRows,
                hasSteps,
                lastRow,
            },
        ],
    }
}
