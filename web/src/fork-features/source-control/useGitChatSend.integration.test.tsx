import type { ReactNode } from 'react'
import { act, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import { useSessionComposerSendBridge } from '@/components/AssistantChat/composer/useSessionComposerSendBridge'
import type { ComposerSendError } from '@/components/AssistantChat/composer/types'
import type { SendMessageSettlement } from '@/hooks/mutations/useSendMessage'
import { I18nProvider } from '@/lib/i18n-context'
import { ToastProvider } from '@/lib/toast-context'
import type { Session } from '@/types/api'
import { useGitChatSend } from './useGitChatSend'

it('keeps the main composer schedule, attachment order and send intent through Git failure and retry', async () => {
    const session: Session = {
        id: 'git-composer-isolation', namespace: 'default', seq: 1, createdAt: 1, updatedAt: 1,
        active: true, activeAt: 1, metadata: { path: '/project', host: 'fixture', flavor: 'claude' },
        metadataVersion: 1, agentState: {}, agentStateVersion: 1, thinking: false, thinkingAt: 0,
        model: null, modelReasoningEffort: null, effort: null, serviceTier: null, resumeWithSessionModel: false,
    }
    const api = { getScratchlist: async () => ({ entries: [] }) } as unknown as ApiClient
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    let attempt = 0
    const onSend = vi.fn(async () => ({ attemptId: `attempt-${++attempt}` }))
    const initialProps: { sendSettlement: SendMessageSettlement | null; sendError: ComposerSendError | null } = {
        sendSettlement: null, sendError: null,
    }
    const { result, rerender, unmount } = renderHook(props => {
        const git = useGitChatSend({ sessionId: session.id, disabled: false, onSend, onDelivered: () => {}, ...props })
        const composer = useSessionComposerSendBridge({
            api, session, inactiveCanResume: false, onSend, sendError: git.composerSendError,
        })
        return { git, composer }
    }, {
        initialProps,
        wrapper: ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}><I18nProvider><ToastProvider>{children}</ToastProvider></I18nProvider></QueryClientProvider>,
    })
    const schedule = { type: 'absolute' as const, ms: Date.now() + 3_600_000 }
    act(() => {
        result.current.composer.updatePendingSchedule(schedule)
        result.current.composer.attachmentOrderRef.current = ['my-upload']
        result.current.composer.pendingSendIntentRef.current = 'default'
    })
    let delivery!: Promise<boolean>
    await act(async () => { delivery = result.current.git.send('Reviewed Git instruction') })
    await act(async () => rerender({
        sendSettlement: { attemptId: 'attempt-1', status: 'error' },
        sendError: { id: 1, text: 'Reviewed Git instruction', message: 'Disconnected', scheduledAt: null, mutationStarted: true, restoreSuppressed: false, deliveryMode: 'queue' },
    }))
    expect(await delivery).toBe(false)
    expect(result.current.composer.pendingSchedule).toEqual(schedule)
    expect(result.current.composer.attachmentOrderRef.current).toEqual(['my-upload'])
    expect(result.current.composer.pendingSendIntentRef.current).toBe('default')
    expect(result.current.composer.sendAcceptance).toBeNull()

    await act(async () => { delivery = result.current.git.send('Edited Git retry') })
    await act(async () => rerender({ sendError: null, sendSettlement: { attemptId: 'attempt-2', status: 'success' } }))
    expect(await delivery).toBe(true)
    expect(result.current.composer.pendingSchedule).toEqual(schedule)
    expect(result.current.composer.attachmentOrderRef.current).toEqual(['my-upload'])
    expect(result.current.composer.pendingSendIntentRef.current).toBe('default')
    expect(result.current.composer.sendAcceptance).toBeNull()

    await act(async () => result.current.composer.handleSend('My original composer message', undefined, schedule.ms))
    expect(result.current.composer.pendingSchedule).toBeNull()
    expect(result.current.composer.sendAcceptance).toEqual({ attemptId: 'attempt-3' })
    unmount()
    queryClient.clear()
})
