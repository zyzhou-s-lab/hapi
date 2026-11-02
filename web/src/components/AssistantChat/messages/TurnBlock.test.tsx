import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { I18nProvider } from '@/lib/i18n-context'
import { HappyChatProvider, type HappyChatContextValue } from '@/components/AssistantChat/context'
import { partitionTurn } from '@/components/AssistantChat/messages/turnBlockModel'
import { TurnBlockView } from '@/components/AssistantChat/messages/TurnBlock'
import type { ToolCallBlock } from '@/chat/types'

vi.mock('@/components/AssistantChat/messages/NotifySummaryText', () => ({
    NotifySummaryText: ({ text }: { text: string }) => <p>{text}</p>,
}))

vi.mock('@/components/ToolCard/ToolCard', () => ({
    ToolDetailDialogContent: () => <div>detail</div>,
}))

function tool(id: string, name: string, extra: Partial<ToolCallBlock['tool']> = {}): ToolCallBlock {
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
            input: {},
            createdAt: 1,
            startedAt: 1,
            completedAt: 2,
            execStartedAt: null,
            execCompletedAt: null,
            description: null,
            ...extra,
        },
    }
}

function renderBlock(node: ReactNode) {
    const value = {
        api: {
            approvePermission: vi.fn(async () => undefined),
            denyPermission: vi.fn(async () => undefined),
        },
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

describe('TurnBlockView', () => {
    it('folds quiet rows, keeps the error and permission rows, and leaves sandwiched text shareable', () => {
        const partition = partitionTurn([
            { type: 'reasoning', text: '先看页面' },
            {
                type: 'tool-call',
                toolName: 'Read',
                artifact: tool('read', 'Read', { input: { file_path: 'src/pages/home.tsx' } }),
            },
            { type: 'text', text: '夹在工具之间的说明' },
            {
                type: 'tool-call',
                toolName: 'Bash',
                artifact: tool('bash', 'Bash', {
                    state: 'error',
                    description: 'Locate a Chromium binary',
                    input: { command: 'which chrome' },
                }),
            },
            {
                type: 'tool-call',
                toolName: 'Edit',
                artifact: tool('edit', 'Edit', {
                    state: 'pending',
                    permission: { id: 'perm', status: 'pending' },
                    input: { file_path: 'home.tsx' },
                }),
            },
            { type: 'text', text: '这是回答。' },
        ], null)

        const { container } = renderBlock(
            <TurnBlockView partition={partition} streaming={false} durationMs={151_000} initiallyOpen={false} />
        )

        const header = screen.getByRole('button', { name: /先看页面/ })
        expect(header).toHaveAttribute('aria-expanded', 'false')
        expect(header.className).not.toContain('app-reasoning-bg')
        expect(header.parentElement).toHaveAttribute('data-hapi-turn-block-list', 'true')
        expect(header.parentElement?.className).toContain('border')
        expect(screen.getByText('2m 31s')).toBeInTheDocument()
        const reasoning = screen.getAllByText('先看页面').find((node) => node.getAttribute('data-hapi-share-exclude') === 'true')
        expect(reasoning?.closest('[data-hapi-turn-quiet]')).toHaveClass('hidden')
        const note = screen.getByText('夹在工具之间的说明')
        expect(note.closest('[data-hapi-turn-quiet]')).toHaveClass('hidden')
        expect(note.closest('[data-hapi-share-exclude]')).toBeNull()
        expect(screen.getByText('Locate a Chromium binary').closest('[data-hapi-turn-quiet]')).toBeNull()
        expect(container.querySelector('[data-hapi-share-exclude] .bg-\\[var\\(--app-badge-error-text\\)\\]')).not.toBeNull()
        expect(screen.getByRole('button', { name: 'Allow' })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Deny' })).toBeInTheDocument()
        expect(screen.getByText('这是回答。')).toBeInTheDocument()

        for (const row of container.querySelectorAll<HTMLElement>('[data-hapi-turn-quiet]')) {
            row.classList.remove('hidden')
        }
        expect(screen.getByText('夹在工具之间的说明').closest('[data-hapi-turn-quiet]')?.classList.contains('hidden')).toBe(false)
    })
})
