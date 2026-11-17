import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { I18nProvider } from '@/lib/i18n-context'
import { GitChatProvider } from './GitChatContext'
import { GitDraftEditor } from './GitDraftEditor'
import type { GitChatPreparation } from './gitChat'

const preparation: GitChatPreparation = {
    requestId: 'e45b122f-f1c9-4d64-ae3f-f71d721833c2', action: 'commit', repoRoot: '/project', branch: 'feature', head: 'abc',
}
const draft = JSON.stringify({ requestId: preparation.requestId, action: 'commit', paths: ['src/changed.ts'], message: 'Fix parser boundary' })

beforeEach(() => localStorage.setItem('hapi-lang', 'en'))

function renderDraft(send: (text: string) => Promise<boolean> = vi.fn(async () => true), disabled = false, code = draft) {
    const view = (blocked: boolean) => <I18nProvider><GitChatProvider value={{ preparation, disabled: blocked, send }}><GitDraftEditor code={code} /></GitChatProvider></I18nProvider>
    const result = render(view(disabled))
    return { ...result, send, setDisabled: (blocked: boolean) => result.rerender(view(blocked)) }
}

describe('Git conversation review', () => {
    it('requires explicit send, retains edits after rejection, and prevents a duplicate submission while pending', async () => {
        const first = Promise.withResolvers<boolean>()
        const second = Promise.withResolvers<boolean>()
        const send = vi.fn<(_text: string) => Promise<boolean>>().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
        renderDraft(send)
        const editor = screen.getByRole('textbox', { name: 'Review Git instruction' })
        fireEvent.change(editor, { target: { value: 'Commit only src/changed.ts with the reviewed message.' } })
        expect(send).not.toHaveBeenCalled()
        fireEvent.click(screen.getByRole('button', { name: 'Send instruction' }))
        expect(screen.getByRole('button', { name: 'Sending…' })).toBeDisabled()
        expect(send).toHaveBeenCalledTimes(1)
        await act(async () => first.resolve(false))
        expect(screen.getByRole('alert')).toBeVisible()
        expect(editor).toHaveValue('Commit only src/changed.ts with the reviewed message.')
        fireEvent.click(screen.getByRole('button', { name: 'Send instruction' }))
        await act(async () => second.resolve(true))
        expect(send.mock.calls[1]?.[0]).toBe('Commit only src/changed.ts with the reviewed message.')
        expect(screen.queryByRole('textbox')).toBeNull()
        expect(screen.getByRole('status')).toHaveTextContent('Sent to the conversation')
        expect(send).toHaveBeenCalledTimes(2)
    })

    it('retains pending review when the optimistic follow-up invalidates preparation, then permits explicit retry', async () => {
        const first = Promise.withResolvers<boolean>()
        const second = Promise.withResolvers<boolean>()
        const send = vi.fn<(_text: string) => Promise<boolean>>().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
        const view = (current: GitChatPreparation | null) => <I18nProvider><GitChatProvider value={{ preparation: current, disabled: false, send }}><GitDraftEditor key={current ? 'answer' : 'historical-answer'} code={draft} /></GitChatProvider></I18nProvider>
        const result = render(view(preparation))
        fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Edited before the optimistic transition' } })
        const original = 'Edited before the optimistic transition'
        fireEvent.click(screen.getByRole('button', { name: 'Send instruction' }))
        result.rerender(view(null))
        expect(screen.getByRole('textbox')).toHaveValue(original)
        expect(screen.getByRole('textbox')).toHaveAttribute('readonly')
        expect(screen.getByRole('button', { name: 'Sending…' })).toBeDisabled()
        expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
        fireEvent.click(screen.getByRole('button', { name: 'Sending…' }))
        expect(send).toHaveBeenCalledTimes(1)
        await act(async () => first.resolve(false))
        result.rerender(view(preparation))
        expect(screen.getByRole('alert')).toBeVisible()
        expect(screen.getByRole('textbox')).toHaveValue(original)
        fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Reviewed retry instruction' } })
        fireEvent.click(screen.getByRole('button', { name: 'Send instruction' }))
        result.rerender(view(null))
        expect(screen.getByRole('textbox')).toHaveValue('Reviewed retry instruction')
        await act(async () => second.resolve(true))
        expect(screen.getByRole('status')).toHaveTextContent('Sent to the conversation')
        expect(send.mock.calls.map(call => call[0])).toEqual([original, 'Reviewed retry instruction'])
        result.rerender(view(preparation))
        expect(screen.getByRole('status')).toHaveTextContent('Sent to the conversation')
        expect(screen.queryByRole('button', { name: 'Send instruction' })).toBeNull()
    })

    it('does not transfer edits or late send completion to another session', async () => {
        const pending = Promise.withResolvers<boolean>()
        const send = vi.fn(() => pending.promise)
        const view = (sessionId: string) => <I18nProvider><GitChatProvider key={sessionId} value={{ preparation, disabled: false, send }}><GitDraftEditor code={draft} /></GitChatProvider></I18nProvider>
        const result = render(view('first-session'))
        fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Only the first session' } })
        fireEvent.click(screen.getByRole('button', { name: 'Send instruction' }))
        result.rerender(view('second-session'))
        expect(screen.getByRole('textbox')).not.toHaveValue('Only the first session')
        expect(screen.getByRole('button', { name: 'Send instruction' })).toBeEnabled()
        await act(async () => pending.resolve(true))
        expect(screen.queryByRole('status')).toBeNull()
        expect(screen.getByRole('button', { name: 'Send instruction' })).toBeEnabled()
        expect(send).toHaveBeenCalledTimes(1)
    })

    it('allows cancellation without sending and restores the locally edited draft', () => {
        const send = vi.fn(async () => true)
        renderDraft(send)
        fireEvent.change(screen.getByRole('textbox'), { target: { value: 'My edited instruction' } })
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
        expect(screen.queryByRole('textbox')).toBeNull()
        expect(send).not.toHaveBeenCalled()
        fireEvent.click(screen.getByRole('button', { name: 'Edit draft' }))
        expect(screen.getByRole('textbox')).toHaveValue('My edited instruction')
    })

    it('blocks review send until the agent is idle without losing edited content', () => {
        const { setDisabled } = renderDraft(undefined, true)
        expect(screen.getByRole('button', { name: 'Send instruction' })).toBeDisabled()
        setDisabled(false)
        fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Reviewed content' } })
        setDisabled(true)
        expect(screen.getByRole('textbox')).toHaveValue('Reviewed content')
        expect(screen.getByRole('button', { name: 'Send instruction' })).toBeDisabled()
    })

    it.each([
        '{"action":',
        JSON.stringify({ requestId: preparation.requestId, action: 'push', message: 'Wrong action' }),
        JSON.stringify({ requestId: 'f55b122f-f1c9-4d64-ae3f-f71d721833c2', action: 'commit', message: 'Stale request' }),
        JSON.stringify({ requestId: preparation.requestId, action: 'commit', message: 'Unexpected command', command: 'git add -A' }),
    ])('renders invalid or mismatched results without an executable review: %s', code => {
        const { send } = renderDraft(undefined, false, code)
        expect(screen.queryByRole('textbox')).toBeNull()
        expect(screen.queryByRole('button', { name: 'Send instruction' })).toBeNull()
        expect(send).not.toHaveBeenCalled()
    })
})
