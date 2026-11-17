import { beforeEach, describe, expect, it } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { gitScopeStorageKey, useGitScope } from './useGitScope'

beforeEach(() => {
    localStorage.clear()
})

describe('useGitScope', () => {
    it('defaults to working and persists scope/baseRef per session', () => {
        const { result, rerender } = renderHook(
            ({ sessionId }: { sessionId: string | null }) => useGitScope(sessionId),
            { initialProps: { sessionId: 'session-1' as string | null } }
        )

        expect(result.current.scope).toBe('working')
        expect(result.current.baseRef).toBeUndefined()

        act(() => result.current.setScope('branch'))
        act(() => result.current.setBaseRef(' origin/main '))

        expect(result.current.scope).toBe('branch')
        expect(result.current.baseRef).toBe('origin/main')
        expect(JSON.parse(localStorage.getItem(gitScopeStorageKey('session-1')) ?? 'null')).toEqual({
            version: 1,
            scope: 'branch',
            baseRef: 'origin/main'
        })

        rerender({ sessionId: 'session-2' })
        expect(result.current.scope).toBe('working')
        expect(result.current.baseRef).toBeUndefined()

        rerender({ sessionId: 'session-1' })
        expect(result.current.scope).toBe('branch')
        expect(result.current.baseRef).toBe('origin/main')
    })

    it('ignores invalid stored scope but keeps a valid baseRef', () => {
        localStorage.setItem(gitScopeStorageKey('session-1'), JSON.stringify({
            scope: 'bogus',
            baseRef: 'origin/develop'
        }))

        const { result } = renderHook(() => useGitScope('session-1'))

        expect(result.current.scope).toBe('working')
        expect(result.current.baseRef).toBe('origin/develop')

        act(() => result.current.setBaseRef(undefined))
        expect(result.current.baseRef).toBeUndefined()
        expect(JSON.parse(localStorage.getItem(gitScopeStorageKey('session-1')) ?? 'null')).toEqual({
            version: 1,
            scope: 'working'
        })
    })

    it('falls back to working when storage is unreadable', () => {
        localStorage.setItem(gitScopeStorageKey('session-1'), '{not json')
        const { result } = renderHook(() => useGitScope('session-1'))
        expect(result.current.scope).toBe('working')
        expect(result.current.baseRef).toBeUndefined()
    })
})
