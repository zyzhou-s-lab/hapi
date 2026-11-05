import type { ReactNode } from 'react'
import { isObject } from '@hapi/protocol'

export type ChecklistStatus = 'pending' | 'in_progress' | 'completed' | 'blocked'

export type ChecklistItem = {
    id?: string
    text: string
    status: ChecklistStatus
}

function normalizeChecklistStatus(value: unknown): ChecklistStatus {
    if (value === 'completed') return 'completed'
    if (value === 'in_progress') return 'in_progress'
    if (value === 'blocked') return 'blocked'
    return 'pending'
}

function parseChecklistEntries(
    entries: unknown,
    opts: {
        textKey: 'content' | 'step'
        idKey?: string
    }
): ChecklistItem[] {
    if (!Array.isArray(entries)) return []

    const items: ChecklistItem[] = []
    for (const entry of entries) {
        if (!isObject(entry)) continue

        const text = entry[opts.textKey]
        if (typeof text !== 'string') continue

        const idValue = opts.idKey ? entry[opts.idKey] : undefined
        items.push({
            id: typeof idValue === 'string' && idValue !== '' ? idValue : undefined,
            text,
            status: entry.blocked === true ? 'blocked' : normalizeChecklistStatus(entry.status)
        })
    }

    return items
}

function parseOmpTodoDocument(doc: string): ChecklistItem[] {
    const byTitle = new Map<string, ChecklistItem>()
    for (const rawLine of doc.split('\n')) {
        const line = rawLine.trim()
        const match = /^(ADD|START|DONE)\s+"((?:\\.|[^"\\])+)"/.exec(line)
        if (!match) continue
        const [, op, rawTitle] = match
        const text = rawTitle.replace(/\\"/g, '"').trim()
        if (!text) continue
        if (op === 'ADD') {
            if (!byTitle.has(text)) {
                byTitle.set(text, { text, status: 'pending' })
            }
        } else if (op === 'START') {
            byTitle.set(text, { text, status: 'in_progress' })
        } else if (op === 'DONE') {
            byTitle.set(text, { text, status: 'completed' })
        }
    }
    return Array.from(byTitle.values())
}

export type OmpTodoTurnContext = {
    touchedPhases: ReadonlySet<string>
    touchedTasks: ReadonlySet<string>
    isInit: boolean
}

function isOmpPhaseTerminal(phase: Record<string, unknown>): boolean {
    if (!Array.isArray(phase.tasks)) return true
    for (const task of phase.tasks) {
        if (!isObject(task) || typeof task.content !== 'string') continue
        if (task.blocked === true) return false
        if (task.status !== 'completed' && task.status !== 'abandoned') return false
    }
    return true
}

function collectOmpTodoTargetsFromCall(
    input: unknown,
    rawDetails: Record<string, unknown> | null,
    phases: Set<string>,
    tasks: Set<string>
): boolean {
    let isInit = false
    if (rawDetails) {
        if (
            rawDetails.op === 'init'
            || (Array.isArray(rawDetails.operations) && rawDetails.operations.includes('init'))
            || (Array.isArray(rawDetails.changes) && rawDetails.changes.some((c) => isObject(c) && c.op === 'init'))
        ) {
            isInit = true
        }
        if (Array.isArray(rawDetails.changes)) {
            for (const change of rawDetails.changes) {
                if (!isObject(change)) continue
                if (typeof change.phase === 'string' && change.phase !== '') phases.add(change.phase)
                if (typeof change.task === 'string' && change.task !== '') tasks.add(change.task)
                if (Array.isArray(change.items)) {
                    for (const item of change.items) {
                        if (isObject(item) && typeof item.title === 'string' && item.title !== '') {
                            tasks.add(item.title)
                        }
                    }
                }
                if (Array.isArray(change.list)) {
                    for (const group of change.list) {
                        if (!isObject(group)) continue
                        if (typeof group.phase === 'string' && group.phase !== '') phases.add(group.phase)
                        if (Array.isArray(group.items)) {
                            for (const item of group.items) {
                                if (isObject(item) && typeof item.title === 'string' && item.title !== '') {
                                    tasks.add(item.title)
                                }
                            }
                        }
                    }
                }
            }
        }
        if (Array.isArray(rawDetails.completedTasks)) {
            for (const entry of rawDetails.completedTasks) {
                if (!isObject(entry)) continue
                if (typeof entry.phase === 'string' && entry.phase !== '') phases.add(entry.phase)
                if (typeof entry.task === 'string' && entry.task !== '') tasks.add(entry.task)
                if (typeof entry.content === 'string' && entry.content !== '') tasks.add(entry.content)
            }
        }
    }
    if (isObject(input) && typeof input.input === 'string') {
        for (const rawLine of input.input.split('\n')) {
            const line = rawLine.trim()
            if (/^INIT\s+"/.test(line)) {
                isInit = true
                continue
            }
            const phaseMatch = /^PHASE\s+"((?:\\.|[^"\\])+)"/.exec(line)
            if (phaseMatch) {
                const name = phaseMatch[1].replace(/\\"/g, '"').trim()
                if (name) phases.add(name)
                continue
            }
            const taskMatch = /^(?:ADD|START|DONE|BLOCK|UNBLOCK|DROP|RM)\s+"((?:\\.|[^"\\])+)"/.exec(line)
            if (taskMatch) {
                const title = taskMatch[1].replace(/\\"/g, '"').trim()
                if (title) tasks.add(title)
            }
        }
    }
    return isInit
}

function resolveOmpRawDetails(result: unknown): { phases: unknown[]; raw: Record<string, unknown> } | null {
    if (!isObject(result)) return null
    if (Array.isArray(result.phases)) {
        return { phases: result.phases, raw: result }
    }
    if (isObject(result.details) && Array.isArray(result.details.phases)) {
        return { phases: result.details.phases, raw: result.details }
    }
    return null
}

export function collectOmpTodoTurnContext(
    calls: ReadonlyArray<{ input: unknown; result: unknown }>
): OmpTodoTurnContext {
    const touchedPhases = new Set<string>()
    const touchedTasks = new Set<string>()
    let isInit = false
    for (const call of calls) {
        const resolved = resolveOmpRawDetails(call.result)
        if (collectOmpTodoTargetsFromCall(call.input, resolved?.raw ?? null, touchedPhases, touchedTasks)) {
            isInit = true
        }
        if (resolved) {
            for (const phase of resolved.phases) {
                if (!isObject(phase) || !Array.isArray(phase.tasks)) continue
                if (!isOmpPhaseTerminal(phase)) {
                    if (typeof phase.name === 'string' && phase.name !== '') {
                        touchedPhases.add(phase.name)
                    }
                    for (const task of phase.tasks) {
                        if (isObject(task) && typeof task.content === 'string' && task.content !== '') {
                            touchedTasks.add(task.content)
                        }
                    }
                }
            }
        }
    }
    return { touchedPhases, touchedTasks, isInit }
}

function selectRelevantOmpPhases(
    phases: unknown[],
    rawDetails: Record<string, unknown>,
    input: unknown,
    turnContext?: OmpTodoTurnContext
): unknown[] {
    const validPhases = phases.filter((phase): phase is Record<string, unknown> => isObject(phase) && Array.isArray(phase.tasks))
    if (validPhases.length <= 1) return validPhases

    const touchedPhases = new Set<string>(turnContext?.touchedPhases)
    const touchedTasks = new Set<string>(turnContext?.touchedTasks)
    const isInit = collectOmpTodoTargetsFromCall(input, rawDetails, touchedPhases, touchedTasks) || Boolean(turnContext?.isInit)
    if (isInit) return validPhases

    const isRelevant = (phase: Record<string, unknown>): boolean => {
        if (!isOmpPhaseTerminal(phase)) return true
        if (typeof phase.name === 'string' && touchedPhases.has(phase.name)) return true
        const tasks = Array.isArray(phase.tasks) ? phase.tasks : []
        return tasks.some(
            (task) => isObject(task) && typeof task.content === 'string' && touchedTasks.has(task.content)
        )
    }

    const firstRelevantIdx = validPhases.findIndex(isRelevant)
    if (firstRelevantIdx > 0) {
        return validPhases.slice(firstRelevantIdx)
    }
    if (firstRelevantIdx === -1) {
        for (let i = validPhases.length - 1; i >= 0; i -= 1) {
            const phase = validPhases[i]
            const tasks = Array.isArray(phase.tasks) ? phase.tasks : []
            const hasVisible = tasks.some(
                (task) => isObject(task) && typeof task.content === 'string' && task.status !== 'abandoned'
            )
            if (hasVisible) {
                return [phase]
            }
        }
    }
    return validPhases
}

export function extractTodoChecklist(
    input: unknown,
    result: unknown,
    turnContext?: OmpTodoTurnContext
): ChecklistItem[] {
    if (isObject(input) && Array.isArray(input.todos)) {
        const items = parseChecklistEntries(input.todos, {
            textKey: 'content',
            idKey: 'id'
        })
        if (items.length > 0) return items
    }

    // OMP `todo` results store the live list under details.phases[].tasks[].
    const resolved = resolveOmpRawDetails(result)
    if (resolved) {
        const items: ChecklistItem[] = []
        for (const phase of selectRelevantOmpPhases(resolved.phases, resolved.raw, input, turnContext)) {
            if (!isObject(phase) || !Array.isArray(phase.tasks)) continue
            items.push(...parseChecklistEntries(phase.tasks, {
                textKey: 'content',
                idKey: 'id'
            }))
        }
        if (items.length > 0) return items
    }
    if (isObject(result) && Array.isArray(result.newTodos)) {
        return parseChecklistEntries(result.newTodos, {
            textKey: 'content',
            idKey: 'id'
        })
    }

    if (isObject(input) && typeof input.input === 'string' && input.input.includes('*** Begin Todo')) {
        return parseOmpTodoDocument(input.input)
    }

    return []
}

export function extractUpdatePlanChecklist(input: unknown, result: unknown): ChecklistItem[] {
    if (isObject(input) && Object.prototype.hasOwnProperty.call(input, 'plan')) {
        return parseChecklistEntries(input.plan, {
            textKey: 'step'
        })
    }

    if (isObject(result)) {
        return parseChecklistEntries(result.plan, {
            textKey: 'step'
        })
    }

    return []
}

function checklistTone(item: ChecklistItem): string {
    if (item.status === 'completed') return 'text-emerald-600 line-through'
    if (item.status === 'in_progress') return 'text-[var(--app-link)]'
    if (item.status === 'blocked') return 'text-red-500'
    return 'text-[var(--app-hint)]'
}

function checklistIcon(item: ChecklistItem): ReactNode {
    if (item.status === 'completed') return '☑'
    if (item.status === 'in_progress') return '◉'
    if (item.status === 'blocked') return '⚠'
    return '☐'
}

export function ChecklistList(props: { items: ChecklistItem[]; emptyLabel?: string | null }) {
    if (props.items.length === 0) {
        return props.emptyLabel ? (
            <div className="text-sm text-[var(--app-hint)]">{props.emptyLabel}</div>
        ) : null
    }

    return (
        <div className="flex flex-col gap-1">
            {props.items.map((item, idx) => {
                const text = item.text.trim().length > 0 ? item.text.trim() : '(empty)'
                return (
                    <div key={item.id ? item.id : String(idx)} className={`text-sm ${checklistTone(item)}`}>
                        {checklistIcon(item)} {text}
                    </div>
                )
            })}
        </div>
    )
}
