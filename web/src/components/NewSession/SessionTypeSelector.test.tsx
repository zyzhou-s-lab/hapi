import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { SessionTypeSelector } from './SessionTypeSelector'

vi.mock('@/lib/use-translation', () => ({
    useTranslation: () => ({ t: (key: string) => key })
}))

describe('SessionTypeSelector', () => {
    it('shows the prefilled worktree name and start ref and reports edits', () => {
        const onWorktreeNameChange = vi.fn()
        const onWorktreeStartRefChange = vi.fn()

        render(
            <SessionTypeSelector
                sessionType="worktree"
                worktreeName="feature-x"
                worktreeStartRef="origin/main"
                worktreeInputRef={{ current: null }}
                isDisabled={false}
                onSessionTypeChange={() => {}}
                onWorktreeNameChange={onWorktreeNameChange}
                onWorktreeStartRefChange={onWorktreeStartRefChange}
            />
        )

        expect(screen.getByDisplayValue('feature-x')).toBeInTheDocument()
        expect(screen.getByTestId('worktree-start-ref')).toHaveValue('origin/main')

        fireEvent.change(screen.getByTestId('worktree-start-ref'), {
            target: { value: 'v1.2.3' }
        })
        expect(onWorktreeStartRefChange).toHaveBeenCalledWith('v1.2.3')
    })
})
