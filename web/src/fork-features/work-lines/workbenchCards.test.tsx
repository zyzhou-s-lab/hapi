import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import { AppContextProvider } from '@/lib/app-context'
import { I18nProvider } from '@/lib/i18n-context'
import { Workbench } from './Workbench'
import { WorkCardHost } from './WorkCardHost'
import './workbenchCards'

vi.mock('@tanstack/react-router', () => ({
    useNavigate: () => vi.fn(),
}))

const emptyMap = { lines: [], directories: [], sessions: [], dismissed: [] }

describe('workbench create line', () => {
    it('shows a translated failure and hides the server message', async () => {
        const raw = '目录已属于别的主线'
        const api = {
            getWorkMap: vi.fn(async () => emptyMap),
            getWorkLayout: async () => ({ source: 'default', layout: null }),
            getMachines: async () => ({ machines: [{ id: 'gpu', metadata: { displayName: 'GPU' } }] }),
            createWorkLine: vi.fn(async () => { throw new Error(raw) }),
        } as unknown as ApiClient
        const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
        render(
            <AppContextProvider value={{ api, token: 't', baseUrl: 'http://hub', user: { id: 7 } }}>
                <QueryClientProvider client={client}>
                    <I18nProvider>
                        <WorkCardHost
                            surface="workbench"
                            view={{ kind: 'line', lineId: '' }}
                            sessions={[]}
                            api={api}
                            layoutFor={() => ({ revision: 1, regions: { rail: [{ cardId: 'workbench.line-list' }] } })}
                        />
                    </I18nProvider>
                </QueryClientProvider>
            </AppContextProvider>,
        )
        await waitFor(() => expect(screen.getByPlaceholderText('Name')).toBeTruthy())
        fireEvent.change(screen.getByPlaceholderText('Name'), { target: { value: '主线' } })
        fireEvent.change(screen.getByPlaceholderText('Primary directory'), { target: { value: '/repo' } })
        fireEvent.change(screen.getByRole('combobox'), { target: { value: 'gpu' } })
        const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
        fireEvent.click(screen.getByText('Create line'))
        await waitFor(() => expect(screen.getByText('Could not create the line.')).toBeTruthy())
        expect(screen.queryByText(raw)).toBeNull()
        expect(logged.mock.calls.some((call) => call[0] instanceof Error && call[0].message === raw)).toBe(true)
        fireEvent.change(screen.getByPlaceholderText('Name'), { target: { value: '另一条' } })
        expect(screen.queryByText('Could not create the line.')).toBeNull()
        logged.mockRestore()
    })

    it('keeps the create form when the machine list contains null', async () => {
        const api = {
            getWorkMap: async () => emptyMap,
            getWorkLayout: async () => ({ source: 'default', layout: null }),
            getMachines: async () => ({ machines: [null, { id: 'gpu', metadata: { displayName: 'GPU' } }] }),
        } as unknown as ApiClient
        render(
            <AppContextProvider value={{ api, token: 't', baseUrl: 'http://hub', user: { id: 7 } }}>
                <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
                    <I18nProvider>
                        <WorkCardHost
                            surface="workbench"
                            view={{ kind: 'line', lineId: '' }}
                            sessions={[]}
                            api={api}
                            layoutFor={() => ({ revision: 1, regions: { rail: [{ cardId: 'workbench.line-list' }] } })}
                        />
                    </I18nProvider>
                </QueryClientProvider>
            </AppContextProvider>,
        )
        expect(await screen.findByRole('option', { name: 'GPU' })).toBeTruthy()
        expect(screen.queryByText('No machine you can use. A line needs one.')).toBeNull()
    })

    it('says when the open line does not exist', async () => {
        const api = {
            getSessions: async () => ({ sessions: [] }),
            getWorkMap: async () => ({
                lines: [{ id: 'line-1', name: 'Main', goal: null, sort: 0, primaryMachineId: 'gpu', primaryPath: '/repo' }],
                directories: [],
                sessions: [],
                dismissed: [],
            }),
            getWorkLayout: async () => ({ source: 'default', layout: null }),
        } as unknown as ApiClient
        render(
            <AppContextProvider value={{ api, token: 't', baseUrl: 'http://hub', user: { id: 7 } }}>
                <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
                    <I18nProvider>
                        <Workbench search={{ line: 'no-such-line' }} />
                    </I18nProvider>
                </QueryClientProvider>
            </AppContextProvider>,
        )
        expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'This line does not exist.')
        expect(screen.queryByText('Show on this line')).toBeNull()
        expect(screen.getByRole('button', { name: 'Back to the first line' })).toBeTruthy()
        expect(screen.getByRole('button', { name: 'Overview' })).toBeTruthy()
    })

    it('unassigns non-primary directories and sessions from a line', async () => {
        const putWorkDirectory = vi.fn().mockResolvedValue({ ok: true })
        const putWorkSession = vi.fn().mockResolvedValue({ ok: true })
        const api = {
            getWorkMap: async () => ({
                lines: [{ id: 'line-1', name: 'Main', goal: null, sort: 0, primaryMachineId: 'gpu', primaryPath: '/repo' }],
                directories: [
                    { directoryKey: 'gpu::/repo', mode: 'line', lineId: 'line-1' },
                    { directoryKey: 'gpu::/extra', mode: 'line', lineId: 'line-1' },
                ],
                sessions: [{ sessionId: 's1', lineId: 'line-1' }],
                dismissed: [],
            }),
            getWorkLayout: async () => ({ source: 'default', layout: null }),
            putWorkDirectory,
            putWorkSession,
        } as unknown as ApiClient
        const sessions = [{ id: 's1', active: false, updatedAt: 10, pendingRequestsCount: 0, metadata: { name: 'Fix crash', path: '/other', machineId: 'gpu' } }]
        render(
            <AppContextProvider value={{ api, token: 't', baseUrl: 'http://hub', user: { id: 7 } }}>
                <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
                    <I18nProvider>
                        <WorkCardHost
                            surface="workbench"
                            view={{ kind: 'line', lineId: 'line-1' }}
                            sessions={sessions as never}
                            api={api}
                            layoutFor={() => ({
                                revision: 1,
                                regions: {
                                    main: [{ cardId: 'workbench.directories' }],
                                    side: [{ cardId: 'workbench.sessions' }],
                                },
                            })}
                        />
                    </I18nProvider>
                </QueryClientProvider>
            </AppContextProvider>,
        )
        const removes = await screen.findAllByRole('button', { name: 'Remove' })
        expect(removes).toHaveLength(2)
        fireEvent.click(removes[0]!)
        fireEvent.click(removes[1]!)
        await vi.waitFor(() => {
            expect(putWorkDirectory).toHaveBeenCalledWith({ directoryKey: 'gpu::/extra', mode: null })
            expect(putWorkSession).toHaveBeenCalledWith({ sessionId: 's1', state: 'follow' })
        })
    })
})
