import { sessionDirectoryGroupKey } from '@/lib/sessionDirectoryGroup'
import type { SessionSummary } from '@/types/api'

export type WorkLineRecord = {
    id: string
    name: string
    goal: string | null
    sort: number
    primaryMachineId: string
    primaryPath: string
}

export type WorkDirectoryRecord = {
    directoryKey: string
    mode: 'line' | 'mixed' | 'ignored'
    lineId: string | null
}

export type WorkSessionRecord = {
    sessionId: string
    lineId: string | null
}

export type WorkMapData = {
    lines: WorkLineRecord[]
    directories: WorkDirectoryRecord[]
    sessions: WorkSessionRecord[]
    dismissed: string[]
}

export type WorkSessionView = {
    id: string
    title: string
    directory: string
    machineId: string | null
    machineLabel: string
    updatedAt: number
    pendingRequestsCount: number
    active: boolean
    lineId: string | null
    ignored: boolean
    inbox: boolean
}

export type WorkModel = {
    lineCount: number
    needsYouCount: number
    runningCount: number
    inboxCount: number
    directoryCount: number
    machineCount: number
    needsYou: WorkSessionView[]
}

const EMPTY_MAP: WorkMapData = { lines: [], directories: [], sessions: [], dismissed: [] }

export function deriveWork(sessions: readonly SessionSummary[], map: WorkMapData | null, titleOf: (session: SessionSummary) => string, machineLabel: (session: SessionSummary) => string): WorkModel {
    const data = map ?? EMPTY_MAP
    const lineIds = new Set(data.lines.map((line) => line.id))
    const directoryByKey = new Map(data.directories.map((row) => [row.directoryKey, row]))
    const sessionById = new Map(data.sessions.map((row) => [row.sessionId, row]))
    const dismissed = new Set(data.dismissed)
    const views = sessions.map((session) => classify(session, lineIds, directoryByKey, sessionById, titleOf, machineLabel))
    const needsYou = views
        .filter((view) => view.pendingRequestsCount > 0 && !view.ignored && !dismissed.has(view.id))
        .sort((a, b) => b.updatedAt - a.updatedAt)
    const lineDirectories = new Set<string>()
    const machines = new Set<string>()
    for (const line of data.lines) {
        lineDirectories.add(`${line.primaryMachineId}::${line.primaryPath}`)
        machines.add(line.primaryMachineId)
    }
    for (const directory of data.directories) {
        if (directory.mode === 'line' && directory.lineId && lineIds.has(directory.lineId)) {
            lineDirectories.add(directory.directoryKey)
            const machineId = directory.directoryKey.split('::')[0]
            if (machineId) machines.add(machineId)
        }
    }
    return {
        lineCount: data.lines.length,
        needsYouCount: needsYou.length,
        runningCount: views.filter((view) => view.active).length,
        inboxCount: views.filter((view) => view.inbox).length,
        directoryCount: lineDirectories.size,
        machineCount: machines.size,
        needsYou,
    }
}

function classify(
    session: SessionSummary,
    lineIds: Set<string>,
    directoryByKey: Map<string, WorkDirectoryRecord>,
    sessionById: Map<string, WorkSessionRecord>,
    titleOf: (session: SessionSummary) => string,
    machineLabel: (session: SessionSummary) => string,
): WorkSessionView {
    const key = sessionDirectoryGroupKey(session)
    const assignment = sessionById.get(session.id)
    const directory = directoryByKey.get(key)
    let lineId: string | null = null
    let ignored = false
    let inbox = false
    if (assignment && assignment.lineId && lineIds.has(assignment.lineId)) {
        lineId = assignment.lineId
    } else if (assignment && assignment.lineId == null) {
        ignored = true
    } else if (directory?.mode === 'line' && directory.lineId && lineIds.has(directory.lineId)) {
        lineId = directory.lineId
    } else if (directory?.mode === 'ignored') {
        ignored = true
    } else {
        inbox = true
    }
    return {
        id: session.id,
        title: titleOf(session),
        directory: session.metadata?.worktree?.basePath ?? session.metadata?.path ?? '',
        machineId: session.metadata?.machineId ?? null,
        machineLabel: machineLabel(session),
        updatedAt: session.updatedAt,
        pendingRequestsCount: session.pendingRequestsCount,
        active: session.active,
        lineId,
        ignored,
        inbox,
    }
}

export type WorkDirectoryView = {
    directoryKey: string
    machineId: string
    path: string
    sessionCount: number
}

export type WorkbenchModel = {
    lines: Array<WorkLineRecord & { sessionCount: number }>
    inboxDirectoryCount: number
    inboxDirectories: WorkDirectoryView[]
    inboxSessions: WorkSessionView[]
    lineDirectories: (lineId: string) => WorkDirectoryView[]
    lineSessions: (lineId: string) => WorkSessionView[]
    focus: (lineId: string) => WorkSessionView | null
}

export function deriveWorkbench(sessions: readonly SessionSummary[], map: WorkMapData | null, titleOf: (session: SessionSummary) => string, machineLabel: (session: SessionSummary) => string): WorkbenchModel {
    const data = map ?? EMPTY_MAP
    const lineIds = new Set(data.lines.map((line) => line.id))
    const directoryByKey = new Map(data.directories.map((row) => [row.directoryKey, row]))
    const sessionById = new Map(data.sessions.map((row) => [row.sessionId, row]))
    const dismissed = new Set(data.dismissed)
    const views = sessions.map((session) => classify(session, lineIds, directoryByKey, sessionById, titleOf, machineLabel))
    const inboxSessions = views.filter((view) => view.inbox)
    const inboxKeys = new Set<string>()
    for (const view of inboxSessions) {
        const key = directoryKeyOf(view)
        if (!directoryByKey.has(key)) inboxKeys.add(key)
    }
    const countByKey = new Map<string, number>()
    for (const view of views) {
        const key = directoryKeyOf(view)
        countByKey.set(key, (countByKey.get(key) ?? 0) + 1)
    }
    const directoryView = (key: string): WorkDirectoryView => {
        const split = key.indexOf('::')
        return {
            directoryKey: key,
            machineId: split > 0 ? key.slice(0, split) : '',
            path: split > 0 ? key.slice(split + 2) : key,
            sessionCount: countByKey.get(key) ?? 0,
        }
    }
    return {
        lines: data.lines.map((line) => ({
            ...line,
            sessionCount: views.filter((view) => view.lineId === line.id).length,
        })),
        inboxDirectoryCount: inboxKeys.size,
        inboxDirectories: [...inboxKeys].map(directoryView),
        inboxSessions,
        lineDirectories: (lineId) => {
            const line = data.lines.find((item) => item.id === lineId)
            if (!line) return []
            const keys = new Set<string>([`${line.primaryMachineId}::${line.primaryPath}`])
            for (const directory of data.directories) {
                if (directory.mode === 'line' && directory.lineId === lineId) keys.add(directory.directoryKey)
            }
            return [...keys].map(directoryView)
        },
        lineSessions: (lineId) => views.filter((view) => view.lineId === lineId).sort((a, b) => b.updatedAt - a.updatedAt),
        focus: (lineId) => {
            const mine = views.filter((view) => view.lineId === lineId)
            const waiting = mine.filter((view) => view.pendingRequestsCount > 0 && !dismissed.has(view.id)).sort((a, b) => b.updatedAt - a.updatedAt)
            if (waiting[0]) return waiting[0]
            return [...mine].sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null
        },
    }
}

function directoryKeyOf(view: WorkSessionView): string {
    return `${view.machineId ?? '__unknown__'}::${view.directory || 'Other'}`
}
