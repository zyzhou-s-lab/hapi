import { describe, expect, it } from 'vitest'
import type { AgentEventBlock, AgentTextBlock } from '@/chat/types'
import type { VisibleChatBlock } from '@/chat/toolGroups'
import { filterVisibleBlocksForFlavor, isEventVisibleForFlavor } from './eventVisibility'

function agentEvent(id: string, event: AgentEventBlock['event']): AgentEventBlock {
    return { kind: 'agent-event', id, createdAt: 0, event }
}

function agentText(id: string): AgentTextBlock {
    return { kind: 'agent-text', id, localId: null, createdAt: 0, text: id }
}

describe('OMP event visibility', () => {
    it.each(['limit-warning', 'limit-reached'] as const)(
        'hides %s for OMP because native RPC does not report quota limits',
        (type) => {
            expect(isEventVisibleForFlavor({ type }, 'omp')).toBe(false)
        }
    )

    it('keeps native OMP retry events visible', () => {
        expect(isEventVisibleForFlavor({ type: 'omp-retry', phase: 'started' }, 'omp')).toBe(true)
    })

    it('keeps Claude limit events visible', () => {
        expect(isEventVisibleForFlavor({ type: 'limit-warning' }, 'claude')).toBe(true)
    })

    it('hides legacy OMP host_tool_call session events but keeps other OMP session events', () => {
        expect(isEventVisibleForFlavor({ type: 'omp-session-event', eventType: 'host_tool_call' }, 'omp')).toBe(false)
        expect(isEventVisibleForFlavor({ type: 'omp-session-event', eventType: 'ttsr_triggered' }, 'omp')).toBe(true)
    })

    it('filters only unsupported OMP quota blocks', () => {
        const blocks: VisibleChatBlock[] = [
            agentEvent('warning', { type: 'limit-warning', utilization: 0.9, endsAt: 1, limitType: 'five_hour' }),
            agentEvent('reached', { type: 'limit-reached', endsAt: 2, limitType: 'five_hour' }),
            agentEvent('retry', { type: 'omp-retry', phase: 'started' }),
            agentText('answer')
        ]

        expect(filterVisibleBlocksForFlavor(blocks, 'omp').map((block) => block.id)).toEqual([
            'retry',
            'answer'
        ])
        expect(filterVisibleBlocksForFlavor(blocks, 'claude')).toEqual(blocks)
    })

    it('folds omp-compaction started and finished events in place and drops skipped compactions', () => {
        const blocks: VisibleChatBlock[] = [
            agentEvent('compact-start', {
                type: 'omp-compaction',
                phase: 'started',
                strategy: 'context-full',
                reason: 'threshold'
            }),
            agentText('step-1'),
            agentEvent('compact-end', {
                type: 'omp-compaction',
                phase: 'finished',
                outcome: 'compacted',
                strategy: 'context-full',
                reason: 'threshold',
                tokensBefore: 148528
            })
        ]

        const folded = filterVisibleBlocksForFlavor(blocks, 'omp')
        expect(folded.map((block) => block.id)).toEqual(['compact-start', 'step-1'])
        expect(folded[0]).toMatchObject({
            id: 'compact-start',
            kind: 'agent-event',
            event: {
                type: 'omp-compaction',
                phase: 'finished',
                outcome: 'compacted',
                tokensBefore: 148528
            }
        })

        const skippedBlocks: VisibleChatBlock[] = [
            agentEvent('compact-start-2', {
                type: 'omp-compaction',
                phase: 'started',
                strategy: 'snapcompact',
                reason: 'threshold'
            }),
            agentEvent('compact-skip-2', {
                type: 'omp-compaction',
                phase: 'finished',
                outcome: 'skipped',
                strategy: 'snapcompact',
                reason: 'threshold'
            }),
            agentText('step-2')
        ]
        expect(filterVisibleBlocksForFlavor(skippedBlocks, 'omp').map((block) => block.id)).toEqual(['step-2'])

        const legacySkippedBlocks: VisibleChatBlock[] = [
            agentEvent('compact-start-3', {
                type: 'omp-compaction',
                phase: 'started',
                action: 'shake',
                reason: 'threshold'
            }),
            agentEvent('compact-skip-3', {
                type: 'omp-compaction',
                phase: 'finished',
                frame: {
                    type: 'auto_compaction_end',
                    action: 'shake',
                    aborted: false,
                    skipped: true,
                    errorMessage: 'Auto-shake found nothing eligible to drop; falling back to context-full compaction.'
                }
            }),
            agentText('step-3')
        ]
        expect(filterVisibleBlocksForFlavor(legacySkippedBlocks, 'omp').map((block) => block.id)).toEqual(['step-3'])
    })
})
