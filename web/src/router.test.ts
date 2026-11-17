import { createMemoryHistory } from '@tanstack/react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAppRouter } from './router'

afterEach(() => {
    window.history.replaceState(null, '', '/')
    vi.unstubAllEnvs()
})

describe('deployment route paths', () => {
    it('loads a browser session deep link and keeps generated links under the deployment base', async () => {
        vi.stubEnv('BASE_URL', '/hapi/')
        window.history.replaceState(null, '', '/hapi/sessions/deep-linked-session?outline=true')
        const router = createAppRouter()
        try {
            await router.load()

            const match = router.state.matches.at(-1)
            expect(match?.routeId).toBe('/sessions/$sessionId')
            expect(match?.params).toMatchObject({ sessionId: 'deep-linked-session' })
            expect(match?.search).toEqual({ outline: true })
            expect(router.buildLocation({ to: '/settings/about' }).href).toBe('/hapi/settings/about')
        } finally {
            router.history.destroy()
        }
    })

    it('keeps Telegram memory-history session paths independent of the static deployment base', async () => {
        vi.stubEnv('BASE_URL', '/hapi/')
        const history = createMemoryHistory({ initialEntries: ['/sessions/telegram-session'] })
        const router = createAppRouter(history)
        try {
            await router.load()

            const match = router.state.matches.at(-1)
            expect(match?.routeId).toBe('/sessions/$sessionId')
            expect(match?.params).toMatchObject({ sessionId: 'telegram-session' })
            expect(router.buildLocation({ to: '/settings/about' }).href).toBe('/settings/about')
        } finally {
            history.destroy()
        }
    })
})
