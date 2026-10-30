import type { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'

export const WORK_LINES_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS work_lines (
    account_id INTEGER NOT NULL,
    id TEXT NOT NULL,
    name TEXT NOT NULL,
    goal TEXT,
    sort INTEGER NOT NULL,
    primary_machine_id TEXT NOT NULL,
    primary_path TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (account_id, id)
);
CREATE TABLE IF NOT EXISTS work_directories (
    account_id INTEGER NOT NULL,
    directory_key TEXT NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('line', 'mixed', 'ignored')),
    line_id TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (account_id, directory_key)
);
CREATE TABLE IF NOT EXISTS work_sessions (
    account_id INTEGER NOT NULL,
    session_id TEXT NOT NULL,
    line_id TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (account_id, session_id)
);
CREATE TABLE IF NOT EXISTS work_dismissed (
    account_id INTEGER NOT NULL,
    session_id TEXT NOT NULL,
    dismissed_at INTEGER NOT NULL,
    PRIMARY KEY (account_id, session_id)
);
CREATE TABLE IF NOT EXISTS work_layouts (
    account_id INTEGER NOT NULL,
    surface TEXT NOT NULL CHECK (surface IN ('overview', 'workbench')),
    json TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (account_id, surface)
);
CREATE TABLE IF NOT EXISTS work_training_runs (
    account_id INTEGER NOT NULL,
    run TEXT NOT NULL,
    machine_id TEXT NOT NULL,
    run_dir TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (account_id, run)
);
`

const NAME_MAX = 60
const GOAL_MAX = 200
const DIRECTORY_KEY_MAX = 1024
const SESSION_ID_MAX = 200
const RUN_MAX = 120
const LAYOUT_REGION_MAX = 40
const LAYOUT_ARGS_MAX = 8
const LAYOUT_VALUE_MAX = 200
const CARD_ID = /^[a-z0-9]+(-[a-z0-9]+)*(\.[a-z0-9]+(-[a-z0-9]+)*)+$/

const LAYOUT_REGIONS = {
    overview: ['stats', 'body'],
    workbench: ['rail', 'main', 'side']
} as const

export type WorkSurface = keyof typeof LAYOUT_REGIONS
export type WorkDirectoryMode = 'line' | 'mixed' | 'ignored'

export type WorkLine = {
    id: string
    name: string
    goal: string | null
    sort: number
    primaryMachineId: string
    primaryPath: string
    createdAt: number
    updatedAt: number
}

export type WorkDirectory = {
    directoryKey: string
    mode: WorkDirectoryMode
    lineId: string | null
    updatedAt: number
}

export type WorkSessionRow = {
    sessionId: string
    lineId: string | null
    updatedAt: number
}

export type WorkMap = {
    lines: WorkLine[]
    directories: WorkDirectory[]
    sessions: WorkSessionRow[]
    dismissed: string[]
}

export type WorkLayoutSlot = {
    cardId: string
    args?: Record<string, string>
}

export type WorkLayout = {
    revision: number
    regions: Record<string, WorkLayoutSlot[]>
}

export type WorkTrainingRun = {
    run: string
    machineId: string
    runDir: string
    createdAt: number
}

export class WorkMapError extends Error {
    constructor(message: string, readonly status: 400 | 404 = 400) {
        super(message)
        this.name = 'WorkMapError'
    }
}

type LineRow = {
    id: string
    name: string
    goal: string | null
    sort: number
    primary_machine_id: string
    primary_path: string
    created_at: number
    updated_at: number
}

function primaryKey(machineId: string, path: string): string {
    return `${machineId}::${path}`
}

function cleanRequired(value: string, label: string, max: number): string {
    const trimmed = value.trim()
    if (!trimmed || trimmed.length > max) {
        throw new WorkMapError(`${label} 长度不合法`)
    }
    return trimmed
}

function cleanGoal(value: string | null | undefined): string | null {
    if (value == null) return null
    const trimmed = value.trim()
    if (!trimmed) return null
    if (trimmed.length > GOAL_MAX) throw new WorkMapError('goal 长度不合法')
    return trimmed
}

export function isWandbRunDir(path: string): boolean {
    const parts = path.replaceAll('\\', '/').split('/').filter(Boolean)
    if (parts.length < 2) return false
    const parent = parts[parts.length - 2]
    const name = parts[parts.length - 1] ?? ''
    if (parent !== 'wandb') return false
    return /^run-.+$/.test(name) || /^offline-run-.+$/.test(name)
}

function canonicalArgs(args: Record<string, string> | undefined): string {
    if (!args) return ''
    const keys = Object.keys(args).sort()
    return JSON.stringify(keys.map((key) => [key, args[key]]))
}

export class WorkLinesStore {
    constructor(private readonly db: Database) {}

    getMap(accountId: number): WorkMap {
        const lines = (this.db.prepare(
            'SELECT id, name, goal, sort, primary_machine_id, primary_path, created_at, updated_at FROM work_lines WHERE account_id = ? ORDER BY sort, created_at'
        ).all(accountId) as LineRow[]).map(toLine)
        const directories = (this.db.prepare(
            'SELECT directory_key, mode, line_id, updated_at FROM work_directories WHERE account_id = ? ORDER BY directory_key'
        ).all(accountId) as Array<{ directory_key: string; mode: WorkDirectoryMode; line_id: string | null; updated_at: number }>).map((row) => ({
            directoryKey: row.directory_key,
            mode: row.mode,
            lineId: row.line_id,
            updatedAt: row.updated_at
        }))
        const sessions = (this.db.prepare(
            'SELECT session_id, line_id, updated_at FROM work_sessions WHERE account_id = ? ORDER BY session_id'
        ).all(accountId) as Array<{ session_id: string; line_id: string | null; updated_at: number }>).map((row) => ({
            sessionId: row.session_id,
            lineId: row.line_id,
            updatedAt: row.updated_at
        }))
        const dismissed = (this.db.prepare(
            'SELECT session_id FROM work_dismissed WHERE account_id = ? ORDER BY session_id'
        ).all(accountId) as Array<{ session_id: string }>).map((row) => row.session_id)
        return { lines, directories, sessions, dismissed }
    }

    createLine(accountId: number, input: {
        name: string
        goal?: string | null
        sort?: number
        primaryMachineId: string
        primaryPath: string
    }): WorkLine {
        const name = cleanRequired(input.name, 'name', NAME_MAX)
        const goal = cleanGoal(input.goal)
        const sort = input.sort ?? 0
        if (!Number.isInteger(sort)) throw new WorkMapError('sort 必须是整数')
        const machineId = cleanRequired(input.primaryMachineId, 'primaryMachineId', 200)
        const path = cleanRequired(input.primaryPath, 'primaryPath', DIRECTORY_KEY_MAX)
        const key = primaryKey(machineId, path)
        if (key.length > DIRECTORY_KEY_MAX) throw new WorkMapError('directory_key 长度不合法')
        const now = Date.now()
        const id = randomUUID()
        this.db.transaction(() => {
            this.assertDirectoryFree(accountId, key, id)
            this.db.prepare(`
                INSERT INTO work_lines (account_id, id, name, goal, sort, primary_machine_id, primary_path, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(accountId, id, name, goal, sort, machineId, path, now, now)
            this.upsertDirectory(accountId, key, 'line', id, now)
        })()
        return this.requireLine(accountId, id)
    }

    updateLine(accountId: number, id: string, input: {
        name?: string
        goal?: string | null
        sort?: number
        primaryMachineId?: string
        primaryPath?: string
    }): WorkLine {
        const existing = this.requireLine(accountId, id)
        const name = input.name === undefined ? existing.name : cleanRequired(input.name, 'name', NAME_MAX)
        const goal = input.goal === undefined ? existing.goal : cleanGoal(input.goal)
        const sort = input.sort === undefined ? existing.sort : input.sort
        if (!Number.isInteger(sort)) throw new WorkMapError('sort 必须是整数')
        const changingPrimary = input.primaryMachineId !== undefined || input.primaryPath !== undefined
        if (changingPrimary && (input.primaryMachineId === undefined || input.primaryPath === undefined)) {
            throw new WorkMapError('改主目录必须同时给出机器和路径')
        }
        const machineId = changingPrimary ? cleanRequired(input.primaryMachineId ?? '', 'primaryMachineId', 200) : existing.primaryMachineId
        const path = changingPrimary ? cleanRequired(input.primaryPath ?? '', 'primaryPath', DIRECTORY_KEY_MAX) : existing.primaryPath
        const key = primaryKey(machineId, path)
        if (key.length > DIRECTORY_KEY_MAX) throw new WorkMapError('directory_key 长度不合法')
        const now = Date.now()
        this.db.transaction(() => {
            if (changingPrimary) this.assertDirectoryFree(accountId, key, id)
            this.db.prepare(`
                UPDATE work_lines
                SET name = ?, goal = ?, sort = ?, primary_machine_id = ?, primary_path = ?, updated_at = ?
                WHERE account_id = ? AND id = ?
            `).run(name, goal, sort, machineId, path, now, accountId, id)
            if (changingPrimary) this.upsertDirectory(accountId, key, 'line', id, now)
        })()
        return this.requireLine(accountId, id)
    }

    deleteLine(accountId: number, id: string): void {
        this.requireLine(accountId, id)
        this.db.transaction(() => {
            this.db.prepare('DELETE FROM work_directories WHERE account_id = ? AND line_id = ?').run(accountId, id)
            this.db.prepare('DELETE FROM work_sessions WHERE account_id = ? AND line_id = ?').run(accountId, id)
            this.db.prepare('DELETE FROM work_lines WHERE account_id = ? AND id = ?').run(accountId, id)
        })()
    }

    putDirectory(accountId: number, input: {
        directoryKey: string
        mode: WorkDirectoryMode | null
        lineId?: string | null
    }): void {
        const key = cleanRequired(input.directoryKey, 'directory_key', DIRECTORY_KEY_MAX)
        if (input.mode === null) {
            const owner = this.db.prepare(
                'SELECT id FROM work_lines WHERE account_id = ? AND primary_machine_id || \'::\' || primary_path = ?'
            ).get(accountId, key) as { id: string } | null
            if (owner) throw new WorkMapError('不能删掉主线当前的主目录，先改主目录或删主线')
            this.db.prepare('DELETE FROM work_directories WHERE account_id = ? AND directory_key = ?').run(accountId, key)
            return
        }
        if (input.mode === 'line') {
            const lineId = input.lineId ?? null
            if (!lineId) throw new WorkMapError('mode=line 必须指向主线')
            this.requireLine(accountId, lineId)
            this.assertDirectoryFree(accountId, key, lineId)
            this.upsertDirectory(accountId, key, 'line', lineId, Date.now())
            return
        }
        if (input.lineId) throw new WorkMapError('只有 mode=line 能带 lineId')
        const owner = this.db.prepare(
            'SELECT id FROM work_lines WHERE account_id = ? AND primary_machine_id || \'::\' || primary_path = ?'
        ).get(accountId, key) as { id: string } | null
        if (owner) throw new WorkMapError('主目录必须保持 mode=line')
        this.upsertDirectory(accountId, key, input.mode, null, Date.now())
    }

    putSession(accountId: number, input: {
        sessionId: string
        state: 'line' | 'ignored' | 'follow'
        lineId?: string | null
    }): void {
        const sessionId = cleanRequired(input.sessionId, 'session_id', SESSION_ID_MAX)
        if (input.state === 'follow') {
            this.db.prepare('DELETE FROM work_sessions WHERE account_id = ? AND session_id = ?').run(accountId, sessionId)
            return
        }
        const lineId = input.state === 'line' ? (input.lineId ?? null) : null
        if (input.state === 'line') {
            if (!lineId) throw new WorkMapError('归入主线必须给出 lineId')
            this.requireLine(accountId, lineId)
        }
        this.db.prepare(`
            INSERT INTO work_sessions (account_id, session_id, line_id, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT (account_id, session_id) DO UPDATE SET line_id = excluded.line_id, updated_at = excluded.updated_at
        `).run(accountId, sessionId, lineId, Date.now())
    }

    putDismissed(accountId: number, sessionId: string, dismissed: boolean): void {
        const id = cleanRequired(sessionId, 'session_id', SESSION_ID_MAX)
        if (!dismissed) {
            this.db.prepare('DELETE FROM work_dismissed WHERE account_id = ? AND session_id = ?').run(accountId, id)
            return
        }
        this.db.prepare(`
            INSERT INTO work_dismissed (account_id, session_id, dismissed_at)
            VALUES (?, ?, ?)
            ON CONFLICT (account_id, session_id) DO UPDATE SET dismissed_at = excluded.dismissed_at
        `).run(accountId, id, Date.now())
    }

    getLayout(accountId: number, surface: string): WorkLayout | null {
        if (!isSurface(surface)) throw new WorkMapError('未知的 surface')
        const row = this.db.prepare(
            'SELECT json FROM work_layouts WHERE account_id = ? AND surface = ?'
        ).get(accountId, surface) as { json: string } | null
        if (!row) return null
        return normalizeStoredLayout(surface, row.json)
    }

    putLayout(accountId: number, surface: string, layout: unknown): WorkLayout {
        if (!isSurface(surface)) throw new WorkMapError('未知的 surface')
        const normalized = validateLayout(surface, layout)
        this.db.prepare(`
            INSERT INTO work_layouts (account_id, surface, json, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT (account_id, surface) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at
        `).run(accountId, surface, JSON.stringify(normalized), Date.now())
        return normalized
    }

    bindTrainingLine(accountId: number, lineId: string, run: string): WorkLayout {
        const cleanLine = cleanRequired(lineId, 'lineId', LAYOUT_VALUE_MAX)
        const cleanRun = cleanRequired(run, 'run', LAYOUT_VALUE_MAX)
        this.requireLine(accountId, cleanLine)
        if (!this.getTrainingRun(accountId, cleanRun)) throw new WorkMapError('训练不存在', 404)
        const defaults: WorkLayout = {
            revision: 1,
            regions: {
                rail: [{ cardId: 'workbench.line-list' }],
                main: [
                    { cardId: 'workbench.line-header' },
                    { cardId: 'workbench.focus' },
                    { cardId: 'workbench.directories' },
                    { cardId: 'workbench.inbox' },
                ],
                side: [
                    { cardId: 'workbench.sessions' },
                    { cardId: 'workbench.continue' },
                ],
            },
        }
        return this.db.transaction(() => {
            const current = this.getLayout(accountId, 'workbench') ?? defaults
            const main = [...(current.regions.main ?? [])]
            const slot = { cardId: 'example.training-curves', args: { run: cleanRun, lineId: cleanLine } }
            const index = main.findIndex((item) => item.cardId === slot.cardId && item.args?.lineId === cleanLine)
            if (index >= 0) main[index] = slot
            else main.push(slot)
            return this.putLayout(accountId, 'workbench', { revision: current.revision, regions: { ...current.regions, main } })
        })()
    }

    registerTrainingRun(accountId: number, input: { run: string; machineId: string; runDir: string }): WorkTrainingRun {
        const run = cleanRequired(input.run, 'run', RUN_MAX)
        const machineId = cleanRequired(input.machineId, 'machineId', 200)
        const runDir = input.runDir.trim()
        if (!isWandbRunDir(runDir) || runDir.length > DIRECTORY_KEY_MAX) {
            throw new WorkMapError('runDir 必须是 wandb/run-* 或 wandb/offline-run-*')
        }
        const now = Date.now()
        this.db.prepare(`
            INSERT INTO work_training_runs (account_id, run, machine_id, run_dir, created_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT (account_id, run) DO UPDATE SET machine_id = excluded.machine_id, run_dir = excluded.run_dir
        `).run(accountId, run, machineId, runDir, now)
        return this.requireTrainingRun(accountId, run)
    }

    listTrainingRuns(accountId: number): { run: string }[] {
        const rows = this.db.prepare(
            'SELECT run FROM work_training_runs WHERE account_id = ? ORDER BY run'
        ).all(accountId) as { run: string }[]
        return rows.map((row) => ({ run: row.run }))
    }

    getTrainingRun(accountId: number, run: string): WorkTrainingRun | null {
        const row = this.db.prepare(
            'SELECT run, machine_id, run_dir, created_at FROM work_training_runs WHERE account_id = ? AND run = ?'
        ).get(accountId, run) as { run: string; machine_id: string; run_dir: string; created_at: number } | null
        if (!row) return null
        return { run: row.run, machineId: row.machine_id, runDir: row.run_dir, createdAt: row.created_at }
    }

    purgeAccount(accountId: number): void {
        this.db.transaction(() => {
            for (const table of ['work_lines', 'work_directories', 'work_sessions', 'work_dismissed', 'work_layouts', 'work_training_runs']) {
                this.db.prepare(`DELETE FROM ${table} WHERE account_id = ?`).run(accountId)
            }
        })()
    }

    private requireLine(accountId: number, id: string): WorkLine {
        const row = this.db.prepare(
            'SELECT id, name, goal, sort, primary_machine_id, primary_path, created_at, updated_at FROM work_lines WHERE account_id = ? AND id = ?'
        ).get(accountId, id) as LineRow | null
        if (!row) throw new WorkMapError('主线不存在', 404)
        return toLine(row)
    }

    private requireTrainingRun(accountId: number, run: string): WorkTrainingRun {
        const row = this.getTrainingRun(accountId, run)
        if (!row) throw new WorkMapError('训练不存在', 404)
        return row
    }

    private assertDirectoryFree(accountId: number, key: string, lineId: string): void {
        const row = this.db.prepare(
            'SELECT mode, line_id FROM work_directories WHERE account_id = ? AND directory_key = ?'
        ).get(accountId, key) as { mode: string; line_id: string | null } | null
        if (row?.mode === 'line' && row.line_id && row.line_id !== lineId) {
            throw new WorkMapError('这个目录已经属于另一条主线')
        }
    }

    private upsertDirectory(accountId: number, key: string, mode: WorkDirectoryMode, lineId: string | null, now: number): void {
        this.db.prepare(`
            INSERT INTO work_directories (account_id, directory_key, mode, line_id, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT (account_id, directory_key) DO UPDATE SET mode = excluded.mode, line_id = excluded.line_id, updated_at = excluded.updated_at
        `).run(accountId, key, mode, lineId, now)
    }
}

function toLine(row: LineRow): WorkLine {
    return {
        id: row.id,
        name: row.name,
        goal: row.goal,
        sort: row.sort,
        primaryMachineId: row.primary_machine_id,
        primaryPath: row.primary_path,
        createdAt: row.created_at,
        updatedAt: row.updated_at
    }
}

function isSurface(value: string): value is WorkSurface {
    return value === 'overview' || value === 'workbench'
}

function normalizeStoredLayout(surface: WorkSurface, raw: string): WorkLayout {
    const parsed = storedLayoutSchema.safeParse(JSON.parse(raw))
    if (!parsed.success) throw new WorkMapError('布局损坏')
    const allowed = LAYOUT_REGIONS[surface]
    const regions: Record<string, WorkLayoutSlot[]> = {}
    for (const key of allowed) {
        regions[key] = parsed.data.regions[key] ?? []
    }
    return { revision: parsed.data.revision, regions }
}

const storedSlotSchema = z.union([
    z.string().transform((cardId) => ({ cardId })),
    z.object({
        cardId: z.string(),
        args: z.record(z.string(), z.string()).optional()
    })
])

const storedLayoutSchema = z.object({
    revision: z.number().optional().default(0),
    regions: z.record(z.string(), z.array(storedSlotSchema))
})

const writeSlotSchema = z.object({
    cardId: z.string().regex(CARD_ID),
    args: z.record(z.string().min(1).max(LAYOUT_VALUE_MAX), z.string().max(LAYOUT_VALUE_MAX)).optional()
}).superRefine((slot, context) => {
    if (slot.args && Object.keys(slot.args).length > LAYOUT_ARGS_MAX) {
        context.addIssue({ code: 'custom', message: 'args 太多' })
    }
})

function validateLayout(surface: WorkSurface, layout: unknown): WorkLayout {
    const allowed = LAYOUT_REGIONS[surface]
    const parsed = z.object({
        revision: z.number().int().nonnegative(),
        regions: z.record(z.string(), z.array(writeSlotSchema).max(LAYOUT_REGION_MAX))
    }).safeParse(layout)
    if (!parsed.success) throw new WorkMapError('布局不合法')
    const keys = Object.keys(parsed.data.regions)
    if (keys.length !== allowed.length || allowed.some((key) => !keys.includes(key))) {
        throw new WorkMapError('区域名不合法')
    }
    const regions: Record<string, WorkLayoutSlot[]> = {}
    for (const key of allowed) {
        const seen = new Set<string>()
        regions[key] = parsed.data.regions[key]!.map((slot) => {
            const fingerprint = `${slot.cardId}\0${canonicalArgs(slot.args)}`
            if (seen.has(fingerprint)) throw new WorkMapError('同一区域里卡重复')
            seen.add(fingerprint)
            return slot.args ? { cardId: slot.cardId, args: slot.args } : { cardId: slot.cardId }
        })
    }
    return { revision: parsed.data.revision, regions }
}
