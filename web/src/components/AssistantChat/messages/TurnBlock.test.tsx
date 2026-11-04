import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
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

vi.mock('@/components/ToolCard/PermissionFooter', () => ({
    PermissionFooter: () => <div>permission options</div>,
}))

vi.mock('@/components/AssistantChat/messages/ToolMessage', () => ({
    GeneratedImageCard: ({ block }: { block: { fileName: string } }) => <div>image {block.fileName}</div>,
    GeneratedFileCard: ({ block }: { block: { fileName: string } }) => <div>file {block.fileName}</div>,
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

        const header = screen.getByRole('button', { name: /home\.tsx 2m 31s/ })
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

    it('folds recovered mid-turn OMP tool errors and keeps the turn header dot neutral', () => {
        const partition = partitionTurn([
            { type: 'reasoning', text: 'Initial inspection revealed nothing immediately suspicious.' },
            {
                type: 'tool-call',
                toolName: 'read',
                artifact: tool('read-1', 'read', {
                    state: 'error',
                    input: {
                        path: 'session://01a1a178-20a6-7795-a647-aaa2418531e5/timeline:-40',
                        i: 'Reading timeline of PAGING session 01a1a178',
                    },
                }),
            },
            {
                type: 'tool-call',
                toolName: 'bash',
                artifact: tool('bash-1', 'bash', {
                    state: 'completed',
                    input: {
                        command: 'tern capture 95988224098306 --surfaces',
                        i: 'Capturing surface text of HAPI blocks in Tern',
                    },
                }),
            },
            { type: 'text', text: '全部整理完毕。' },
        ], null)

        renderBlock(
            <TurnBlockView partition={partition} streaming={false} durationMs={134_000} initiallyOpen={false} />
        )

        const header = screen.getByRole('button', { name: /Capturing surface text of HAPI blocks in Tern 2m 14s/ })
        const headerDot = header.querySelector('span.rounded-full')
        expect(headerDot?.className).toContain('bg-current')
        expect(headerDot?.className).not.toContain('bg-[var(--app-badge-error-text)]')
        expect(screen.getByText('Reading timeline of PAGING session 01a1a178').closest('[data-hapi-turn-quiet]')).toHaveClass('hidden')
        expect(screen.getByText('全部整理完毕。')).toBeInTheDocument()
    })

    it('keeps the last tool error visible and the turn header dot red when followed only by text', () => {
        const partition = partitionTurn([
            { type: 'reasoning', text: '尝试执行迁移' },
            {
                type: 'tool-call',
                toolName: 'Bash',
                artifact: tool('bash-fail', 'Bash', {
                    state: 'error',
                    description: 'Run database migration',
                    input: { command: 'bun run migrate' },
                }),
            },
            { type: 'text', text: '没能跑迁移。' },
        ], null)

        renderBlock(
            <TurnBlockView partition={partition} streaming={false} durationMs={12_000} initiallyOpen={false} />
        )

        const header = screen.getByRole('button', { name: /Run database migration 12\.0s/ })
        const headerDot = header.querySelector('span.rounded-full')
        expect(headerDot?.className).toContain('bg-[var(--app-badge-error-text)]')
        const errorRow = screen.getAllByText('Run database migration').find((node) => !header.contains(node))
        expect(errorRow?.closest('[data-hapi-turn-quiet]')).toBeNull()
        expect(screen.getByText('没能跑迁移。')).toBeInTheDocument()
    })

    it('renders the answer when reasoning is blank or the only tool is Codex reasoning', () => {
        const blank = partitionTurn([
            { type: 'reasoning', text: '   ' },
            { type: 'text', text: '空白思考后的回答' },
        ], null)
        renderBlock(<TurnBlockView partition={blank} streaming={false} durationMs={null} initiallyOpen={false} />)
        expect(screen.getByText('空白思考后的回答')).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: /空白思考/ })).toBeNull()

        const codex = partitionTurn([
            {
                type: 'tool-call',
                toolName: 'CodexReasoning',
                artifact: tool('reason', 'CodexReasoning', { input: { title: 'Thinking' } }),
            },
            { type: 'text', text: '只有推理标题后的回答' },
        ], null)
        renderBlock(<TurnBlockView partition={codex} streaming={false} durationMs={null} initiallyOpen={false} />)
        expect(screen.getByText('只有推理标题后的回答')).toBeInTheDocument()
    })

    it('keeps generated images and files visible beside text and tools', () => {
        const image = {
            kind: 'generated-image' as const,
            id: 'img',
            localId: null,
            createdAt: 1,
            imageId: 'image-1',
            fileName: 'shot.png',
            mimeType: 'image/png',
        }
        const file = {
            kind: 'generated-file' as const,
            id: 'file',
            localId: null,
            createdAt: 1,
            fileId: 'file-1',
            fileName: 'notes.txt',
            mimeType: 'text/plain',
            size: 12,
        }
        const onlyImage = partitionTurn([{ type: 'tool-call', toolName: 'GeneratedImage', artifact: image }], null)
        const { container: imageOnly } = renderBlock(<TurnBlockView partition={onlyImage} streaming={false} durationMs={0} initiallyOpen={false} />)
        expect(screen.getByText('image shot.png')).toBeInTheDocument()
        expect(imageOnly.querySelector('[data-hapi-turn-block-list]')).toBeNull()
        expect(screen.queryByText('0.0s')).toBeNull()

        const textAndImage = partitionTurn([
            { type: 'text', text: '图在这里。' },
            { type: 'tool-call', toolName: 'GeneratedImage', artifact: image },
        ], null)
        renderBlock(<TurnBlockView partition={textAndImage} streaming={false} durationMs={0} initiallyOpen={false} />)
        const caption = screen.getByText('图在这里。')
        expect(caption.closest('.hidden')).toBeNull()
        expect(caption.closest('[data-hapi-turn-quiet]')).toBeNull()

        const toolAndFile = partitionTurn([
            {
                type: 'tool-call',
                toolName: 'Read',
                artifact: tool('read', 'Read', { input: { file_path: 'home.tsx' } }),
            },
            { type: 'tool-call', toolName: 'GeneratedFile', artifact: file },
        ], null)
        renderBlock(<TurnBlockView partition={toolAndFile} streaming={false} durationMs={0} initiallyOpen={false} />)
        expect(screen.getByText('file notes.txt')).toBeInTheDocument()
        expect(screen.queryByText('0.0s')).toBeNull()
    })

    it('keeps the full permission options inside the expanded pending row', () => {
        const partition = partitionTurn([
            {
                type: 'tool-call',
                toolName: 'Bash',
                artifact: tool('bash', 'Bash', {
                    state: 'pending',
                    permission: { id: 'perm', status: 'pending' },
                    input: { command: 'which chrome' },
                }),
            },
        ], null)
        renderBlock(<TurnBlockView partition={partition} streaming={false} durationMs={null} initiallyOpen={false} />)
        expect(screen.getByRole('button', { name: 'Allow' })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: 'Deny' })).toBeInTheDocument()
        expect(screen.queryByText('permission options')).toBeNull()
        fireEvent.click(screen.getByRole('button', { name: /Ran/ }))
        expect(screen.getByText('permission options')).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'Allow' })).toBeNull()
        expect(screen.queryByRole('button', { name: 'Deny' })).toBeNull()
    })

    it('shows the question and its options instead of allow and deny', () => {
        const partition = partitionTurn([
            {
                type: 'tool-call',
                toolName: 'AskUserQuestion',
                artifact: tool('ask', 'AskUserQuestion', {
                    state: 'pending',
                    permission: { id: 'perm', status: 'pending' },
                    input: {
                        questions: [{
                            question: '用哪种布局？',
                            options: [{ label: '单列' }, { label: '双列' }],
                        }],
                    },
                }),
            },
        ], null)
        renderBlock(<TurnBlockView partition={partition} streaming={false} durationMs={null} initiallyOpen={false} />)
        expect(screen.getByText('用哪种布局？')).toBeInTheDocument()
        expect(screen.getByRole('radio', { name: '单列' })).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'Allow' })).toBeNull()
        expect(screen.queryByRole('button', { name: 'Deny' })).toBeNull()
    })

    it('renders generated media outside the timeline rail instead of sandwiching it between pinned todo steps', () => {
        const image = {
            kind: 'generated-image' as const,
            id: 'img-mid-turn',
            localId: null,
            createdAt: 1,
            imageId: 'image-mid-1',
            fileName: 'preview.png',
            mimeType: 'image/png',
        }
        const partition = partitionTurn([
            {
                type: 'tool-call',
                toolName: 'TodoWrite',
                artifact: tool('todo-1', 'TodoWrite', {
                    description: 'Adding implementation and verification tasks',
                    input: { todos: [{ id: '1', content: 'Task 1', status: 'in_progress' }] },
                }),
            },
            {
                type: 'tool-call',
                toolName: 'Bash',
                artifact: tool('bash-1', 'Bash', { input: { command: 'bun test' } }),
            },
            { type: 'tool-call', toolName: 'GeneratedImage', artifact: image },
            {
                type: 'tool-call',
                toolName: 'TodoWrite',
                artifact: tool('todo-2', 'TodoWrite', {
                    description: 'Completing ApplyStyle phase tasks',
                    input: { todos: [{ id: '1', content: 'Task 1', status: 'completed' }] },
                }),
            },
            { type: 'text', text: 'Final answer after image.' },
        ], null)

        renderBlock(
            <TurnBlockView
                variant="timeline"
                partition={partition}
                streaming={false}
                durationMs={5000}
                initiallyOpen={false}
            />
        )

        const collapsedRail = screen.getByTestId('turn-collapsed-pinned-rail')
        const deliverables = screen.getByTestId('turn-media-deliverables')
        const imageNodeBefore = screen.getByText('image preview.png')

        expect(deliverables).toContainElement(imageNodeBefore)
        expect(collapsedRail).not.toContainElement(imageNodeBefore)
        expect(screen.getByTestId('turn-level1-rail')).not.toContainElement(imageNodeBefore)
        expect(
            collapsedRail.compareDocumentPosition(deliverables) & Node.DOCUMENT_POSITION_FOLLOWING
        ).toBeTruthy()

        fireEvent.click(screen.getByTestId('turn-level0-header'))
        const imageNodeAfter = screen.getByText('image preview.png')
        expect(imageNodeAfter).toBe(imageNodeBefore)
        expect(screen.getByTestId('turn-level1-rail')).not.toContainElement(imageNodeAfter)
    })
})
