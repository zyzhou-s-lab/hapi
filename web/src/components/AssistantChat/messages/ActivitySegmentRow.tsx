import { memo, useCallback, useState } from 'react'
import { describeActivitySegment, type TurnActivityRow, type TurnToolRow } from './turnBlockModel'
import { SmallChevron, TimelineToolStepRow, useTurnStepExpansion } from './TimelineStepRows'

export const ActivitySegmentRow = memo(function ActivitySegmentRow(props: {
    row: TurnActivityRow
    lang: 'en' | 'zh-CN'
    accentColor?: string
    shareCapture?: boolean
    pinnedOnly?: boolean
}) {
    const { open, toggle } = useTurnStepExpansion(props.row.key, false)
    const [expandedKeys, setExpandedKeys] = useState<ReadonlySet<string>>(() => new Set())
    const [focusedKey, setFocusedKey] = useState<string | null>(null)
    const onExpandedChange = useCallback((key: string, expanded: boolean) => {
        setExpandedKeys((previous) => {
            if (previous.has(key) === expanded) return previous
            const next = new Set(previous)
            if (expanded) next.add(key)
            else next.delete(key)
            return next
        })
    }, [])
    // Exceptions remain visible without expanding unrelated successful siblings.
    // Keep the same list parents when live state changes; do not move the following tools.
    const summarized = props.row.toolRows.filter((row) => (
        row.block.tool.state === 'completed' && !row.pinned && !row.error && !row.permission
        && !expandedKeys.has(row.key) && focusedKey !== row.key
    ))
    const grouped = summarized.length >= 2
    const hiddenKeys = grouped && !open && !props.shareCapture
        ? new Set(summarized.map((row) => row.key))
        : new Set<string>()
    return (
        <div
            data-testid="activity-segment"
            data-block-id={props.row.key}
            className="min-w-0"
            onFocusCapture={(event) => {
                setFocusedKey((event.target as HTMLElement).closest<HTMLElement>('[data-activity-member]')?.dataset.activityMember ?? null)
            }}
            onBlurCapture={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocusedKey(null)
            }}
        >
            {grouped && !props.pinnedOnly ? (
                <button
                    type="button"
                    data-testid="activity-segment-summary"
                    data-hapi-share-exclude="true"
                    aria-expanded={open || Boolean(props.shareCapture)}
                    onClick={toggle}
                    className="group flex w-full items-center gap-1.5 rounded-md px-1.5 py-1.5 text-left text-[13.5px] leading-5 text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)]/60 hover:text-[var(--app-fg)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--app-link)]"
                >
                    <span className="min-w-0 flex-1 break-words">{describeActivitySegment(summarized, props.lang)}</span>
                    <SmallChevron open={open || Boolean(props.shareCapture)} />
                </button>
            ) : null}
            <div>
                {props.row.toolRows.map((row) => (
                    <div key={row.key} data-activity-member={row.key} hidden={props.pinnedOnly ? !row.pinned && !row.permission : hiddenKeys.has(row.key)}>
                        <ActivityToolRow row={row} lang={props.lang} accentColor={props.accentColor} onExpandedChange={onExpandedChange} />
                    </div>
                ))}
            </div>
        </div>
    )
})

const ActivityToolRow = memo(function ActivityToolRow(props: {
    row: TurnToolRow
    lang: 'en' | 'zh-CN'
    accentColor?: string
    onExpandedChange: (key: string, open: boolean) => void
}) {
    const onExpandedChange = useCallback((open: boolean) => props.onExpandedChange(props.row.key, open), [props.onExpandedChange, props.row.key])
    return <TimelineToolStepRow row={props.row} defaultExpanded={false} lang={props.lang} accentColor={props.accentColor} showInlineRailSpinner={true} onExpandedChange={onExpandedChange} />
})
