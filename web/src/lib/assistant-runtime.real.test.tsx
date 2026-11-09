import { act, render, renderHook, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AssistantRuntimeProvider, ThreadPrimitive } from '@assistant-ui/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@tanstack/react-router', () => ({
    useNavigate: () => vi.fn(),
}))
import { createSessionEntityStore, type SessionEntityStore } from '@/chat/store/sessionEntityStore'
import { HappyChatProvider, type HappyChatContextValue } from '@/components/AssistantChat/context'
import { HappyAssistantMessage } from '@/components/AssistantChat/messages/AssistantMessage'
import { HappySystemMessage } from '@/components/AssistantChat/messages/SystemMessage'
import { HappyUserMessage } from '@/components/AssistantChat/messages/UserMessage'
import { SessionEntityStoreProvider, useSessionTimelineIndex } from '@/hooks/useSessionEntityStore'
import { I18nProvider } from '@/lib/i18n-context'
import type { DecryptedMessage, Session } from '@/types/api'
import { useHappyRuntime } from './assistant-runtime'

const session: Session = {
    id: 's', namespace: 'default', seq: 0, createdAt: 0, updatedAt: 0, active: true, activeAt: 0,
    metadata: { path: '/repo', host: 'test', flavor: 'omp' }, metadataVersion: 0,
    agentState: null, agentStateVersion: 0, thinking: false, thinkingAt: 0,
    model: null, modelReasoningEffort: null, effort: null, serviceTier: null, resumeWithSessionModel: false,
}
function user(id: string, seq: number): DecryptedMessage {
    return { id, seq, localId: id, createdAt: seq, invokedAt: seq, content: { role: 'user', content: { type: 'text', text: id } } }
}
function assistant(id: string, seq: number, content: unknown[], live = false): DecryptedMessage {
    return { id, seq, localId: null, createdAt: seq, content: { role: 'agent', content: { type: 'output', data: {
        type: 'assistant', uuid: id, streamSnapshot: true, live,
        message: { role: 'assistant', content },
    } } } }
}

describe('real assistant-ui entity runtime', () => {
    it('keeps full joined content current, preserves settled messages and empties safely on rewind/session switch', () => {
        const store = createSessionEntityStore()
        const history = [user('u1', 1), assistant('a1', 2, [{ type: 'text', text: 'Historical answer' }]), user('u2', 3)]
        const update = (content: unknown[], result?: string) => store.reconcileInput({ sessionId: 's', messages: [
            ...history,
            assistant('active', 4, content, true),
            ...(result === undefined ? [] : [{ id: 'result', seq: 5, localId: null, createdAt: 5, content: { role: 'agent' as const, content: { type: 'output', data: { type: 'user', uuid: 'result', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call', content: result }] } } } } }]),
        ] })
        update([{ type: 'thinking', thinking: 'Inspect' }, { type: 'tool_use', id: 'call', name: 'Read', input: {} }])
        const view = renderHook(({ currentSession }: { currentSession: Session }) => useHappyRuntime({
            entityStore: store, session: currentSession, isSending: false, historyVersion: 0,
            onSendMessage: () => undefined, onAbort: async () => undefined,
        }), { initialProps: { currentSession: { ...session, thinking: true, activeTurnStartedAt: 3 } as Session } })
        const initial = view.result.current.thread.getState().messages
        expect(initial.map((message) => message.id)).toEqual(store.getTimelineIndex().map((entry) => entry.id))
        expect(initial).toHaveLength(4)
        act(() => { update([
            { type: 'thinking', thinking: 'Inspect the current implementation' },
            { type: 'tool_use', id: 'call', name: 'Read', input: { file_path: 'src/a.ts', i: 'Reading current source' } },
            { type: 'text', text: 'Full final answer' },
        ], 'Complete tool output') })
        const current = view.result.current.thread.getState().messages
        expect(current[1]).toBe(initial[1])
        expect(current.at(-1)?.content).toMatchObject([
            { type: 'reasoning', text: 'Inspect the current implementation' },
            { type: 'tool-call', toolCallId: 'call', args: { file_path: 'src/a.ts' }, result: 'Complete tool output' },
            { type: 'text', text: 'Full final answer' },
        ])
        const settledTurn1 = current[1]
        const settledUser2 = current[2]
        // Pagination prepend preserves settled ThreadMessage references
        act(() => {
            store.reconcileInput({
                sessionId: 's',
                messages: [
                    user('u0', 0),
                    assistant('a0', 0, [{ type: 'text', text: 'Older answer' }]),
                    ...history,
                    assistant('active', 4, [{ type: 'text', text: 'Full final answer' }], false),
                ],
            })
        })
        const afterPrepend = view.result.current.thread.getState().messages
        expect(afterPrepend).toHaveLength(6)
        expect(afterPrepend[3]).toBe(settledTurn1)
        expect(afterPrepend[4]).toBe(settledUser2)
        // Trim preserves remaining settled ThreadMessage references
        act(() => {
            store.reconcileInput({
                sessionId: 's',
                messages: [
                    ...history,
                    assistant('active', 4, [{ type: 'text', text: 'Full final answer' }], false),
                ],
            })
        })
        const afterTrim = view.result.current.thread.getState().messages
        expect(afterTrim).toHaveLength(4)
        expect(afterTrim[1]).toBe(settledTurn1)
        expect(afterTrim[2]).toBe(settledUser2)
        act(() => { store.reconcileInput({ sessionId: 's', messages: [] }) })
        view.rerender({ currentSession: { ...session, thinking: false } })
        expect(view.result.current.thread.getState().messages).toEqual([])
        act(() => { store.reconcileInput({ sessionId: 'other', messages: [user('other-u', 1), assistant('other-a', 2, [{ type: 'text', text: 'Other session' }])] }) })
        expect(view.result.current.thread.getState().messages.map((message) => message.id)).toEqual(store.getTimelineIndex().map((entry) => entry.id))
        expect(view.result.current.thread.getState().messages.at(-1)?.content).toMatchObject([{ type: 'text', text: 'Other session' }])
    })

    it('keeps historical answers complete while a new run waits for its first output', () => {
        const store = createSessionEntityStore()
        store.reconcileInput({ sessionId: 's', messages: [user('u', 1), assistant('a', 2, [{ type: 'text', text: 'Settled answer' }])] })
        const view = renderHook(({ currentSession }) => useHappyRuntime({ entityStore: store, session: currentSession, isSending: false, historyVersion: 0,
            onSendMessage: () => undefined, onAbort: async () => undefined,
        }), { initialProps: { currentSession: session } })
        view.rerender({ currentSession: { ...session, thinking: true, activeTurnId: 'new-turn', activeTurnStartedAt: 10, lifecycleState: 'streaming-answer' } })
        const state = view.result.current.thread.getState()
        const settledId = store.getTimelineIndex()[1]!.id
        expect(state.isRunning).toBe(true)
        expect(state.messages.find((m) => m.id === settledId)).toMatchObject({ status: { type: 'complete' }, content: [{ text: 'Settled answer' }] })
    })

    it('renders live text, CLI output, tool args/results, permissions, and Todo updates through real AssistantRuntimeProvider + Unstable_MessageById without re-rendering the list or TurnBlock on payload deltas', async () => {
        const store = createSessionEntityStore()
        const queryClient = new QueryClient({
            defaultOptions: { queries: { retry: false } },
        })
        let listRenders = 0
        const chatContext = {
            api: {
                approvePermission: vi.fn(async () => undefined),
                denyPermission: vi.fn(async () => undefined),
                fetchVoiceBackend: vi.fn(async () => ({ provider: 'none' })),
            },
            sessionId: 's',
            metadata: { path: '/repo', host: 'test', flavor: 'omp' },
            disabled: false,
            onRefresh: vi.fn(),
        } as unknown as HappyChatContextValue

        const COMPONENTS = {
            UserMessage: HappyUserMessage,
            AssistantMessage: HappyAssistantMessage,
            SystemMessage: HappySystemMessage,
        } as const

        function CanonicalTimelineList({ entityStore }: { entityStore: SessionEntityStore }) {
            listRenders += 1
            const timeline = useSessionTimelineIndex(entityStore)
            return (
                <div data-testid="canonical-list">
                    {timeline.map((entry) => (
                        <ThreadPrimitive.Unstable_MessageById
                            key={entry.id}
                            messageId={entry.id}
                            components={COMPONENTS}
                        />
                    ))}
                </div>
            )
        }

        function RuntimeHost({ entityStore, currentSession, children }: { entityStore: SessionEntityStore; currentSession: Session; children: ReactNode }) {
            const runtime = useHappyRuntime({
                entityStore,
                session: currentSession,
                isSending: false,
                historyVersion: 0,
                onSendMessage: () => undefined,
                onAbort: async () => undefined,
            })
            return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>
        }

        function Host({ entityStore, currentSession }: { entityStore: SessionEntityStore; currentSession: Session }) {
            return (
                <QueryClientProvider client={queryClient}>
                    <I18nProvider>
                        <SessionEntityStoreProvider store={entityStore}>
                            <RuntimeHost entityStore={entityStore} currentSession={currentSession}>
                                <HappyChatProvider value={chatContext}>
                                    <ThreadPrimitive.Root>
                                        <CanonicalTimelineList entityStore={entityStore} />
                                    </ThreadPrimitive.Root>
                                </HappyChatProvider>
                            </RuntimeHost>
                        </SessionEntityStoreProvider>
                    </I18nProvider>
                </QueryClientProvider>
            )
        }

        // 1. Start with user prompt + assistant first token
        store.reconcileInput({
            sessionId: 's',
            messages: [
                user('u1', 1),
                assistant('a1', 2, [{ type: 'text', text: 'Hello' }], true),
            ],
        })

        render(<Host entityStore={store} currentSession={{ ...session, thinking: true, activeTurnStartedAt: 1 }} />)
        await waitFor(() => expect(screen.getByText('Hello')).toBeInTheDocument())
        const initialListRenders = listRenders

        // 2. Stream text delta -> DOM updates live, listRenders stays identical
        act(() => {
            store.reconcileInput({
                sessionId: 's',
                messages: [
                    user('u1', 1),
                    assistant('a1', 2, [{ type: 'text', text: 'Hello world from live leaf!' }], true),
                ],
            })
        })
        await waitFor(() => expect(screen.getByText('Hello world from live leaf!')).toBeInTheDocument())
        expect(listRenders).toBe(initialListRenders)

        // 3. Add a running Read tool call with empty input, then stream its file_path + intent
        const turnId = store.getTimelineIndex()[1]!.id
        let layoutNotifications = 0
        const unsubLayout = store.subscribeEntity(`layout:${turnId}`, () => {
            layoutNotifications += 1
        })
        act(() => {
            store.reconcileInput({
                sessionId: 's',
                messages: [
                    user('u1', 1),
                    assistant('a1', 2, [
                        { type: 'thinking', thinking: 'Checking file' },
                        { type: 'tool_use', id: 'tool-read', name: 'Read', input: {} },
                    ], true),
                ],
            })
        })
        expect(layoutNotifications).toBe(1)
        expect(listRenders).toBe(initialListRenders)

        // Stream tool input (file_path + intent) while tool remains running -> layoutNotifications does not increment, rail header & row update live!
        act(() => {
            store.reconcileInput({
                sessionId: 's',
                messages: [
                    user('u1', 1),
                    assistant('a1', 2, [
                        { type: 'thinking', thinking: 'Checking file\nSecond line of thought' },
                        { type: 'tool_use', id: 'tool-read', name: 'Read', input: { file_path: 'src/App.tsx', i: 'Reading App component' } },
                    ], true),
                ],
            })
        })
        expect(layoutNotifications).toBe(1)
        expect(listRenders).toBe(initialListRenders)
        expect(screen.getByTestId('turn-level0-header')).toHaveTextContent('Reading App component')

        // 4. Add TodoWrite tool and update its todos -> layout updates and renders Todo card live
        act(() => {
            store.reconcileInput({
                sessionId: 's',
                messages: [
                    user('u1', 1),
                    assistant('a1', 2, [
                        { type: 'thinking', thinking: 'Checking file' },
                        {
                            type: 'tool_use',
                            id: 'tool-todo',
                            name: 'TodoWrite',
                            input: {
                                todos: [
                                    { id: 't1', content: 'Audit canonical thread topology', status: 'in_progress' },
                                ],
                            },
                        },
                    ], true),
                ],
            })
        })
        expect(screen.getByText('Audit canonical thread topology')).toBeInTheDocument()
        expect(listRenders).toBe(initialListRenders)
        // 5. Assistant CLI output in turn 2 streams in place without changing list topology or TurnLayoutSnapshot after first chunk
        const cliMsg = (text: string): DecryptedMessage => ({
            id: 'a-cli',
            seq: 4,
            localId: null,
            createdAt: 4,
            content: {
                role: 'agent',
                content: {
                    type: 'output',
                    data: {
                        type: 'assistant',
                        uuid: 'a-cli',
                        message: {
                            role: 'assistant',
                            content: [{ type: 'text', text: `<local-command-stdout>${text}</local-command-stdout>` }],
                        },
                    },
                },
                meta: { sentFrom: 'cli' },
            },
        })
        await act(async () => {
            store.reconcileInput({
                sessionId: 's',
                messages: [
                    user('u1', 1),
                    assistant('a1', 2, [{ type: 'text', text: 'Done turn 1' }], false),
                    user('u2', 3),
                    cliMsg('On branch main'),
                ],
            })
        })
        expect(screen.getByText(/On branch main/)).toBeInTheDocument()
        const rendersAfterTurn2Added = listRenders
        const cliTurnId = store.getTimelineIndex().at(-1)!.id
        const cliLayoutBefore = store.getTurnLayout(cliTurnId)
        act(() => {
            store.reconcileInput({
                sessionId: 's',
                messages: [
                    user('u1', 1),
                    assistant('a1', 2, [{ type: 'text', text: 'Done turn 1' }], false),
                    user('u2', 3),
                    cliMsg('On branch main\nnothing to commit, working tree clean'),
                ],
            })
        })
        expect(screen.getByText(/nothing to commit, working tree clean/)).toBeInTheDocument()
        expect(store.getTurnLayout(cliTurnId)).toBe(cliLayoutBefore)
        expect(listRenders).toBe(rendersAfterTurn2Added)
        // 6. User CLI output updates in place without re-rendering list after initial insert
        const userCliMsg = (stdout: string): DecryptedMessage => ({
            id: 'u-cli',
            seq: 5,
            localId: 'u-cli',
            createdAt: 5,
            content: {
                role: 'user',
                content: {
                    type: 'text',
                    text: `<command-name>/context</command-name>\n<local-command-stdout>${stdout}</local-command-stdout>`,
                },
                meta: { sentFrom: 'cli' },
            },
        })
        await act(async () => {
            store.reconcileInput({
                sessionId: 's',
                messages: [
                    user('u1', 1),
                    assistant('a1', 2, [{ type: 'text', text: 'Done turn 1' }], false),
                    user('u2', 3),
                    cliMsg('On branch main\nnothing to commit, working tree clean'),
                    userCliMsg('Context usage: 12%'),
                ],
            })
        })
        expect(screen.getByText(/Context usage: 12%/)).toBeInTheDocument()
        const rendersAfterUserCli = listRenders
        act(() => {
            store.reconcileInput({
                sessionId: 's',
                messages: [
                    user('u1', 1),
                    assistant('a1', 2, [{ type: 'text', text: 'Done turn 1' }], false),
                    user('u2', 3),
                    cliMsg('On branch main\nnothing to commit, working tree clean'),
                    userCliMsg('Context usage: 42% (updated)'),
                ],
            })
        })
        expect(screen.getByText(/Context usage: 42% \(updated\)/)).toBeInTheDocument()
        expect(listRenders).toBe(rendersAfterUserCli)
        unsubLayout()
    })
})
