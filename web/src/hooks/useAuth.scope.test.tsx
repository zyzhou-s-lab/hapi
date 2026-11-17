import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAuth, type AuthSource } from './useAuth'

function auth(token: string, id: number) {
    return Response.json({ token, user: { id, firstName: `user-${id}` } })
}

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('auth credential lifetime', () => {
    it('masks old credentials on the first account/Hub render and ignores late initial auth', async () => {
        const lateA = Promise.withResolvers<Response>()
        vi.stubGlobal('fetch', vi.fn((url: string) => url.startsWith('http://hub-a')
            ? lateA.promise
            : Promise.resolve(auth('token-B', 2))))
        const sourceA: AuthSource = { type: 'accessToken', token: 'seed-A' }
        const sourceB: AuthSource = { type: 'accessToken', token: 'seed-B' }
        const seen: Array<string | null> = []
        const hook = renderHook(({ source, hub }: { source: AuthSource; hub: string }) => {
            const result = useAuth(source, hub)
            seen.push(result.token)
            return result
        }, { initialProps: { source: sourceA, hub: 'http://hub-a' } })
        hook.rerender({ source: sourceB, hub: 'http://hub-b' })
        expect(hook.result.current).toMatchObject({ token: null, user: null, api: null })
        await waitFor(() => expect(hook.result.current.token).toBe('token-B'))
        await act(async () => { lateA.resolve(auth('private-token-A', 1)) })
        expect(hook.result.current.user?.id).toBe(2)
        expect(seen).not.toContain('private-token-A')
    })

    it('does not restore a logged-out account when refresh settles or let its old client read the replacement JWT', async () => {
        const refresh = Promise.withResolvers<Response>()
        let authRequests = 0
        const sessionHeaders: string[] = []
        vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
            if (url.endsWith('/api/auth')) {
                authRequests += 1
                if (authRequests === 1) return Promise.resolve(auth('token-A', 1))
                if (authRequests === 2) return refresh.promise
                return Promise.resolve(auth('token-B', 2))
            }
            sessionHeaders.push(new Headers(init?.headers).get('authorization') ?? '')
            return Promise.resolve(Response.json({ error: 'unauthorized' }, { status: 401 }))
        }))
        const sourceA: AuthSource = { type: 'accessToken', token: 'seed-A' }
        const sourceB: AuthSource = { type: 'accessToken', token: 'seed-B' }
        const hook = renderHook(({ source }: { source: AuthSource | null }) => useAuth(source, 'http://hub.test'), {
            initialProps: { source: sourceA as AuthSource | null },
        })
        await waitFor(() => expect(hook.result.current.token).toBe('token-A'))
        const oldClient = hook.result.current.api!
        let pending!: Promise<unknown>
        act(() => { pending = oldClient.getSession('same').catch((error: unknown) => error) })
        await waitFor(() => expect(authRequests).toBe(2))
        hook.rerender({ source: null })
        await act(async () => { refresh.resolve(auth('private-late-refresh', 1)); await pending })
        expect(hook.result.current).toMatchObject({ token: null, user: null, api: null })
        hook.rerender({ source: sourceB })
        await waitFor(() => expect(hook.result.current.token).toBe('token-B'))
        await expect(oldClient.getSession('same')).rejects.toThrow()
        expect(sessionHeaders).toEqual(['Bearer token-A', ''])
        expect(authRequests).toBe(3)
    })

    it('gives StrictMode replay fresh authority without reviving the first authentication', async () => {
        const retired = Promise.withResolvers<Response>()
        let requests = 0
        vi.stubGlobal('fetch', vi.fn(() => {
            requests += 1
            return requests === 1 ? retired.promise : Promise.resolve(auth('live-replay', 2))
        }))
        const source: AuthSource = { type: 'accessToken', token: 'seed' }
        const hook = renderHook(() => useAuth(source, 'http://hub.test'), { reactStrictMode: true })
        await waitFor(() => expect(hook.result.current.token).toBe('live-replay'))
        await act(async () => { retired.resolve(auth('retired-first-attachment', 1)) })
        expect(hook.result.current.user?.id).toBe(2)
        expect(hook.result.current.token).toBe('live-replay')
    })
})
