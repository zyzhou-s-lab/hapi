import type { ThreadAssistantMessagePart } from '@assistant-ui/react'
import { stripNotifySummaryFooter } from '@hapi/protocol/messages'
import type { TurnEntityContentPart } from '@/lib/assistant-runtime-blocks'

export function getAssistantCopyText(
    parts: readonly (ThreadAssistantMessagePart | TurnEntityContentPart)[],
    options?: { stripNotifySummary?: boolean }
): string {
    const strip = options?.stripNotifySummary === true
    return parts
        .filter((part): part is Extract<ThreadAssistantMessagePart | TurnEntityContentPart, { type: 'text' }> => part.type === 'text')
        .map((part) => {
            const trimmed = part.text.trim()
            return strip ? stripNotifySummaryFooter(trimmed) : trimmed
        })
        .filter((text) => text.length > 0)
        .join('\n\n')
}
