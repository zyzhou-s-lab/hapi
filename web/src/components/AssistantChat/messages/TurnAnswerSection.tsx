import { memo } from 'react'
import type { TurnTextRow } from '@/components/AssistantChat/messages/turnBlockModel'
import type { ProjectedSubturn } from '@/components/AssistantChat/messages/turnProjection'
import { renderSimpleMarkdownText } from '@/components/AssistantChat/messages/TimelineStepRows'
import { GeneratedFileCard, GeneratedImageCard } from '@/components/AssistantChat/messages/ToolMessage'
import { useOptionalSessionVisibleEntity } from '@/hooks/useSessionEntityStore'
import { cn } from '@/lib/utils'

export const TurnEntityTextBody = memo(function TurnEntityTextBody(props: {
    row: TurnTextRow
    streaming: boolean
    renderTrailingText?: (text: string, streaming: boolean) => React.ReactNode
}) {
    const entity = useOptionalSessionVisibleEntity(props.row.blockId)
    const text = entity && 'text' in entity && typeof entity.text === 'string'
        ? entity.text.trim()
        : props.row.text
    return (
        <>
            {props.renderTrailingText
                ? props.renderTrailingText(text, props.streaming)
                : renderSimpleMarkdownText(text)}
        </>
    )
})
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
                            className="happy-chat-text py-1.5 text-[var(--app-fg)]"
                        >
                            <TurnEntityTextBody
                                row={row}
                                streaming={false}
                                renderTrailingText={renderTrailingText}
                            />
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
                        className="happy-chat-text mt-3 text-[var(--app-fg)]"
                        data-testid="turn-trailing-answer"
                    >
                        <TurnEntityTextBody
                            row={row}
                            streaming={isRowStreaming}
                            renderTrailingText={renderTrailingText}
                        />
                    </div>
                )
            })}
        </div>
    )
}
