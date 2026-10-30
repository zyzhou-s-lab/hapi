import { describe, expect, it } from 'vitest'
import type { SessionSummary } from '@/types/api'
import { deriveWork, type WorkMapData } from './deriveWork'

function session(patch: Partial<SessionSummary> & { id: string }): SessionSummary {
    return {
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: false,
        activeAt: 1,
        metadata: { path: '/repo', machineId: 'gpu' },
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 1,
        pendingRequestsCount: 0,
        ...patch,
    } as SessionSummary
}

const empty: WorkMapData = { lines: [], directories: [], sessions: [], dismissed: [] }

describe('deriveWork', () => {
    it('follows a directory, lets a session override it, and ignores a dismissed pending row', () => {
        const map: WorkMapData = {
            lines: [{ id: 'line-1', name: '主线', goal: null, sort: 0, primaryMachineId: 'gpu', primaryPath: '/repo' }],
            directories: [
                { directoryKey: 'gpu::/repo', mode: 'line', lineId: 'line-1' },
                { directoryKey: 'gpu::/skip', mode: 'ignored', lineId: null },
            ],
            sessions: [{ sessionId: 'override', lineId: null }],
            dismissed: ['gone'],
        }
        const model = deriveWork([
            session({ id: 'followed', pendingRequestsCount: 2, updatedAt: 10 }),
            session({ id: 'override', metadata: { path: '/repo', machineId: 'gpu' }, pendingRequestsCount: 4, updatedAt: 20 }),
            session({ id: 'skipped', metadata: { path: '/skip', machineId: 'gpu' }, pendingRequestsCount: 1 }),
            session({ id: 'gone', pendingRequestsCount: 9, updatedAt: 30 }),
            session({ id: 'loose', metadata: { path: '/other', machineId: 'mac' }, active: true }),
        ], map, (item) => item.id, (item) => item.metadata?.machineId ?? '')

        expect(model.lineCount).toBe(1)
        expect(model.needsYou.map((row) => row.id)).toEqual(['followed'])
        expect(model.needsYouCount).toBe(1)
        expect(model.runningCount).toBe(1)
        expect(model.inboxCount).toBe(1)
        expect(model.directoryCount).toBe(1)
        expect(model.machineCount).toBe(1)
        expect(model.needsYou[0]?.directory).toBe('/repo')
    })

    it('does not keep a session on a line that no longer exists', () => {
        const model = deriveWork([
            session({ id: 'stale' }),
        ], {
            ...empty,
            sessions: [{ sessionId: 'stale', lineId: 'missing' }],
        }, (item) => item.id, () => 'gpu')
        expect(model.inboxCount).toBe(1)
        expect(model.needsYouCount).toBe(0)
    })
})
