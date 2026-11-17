import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAuthSource } from '@/hooks/useAuthSource'
import { I18nProvider } from '@/lib/i18n-context'
import { LoginPrompt } from './LoginPrompt'

const hub = 'http://hub.test'

function Login() {
    const source = useAuthSource(hub)
    return source.authSource
        ? <div>Signed in</div>
        : <LoginPrompt baseUrl={hub} serverUrl={null} setServerUrl={() => ({ ok: true, value: hub })} clearServerUrl={() => {}} onLogin={source.setAccessToken} onPasswordLogin={source.setPasswordToken} />
}

afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals() })

describe('login form lifetime', () => {
    it.each(['token', 'password'] as const)('cannot restore %s credentials after its form is retired', async (mode) => {
        const pending = Promise.withResolvers<Response>()
        const fetchMock = vi.fn(() => pending.promise)
        vi.stubGlobal('fetch', fetchMock)
        const view = render(<I18nProvider><Login /></I18nProvider>)
        if (mode === 'token') {
            fireEvent.click(screen.getByRole('tab', { name: 'API token' }))
            fireEvent.change(screen.getByPlaceholderText('Access token'), { target: { value: 'retired-seed' } })
        } else {
            fireEvent.change(screen.getByPlaceholderText('Username'), { target: { value: 'user' } })
            fireEvent.change(screen.getByPlaceholderText('Password'), { target: { value: 'password' } })
        }
        fireEvent.click(screen.getByRole('button', { name: 'Sign In' }))
        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
        view.unmount()
        render(<I18nProvider><Login /></I18nProvider>)
        await act(async () => { pending.resolve(Response.json({ token: 'retired-jwt', user: { id: 1 } })) })
        expect(screen.queryByText('Signed in')).not.toBeInTheDocument()
        expect(localStorage.getItem(`hapi_access_token::${hub}`)).toBeNull()
        expect(localStorage.getItem(`hapi_password_jwt::${hub}`)).toBeNull()
        expect(screen.getByRole('button', { name: 'Sign In' })).toBeInTheDocument()
    })
})
