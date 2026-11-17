import { useCallback, useEffect, useState } from 'react'
import { GitScopeSchema, type GitScope } from '@hapi/protocol/sourceControl'

const STORAGE_PREFIX = 'hapi.git-scope.v1:'
const DEFAULT_SCOPE: GitScope = 'working'
const MAX_BASE_REF_LENGTH = 256

type GitScopeState = {
    sessionId: string | null
    scope: GitScope
    baseRef?: string
}

export function gitScopeStorageKey(sessionId: string): string {
    return `${STORAGE_PREFIX}${sessionId}`
}

function normalizeBaseRef(value: string | undefined): string | undefined {
    const trimmed = value?.trim()
    if (!trimmed) return undefined
    return trimmed.slice(0, MAX_BASE_REF_LENGTH)
}

function readGitScope(sessionId: string | null): { scope: GitScope; baseRef?: string } {
    if (!sessionId) {
        return { scope: DEFAULT_SCOPE }
    }
    try {
        const raw = typeof localStorage === 'undefined'
            ? null
            : localStorage.getItem(gitScopeStorageKey(sessionId))
        if (!raw) {
            return { scope: DEFAULT_SCOPE }
        }
        const parsed: unknown = JSON.parse(raw)
        if (!parsed || typeof parsed !== 'object') {
            return { scope: DEFAULT_SCOPE }
        }
        const record = parsed as Record<string, unknown>
        const scope = GitScopeSchema.safeParse(record.scope)
        const baseRef = typeof record.baseRef === 'string' ? normalizeBaseRef(record.baseRef) : undefined
        return {
            scope: scope.success ? scope.data : DEFAULT_SCOPE,
            ...(baseRef ? { baseRef } : {})
        }
    } catch {
        return { scope: DEFAULT_SCOPE }
    }
}

function writeGitScope(sessionId: string, state: { scope: GitScope; baseRef?: string }): void {
    try {
        if (typeof localStorage === 'undefined') return
        localStorage.setItem(gitScopeStorageKey(sessionId), JSON.stringify({
            version: 1,
            scope: state.scope,
            ...(state.baseRef ? { baseRef: state.baseRef } : {})
        }))
    } catch {
        // The picker still works when storage is unavailable.
    }
}

/**
 * Per-session Git comparison scope. The selected scope/baseRef survives route
 * navigation and reloads so Files, the composer and per-file Diff all compare
 * against the same reference.
 */
export function useGitScope(sessionId: string | null): {
    scope: GitScope
    baseRef?: string
    setScope: (scope: GitScope) => void
    setBaseRef: (baseRef: string | undefined) => void
} {
    const [state, setState] = useState<GitScopeState>(() => ({
        sessionId,
        ...readGitScope(sessionId)
    }))

    useEffect(() => {
        setState((previous) => previous.sessionId === sessionId
            ? previous
            : { sessionId, ...readGitScope(sessionId) })
    }, [sessionId])

    const resolved = state.sessionId === sessionId
        ? state
        : { sessionId, ...readGitScope(sessionId) }

    const setScope = useCallback((scope: GitScope) => {
        setState((previous) => {
            const base = previous.sessionId === sessionId
                ? previous
                : { sessionId, ...readGitScope(sessionId) }
            const next = { ...base, scope }
            if (sessionId) writeGitScope(sessionId, next)
            return next
        })
    }, [sessionId])

    const setBaseRef = useCallback((value: string | undefined) => {
        const baseRef = normalizeBaseRef(value)
        setState((previous) => {
            const base = previous.sessionId === sessionId
                ? previous
                : { sessionId, ...readGitScope(sessionId) }
            const next = { ...base, baseRef }
            if (sessionId) writeGitScope(sessionId, next)
            return next
        })
    }, [sessionId])

    return {
        scope: resolved.scope,
        ...(resolved.baseRef ? { baseRef: resolved.baseRef } : {}),
        setScope,
        setBaseRef
    }
}
