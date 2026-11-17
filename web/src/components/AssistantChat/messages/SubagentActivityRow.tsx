import { memo, useContext, useId, useState } from 'react'
import { StepInlinePreviewCard, SmallChevron, TurnStepExpansionContext } from './TimelineStepRows'
import type { SubagentActivity, SubagentActivityStatus } from './subagentActivity'

const statusLabels: Record<SubagentActivityStatus, { en: string; 'zh-CN': string }> = {
    pending: { en: 'Pending', 'zh-CN': '等待中' },
    running: { en: 'Running', 'zh-CN': '运行中' },
    completed: { en: 'Completed', 'zh-CN': '已完成' },
    failed: { en: 'Failed', 'zh-CN': '失败' },
    canceled: { en: 'Canceled', 'zh-CN': '已取消' },
    unknown: { en: 'Status unavailable', 'zh-CN': '状态未知' },
}

export const SubagentActivityRow = memo(function SubagentActivityRow(props: {
    activity: SubagentActivity
    lang: 'en' | 'zh-CN'
    accentColor?: string
}) {
    const { activity, lang } = props
    const store = useContext(TurnStepExpansionContext)
    const [open, setOpen] = useState(() => store?.subturns.get(activity.key) ?? false)
    const detailsId = useId()
    const durationMs = activity.startedAt !== null && activity.completedAt !== null
        ? activity.completedAt - activity.startedAt : null
    const failed = activity.status === 'failed'
    const statusColor = failed ? 'var(--app-badge-error-text)' : 'var(--app-hint)'

    return (
        <section
            data-block-id={activity.anchorKey}
            className="my-1 min-w-0 rounded-lg border border-[var(--app-border)] bg-[var(--app-subtle-bg)]/40"
            aria-label={activity.name}
        >
            <button
                type="button"
                aria-expanded={open}
                aria-controls={detailsId}
                onClick={() => {
                    const next = !open
                    store?.subturns.set(activity.key, next)
                    setOpen(next)
                }}
                className="flex w-full min-w-0 items-start gap-2 rounded-lg px-3 py-2 text-left hover:bg-[var(--app-subtle-bg)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--app-fg)]"
            >
                <span className="min-w-0 flex-1">
                    <span className="block break-words text-[13.5px] font-medium leading-5 text-[var(--app-fg)]">
                        {activity.name}
                    </span>
                    {activity.taskId !== activity.name ? (
                        <span className="block break-all font-mono text-xs leading-5 text-[var(--app-hint)]">
                            {activity.taskId}
                        </span>
                    ) : null}
                </span>
                <span className="shrink-0 text-right text-xs leading-5" style={{ color: statusColor }}>
                    <span className="block">{statusLabels[activity.status][lang]}</span>
                    {durationMs !== null && durationMs >= 0 ? (
                        <span className="block tabular-nums">{(durationMs / 1000).toFixed(1)}s</span>
                    ) : activity.startedAt !== null ? (
                        <time className="block tabular-nums" dateTime={new Date(activity.startedAt).toISOString()}>
                            {new Date(activity.startedAt).toLocaleTimeString(lang)}
                        </time>
                    ) : null}
                </span>
                <SmallChevron open={open} className="mt-1 shrink-0 text-[var(--app-hint)]" />
            </button>
            {activity.resultExcerpt ? (
                <p className="mx-3 mb-2 line-clamp-3 whitespace-pre-wrap break-words text-[13px] leading-5 text-[var(--app-fg)]">
                    {activity.resultExcerpt}
                </p>
            ) : null}
            <div id={detailsId} hidden={!open}>
                {open ? (
                    <div className="space-y-2 border-t border-[var(--app-border)] px-2 pb-2">
                        {activity.tools.map((row) => (
                            <div key={row.key}>
                                <div className="px-1 pt-2 text-xs font-medium text-[var(--app-hint)]">{row.block.tool.name}</div>
                                <StepInlinePreviewCard preview={{ kind: 'default', block: row.block }} />
                            </div>
                        ))}
                    </div>
                ) : null}
            </div>
        </section>
    )
})
