import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import {
    __resetEmittedSystemEventToastKeysForTests,
    HappySystemMessage,
} from '@/components/AssistantChat/messages/SystemMessage'
import { ToastContainer } from '@/components/ToastContainer'
import { ToastProvider } from '@/lib/toast-context'
import { SessionEntityStoreProvider } from '@/hooks/useSessionEntityStore'
import { createSessionEntityStore } from '@/chat/store/sessionEntityStore'
import type { DecryptedMessage } from '@/types/api'

vi.mock('@tanstack/react-router', () => ({
    useNavigate: () => vi.fn(),
}))

function makeEventMessage(id: string, seq: number, content: unknown, createdAt = Date.now()): DecryptedMessage {
    return {
        id,
        seq,
        localId: null,
        createdAt,
        content,
    }
}

describe('HappySystemMessage coss UI floating Toast behavior', () => {
    beforeEach(() => {
        __resetEmittedSystemEventToastKeysForTests()
    })

    it('pops omp-notice mounted tools event as a floating coss UI Toast instead of inline in chat', () => {
        const store = createSessionEntityStore()
        store.reconcileInput({
            sessionId: 's1',
            messages: [
                makeEventMessage('m1', 1, {
                    role: 'agent',
                    content: {
                        type: 'event',
                        data: {
                            type: 'omp-notice',
                            level: 'info',
                            message: 'xd://: mounted change_title, codex_generate_image, install_pi_package, search_pi_packages, slash_command (5 tools)',
                        },
                    },
                }),
            ],
        })

        const entry = store.getTimelineIndex()[0]!
        render(
            <ToastProvider>
                <SessionEntityStoreProvider store={store}>
                    <div data-testid="chat-timeline">
                        <HappySystemMessage messageId={entry.id} />
                    </div>
                </SessionEntityStoreProvider>
                <ToastContainer />
            </ToastProvider>
        )

        expect(screen.getByTestId('chat-timeline')).toBeEmptyDOMElement()

        const popup = screen.getByText('xd://').closest('[data-slot="toast-popup"]')
        expect(popup).toHaveTextContent('xd://')
        expect(popup).toHaveTextContent(
            'mounted change_title, codex_generate_image, install_pi_package, search_pi_packages, slash_command (5 tools)'
        )
    })

    it('pops live title-changed event as a floating coss UI Toast and suppresses stale historical replay toasts', () => {
        const store = createSessionEntityStore()
        store.reconcileInput({
            sessionId: 's1',
            messages: [
                makeEventMessage(
                    'm-old',
                    1,
                    {
                        role: 'agent',
                        content: {
                            type: 'event',
                            data: {
                                type: 'title-changed',
                                title: '历史旧标题',
                            },
                        },
                    },
                    1_000
                ),
                makeEventMessage(
                    'm-live',
                    2,
                    {
                        role: 'agent',
                        content: {
                            type: 'event',
                            data: {
                                type: 'title-changed',
                                title: '扫描整理 database_workshop 仓库',
                            },
                        },
                    },
                    Date.now()
                ),
            ],
        })

        const entries = store.getTimelineIndex()
        render(
            <ToastProvider>
                <SessionEntityStoreProvider store={store}>
                    <div data-testid="chat-timeline">
                        {entries.map((entry) => (
                            <HappySystemMessage key={entry.id} messageId={entry.id} />
                        ))}
                    </div>
                </SessionEntityStoreProvider>
                <ToastContainer />
            </ToastProvider>
        )

        expect(screen.getByTestId('chat-timeline')).toBeEmptyDOMElement()

        const popups = document.querySelectorAll('[data-slot="toast-popup"]')
        expect(popups).toHaveLength(1)
        expect(popups[0]).toHaveTextContent('Title changed')
        expect(popups[0]).toHaveTextContent('扫描整理 database_workshop 仓库')
    })
})
