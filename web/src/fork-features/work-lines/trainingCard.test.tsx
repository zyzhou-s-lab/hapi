import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import { AppContextProvider } from '@/lib/app-context'
import { I18nProvider } from '@/lib/i18n-context'
import { WorkCardHost } from './WorkCardHost'
import { TrainingCurvesBody } from './trainingCard'
import type { TrainingSocketState } from '@/hooks/useTrainingSocket'
import './trainingCard'

vi.mock('./charts/TrainingChart', () => ({
    TrainingChart: () => <div>uplot-chart</div>,
}))

vi.mock('@/hooks/useTrainingSocket', () => ({
    useTrainingSocket: () => ({ status: 'live', message: null, finished: false, series: [] }),
    trainingMessageKey: (raw: string | null) => raw === 'wandb is not available' ? 'work.trainingNoWandb' : 'work.trainingUnavailable',
}))

const empty: TrainingSocketState = { status: 'live', message: null, finished: false, series: [] }

function host(lineId: string, api: ApiClient) {
    return render(
        <AppContextProvider value={{ api, token: 't', baseUrl: 'http://hub', user: { id: 7 } }}>
            <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
                <I18nProvider>
                    <WorkCardHost
                        surface="workbench"
                        view={{ kind: 'line', lineId }}
                        sessions={[]}
                        api={api}
                        layoutFor={() => ({
                            revision: 2,
                            regions: { main: [{ cardId: 'example.training-curves', args: { run: 'exp-1', lineId: 'line-1' } }] },
                        })}
                    />
                </I18nProvider>
            </QueryClientProvider>
        </AppContextProvider>,
    )
}

describe('training curve card', () => {
    it('does not load the chart when there are no points', () => {
        render(<I18nProvider><TrainingCurvesBody state={empty} /></I18nProvider>)
        expect(screen.getByText('No points yet.')).toBeTruthy()
        expect(screen.queryByText('uplot-chart')).toBeNull()
    })

    it('shows a translation instead of the raw runner error', () => {
        render(
            <I18nProvider>
                <TrainingCurvesBody state={{ ...empty, status: 'reconnecting', message: 'wandb is not available' }} />
            </I18nProvider>,
        )
        expect(screen.getByText('This machine cannot read wandb.')).toBeTruthy()
        expect(screen.getByText('Reconnecting…')).toBeTruthy()
        expect(screen.queryByText('wandb is not available')).toBeNull()
    })

    it('loads the chart once points exist', async () => {
        render(
            <I18nProvider>
                <TrainingCurvesBody state={{ ...empty, series: [{ id: 'loss', name: 'loss', points: [{ step: 1, value: 0.2 }] }] }} />
            </I18nProvider>,
        )
        expect(await screen.findByText('uplot-chart')).toBeTruthy()
    })

    it('shows the curve only on the bound line', () => {
        const api = {
            getWorkMap: async () => ({ lines: [], directories: [], sessions: [], dismissed: [] }),
            getWorkLayout: async () => ({ source: 'default', layout: null }),
        } as unknown as ApiClient
        const other = host('other', api)
        expect(screen.getByText('Not bound yet.')).toBeTruthy()
        expect(screen.queryByText('No points yet.')).toBeNull()
        other.unmount()
        host('line-1', api)
        expect(screen.getByText('No points yet.')).toBeTruthy()
        expect(screen.queryByRole('combobox')).toBeNull()
        expect(screen.queryByText('Show on this line')).toBeNull()
    })

    it('says the card is not bound when the slot has no run', () => {
        const api = {
            getWorkMap: async () => ({ lines: [], directories: [], sessions: [], dismissed: [] }),
            getWorkLayout: async () => ({ source: 'default', layout: null }),
        } as unknown as ApiClient
        render(
            <AppContextProvider value={{ api, token: 't', baseUrl: 'http://hub', user: { id: 7 } }}>
                <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
                    <I18nProvider>
                        <WorkCardHost
                            surface="workbench"
                            view={{ kind: 'line', lineId: 'line-1' }}
                            sessions={[]}
                            api={api}
                            layoutFor={() => ({
                                revision: 2,
                                regions: { main: [{ cardId: 'example.training-curves', args: { lineId: 'line-1' } }] },
                            })}
                        />
                    </I18nProvider>
                </QueryClientProvider>
            </AppContextProvider>,
        )
        expect(screen.getByText('Not bound yet.')).toBeTruthy()
        expect(screen.queryByText('uplot-chart')).toBeNull()
        expect(screen.queryByRole('combobox')).toBeNull()
    })
})
