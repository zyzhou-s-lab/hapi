import type { AgentEvent } from '@/chat/types'
import type { VisibleChatBlock } from '@/chat/toolGroups'

export function isEventVisibleForFlavor(
    event: AgentEvent,
    flavor: string | null | undefined
): boolean {
    if (flavor !== 'omp') return true
    if (event.type === 'limit-warning' || event.type === 'limit-reached') return false
    // Older CLIs duplicated each host tool as a session event; the tool row already shows it.
    return !(event.type === 'omp-session-event' && 'eventType' in event && event.eventType === 'host_tool_call')
}

export function filterVisibleBlocksForFlavor(
    blocks: readonly VisibleChatBlock[],
    flavor: string | null | undefined
): VisibleChatBlock[] {
    return blocks.filter((block) => (
        block.kind !== 'agent-event' || isEventVisibleForFlavor(block.event, flavor)
    ))
}
