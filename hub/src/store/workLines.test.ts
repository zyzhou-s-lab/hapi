import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from './index'
import { WorkMapError } from './workLines'

describe('work lines', () => {
    const accounts: Store[] = []

    afterEach(() => {
        for (const store of accounts) store.close()
        accounts.length = 0
    })

    function open(): Store {
        const store = new Store(':memory:')
        accounts.push(store)
        return store
    }

    it('creates a line and its primary directory together', () => {
        const lines = open().workLines
        const line = lines.createLine(1, {
            name: '  hapi  ',
            primaryMachineId: 'gpu',
            primaryPath: '/data/hapi'
        })
        expect(line.name).toBe('hapi')
        const map = lines.getMap(1)
        expect(map.lines).toHaveLength(1)
        expect(map.directories).toEqual([expect.objectContaining({
            directoryKey: 'gpu::/data/hapi',
            mode: 'line',
            lineId: line.id
        })])
    })

    it('refuses a primary directory that already belongs to another line', () => {
        const lines = open().workLines
        lines.createLine(1, { name: 'a', primaryMachineId: 'gpu', primaryPath: '/data/hapi' })
        expect(() => lines.createLine(1, { name: 'b', primaryMachineId: 'gpu', primaryPath: '/data/hapi' }))
            .toThrow(WorkMapError)
    })

    it('keeps the old directory when the primary changes', () => {
        const lines = open().workLines
        const line = lines.createLine(1, { name: 'a', primaryMachineId: 'gpu', primaryPath: '/old' })
        lines.updateLine(1, line.id, { primaryMachineId: 'mac', primaryPath: '/new' })
        const keys = lines.getMap(1).directories.map((row) => row.directoryKey).sort()
        expect(keys).toEqual(['gpu::/old', 'mac::/new'])
    })

    it('returns ignored sessions to nowhere and assigned ones to the inbox on delete', () => {
        const lines = open().workLines
        const line = lines.createLine(1, { name: 'a', primaryMachineId: 'gpu', primaryPath: '/data' })
        lines.putSession(1, { sessionId: 'kept', state: 'ignored' })
        lines.putSession(1, { sessionId: 'moved', state: 'line', lineId: line.id })
        lines.deleteLine(1, line.id)
        const map = lines.getMap(1)
        expect(map.lines).toHaveLength(0)
        expect(map.directories).toHaveLength(0)
        expect(map.sessions).toEqual([expect.objectContaining({ sessionId: 'kept', lineId: null })])
    })

    it('refuses to drop the current primary directory row', () => {
        const lines = open().workLines
        lines.createLine(1, { name: 'a', primaryMachineId: 'gpu', primaryPath: '/data' })
        expect(() => lines.putDirectory(1, { directoryKey: 'gpu::/data', mode: null }))
            .toThrow(/主目录/)
    })

    it('rejects a bad layout region and an overlong arg', () => {
        const lines = open().workLines
        expect(() => lines.putLayout(1, 'overview', {
            revision: 1,
            regions: { stats: [], nope: [] }
        })).toThrow(WorkMapError)
        expect(() => lines.putLayout(1, 'overview', {
            revision: 1,
            regions: {
                stats: [{ cardId: 'overview.lines', args: { lineId: 'x'.repeat(201) } }],
                body: []
            }
        })).toThrow(WorkMapError)
        expect(lines.putLayout(1, 'overview', {
            revision: 1,
            regions: {
                stats: [{ cardId: 'overview.lines', args: { metrics: 'x'.repeat(201) } }],
                body: []
            }
        }).revision).toBe(1)
        expect(() => lines.putLayout(1, 'overview', {
            revision: 1,
            regions: {
                stats: [{ cardId: 'overview.lines', args: { metrics: 'x'.repeat(8_001) } }],
                body: []
            }
        })).toThrow(WorkMapError)
    })

    it('registers a run without a points table and purges the account', () => {
        const store = open()
        const run = store.workLines.registerTrainingRun(7, {
            run: 'exp-1',
            machineId: 'gpu',
            runDir: '/data/wandb/run-abc'
        })
        expect(run.runDir).toBe('/data/wandb/run-abc')
        expect(() => store.workLines.registerTrainingRun(7, {
            run: 'bad',
            machineId: 'gpu',
            runDir: '/data/wandb'
        })).toThrow(WorkMapError)
        store.workLines.purgeAccount(7)
        expect(store.workLines.getTrainingRun(7, 'exp-1')).toBeNull()
        const names = (store as unknown as { db: Database }).db
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'work_%'")
            .all() as Array<{ name: string }>
        expect(names.map((row) => row.name).sort()).toEqual([
            'work_directories',
            'work_dismissed',
            'work_layouts',
            'work_lines',
            'work_sessions',
            'work_training_runs'
        ])
    })

    it('assigns an id to a legacy card and reuses an identical bind', () => {
        const lines = open().workLines
        const line = lines.createLine(1, { name: 'a', primaryMachineId: 'gpu', primaryPath: '/data' })
        lines.registerTrainingRun(1, { run: 'exp-1', machineId: 'gpu', runDir: '/data/wandb/offline-run-1' })
        lines.putLayout(1, 'workbench', {
            revision: 1,
            regions: {
                rail: [{ cardId: 'workbench.line-list' }],
                main: [{ cardId: 'example.training-curves', args: { lineId: line.id, run: 'exp-1', metrics: '["loss","loss"]' } }],
                side: [{ cardId: 'workbench.sessions' }, { cardId: 'workbench.continue' }],
            },
        })
        const read = lines.getLayout(1, 'workbench')
        const id = read?.regions.main.find((slot) => slot.cardId === 'example.training-curves')?.args?.instanceId
        if (!id) throw new Error('missing instance id')
        expect(lines.getLayout(1, 'workbench')?.regions.main.find((slot) => slot.cardId === 'example.training-curves')?.args?.instanceId).toBe(id)
        const reused = lines.bindTrainingLine(1, { lineId: line.id, run: 'exp-1', metrics: ['loss'] })
        expect(reused.instanceId).toBe(id)
        expect(reused.layout.regions.main.filter((slot) => slot.cardId === 'example.training-curves')).toHaveLength(1)
        const added = lines.bindTrainingLine(1, { lineId: line.id, run: 'exp-1', metrics: ['loss'], xAxis: '_step' })
        expect(added.instanceId).not.toBe(id)
        expect(lines.listTrainingCards(1, 'exp-1')).toEqual([
            { instanceId: id, lineId: line.id, metrics: ['loss'] },
            { instanceId: added.instanceId, lineId: line.id, metrics: ['loss'], xAxis: '_step' },
        ])
        expect(lines.unbindTrainingCard(1, id!).regions.main.some((slot) => slot.args?.instanceId === id)).toBe(false)
    })
})

describe('schema 27', () => {
    it('migrates a v26 database and does not create work_training_points', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-worklines-'))
        const path = join(dir, 'hub.sqlite')
        const created = new Store(path)
        created.close()
        const legacy = new Database(path)
        for (const table of ['work_lines', 'work_directories', 'work_sessions', 'work_dismissed', 'work_layouts', 'work_training_runs']) {
            legacy.exec(`DROP TABLE ${table}`)
        }
        legacy.exec('PRAGMA user_version = 26')
        legacy.close()

        const migrated = new Store(path)
        try {
            const db = (migrated as unknown as { db: Database }).db
            const version = db.prepare('PRAGMA user_version').get() as { user_version: number }
            expect(version.user_version).toBe(27)
            const points = db.prepare("SELECT name FROM sqlite_master WHERE name = 'work_training_points'").get()
            expect(points).toBeNull()
            expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'work_training_runs'").get()).toBeTruthy()
        } finally {
            migrated.close()
            rmSync(dir, { recursive: true, force: true })
        }
    })
})
