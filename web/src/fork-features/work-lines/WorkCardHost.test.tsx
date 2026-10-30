import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import { AppContextProvider } from '@/lib/app-context'
import { I18nProvider } from '@/lib/i18n-context'
import type { SessionSummary } from '@/types/api'
import { registerWorkCards, WorkCardHost } from './WorkCardHost'
import './cards'

const map = {
    lines: [],
    directories: [],
    sessions: [],
    dismissed: [],
}

function session(active: boolean): SessionSummary {
    return {
        id: 's1',
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active,
        activeAt: 1,
        metadata: { path: '/repo', machineId: 'gpu' },
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 1,
        pendingRequestsCount: 0,
    } as unknown as SessionSummary
}

function host(sessions: SessionSummary[], api: ApiClient): ReactNode {
    return (
        <WorkCardHost
            surface="overview"
            view={{ kind: 'overview' }}
            sessions={sessions}
            api={api}
            layoutFor={() => ({
                revision: 1,
                regions: {
                    stats: [{ cardId: 'overview.running-count' }, { cardId: 'test.boom' }],
                    body: [{ cardId: 'test.query' }],
                },
            })}
        />
    )
}

describe('WorkCardHost', () => {
    afterEach(() => cleanup())

    it('updates a stat from the session list without fetching the map again, and isolates a broken card', async () => {
        const getWorkMap = vi.fn(async () => map)
        const api = {
            getWorkMap,
            getWorkLayout: async () => ({ source: 'default', layout: null }),
        } as unknown as ApiClient
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        const wrap = (sessions: SessionSummary[]) => (
            <AppContextProvider value={{ api, token: 't', baseUrl: 'http://hub', user: { id: 7 } }}>
                <QueryClientProvider client={client}>
                    <I18nProvider>
                        {host(sessions, api)}
                    </I18nProvider>
                </QueryClientProvider>
            </AppContextProvider>
        )
        registerWorkCards([
            {
                id: 'test.boom',
                titleKey: 'work.lineCount',
                size: 'stat',
                source: { kind: 'work-model' },
                Component: () => { throw new Error('boom') },
            },
            {
                id: 'test.query',
                titleKey: 'work.retry',
                size: 'full',
                source: {
                    kind: 'query',
                    queryKey: ['test', 'broken-query'],
                    queryFn: async () => { throw new Error('query broke') },
                },
                Component: () => <span>query-body</span>,
            },
        ])
        const error = vi.spyOn(console, 'error').mockImplementation(() => {})
        const { rerender } = render(wrap([session(false)]))
        await waitFor(() => expect(screen.getByText('0')).toBeTruthy())
        expect(screen.getByText('This card failed.')).toBeTruthy()
        expect(screen.queryByText(/boom/)).toBeNull()
        expect(screen.queryByText('test.boom')).toBeNull()
        await waitFor(() => expect(screen.getByText('query broke')).toBeTruthy())
        expect(screen.queryByText('query-body')).toBeNull()

        rerender(wrap([session(true)]))
        await waitFor(() => expect(screen.getByText('1')).toBeTruthy())
        expect(getWorkMap).toHaveBeenCalledTimes(1)
        expect(screen.getByText('This card failed.')).toBeTruthy()
        error.mockRestore()
    })

    it('renders card hooks after the map query recovers', async () => {
        let fail = true
        const getWorkMap = vi.fn(async () => {
            if (fail) throw new Error('map down')
            return map
        })
        const api = {
            getWorkMap,
            getWorkLayout: async () => ({ source: 'default', layout: null }),
        } as unknown as ApiClient
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        const error = vi.spyOn(console, 'error').mockImplementation(() => {})
        render(
            <AppContextProvider value={{ api, token: 't', baseUrl: 'http://hub', user: { id: 7 } }}>
                <QueryClientProvider client={client}>
                    <I18nProvider>
                        <WorkCardHost
                            surface="overview"
                            view={{ kind: 'overview' }}
                            sessions={[session(false)]}
                            api={api}
                            layoutFor={() => ({ revision: 1, regions: { stats: [{ cardId: 'overview.running-count' }] } })}
                        />
                    </I18nProvider>
                </QueryClientProvider>
            </AppContextProvider>,
        )
        await waitFor(() => expect(screen.getByText('map down')).toBeTruthy())
        fail = false
        screen.getByText('Retry').click()
        await waitFor(() => expect(screen.getByText('0')).toBeTruthy())
        expect(error.mock.calls.some((call) => String(call[0]).includes('Rendered more hooks'))).toBe(false)
        error.mockRestore()
    })
})
