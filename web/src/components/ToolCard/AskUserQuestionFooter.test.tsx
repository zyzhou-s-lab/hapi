import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import type { ChatToolCall } from '@/chat/types'

vi.mock('@/hooks/usePlatform', () => ({
    usePlatform: () => ({ haptic: { notification: vi.fn(), selection: vi.fn() } })
}))
vi.mock('@/lib/use-translation', () => ({
    useTranslation: () => ({ t: (key: string) => key })
}))

import { AskUserQuestionFooter, computeAnswersForQuestion } from './AskUserQuestionFooter'

function makeTool(id: string, allowFreeText?: boolean, status: 'pending' | 'denied' = 'pending'): ChatToolCall {
    return {
        id,
        name: 'AskUserQuestion',
        state: 'pending',
        input: {
            questions: [{
                question: 'Pick one',
                options: [
                    { label: 'Alpha', description: null },
                    { label: 'Beta', description: null },
                ],
                multiSelect: false,
                ...(allowFreeText === undefined ? {} : { allowFreeText }),
            }],
        },
        createdAt: 1,
        startedAt: null,
        completedAt: null,
        execStartedAt: null,
        execCompletedAt: null,
        description: null,
        permission: { id: 'permission-1', status },
    } as unknown as ChatToolCall
}

function renderFooter(
    sessionId: string,
    tool: ChatToolCall,
    approvePermission = vi.fn().mockResolvedValue(undefined),
    denyPermission = vi.fn().mockResolvedValue(undefined)
) {
    return {
        ...render(
            <AskUserQuestionFooter
                api={{ approvePermission, denyPermission } as unknown as ApiClient}
                sessionId={sessionId}
                tool={tool}
                disabled={false}
                onDone={vi.fn()}
            />
        ),
        approvePermission,
        denyPermission,
    }
}

describe('AskUserQuestionFooter question controls', () => {
    it('denies the question once on Skip', async () => {
        const { approvePermission, denyPermission } = renderFooter('session-A', makeTool('tool-1'))

        fireEvent.click(screen.getByRole('radio', { name: /Alpha/ }))
        fireEvent.click(screen.getByRole('button', { name: 'tool.skip' }))

        await vi.waitFor(() => expect(denyPermission).toHaveBeenCalledTimes(1))
        expect(denyPermission).toHaveBeenCalledWith('session-A', 'permission-1')
        expect(approvePermission).not.toHaveBeenCalled()
    })

    it('skips on Escape from inside the card', async () => {
        const { denyPermission } = renderFooter('session-A', makeTool('tool-1'))

        fireEvent.keyDown(screen.getByRole('radio', { name: /Alpha/ }), { key: 'Escape' })

        await vi.waitFor(() => expect(denyPermission).toHaveBeenCalledTimes(1))
        expect(denyPermission).toHaveBeenCalledWith('session-A', 'permission-1')
    })

    it('only leaves the Other field on Escape, keeping the typed text', async () => {
        const { denyPermission } = renderFooter('session-A', makeTool('tool-1'))

        fireEvent.click(screen.getByRole('radio', { name: /tool\.other/ }))
        const field = screen.getByPlaceholderText('tool.askUserQuestion.otherPlaceholder') as HTMLTextAreaElement
        field.focus()
        fireEvent.change(field, { target: { value: 'my answer' } })
        fireEvent.keyDown(field, { key: 'Escape' })

        await new Promise((resolve) => setTimeout(resolve, 50))
        expect(denyPermission).not.toHaveBeenCalled()
        expect(field.value).toBe('my answer')
        expect(document.activeElement).not.toBe(field)
    })

    it('hides Other when the question does not allow free text, and submits an option as accept', async () => {
        const { approvePermission } = renderFooter('session-A', makeTool('tool-1', false))

        expect(screen.queryByRole('radio', { name: /tool\.other/ })).toBeNull()
        fireEvent.click(screen.getByRole('radio', { name: /Beta/ }))
        fireEvent.click(screen.getByRole('button', { name: 'tool.submit' }))

        await vi.waitFor(() =>
            expect(approvePermission).toHaveBeenCalledWith('session-A', 'permission-1', { answers: { '0': ['Beta'] } })
        )
    })

    it('still shows Other when free text is allowed or the flag is absent', () => {
        const allowed = renderFooter('session-A', makeTool('tool-1', true))
        expect(screen.getByRole('radio', { name: /tool\.other/ })).toBeTruthy()
        allowed.unmount()

        renderFooter('session-B', makeTool('tool-2'))
        expect(screen.getByRole('radio', { name: /tool\.other/ })).toBeTruthy()
    })

    it('is not shown once the question is no longer pending', () => {
        renderFooter('session-A', makeTool('tool-1', undefined, 'denied'))
        expect(screen.queryByRole('button', { name: 'tool.skip' })).toBeNull()
    })

    it('drops Other free text in computeAnswersForQuestion when allowFreeText is false', () => {
        const question = {
            header: null,
            question: 'Pick one',
            options: [{ label: 'Alpha', description: null }],
            multiSelect: false,
            allowFreeText: false
        }
        expect(computeAnswersForQuestion(question, [], true, 'injected', false)).toEqual([])
        expect(computeAnswersForQuestion(question, [0], true, 'injected', false)).toEqual(['Alpha'])
        expect(computeAnswersForQuestion({ ...question, allowFreeText: true }, [], true, 'allowed', false)).toEqual(['allowed'])
    })
})
