import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { I18nProvider } from '@/lib/i18n-context'
import { SessionEntityStore } from '@/chat/store/sessionEntityStore'
import { HappyChatProvider, type HappyChatContextValue } from '@/components/AssistantChat/context'
import { SessionEntityStoreProvider } from '@/hooks/useSessionEntityStore'
import { partitionTurn } from '@/components/AssistantChat/messages/turnBlockModel'
import { TurnBlock, TurnBlockView } from '@/components/AssistantChat/messages/TurnBlock'
import { ShareTurnButton } from '@/components/AssistantChat/messages/ShareTurnButton'
import type { ToolCallBlock } from '@/chat/types'
import type { DecryptedMessage } from '@/types/api'
const { mockAuiMessage } = vi.hoisted(() => ({
    mockAuiMessage: {
        role: 'assistant' as const,
        content: [] as unknown[],
        status: { type: 'running' as 'running' | 'complete' },
        isLast: true,
        createdAt: new Date(1_000),
        metadata: { custom: {} as Record<string, unknown> },
    },
}))

vi.mock('@assistant-ui/react', async (importOriginal) => {
    const actual = (await importOriginal()) as Record<string, unknown>
    return {
        ...actual,
        useAuiState: (selector: (state: { message: typeof mockAuiMessage }) => unknown) =>
            selector({ message: mockAuiMessage }),
    }
})
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
    it('folds quiet rows without mounting collapsed step or quiet-text DOM, keeps error and permission rows operable, and mounts shareable sandwiched text on demand', () => {
        const partition = partitionTurn([
            { type: 'reasoning', text: '先看页面', blockId: 'reason-1' },
            {
                type: 'tool-call',
                toolName: 'Read',
                artifact: tool('read', 'Read', { input: { file_path: 'src/pages/home.tsx' } }),
            },
            { type: 'text', text: '夹在工具之间的说明', blockId: 'quiet-text-1' },
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
            { type: 'text', text: '这是回答。', blockId: 'answer-1' },
        ], null)

        let capturedTarget: HTMLElement | string | null = null
        let capturedOuterHTML = ''
        const onShareTurn = vi.fn((target: HTMLElement | string | null) => {
            capturedTarget = target
            if (target instanceof HTMLElement) {
                capturedOuterHTML = target.outerHTML
            }
        })
        const value = {
            api: {
                approvePermission: vi.fn(async () => undefined),
                denyPermission: vi.fn(async () => undefined),
            },
            sessionId: 'session',
            metadata: null,
            disabled: false,
            onRefresh: vi.fn(),
            onShareTurn,
        } as unknown as HappyChatContextValue

        const { container } = render(
            <I18nProvider>
                <HappyChatProvider value={value}>
                    <div className="chat-scroll-content">
                        <div className="happy-thread-messages">
                            <div id="hapi-message-turn-1" data-hapi-message-role="assistant">
                                <TurnBlockView
                                    partition={partition}
                                    streaming={false}
                                    durationMs={151_000}
                                    initiallyOpen={false}
                                    turnId="turn-1"
                                />
                                <ShareTurnButton messageId="turn-1" messageElementId="hapi-message-turn-1" />
                            </div>
                        </div>
                    </div>
                </HappyChatProvider>
            </I18nProvider>
        )

        const header = screen.getByTestId('turn-level0-header')
        expect(header).toHaveAttribute('aria-expanded', 'false')
        expect(header.className).not.toContain('app-reasoning-bg')
        expect(screen.getByTestId('turn-level1-shell')).toHaveAttribute('data-open', 'false')
        expect(screen.getByText('2m 31s')).toBeInTheDocument()
        // Closed rail does not mount full stepRows or hidden quiet-text markdown in main DOM
        expect(screen.getByTestId('turn-level1-rail').querySelectorAll('[data-rail-row-index]')).toHaveLength(0)
        expect(container.querySelector('[data-hapi-turn-quiet]')).toBeNull()
        expect(screen.queryByText('home.tsx')).not.toBeNull()
        const pinnedRail = screen.getByTestId('turn-collapsed-pinned-rail')
        expect(pinnedRail).toHaveTextContent('which chrome')
        expect(pinnedRail).toHaveTextContent('home.tsx')
        expect(pinnedRail).toHaveTextContent('permission options')
        expect(screen.getByText('这是回答。')).toBeInTheDocument()

        // Clicking ShareTurnButton mounts an offscreen capture tree inside .chat-scroll-content with sandwiched quiet text, then unmounts it
        const rafCallbacks: FrameRequestCallback[] = []
        const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
            rafCallbacks.push(cb)
            return rafCallbacks.length
        })
        try {
            fireEvent.click(screen.getByRole('button', { name: 'Share turn as image' }))
            const offscreenStage = container.querySelector('[data-testid="turn-share-offscreen-stage"]')
            expect(offscreenStage).not.toBeNull()
            expect(container.querySelector('.chat-scroll-content')?.contains(offscreenStage)).toBe(true)
            const quietNote = offscreenStage?.querySelector('[data-hapi-turn-quiet]')
            expect(quietNote).not.toBeNull()
            expect(quietNote).toHaveTextContent('夹在工具之间的说明')
            expect(quietNote).toHaveClass('hidden')
            expect(quietNote?.closest('[data-hapi-share-exclude="true"]')).toBe(offscreenStage)

            while (rafCallbacks.length > 0) {
                const next = rafCallbacks.shift()!
                act(() => {
                    next(16)
                })
            }

            expect(onShareTurn).toHaveBeenCalledTimes(1)
            expect(capturedTarget).toBeInstanceOf(HTMLElement)
            expect(capturedOuterHTML).toContain('夹在工具之间的说明')
            expect(capturedOuterHTML).toContain('这是回答。')
            expect(container.querySelector('[data-testid="turn-share-offscreen-stage"]')).toBeNull()
        } finally {
            rafSpy.mockRestore()
        }
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

        const header = screen.getByTestId('turn-level0-header')
        expect(header).toHaveTextContent('2m 14s')
        expect(header.querySelector('.bg-\\[var\\(--app-badge-error-text\\)\\]')).toBeNull()
        expect(screen.queryByTestId('turn-collapsed-pinned-rail')).toBeNull()
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

        const header = screen.getByTestId('turn-level0-header')
        expect(header).toHaveTextContent('12.0s')
        expect(header.querySelector('.bg-\\[var\\(--app-badge-error-text\\)\\]')).not.toBeNull()
        expect(screen.getByTestId('turn-collapsed-pinned-rail')).toHaveTextContent('bun run migrate')
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
        const pinnedRail = screen.getByTestId('turn-collapsed-pinned-rail')
        expect(pinnedRail).toHaveTextContent('permission options')
        const rowToggle = pinnedRail.querySelector('button[aria-expanded="false"]')
        expect(rowToggle).not.toBeNull()
        fireEvent.click(rowToggle!)
        expect(pinnedRail.querySelector('button[aria-expanded="true"]')).not.toBeNull()
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
        const pinnedRail = screen.getByTestId('turn-collapsed-pinned-rail')
        expect(pinnedRail).toHaveTextContent('用哪种布局？')
        expect(pinnedRail).toHaveTextContent('单列')
        expect(pinnedRail).toHaveTextContent('双列')
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
                partition={partition}
                streaming={false}
                durationMs={5000}
                initiallyOpen={false}
            />
        )

        const collapsedRail = screen.getByTestId('turn-live-todo-cards')
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

    it('defaults the timeline track to collapsed while a turn is running and still supports manual expand and auto-collapse', () => {
        mockAuiMessage.status = { type: 'running' }
        mockAuiMessage.content = [
            { type: 'reasoning', text: 'Inspecting TurnBlock default open state', status: { type: 'running' } },
            {
                type: 'tool-call',
                toolCallId: 'read-1',
                toolName: 'Read',
                artifact: tool('read-1', 'Read', {
                    state: 'running',
                    input: { file_path: 'web/src/components/AssistantChat/messages/TurnBlock.tsx', i: 'Reading TurnBlock' },
                }),
            },
        ]

        const { rerender } = renderBlock(<TurnBlock />)

        const header = screen.getByTestId('turn-level0-header')
        const shell = screen.getByTestId('turn-level1-shell')
        expect(header).toHaveAttribute('aria-expanded', 'false')
        expect(shell).toHaveAttribute('data-open', 'false')

        fireEvent.click(header)
        expect(header).toHaveAttribute('aria-expanded', 'true')
        expect(shell).toHaveAttribute('data-open', 'true')

        mockAuiMessage.status = { type: 'complete' }
        mockAuiMessage.content = [
            { type: 'reasoning', text: 'Inspecting TurnBlock default open state', status: { type: 'complete' } },
            {
                type: 'tool-call',
                toolCallId: 'read-1',
                toolName: 'Read',
                artifact: tool('read-1', 'Read', {
                    state: 'completed',
                    input: { file_path: 'web/src/components/AssistantChat/messages/TurnBlock.tsx', i: 'Reading TurnBlock' },
                }),
            },
            { type: 'text', text: 'Timeline now defaults to collapsed while running.' },
        ]

        rerender(
            <I18nProvider>
                <HappyChatProvider
                    value={{
                        api: {
                            approvePermission: vi.fn(async () => undefined),
                            denyPermission: vi.fn(async () => undefined),
                        },
                        sessionId: 'session',
                        metadata: null,
                        disabled: false,
                        onRefresh: vi.fn(),
                    } as unknown as HappyChatContextValue}
                >
                    <TurnBlock />
                </HappyChatProvider>
            </I18nProvider>
        )

        expect(screen.getByTestId('turn-level0-header')).toHaveAttribute('aria-expanded', 'false')
        expect(screen.getByTestId('turn-level1-shell')).toHaveAttribute('data-open', 'false')
    })

    it('subscribes TurnBlock and leaf rows to SessionEntityStore by entity id without re-rendering completed turns on tail deltas', () => {
        const store = new SessionEntityStore()
        const baseMessages: DecryptedMessage[] = [
            {
                id: 'u1',
                seq: 1,
                localId: null,
                CreatedAt: 1000,
                createdAt: 1000,
                content: { role: 'user', content: { type: 'text', text: 'First question' } },
            } as unknown as DecryptedMessage,
            {
                id: 'a1-tool',
                seq: 2,
                localId: null,
                CreatedAt: 1001,
                createdAt: 1001,
                content: {
                    role: 'agent',
                    content: {
                        type: 'output',
                        data: {
                            type: 'assistant',
                            uuid: 'a1-tool-uuid',
                            message: {
                                role: 'assistant',
                                model: 'claude-sonnet',
                                content: [{ type: 'tool_use', id: 'call-1', name: 'Read', input: { file_path: 'a.ts' } }],
                            },
                        },
                    },
                },
            } as unknown as DecryptedMessage,
            {
                id: 'a1-res',
                seq: 3,
                localId: null,
                CreatedAt: 1002,
                createdAt: 1002,
                content: {
                    role: 'agent',
                    content: {
                        type: 'output',
                        data: {
                            type: 'user',
                            uuid: 'a1-res-uuid',
                            message: {
                                role: 'user',
                                content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'ok' }],
                            },
                        },
                    },
                },
            } as unknown as DecryptedMessage,
            {
                id: 'a1-ans',
                seq: 4,
                localId: null,
                CreatedAt: 1003,
                createdAt: 1003,
                content: {
                    role: 'agent',
                    content: {
                        type: 'output',
                        data: {
                            type: 'assistant',
                            uuid: 'a1-ans-uuid',
                            message: {
                                role: 'assistant',
                                model: 'claude-sonnet',
                                content: [{ type: 'text', text: 'First turn completed answer.' }],
                            },
                        },
                    },
                },
            } as unknown as DecryptedMessage,
            {
                id: 'u2',
                seq: 5,
                localId: null,
                CreatedAt: 2000,
                createdAt: 2000,
                content: { role: 'user', content: { type: 'text', text: 'Second question' } },
            } as unknown as DecryptedMessage,
            {
                id: 'a2-think',
                seq: 6,
                localId: null,
                CreatedAt: 2001,
                createdAt: 2001,
                content: {
                    role: 'agent',
                    content: {
                        type: 'output',
                        data: {
                            type: 'assistant',
                            uuid: 'a2-think-uuid',
                            message: {
                                role: 'assistant',
                                model: 'claude-sonnet',
                                content: [{ type: 'thinking', thinking: 'Initial thought step' }],
                            },
                        },
                    },
                },
            } as unknown as DecryptedMessage,
            {
                id: 'a2-ans',
                seq: 7,
                localId: null,
                CreatedAt: 2002,
                createdAt: 2002,
                content: {
                    role: 'agent',
                    content: {
                        type: 'output',
                        data: {
                            type: 'assistant',
                            uuid: 'a2-ans-uuid',
                            streamSnapshot: true,
                            live: true,
                            message: {
                                role: 'assistant',
                                model: 'claude-sonnet',
                                content: [{ type: 'text', text: 'Stream chunk 1' }],
                            },
                        },
                    },
                },
            } as unknown as DecryptedMessage,
        ]

        const snap1 = store.reconcileInput({ sessionId: 's1', messages: baseMessages })
        const turnIds = Array.from(snap1.turnsById.keys())
        expect(turnIds.length).toBe(2)
        const [turn1Id, turn2Id] = turnIds as [string, string]

        // Point mockAuiMessage at turn2 with empty content to prove TurnBlock reads from SessionEntityStore
        ;(mockAuiMessage as { id?: string }).id = turn2Id
        mockAuiMessage.status = { type: 'running' }
        mockAuiMessage.isLast = true
        mockAuiMessage.content = []

        let turn1SelectorCalls = 0
        const unsubTurn1 = store.subscribe(() => {
            turn1SelectorCalls += 1
        })
        const turn1InitialRef = store.getTurnEntity(turn1Id)
        const turn1InitialLayout = store.getTurnLayout(turn1Id)
        expect(turn1InitialLayout?.partition.rows.length).toBeGreaterThan(0)
        expect(turn1InitialLayout?.projectedSettled.subturns[0]?.answerRows.length).toBe(1)
        const getLiveTurnPartsSpy = vi.spyOn(store, 'getLiveTurnParts')

        renderBlock(
            <SessionEntityStoreProvider store={store}>
                <TurnBlock messageId={turn1Id} />
                <TurnBlock messageId={turn2Id} />
            </SessionEntityStoreProvider>
        )
        expect(getLiveTurnPartsSpy).not.toHaveBeenCalled()
        expect(screen.getByText('Stream chunk 1')).toBeInTheDocument()

        const deltaMessages = baseMessages.slice(0, -1).concat({
            ...baseMessages[baseMessages.length - 1]!,
            content: {
                role: 'agent',
                content: {
                    type: 'output',
                    data: {
                        type: 'assistant',
                        uuid: 'a2-ans-uuid',
                        streamSnapshot: true,
                        live: true,
                        message: {
                            role: 'assistant',
                            model: 'claude-sonnet',
                            content: [{ type: 'text', text: 'Stream chunk 1 + chunk 2' }],
                        },
                    },
                },
            },
        } as unknown as DecryptedMessage)

        act(() => {
            store.reconcileInput({ sessionId: 's1', messages: deltaMessages })
        })

        expect(screen.getByText('Stream chunk 1 + chunk 2')).toBeInTheDocument()
        // Turn 1 entity reference is strictly preserved (Object.is equal -> 0 Turn 1 re-renders)
        expect(store.getTurnEntity(turn1Id)).toBe(turn1InitialRef)
        expect(turn1SelectorCalls).toBe(1)
        expect(store.getTurnLayout(turn1Id)).toBe(turn1InitialLayout)
        expect(getLiveTurnPartsSpy).not.toHaveBeenCalled()
        getLiveTurnPartsSpy.mockRestore()
        unsubTurn1()
    })

    it('retains expanded tool and thought states across rail collapse/re-open and pinned-to-open transitions', () => {
        const partition = partitionTurn([
            { type: 'reasoning', text: '**Detailed thought step** body line 2', blockId: 'thought-block-1' },
            {
                type: 'tool-call',
                toolName: 'Read',
                artifact: tool('read-a', 'Read', {
                    input: { file_path: 'src/a.ts' },
                    result: 'alpha content',
                }),
            },
            {
                type: 'tool-call',
                toolName: 'Read',
                artifact: tool('read-b', 'Read', {
                    input: { file_path: 'src/b.ts' },
                    result: 'beta content',
                }),
            },
            {
                type: 'tool-call',
                toolName: 'Bash',
                artifact: tool('bash-err', 'Bash', {
                    state: 'error',
                    input: { command: 'bun run check' },
                    result: { stderr: 'Check failed' },
                }),
            },
            { type: 'text', text: 'Done.', blockId: 'ans-block-1' },
        ], null)

        renderBlock(
            <TurnBlockView
                partition={partition}
                streaming={false}
                durationMs={2_000}
                initiallyOpen={false}
                turnId="turn-preserve"
            />
        )

        // Expand the pinned error tool while the rail is collapsed
        const pinnedRail = screen.getByTestId('turn-collapsed-pinned-rail')
        const pinnedToolButton = within(pinnedRail).getByRole('button', { name: /bun run check/ })
        fireEvent.click(pinnedToolButton)
        expect(screen.getByTestId('turn-level2-bash')).toBeVisible()

        // Open the main execution rail -> pinned tool moves into the open rail and stays expanded
        fireEvent.click(screen.getByTestId('turn-level0-header'))
        expect(screen.queryByTestId('turn-collapsed-pinned-rail')).toBeNull()
        expect(screen.getByTestId('turn-level2-bash')).toBeInTheDocument()

        // Error segments expose individual read tools without an extra group.
        const thoughtButton = screen.getByText('Thought').closest('button')
        expect(thoughtButton).not.toBeNull()
        fireEvent.click(thoughtButton!)
        expect(screen.getByText(/Detailed thought step/)).toBeInTheDocument()

        fireEvent.click(screen.getByText('a.ts').closest('button')!)
        expect(screen.getByTestId('turn-level2-read')).toHaveTextContent('alpha content')

        // Collapsing retains the pinned segment DOM but hides its non-pinned members.
        fireEvent.click(screen.getByTestId('turn-level0-header'))
        expect(screen.getByTestId('turn-level1-rail').querySelectorAll('[data-rail-row-index]')).toHaveLength(0)
        expect(screen.queryByText(/Detailed thought step/)).toBeNull()
        expect(screen.getByTestId('turn-level2-read')).not.toBeVisible()
        expect(screen.getByTestId('turn-collapsed-pinned-rail')).toBeInTheDocument()
        expect(screen.getByTestId('turn-level2-bash')).toBeInTheDocument()

        // Re-opening restores the thought, read preview, and pinned tool details.
        fireEvent.click(screen.getByTestId('turn-level0-header'))
        expect(screen.getByText(/Detailed thought step/)).toBeInTheDocument()
        expect(screen.getByTestId('turn-level2-read')).toHaveTextContent('alpha content')
        expect(screen.getByTestId('turn-level2-bash')).toBeInTheDocument()
    })

    it('keeps unpinned running tools collapsed in the level-0 header while exposing pinned running subagents when collapsed while streaming', () => {
        const partition = partitionTurn([
            {
                type: 'tool-call',
                toolName: 'Bash',
                artifact: tool('bash-live', 'Bash', {
                    state: 'running',
                    input: { command: 'bun run build', i: 'Building production bundle' },
                }),
            },
            {
                type: 'tool-call',
                toolName: 'Task',
                artifact: tool('task-live', 'Task', {
                    state: 'running',
                    input: { description: 'Audit rail exposure', subagent_type: 'Explore' },
                }),
            },
        ], null)

        renderBlock(
            <TurnBlockView
                partition={partition}
                streaming={true}
                durationMs={1_000}
                initiallyOpen={false}
                turnId="turn-live-collapsed"
            />
        )

        expect(screen.getByTestId('turn-level0-header')).toHaveAttribute('aria-expanded', 'false')
        const collapsedRail = screen.getByTestId('turn-collapsed-pinned-rail')
        expect(collapsedRail).toHaveAttribute('data-block-id', 'task-live')
        expect(collapsedRail).toHaveTextContent('Running')
        expect(collapsedRail).toHaveTextContent('Audit rail exposure')
        expect(collapsedRail).not.toHaveTextContent('Building production bundle')
        expect(collapsedRail.querySelector('[data-testid="rail-step-spinner"]')).not.toBeNull()
    })

    it('captures the full user+assistant turn sibling range when ShareTurnButton is clicked on the user prompt above a collapsed assistant rail', () => {
        const partition = partitionTurn([
            {
                type: 'tool-call',
                toolName: 'Read',
                artifact: tool('read-user-share', 'Read', { input: { file_path: 'src/index.ts' } }),
            },
            { type: 'text', text: '助手在两个工具之间的静默说明', blockId: 'quiet-user-share' },
            {
                type: 'tool-call',
                toolName: 'Bash',
                artifact: tool('bash-user-share', 'Bash', { input: { command: 'echo ok' } }),
            },
            { type: 'text', text: '最终回复内容。', blockId: 'final-user-share' },
        ], null)

        let capturedSnapshots: Array<{ role: string | null; html: string }> = []
        const onShareTurn = vi.fn((target: HTMLElement | string | null) => {
            if (!(target instanceof HTMLElement)) return
            let start: Element | null = target
            while (start?.previousElementSibling && start.getAttribute('data-hapi-message-role') !== 'user') {
                start = start.previousElementSibling
            }
            if (!start || start.getAttribute('data-hapi-message-role') !== 'user') {
                start = target
            }
            const list: Array<{ role: string | null; html: string }> = []
            let current: Element | null = start
            while (current instanceof HTMLElement) {
                if (current !== start && current.getAttribute('data-hapi-message-role') === 'user') {
                    break
                }
                list.push({
                    role: current.getAttribute('data-hapi-message-role'),
                    html: current.outerHTML,
                })
                current = current.nextElementSibling
            }
            capturedSnapshots = list
        })

        const value = {
            api: {
                approvePermission: vi.fn(async () => undefined),
                denyPermission: vi.fn(async () => undefined),
            },
            sessionId: 'session',
            metadata: null,
            disabled: false,
            onRefresh: vi.fn(),
            onShareTurn,
        } as unknown as HappyChatContextValue

        const { container } = render(
            <I18nProvider>
                <HappyChatProvider value={value}>
                    <div className="chat-scroll-content">
                        <div className="happy-thread-messages">
                            <div id="hapi-message-user-1" data-hapi-message-role="user">
                                <p>用户提问：请检查构建</p>
                                <ShareTurnButton messageId="user-1" messageElementId="hapi-message-user-1" />
                            </div>
                            <div id="hapi-message-assistant-1" data-hapi-message-role="assistant">
                                <TurnBlockView
                                    partition={partition}
                                    streaming={false}
                                    durationMs={3_000}
                                    initiallyOpen={false}
                                    turnId="assistant-1"
                                />
                            </div>
                        </div>
                    </div>
                </HappyChatProvider>
            </I18nProvider>
        )

        const rafCallbacks: FrameRequestCallback[] = []
        const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => {
            rafCallbacks.push(cb)
            return rafCallbacks.length
        })
        try {
            fireEvent.click(screen.getByRole('button', { name: 'Share turn as image' }))
            while (rafCallbacks.length > 0) {
                const next = rafCallbacks.shift()!
                act(() => {
                    next(16)
                })
            }
            expect(onShareTurn).toHaveBeenCalledTimes(1)
            expect(capturedSnapshots).toHaveLength(2)
            expect(capturedSnapshots[0]?.role).toBe('user')
            expect(capturedSnapshots[0]?.html).toContain('用户提问：请检查构建')
            expect(capturedSnapshots[1]?.role).toBe('assistant')
            expect(capturedSnapshots[1]?.html).toContain('助手在两个工具之间的静默说明')
            expect(capturedSnapshots[1]?.html.split('助手在两个工具之间的静默说明')).toHaveLength(2)
            expect(capturedSnapshots[1]?.html).toContain('最终回复内容。')
            expect(container.querySelector('[data-testid="turn-share-offscreen-stage"]')).toBeNull()
        } finally {
            rafSpy.mockRestore()
        }
    })

    it('omits data-block-id on reasoning/text rows without stable blockId while writing stable data-block-id when blockId or tool id is present', () => {
        const withoutIds = partitionTurn([
            { type: 'reasoning', text: 'Positional thought without blockId' },
            { type: 'text', text: 'Answer.' },
        ], null)

        const { container, rerender } = renderBlock(
            <TurnBlockView
                partition={withoutIds}
                streaming={false}
                durationMs={1_000}
                initiallyOpen={true}
            />
        )

        // No positional reasoning:0 or text:0 should appear in data-block-id
        expect(container.querySelector('[data-block-id^="reasoning:"]')).toBeNull()
        expect(container.querySelector('[data-block-id^="text:"]')).toBeNull()

        const withIds = partitionTurn([
            { type: 'reasoning', text: 'Stable thought with blockId', blockId: 'blk-reason-42' },
            {
                type: 'tool-call',
                toolName: 'Bash',
                artifact: tool('blk-tool-99', 'Bash', { input: { command: 'ls' } }),
            },
            { type: 'text', text: 'Answer.', blockId: 'blk-ans-1' },
        ], null)

        rerender(
            <I18nProvider>
                <HappyChatProvider
                    value={{
                        api: {
                            approvePermission: vi.fn(async () => undefined),
                            denyPermission: vi.fn(async () => undefined),
                        },
                        sessionId: 'session',
                        metadata: null,
                        disabled: false,
                        onRefresh: vi.fn(),
                    } as unknown as HappyChatContextValue}
                >
                    <TurnBlockView
                        partition={withIds}
                        streaming={false}
                        durationMs={1_000}
                        initiallyOpen={true}
                    />
                </HappyChatProvider>
            </I18nProvider>
        )

        expect(container.querySelector('[data-block-id="blk-reason-42"]')).not.toBeNull()
        expect(container.querySelector('[data-block-id="blk-tool-99"]')).not.toBeNull()
    })
})
