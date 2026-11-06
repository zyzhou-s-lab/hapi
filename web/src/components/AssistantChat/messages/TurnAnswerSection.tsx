import type { ProjectedSubturn } from '@/components/AssistantChat/messages/turnBlockModel'
import { renderSimpleMarkdownText } from '@/components/AssistantChat/messages/TimelineStepRows'
import { GeneratedFileCard, GeneratedImageCard } from '@/components/AssistantChat/messages/ToolMessage'
import { cn } from '@/lib/utils'

export function TurnAnswerSection(props: {
    subturn: ProjectedSubturn
    streaming: boolean
    suppressRunningShimmer?: boolean
    renderTrailingText?: (text: string, streaming: boolean) => React.ReactNode
}) {
    const { subturn, streaming, suppressRunningShimmer, renderTrailingText } = props
    const visibleNonTrailingTextRows = subturn.quietTextRows.filter(
        (item) => item.keepVisibleWhenCollapsed || !subturn.hasSteps
    )

    if (
        visibleNonTrailingTextRows.length === 0
        && subturn.mediaRows.length === 0
        && subturn.answerRows.length === 0
    ) {
        return null
    }

    return (
        <div data-testid="turn-answer-section" className="w-full">
            {visibleNonTrailingTextRows.length > 0 ? (
                <div className="space-y-2">
                    {visibleNonTrailingTextRows.map(({ row }) => (
                        <div
                            key={row.key}
                            className="py-1.5 text-[15px] leading-relaxed text-[var(--app-fg)]"
                        >
                            {renderTrailingText ? renderTrailingText(row.text, false) : renderSimpleMarkdownText(row.text)}
                        </div>
                    ))}
                </div>
            ) : null}

            {subturn.mediaRows.length > 0 ? (
                <div
                    className={cn(subturn.hasSteps ? 'mt-2.5' : '', 'space-y-2.5')}
                    data-testid="turn-media-deliverables"
                >
                    {subturn.mediaRows.map((row) => {
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

            {subturn.answerRows.map((row) => {
                const isRowStreaming = Boolean(
                    streaming && !suppressRunningShimmer && row === subturn.lastRow
                )
                return (
                    <div
                        key={row.key}
                        className="mt-3 text-[15px] leading-relaxed text-[var(--app-fg)]"
                        data-testid="turn-trailing-answer"
                    >
                        {renderTrailingText ? (
                            renderTrailingText(row.text, isRowStreaming)
                        ) : (
                            renderSimpleMarkdownText(row.text)
                        )}
                    </div>
                )
            })}
        </div>
    )
}
