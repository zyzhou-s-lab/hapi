import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('@/lib/use-translation', () => ({
    useTranslation: () => ({ t: (key: string) => key }),
}))

import { AgyModelSelector } from './AgyModelSelector'

describe('AgyModelSelector', () => {
    it('keeps an unlisted selected model visible and labeled in the picker', () => {
        const { container } = render(
            <AgyModelSelector
                machineId="machine-1"
                isLoading={false}
                error={null}
                availableModels={[
                    { modelId: 'gemini-4-argon-medium', name: 'Gemini 4 Argon (Medium)' },
                ]}
                selectedModel="claude-sonnet-4-6"
                onModelChange={vi.fn()}
            />
        )

        const select = screen.getByTestId('agy-model-list') as HTMLSelectElement
        expect(select.value).toBe('claude-sonnet-4-6')
        const options = Array.from(container.querySelectorAll('option')).map((opt) => ({
            value: opt.value,
            label: opt.textContent,
        }))
        expect(options).toEqual([
            { value: '', label: 'newSession.model.default' },
            { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (Thinking) (newSession.agyModel.notListed)' },
            { value: 'gemini-4-argon-medium', label: 'Gemini 4 Argon (Medium)' },
        ])
    })

    it('falls back to raw modelId when an unlisted selected model has no known label', () => {
        const { container } = render(
            <AgyModelSelector
                machineId="machine-1"
                isLoading={false}
                error={null}
                availableModels={[]}
                selectedModel="custom-agy-model"
                onModelChange={vi.fn()}
            />
        )

        expect(Array.from(container.querySelectorAll('option')).map((opt) => opt.textContent)).toEqual([
            'newSession.model.default',
            'custom-agy-model (newSession.agyModel.notListed)',
        ])
    })

    it('renders the empty message when no models exist and nothing is selected', () => {
        render(
            <AgyModelSelector
                machineId="machine-1"
                isLoading={false}
                error={null}
                availableModels={[]}
                selectedModel={null}
                onModelChange={vi.fn()}
            />
        )

        expect(screen.queryByTestId('agy-model-list')).toBeNull()
        expect(screen.getByText('newSession.agyModel.noModels')).toBeTruthy()
    })
})
