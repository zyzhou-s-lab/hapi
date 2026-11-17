import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react'
import { ApiClient, ApiError } from '@/api/client'
import type { AuthResponse } from '@/types/api'

export type AuthSource =
    | { type: 'telegram'; initData: string }
    | { type: 'accessToken'; token: string }
    | { type: 'password'; token: string }

function decodeJwtExpMs(token: string): number | null {
    const parts = token.split('.')
    if (parts.length < 2) return null

    const payloadBase64Url = parts[1] ?? ''
    const payloadBase64 = payloadBase64Url
        .replace(/-/g, '+')
        .replace(/_/g, '/')
        .padEnd(Math.ceil(payloadBase64Url.length / 4) * 4, '=')

    try {
        const decoded = globalThis.atob(payloadBase64)
        const payload = JSON.parse(decoded) as { exp?: unknown }
        if (typeof payload.exp !== 'number') return null
        return payload.exp * 1000
    } catch {
        return null
    }
}

function getAuthPayload(source: Exclude<AuthSource, { type: 'password' }>): { initData: string } | { accessToken: string } {
    if (source.type === 'telegram') {
        return { initData: source.initData }
    }
    return { accessToken: source.token }
}

function isNotBoundError(error: unknown): boolean {
    return error instanceof ApiError && error.status === 401 && error.code === 'not_bound'
}

const ACCESS_TOKEN_PREFIX = 'hapi_access_token::'

function rememberAccessToken(baseUrl: string, accessToken: string): void {
    try {
        localStorage.setItem(`${ACCESS_TOKEN_PREFIX}${baseUrl}`, accessToken)
    } catch {
        // Ignore storage errors (private mode, full quota, etc.)
    }
}

export type AuthResult = {
    token: string | null
    user: AuthResponse['user'] | null
    api: ApiClient | null
    isLoading: boolean
    error: string | null
    needsBinding: boolean
    bind: (accessToken: string) => Promise<void>
}

type AuthState = Pick<AuthResult, 'token' | 'user' | 'isLoading' | 'error' | 'needsBinding'>
type AuthLifetime = {
    lease: object | null
    token: string | null
    refreshPromise: Promise<string | null> | null
    lastRefreshAttempt: number
}
const EMPTY_AUTH: AuthState = {
    token: null, user: null, isLoading: false, error: null, needsBinding: false,
}

export function useAuth(authSource: AuthSource | null, baseUrl: string): AuthResult {
    const lifetime = useMemo<AuthLifetime>(() => ({
        lease: null, token: null, refreshPromise: null, lastRefreshAttempt: 0,
    }), [authSource, baseUrl])
    const [state, setState] = useState<AuthState & { lifetime: AuthLifetime; lease: object | null }>(() => ({ ...EMPTY_AUTH, lifetime, lease: null }))
    // A changed credential/Hub never exposes the previous auth, even before effects.
    const lease = state.lifetime === lifetime ? state.lease : null
    const { token, user, isLoading, error, needsBinding } = lease === lifetime.lease && state.lifetime === lifetime ? state : EMPTY_AUTH

    useLayoutEffect(() => {
        // Each attachment gets a fresh lease; StrictMode cannot revive old work.
        const lease = {}
        lifetime.lease = lease
        setState({ ...EMPTY_AUTH, lifetime, lease })
        return () => {
            if (lifetime.lease !== lease) return
            lifetime.lease = null
            lifetime.token = null
            lifetime.refreshPromise = null
            lifetime.lastRefreshAttempt = 0
        }
    }, [lifetime])

    const updateAuth = useCallback((lease: object, patch: Partial<AuthState>) => {
        if (lifetime.lease !== lease) return
        if (patch.token !== undefined) lifetime.token = patch.token
        setState((previous) => lifetime.lease === lease ? {
            ...(previous.lifetime === lifetime && previous.lease === lease ? previous : EMPTY_AUTH),
            ...patch,
            lifetime,
            lease,
        } : previous)
    }, [lifetime])

    const refreshAuth = useCallback(async (options?: {
        minTtlMs?: number
        hardFail?: boolean
        force?: boolean
    }): Promise<string | null> => {
        if (!authSource || !lease || lifetime.lease !== lease) return null
        const currentToken = lifetime.token
        const expMs = currentToken ? decodeJwtExpMs(currentToken) : null
        const minTtlMs = options?.minTtlMs ?? 0
        const now = Date.now()
        const ttlMs = expMs ? expMs - now : null
        const needsRefreshForTtl = ttlMs !== null && ttlMs <= minTtlMs
        if (!options?.force && ttlMs !== null && ttlMs > minTtlMs) return currentToken
        if (!options?.force && !needsRefreshForTtl && now - lifetime.lastRefreshAttempt < 15_000) return currentToken
        if (lifetime.refreshPromise) return await lifetime.refreshPromise

        const run = async () => {
            lifetime.lastRefreshAttempt = now
            try {
                const client = new ApiClient(authSource.type === 'password' ? (currentToken ?? authSource.token) : '', { baseUrl })
                const auth = authSource.type === 'password'
                    ? await client.refreshAuth()
                    : await client.authenticate(getAuthPayload(authSource))
                if (lifetime.lease !== lease) return null
                updateAuth(lease, { token: auth.token, user: auth.user, error: null, needsBinding: false })
                return auth.token
            } catch (error) {
                if (lifetime.lease !== lease) return null
                if (authSource.type === 'telegram' && isNotBoundError(error)) {
                    updateAuth(lease, { token: null, user: null, error: null, needsBinding: true })
                    return null
                }
                const isExpired = expMs ? Date.now() >= expMs : false
                if (options?.hardFail || isExpired) {
                    updateAuth(lease, {
                        token: null,
                        user: null,
                        error: authSource.type === 'telegram'
                            ? 'Session expired. Reopen the Mini App from Telegram.'
                            : 'Session expired. Please login again.',
                    })
                }
                return null
            }
        }

        const refreshPromise = run()
        lifetime.refreshPromise = refreshPromise
        try {
            return await refreshPromise
        } finally {
            if (lifetime.lease === lease && lifetime.refreshPromise === refreshPromise) lifetime.refreshPromise = null
        }
    }, [authSource, baseUrl, lease, lifetime, updateAuth])

    const bind = useCallback(async (accessToken: string) => {
        if (!lease || lifetime.lease !== lease) return
        if (!authSource || authSource.type !== 'telegram') {
            updateAuth(lease, { error: 'Binding is only supported in Telegram.' })
            return
        }
        updateAuth(lease, { isLoading: true, error: null })
        try {
            const client = new ApiClient('', { baseUrl })
            const auth = await client.bind({ initData: authSource.initData, accessToken })
            if (lifetime.lease !== lease) return
            updateAuth(lease, { token: auth.token, user: auth.user, needsBinding: false })
            rememberAccessToken(baseUrl, accessToken)
        } catch (error) {
            if (lifetime.lease !== lease) return
            updateAuth(lease, { error: error instanceof Error ? error.message : 'Binding failed' })
            throw error
        } finally {
            updateAuth(lease, { isLoading: false })
        }
    }, [authSource, baseUrl, lease, lifetime, updateAuth])

    // Token refresh changes only this credential lifetime's live token. It does
    // not recreate the client or grant a retired client the next account's JWT.
    const hasToken = token !== null
    const api = useMemo(() => hasToken ? new ApiClient(lifetime.token ?? '', {
        baseUrl,
        getToken: () => lifetime.lease === lease ? (lifetime.token ?? '') : '',
        onUnauthorized: () => refreshAuth({ force: true }),
    }) : null, [baseUrl, lease, lifetime, refreshAuth, hasToken])

    useEffect(() => {
        const lease = lifetime.lease
        if (!lease) return
        let isCancelled = false
        const run = async () => {
            updateAuth(lease, { ...EMPTY_AUTH, isLoading: Boolean(authSource) })
            if (!authSource) return
            try {
                const client = new ApiClient(authSource.type === 'password' ? authSource.token : '', { baseUrl })
                const auth = authSource.type === 'password'
                    ? await client.refreshAuth()
                    : await client.authenticate(getAuthPayload(authSource))
                if (isCancelled) return
                updateAuth(lease, { token: auth.token, user: auth.user, needsBinding: false })
            } catch (error) {
                if (isCancelled) return
                if (authSource.type === 'telegram' && isNotBoundError(error)) {
                    updateAuth(lease, { token: null, user: null, error: null, needsBinding: true })
                } else {
                    updateAuth(lease, { needsBinding: false, error: error instanceof Error ? error.message : 'Auth failed' })
                }
            } finally {
                if (!isCancelled) updateAuth(lease, { isLoading: false })
            }
        }
        void run()
        return () => { isCancelled = true }
    }, [authSource, baseUrl, lifetime, updateAuth])

    useEffect(() => {
        if (!token || !authSource) {
            return
        }

        const expMs = decodeJwtExpMs(token)
        if (!expMs) {
            return
        }

        let isCancelled = false
        let timeout: ReturnType<typeof setTimeout> | null = null

        const schedule = (delayMs: number) => {
            if (timeout) {
                clearTimeout(timeout)
            }
            timeout = setTimeout(() => void refresh(), Math.max(0, delayMs))
        }

        const refresh = async () => {
            if (isCancelled) return
            const refreshed = await refreshAuth({ force: true })
            if (isCancelled) return
            if (!refreshed && Date.now() < expMs) {
                schedule(15_000)
            }
        }

        schedule(expMs - 60_000 - Date.now())

        return () => {
            isCancelled = true
            if (timeout) {
                clearTimeout(timeout)
            }
        }
    }, [authSource, refreshAuth, token])

    useEffect(() => {
        if (!authSource) {
            return
        }

        const handleActive = () => {
            void refreshAuth({ minTtlMs: 60_000 })
        }

        const handleVisibilityChange = () => {
            if (document.visibilityState === 'visible') {
                handleActive()
            }
        }

        window.addEventListener('focus', handleActive)
        document.addEventListener('visibilitychange', handleVisibilityChange)

        return () => {
            window.removeEventListener('focus', handleActive)
            document.removeEventListener('visibilitychange', handleVisibilityChange)
        }
    }, [authSource, refreshAuth])

    return { token, user, api, isLoading, error, needsBinding, bind }
}
