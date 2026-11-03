import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { I18nProvider } from '@/lib/i18n-context'
import { HappyChatProvider, type HappyChatContextValue } from '@/components/AssistantChat/context'
import { partitionTurn } from '@/components/AssistantChat/messages/turnBlockModel'
import { TurnBlockView } from '@/components/AssistantChat/messages/TurnBlock'
import type { ToolCallBlock } from '@/chat/types'

function tool(id: string, name: string): ToolCallBlock {
    return {
        kind: 'tool-call',
        id,
        localId: null,
        createdAt: 1,
        children: [],
        tool: {
            id,
            name,
            state: 'completed',
            input: { file_path: 'home.tsx' },
            createdAt: 1,
            startedAt: 1,
            completedAt: 2,
            execStartedAt: null,
            execCompletedAt: null,
            description: null,
        },
    }
}

function renderBlock(node: ReactNode) {
    const value = {
        api: {},
        sessionId: 'session',
        metadata: null,
        disabled: false,
        onRefresh: vi.fn(),
    } as unknown as HappyChatContextValue
    return render(
        <I18nProvider>
            <HappyChatProvider value={value}>{node}</HappyChatProvider>
        </I18nProvider>
    )
}

describe('TurnBlockView markdown', () => {
    it('renders real markdown for the answer and for text inside the block', () => {
        const answer = partitionTurn([
            {
                type: 'tool-call',
                toolName: 'Read',
                artifact: tool('read', 'Read'),
            },
            { type: 'text', text: '这是 **加粗** 的回答' },
        ], null)
        renderBlock(<TurnBlockView partition={answer} streaming={false} durationMs={null} initiallyOpen={false} />)
        expect(screen.getByText('加粗').closest('strong')).not.toBeNull()
        expect(screen.queryByText('**加粗**')).toBeNull()

        const note = partitionTurn([
            { type: 'text', text: '中间的 *斜体* 说明' },
            {
                type: 'tool-call',
                toolName: 'Read',
                artifact: tool('read-2', 'Read'),
            },
        ], null)
        renderBlock(<TurnBlockView partition={note} streaming={false} durationMs={null} initiallyOpen />)
        expect(screen.getByText('斜体').closest('em')).not.toBeNull()
    })
})
