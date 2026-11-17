import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ComposerSendError } from '@/components/AssistantChat/composer/types'
import type { SendMessageSettlement } from '@/hooks/mutations/useSendMessage'
import { useGitChatSend } from './useGitChatSend'

function harness() {
    let attempt = 0
    const onSend = vi.fn(async () => ({ attemptId: `attempt-${++attempt}` }))
    const onDelivered = vi.fn()
    const initialProps: { sendSettlement: SendMessageSettlement | null; sendError: ComposerSendError | null; disabled: boolean } = {
        sendSettlement: null, sendError: null, disabled: false,
    }
    const hook = renderHook(props => useGitChatSend({ sessionId: 'git-chat', onSend, onDelivered, ...props }), { initialProps })
    return { ...hook, onSend, onDelivered, initialProps }
}

function failedMessage(text: string): ComposerSendError {
    return { id: 1, text, message: 'Disconnected', scheduledAt: null, mutationStarted: true, restoreSuppressed: false }
}

describe('Git chat delivery', () => {
    it('waits for its own HTTP settlement, not optimistic acceptance or another send, and blocks concurrent submissions', async () => {
        const { result, rerender, initialProps, onDelivered } = harness()
        let delivery!: Promise<boolean>
        let delivered: boolean | undefined
        await act(async () => { delivery = result.current.send('Reviewed Git instruction').then(value => { delivered = value; return value }) })
        expect(delivered).toBeUndefined()
        expect(onDelivered).not.toHaveBeenCalled()
        expect(await result.current.send('Duplicate')).toBe(false)
        rerender({ ...initialProps, sendSettlement: { attemptId: 'other', status: 'success' } })
        expect(delivered).toBeUndefined()
        await act(async () => { rerender({ ...initialProps, sendSettlement: { attemptId: 'attempt-1', status: 'success' } }) })
        expect(await delivery).toBe(true)
        expect(onDelivered).toHaveBeenCalledTimes(1)
    })

    it('returns delivery failure to the inline editor, suppresses composer recovery only for Git text, and allows retry', async () => {
        const { result, rerender, initialProps, onDelivered } = harness()
        let delivery!: Promise<boolean>
        await act(async () => { delivery = result.current.send('Reviewed Git instruction') })
        await act(async () => {
            rerender({ ...initialProps, sendSettlement: { attemptId: 'attempt-1', status: 'error' }, sendError: failedMessage('Reviewed Git instruction') })
        })
        expect(await delivery).toBe(false)
        expect(result.current.composerSendError).toBeNull()
        expect(onDelivered).not.toHaveBeenCalled()
        const ordinaryError = failedMessage('My unrelated composer draft')
        rerender({ ...initialProps, sendError: ordinaryError })
        expect(result.current.composerSendError).toBe(ordinaryError)
        await act(async () => { delivery = result.current.send('Edited retry') })
        await act(async () => { rerender({ ...initialProps, sendSettlement: { attemptId: 'attempt-2', status: 'success' } }) })
        expect(await delivery).toBe(true)
    })

    it('handles settlement arriving before the acceptance promise resolves', async () => {
        const acceptance = Promise.withResolvers<{ attemptId: string }>()
        const onDelivered = vi.fn()
        const onSend = vi.fn(() => acceptance.promise)
        const initialProps: { sendSettlement: SendMessageSettlement | null } = { sendSettlement: null }
        const { result, rerender } = renderHook(props => useGitChatSend({ sessionId: 'git-chat', disabled: false, onSend, onDelivered, ...props }), { initialProps })
        let delivery!: Promise<boolean>
        act(() => { delivery = result.current.send('Git review') })
        rerender({ sendSettlement: { attemptId: 'fast', status: 'error' } })
        await act(async () => { acceptance.resolve({ attemptId: 'fast' }) })
        expect(await delivery).toBe(false)
        expect(onDelivered).not.toHaveBeenCalled()
    })

    it('rejects a busy send and releases an in-flight editor when the session unmounts', async () => {
        const { result, rerender, initialProps, unmount, onDelivered } = harness()
        rerender({ ...initialProps, disabled: true })
        expect(await result.current.send('Busy')).toBe(false)
        rerender(initialProps)
        let delivery!: Promise<boolean>
        await act(async () => { delivery = result.current.send('Waiting for HTTP') })
        unmount()
        expect(await delivery).toBe(false)
        expect(onDelivered).not.toHaveBeenCalled()
    })
})
