import { describe, expect, it } from 'vitest'
import type { SessionSummary } from '@/types/api'
import { sessionDirectoryGroupKey, UNKNOWN_MACHINE_ID } from './sessionDirectoryGroup'

function session(metadata: SessionSummary['metadata']): SessionSummary {
    return { id: 's', metadata } as SessionSummary
}

describe('sessionDirectoryGroupKey', () => {
    it('matches the sidebar: machine, worktree base path, else path, else Other', () => {
        expect(sessionDirectoryGroupKey(session({
            path: '/repo/checkout',
            host: 'h',
            machineId: 'm1',
            worktree: { basePath: '/repo', branch: 'main', name: 'wt' },
        }))).toBe('m1::/repo')

        expect(sessionDirectoryGroupKey(session({
            path: '/repo',
            host: 'h',
            machineId: 'm1',
        }))).toBe('m1::/repo')

        expect(sessionDirectoryGroupKey(session({
            path: '/repo',
            host: 'h',
        }))).toBe(`${UNKNOWN_MACHINE_ID}::/repo`)

        expect(sessionDirectoryGroupKey(session(null))).toBe(`${UNKNOWN_MACHINE_ID}::Other`)
    })
})
