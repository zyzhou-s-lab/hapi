import type { ReactNode } from 'react'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import { useAppContext } from '@/lib/app-context'
import { I18nProvider } from '@/lib/i18n-context'
import { getMessageWindowState, setMessageWindowScope } from '@/lib/message-window-store'
import { useMessages } from '@/hooks/queries/useMessages'
import SettingsLayout from '@/routes/settings/layout'
import { App } from './App'

vi.mock('@/hooks/useSSE', () => ({ useSSE: () => ({ subscriptionId: null }) }))
vi.mock('@/hooks/usePushNotifications', () => ({ usePushNotifications: () => ({ isSupported: false, permission: 'default' }) }))
vi.mock('@/hooks/useVisibilityReporter', () => ({ useVisibilityReporter: () => {} }))
vi.mock('@/lib/voice-context', () => ({ VoiceProvider: ({ children }: { children: ReactNode }) => children }))
vi.mock('@/lib/pwa-update-context', () => ({ PwaUpdateProvider: ({ children }: { children: ReactNode }) => children }))
vi.mock('@/components/PwaUpdateBanner', () => ({ PwaUpdateBanner: () => null, PwaUpdateBannerWithStatusOffset: () => null }))
vi.mock('@/components/VoiceErrorBanner', () => ({ VoiceErrorBanner: () => null }))
vi.mock('@/components/RunnerVersionSkewBanner', () => ({ RunnerVersionSkewBanner: () => null }))
vi.mock('@/components/InstallPrompt', () => ({ InstallPrompt: () => null }))
vi.mock('@/components/ToastContainer', () => ({ ToastContainer: () => null }))
vi.mock('@/components/AssistantChat/messages/TurnTimelineDemo', () => ({ TurnTimelineDemo: () => null }))

const hub = window.location.origin
let oldApi: ApiClient | null = null
let queryClient: QueryClient

function ChatProbe() {
    const { api } = useAppContext()
    oldApi = api
    const messages = useMessages(api, 'same')
    return <output>{messages.messages.map(message => JSON.stringify(message.content)).join('\n')}</output>
}

function mountApp() {
    const root = createRootRoute({ component: App })
    const settings = createRoute({ getParentRoute: () => root, path: '/settings', component: SettingsLayout })
    const index = createRoute({ getParentRoute: () => settings, path: '/', component: ChatProbe })
    const router = createRouter({ routeTree: root.addChildren([settings.addChildren([index])]), history: createMemoryHistory({ initialEntries: ['/settings'] }) })
    return render(<QueryClientProvider client={queryClient}><I18nProvider><RouterProvider router={router} /></I18nProvider></QueryClientProvider>)
}

function auth() {
    return Response.json({ token: 'live-jwt', user: { id: 1, firstName: 'User' } })
}

beforeEach(() => {
    vi.stubGlobal('scrollTo', vi.fn())
    localStorage.clear()
    sessionStorage.clear()
    window.history.replaceState(null, '', '/settings')
    setMessageWindowScope(null)
    oldApi = null
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
})
afterEach(() => {
    cleanup()
    setMessageWindowScope(null)
    queryClient.clear()
    localStorage.clear()
    sessionStorage.clear()
    window.history.replaceState(null, '', '/')
    vi.unstubAllGlobals()
})

describe('mounted browser logout', () => {
    it('retires chat and Query data from Settings, rejects late refresh, stays out on reload, and accepts a new form login', async () => {
        const refresh = Promise.withResolvers<Response>()
        let authRequests = 0
        vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
            const url = String(input)
            if (url.endsWith('/api/auth')) {
                authRequests += 1
                return authRequests === 2 ? refresh.promise : Promise.resolve(auth())
            }
            if (url.includes('/messages')) return Promise.resolve(Response.json({
                messages: [{ id: 'old-message', seq: 1, localId: null, createdAt: 1, content: { role: 'agent', content: { type: 'codex', data: { type: 'message', message: 'private-old-chat' } } } }],
                page: { direction: 'latest', limit: 200, epoch: 1, reset: false, hasMore: false, nextBeforeAt: null, nextBeforeSeq: null, nextAfterAt: null, nextAfterSeq: null, snapshotHeadAt: 1, snapshotHeadSeq: 1 },
            }))
            if (url.endsWith('/api/sessions/same')) return Promise.resolve(Response.json({ error: 'unauthorized' }, { status: 401 }))
            return Promise.resolve(Response.json({}))
        }))
        window.history.replaceState(null, '', '/settings?token=url-seed')
        const view = mountApp()
        expect(await screen.findByText(/private-old-chat/)).toBeInTheDocument()
        queryClient.setQueryData(['private-session'], { body: 'private-old-chat' })
        let pending!: Promise<unknown>
        act(() => { pending = oldApi!.getSession('same').catch((error: unknown) => error) })
        await waitFor(() => expect(authRequests).toBe(2))
        fireEvent.click(screen.getByRole('button', { name: 'Log out' }))
        expect(await screen.findByRole('button', { name: 'Sign In' })).toBeInTheDocument()
        expect(screen.queryByText(/private-old-chat/)).not.toBeInTheDocument()
        expect(getMessageWindowState('same').messages).toEqual([])
        expect(queryClient.getQueryData(['private-session'])).toBeUndefined()
        expect(localStorage.getItem(`hapi_access_token::${hub}`)).toBeNull()
        expect(window.location.search).toBe('')
        await act(async () => { refresh.resolve(auth()); await pending })
        expect(screen.queryByRole('button', { name: 'Log out' })).not.toBeInTheDocument()
        view.unmount()
        mountApp()
        expect(await screen.findByRole('button', { name: 'Sign In' })).toBeInTheDocument()
        expect(authRequests).toBe(2)
        fireEvent.click(screen.getByRole('tab', { name: 'API token' }))
        fireEvent.change(screen.getByPlaceholderText('Access token'), { target: { value: 'new-seed' } })
        fireEvent.click(screen.getByRole('button', { name: 'Sign In' }))
        expect(await screen.findByRole('button', { name: 'Log out' })).toBeInTheDocument()
        expect(localStorage.getItem(`hapi_access_token::${hub}`)).toBe('new-seed')
    })

    it('does not offer unsupported logout for automatic Telegram authentication', async () => {
        window.history.replaceState(null, '', '/settings?initData=telegram-data')
        vi.stubGlobal('fetch', vi.fn(async () => auth()))
        mountApp()
        expect(await screen.findByRole('navigation', { name: 'Settings' })).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: 'Log out' })).not.toBeInTheDocument()
    })
})
