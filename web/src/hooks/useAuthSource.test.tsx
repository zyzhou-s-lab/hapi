import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useAuthSource } from './useAuthSource'

const hub = 'http://hub.test'
const accessKey = `hapi_access_token::${hub}`
const passwordKey = `hapi_password_jwt::${hub}`

beforeEach(() => {
    localStorage.clear()
    window.history.replaceState(null, '', '/')
})
afterEach(() => {
    cleanup()
    localStorage.clear()
    window.history.replaceState(null, '', '/')
})

describe('browser credential retirement', () => {
    it('consumes URL tokens before authentication while preserving unrelated location and history state', () => {
        window.history.replaceState({ navigation: 'keep' }, '', '/sessions/same?token=url-seed&keep=yes&token=duplicate#anchor')
        const hook = renderHook(() => useAuthSource(hub), { reactStrictMode: true })
        expect(hook.result.current.authSource).toEqual({ type: 'accessToken', token: 'url-seed' })
        expect(window.location.pathname + window.location.search + window.location.hash).toBe('/sessions/same?keep=yes#anchor')
        expect(window.history.state).toEqual({ navigation: 'keep' })
        expect(localStorage.getItem(accessKey)).toBe('url-seed')
    })

    it('logs out only the current Hub, removes a later URL token, and stays logged out on remount', () => {
        localStorage.setItem(accessKey, 'current-seed')
        localStorage.setItem(passwordKey, 'current-password-jwt')
        localStorage.setItem('hapi_access_token::http://other-hub.test', 'other-seed')
        const hook = renderHook(() => useAuthSource(hub))
        window.history.replaceState(null, '', '/settings?token=late-url-seed&keep=yes#anchor')
        act(() => hook.result.current.clearAuth())
        expect(hook.result.current.authSource).toBeNull()
        expect(localStorage.getItem(accessKey)).toBeNull()
        expect(localStorage.getItem(passwordKey)).toBeNull()
        expect(localStorage.getItem('hapi_access_token::http://other-hub.test')).toBe('other-seed')
        expect(window.location.search + window.location.hash).toBe('?keep=yes#anchor')
        hook.unmount()
        const reloaded = renderHook(() => useAuthSource(hub))
        expect(reloaded.result.current).toMatchObject({ authSource: null, isLoading: false })
        act(() => reloaded.result.current.setAccessToken('new-seed'))
        expect(reloaded.result.current.authSource).toEqual({ type: 'accessToken', token: 'new-seed' })
    })

    it('keeps Telegram automatic authentication independent of browser credentials', () => {
        window.history.replaceState(null, '', '/?initData=telegram-data&token=browser-seed')
        localStorage.setItem(accessKey, 'stored-browser-seed')
        const hook = renderHook(() => useAuthSource(hub))
        expect(hook.result.current).toMatchObject({ authSource: { type: 'telegram', initData: 'telegram-data' }, isTelegram: true })
        expect(localStorage.getItem(accessKey)).toBe('stored-browser-seed')
    })
})
