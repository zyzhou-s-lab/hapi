import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { DecryptedMessage } from '@/types/api'
import type * as MessageWindowStore from '@/lib/message-window-store'
import { useMessageWindowControls, useMessages } from './useMessages'

type Listener = () => void

const mockStore = vi.hoisted(() => {
    const states = new Map<
        string,
        {
            sessionId: string
            messages: DecryptedMessage[]
            hasMore: boolean
            oldestSeq: number | null
            newestSeq: number | null
            epoch: number | null
            isSyncingTail: boolean
            isLoadingMore: boolean
            warning: string | null
            viewMode: 'tail' | 'history'
            messagesVersion: number
            historyVersion: number
            tailRevision: number
        }
    >()
    const listeners = new Map<string, Set<Listener>>()

    function ensureState(sessionId: string) {
        let current = states.get(sessionId)
        if (!current) {
            current = {
                sessionId,
                messages: [],
                hasMore: false,
                oldestSeq: null,
                newestSeq: null,
                epoch: null,
                isSyncingTail: false,
                isLoadingMore: false,
                warning: null,
                viewMode: 'tail',
                messagesVersion: 0,
                historyVersion: 0,
                tailRevision: 0,
            }
            states.set(sessionId, current)
        }
        return current
    }

    function emit(sessionId: string) {
        const set = listeners.get(sessionId)
        if (!set) return
        for (const listener of set) {
            listener()
        }
    }

    return {
        states,
        listeners,
        ensureState,
        emit,
        activateMessageWindow: vi.fn((sessionId: string) => {
            ensureState(sessionId)
        }),
        syncTailMessages: vi.fn(async () => {}),
        fetchOlderMessages: vi.fn(async () => ({ kind: 'loaded' as const, loadedCount: 1 })),
        cancelOlderMessageLoad: vi.fn(),
        setMessageViewMode: vi.fn((sessionId: string, mode: 'tail' | 'history') => {
            const current = ensureState(sessionId)
            states.set(sessionId, { ...current, viewMode: mode })
            emit(sessionId)
        }),
        getMessageWindowState: vi.fn((sessionId: string) => ensureState(sessionId)),
        subscribeMessageWindow: vi.fn((sessionId: string, listener: Listener) => {
            let set = listeners.get(sessionId)
            if (!set) {
                set = new Set()
                listeners.set(sessionId, set)
            }
            set.add(listener)
            return () => {
                set?.delete(listener)
            }
        }),
    }
})

vi.mock('@/lib/message-window-store', async (importOriginal) => ({
    ...(await importOriginal<typeof MessageWindowStore>()),
    activateMessageWindow: mockStore.activateMessageWindow,
    cancelOlderMessageLoad: mockStore.cancelOlderMessageLoad,
    fetchOlderMessages: mockStore.fetchOlderMessages,
    getMessageWindowState: mockStore.getMessageWindowState,
    setMessageViewMode: mockStore.setMessageViewMode,
    subscribeMessageWindow: mockStore.subscribeMessageWindow,
    syncTailMessages: mockStore.syncTailMessages,
}))

function makeMessage(id: string, text: string): DecryptedMessage {
    return {
        id,
        seq: 1,
        localId: null,
        content: { role: 'assistant', content: text },
        createdAt: 1_000,
    }
}

describe('useMessageWindowControls', () => {
    beforeEach(() => {
        mockStore.states.clear()
        mockStore.listeners.clear()
        vi.clearAllMocks()
    })

    it('shares hydration lifecycle with useMessages, exposes hasMessages and controls without messages/messagesVersion, and ignores streaming message array/version updates', () => {
        const api = {} as unknown as ApiClient
        mockStore.ensureState('sess-stream')

        let controlsRenders = 0
        let fullMessagesRenders = 0

        const controlsHook = renderHook(() => {
            controlsRenders += 1
            return useMessageWindowControls(api, 'sess-stream')
        })
        const fullHook = renderHook(() => {
            fullMessagesRenders += 1
            return useMessages(api, 'sess-stream')
        })

        expect(mockStore.activateMessageWindow).toHaveBeenCalledWith('sess-stream')
        expect(mockStore.syncTailMessages).toHaveBeenCalledWith(api, 'sess-stream')
        expect(controlsRenders).toBe(1)
        expect(fullMessagesRenders).toBe(1)
        expect(controlsHook.result.current.hasMessages).toBe(false)
        expect('messages' in controlsHook.result.current).toBe(false)
        expect('messagesVersion' in controlsHook.result.current).toBe(false)

        // First message arrives: hasMessages transitions false -> true, notifying both hooks
        act(() => {
            const current = mockStore.ensureState('sess-stream')
            mockStore.states.set('sess-stream', {
                ...current,
                messages: [makeMessage('m-1', 'Hello')],
                messagesVersion: 1,
                tailRevision: 1,
            })
            mockStore.emit('sess-stream')
        })

        expect(controlsHook.result.current.hasMessages).toBe(true)
        expect(controlsRenders).toBe(2)
        expect(fullMessagesRenders).toBe(2)

        // Streaming token delta updates messages array, messagesVersion, and tailRevision while hasMessages remains true
        act(() => {
            const current = mockStore.ensureState('sess-stream')
            mockStore.states.set('sess-stream', {
                ...current,
                messages: [makeMessage('m-1', 'Hello world'), makeMessage('m-2', 'Second chunk')],
                messagesVersion: 2,
                tailRevision: 2,
            })
            mockStore.emit('sess-stream')
        })

        expect(fullHook.result.current.messages).toHaveLength(2)
        expect(fullHook.result.current.messagesVersion).toBe(2)
        expect(fullHook.result.current.tailRevision).toBe(2)
        expect(fullMessagesRenders).toBe(3)
        // Decisive check: useMessageWindowControls did NOT re-render on streaming token/message/tailRevision updates
        expect(controlsRenders).toBe(2)
        expect('tailRevision' in controlsHook.result.current).toBe(false)

        // Control flag change (hasMore + warning) notifies useMessageWindowControls
        act(() => {
            const current = mockStore.ensureState('sess-stream')
            mockStore.states.set('sess-stream', {
                ...current,
                hasMore: true,
                warning: 'Partial history',
            })
            mockStore.emit('sess-stream')
        })

        expect(controlsHook.result.current.hasMore).toBe(true)
        expect(controlsHook.result.current.warning).toBe('Partial history')
        expect(controlsRenders).toBe(3)
    })
})
