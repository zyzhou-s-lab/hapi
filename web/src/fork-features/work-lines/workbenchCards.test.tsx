import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import { AppContextProvider } from '@/lib/app-context'
import { I18nProvider } from '@/lib/i18n-context'
import { WorkCardHost } from './WorkCardHost'
import './workbenchCards'

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
        fireEvent.click(screen.getByText('Create line'))
        await waitFor(() => expect(screen.getByText('Could not create the line.')).toBeTruthy())
        expect(screen.queryByText(raw)).toBeNull()
    })
})
