import { memo } from 'react'
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

type OmpTrackedItem = ChecklistItem & {
    phase?: string
}

function inferOmpItemPhase(item: ChecklistItem): string | undefined {
    if (!item.id) return undefined
    const match = /^(.+):\d+$/.exec(item.id)
    return match ? match[1] : undefined
}

function ompDocumentDefinesTasks(doc: string): boolean {
    for (const rawLine of doc.split('\n')) {
        const line = rawLine.trim()
        if (/^(?:INIT|ADD)\s+"/.test(line)) return true
    }
    return false
}

export function applyOmpTodoDocument(
    doc: string,
    baseItems: readonly ChecklistItem[] = []
): ChecklistItem[] {
    let items: OmpTrackedItem[] = baseItems.map((item) => ({
        ...item,
        phase: inferOmpItemPhase(item)
    }))
    let currentPhase: string | undefined

    for (const rawLine of doc.split('\n')) {
        const line = rawLine.trim()
        if (!line || line === '*** Begin Todo' || line === '*** End Todo' || line === 'VIEW') {
            continue
        }
        if (/^INIT\s+"/.test(line)) {
            items = []
            currentPhase = 'Tasks'
            continue
        }
        const phaseMatch = /^PHASE\s+"((?:\\.|[^"\\])+)"/.exec(line)
        if (phaseMatch) {
            const phaseName = phaseMatch[1].replace(/\\"/g, '"').trim()
            if (phaseName) currentPhase = phaseName
            continue
        }
        if (/^DONE\s+ALL(?:\s|$)/.test(line)) {
            items = items.map((item) => ({ ...item, status: 'completed' }))
            continue
        }
        const donePhaseMatch = /^DONE\s+PHASE\s+"((?:\\.|[^"\\])+)"/.exec(line)
        if (donePhaseMatch) {
            const phaseName = donePhaseMatch[1].replace(/\\"/g, '"').trim()
            if (phaseName) {
                const hasMatchingPhase = items.some((item) => item.phase === phaseName)
                items = items.map((item) =>
                    !hasMatchingPhase || item.phase === phaseName
                        ? { ...item, status: 'completed' }
                        : item
                )
            }
            continue
        }
        if (/^(?:DROP|RM)\s+ALL(?:\s|$)/.test(line)) {
            items = []
            continue
        }
        const dropPhaseMatch = /^(?:DROP|RM)\s+PHASE\s+"((?:\\.|[^"\\])+)"/.exec(line)
        if (dropPhaseMatch) {
            const phaseName = dropPhaseMatch[1].replace(/\\"/g, '"').trim()
            if (phaseName) {
                items = items.filter((item) => item.phase !== phaseName)
            }
            continue
        }
        const match = /^(ADD|START|DONE|BLOCK|UNBLOCK|DROP|RM)\s+"((?:\\.|[^"\\])+)"/.exec(line)
        if (!match) continue
        const [, op, rawTitle] = match
        const text = rawTitle.replace(/\\"/g, '"').trim()
        if (!text) continue

        if (op === 'DROP' || op === 'RM') {
            items = items.filter((item) => item.text !== text)
            continue
        }

        const existingIdx = items.findIndex((item) => item.text === text)
        if (op === 'ADD') {
            if (existingIdx === -1) {
                items.push({ text, status: 'pending', phase: currentPhase })
            } else if (currentPhase && !items[existingIdx]!.phase) {
                items[existingIdx] = { ...items[existingIdx]!, phase: currentPhase }
            }
        } else if (op === 'START') {
            items = items.map((item) =>
                item.status === 'in_progress' && item.text !== text
                    ? { ...item, status: 'pending' }
                    : item
            )
            if (existingIdx >= 0) {
                items[existingIdx] = { ...items[existingIdx]!, status: 'in_progress' }
            } else {
                items.push({ text, status: 'in_progress', phase: currentPhase })
            }
        } else if (op === 'DONE') {
            if (existingIdx >= 0) {
                items[existingIdx] = { ...items[existingIdx]!, status: 'completed' }
            } else {
                items.push({ text, status: 'completed', phase: currentPhase })
            }
        } else if (op === 'BLOCK') {
            if (existingIdx >= 0) {
                items[existingIdx] = { ...items[existingIdx]!, status: 'blocked' }
            } else {
                items.push({ text, status: 'blocked', phase: currentPhase })
            }
        } else if (op === 'UNBLOCK') {
            if (existingIdx >= 0) {
                items[existingIdx] = { ...items[existingIdx]!, status: 'pending' }
            } else {
                items.push({ text, status: 'pending', phase: currentPhase })
            }
        }
    }

    return items.map(({ id, text, status }) => (id !== undefined ? { id, text, status } : { text, status }))
}

export type OmpTodoTurnCall = {
    input: unknown
    result: unknown
}

export type OmpTodoTurnContext = {
    touchedPhases: ReadonlySet<string>
    touchedTasks: ReadonlySet<string>
    isInit: boolean
    calls?: ReadonlyArray<OmpTodoTurnCall>
    fallbackItems?: readonly ChecklistItem[]
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

function isOmpCallResultError(result: unknown): boolean {
    return isObject(result) && (result.isError === true || result.is_error === true)
}

export function collectOmpTodoTurnContext(
    calls: ReadonlyArray<OmpTodoTurnCall>,
    fallbackItems?: readonly ChecklistItem[]
): OmpTodoTurnContext {
    const touchedPhases = new Set<string>()
    const touchedTasks = new Set<string>()
    const validCalls: OmpTodoTurnCall[] = []
    let isInit = false
    for (const call of calls) {
        if (isOmpCallResultError(call.result)) continue
        validCalls.push(call)
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
    return { touchedPhases, touchedTasks, isInit, calls: validCalls, fallbackItems }
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

function scopeChecklistItemsByOmpPhaseId(items: ChecklistItem[]): ChecklistItem[] {
    if (items.length <= 1) return items
    const phaseGroups: ChecklistItem[][] = []
    let currentPhase = ''
    for (const item of items) {
        if (!item.id) return items
        const match = /^(.+):\d+$/.exec(item.id)
        if (!match) return items
        const phaseName = match[1]
        if (phaseGroups.length === 0 || phaseName !== currentPhase) {
            currentPhase = phaseName
            phaseGroups.push([item])
        } else {
            phaseGroups[phaseGroups.length - 1]!.push(item)
        }
    }
    if (phaseGroups.length <= 1) return items
    const firstActiveIdx = phaseGroups.findIndex((group) =>
        group.some((item) => item.status === 'in_progress' || item.status === 'pending')
    )
    const firstUnfinishedIdx = firstActiveIdx >= 0
        ? firstActiveIdx
        : phaseGroups.findIndex((group) => group.some((item) => item.status !== 'completed'))
    if (firstUnfinishedIdx >= 0) {
        return phaseGroups.slice(firstUnfinishedIdx).flat()
    }
    return phaseGroups[phaseGroups.length - 1]!
}

function extractStructuredTodoChecklist(
    input: unknown,
    result: unknown,
    turnContext?: OmpTodoTurnContext
): ChecklistItem[] | null {
    if (isObject(input) && Array.isArray(input.todos)) {
        const items = parseChecklistEntries(input.todos, {
            textKey: 'content',
            idKey: 'id'
        })
        if (items.length > 0) {
            return scopeChecklistItemsByOmpPhaseId(items)
        }
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
        const items = parseChecklistEntries(result.newTodos, {
            textKey: 'content',
            idKey: 'id'
        })
        if (items.length > 0) return items
    }

    return null
}

function extractCompletedTasksFromOmpDetails(result: unknown): ChecklistItem[] {
    const resolved = resolveOmpRawDetails(result)
    if (!resolved || !Array.isArray(resolved.raw.completedTasks)) return []
    const items: ChecklistItem[] = []
    for (const entry of resolved.raw.completedTasks) {
        if (!isObject(entry)) continue
        const text = typeof entry.content === 'string' && entry.content.trim() !== ''
            ? entry.content.trim()
            : typeof entry.task === 'string' && entry.task.trim() !== ''
                ? entry.task.trim()
                : null
        if (!text) continue
        const id = typeof entry.id === 'string' && entry.id !== '' ? entry.id : undefined
        items.push(id !== undefined ? { id, text, status: 'completed' } : { text, status: 'completed' })
    }
    return items
}

export function extractTodoChecklist(
    input: unknown,
    result: unknown,
    turnContext?: OmpTodoTurnContext
): ChecklistItem[] {
    if (isOmpCallResultError(result)) return []

    const structured = extractStructuredTodoChecklist(input, result, turnContext)
    if (structured !== null) return structured

    if (isObject(input) && typeof input.input === 'string' && input.input.includes('*** Begin Todo')) {
        if (turnContext?.calls && turnContext.calls.length > 0) {
            const turnDefinesOwnTasks = turnContext.calls.some((call) => {
                if (extractStructuredTodoChecklist(call.input, call.result, turnContext) !== null) return true
                return (
                    isObject(call.input)
                    && typeof call.input.input === 'string'
                    && ompDocumentDefinesTasks(call.input.input)
                )
            }) || ompDocumentDefinesTasks(input.input)

            let runningItems: ChecklistItem[] =
                !turnDefinesOwnTasks && turnContext.fallbackItems
                    ? turnContext.fallbackItems.map((item) => ({ ...item }))
                    : []
            let reachedTarget = false
            for (const call of turnContext.calls) {
                if (isOmpCallResultError(call.result)) continue
                const callStructured = extractStructuredTodoChecklist(call.input, call.result, turnContext)
                if (callStructured !== null) {
                    runningItems = callStructured.map((item) => ({ ...item }))
                } else if (
                    isObject(call.input)
                    && typeof call.input.input === 'string'
                    && call.input.input.includes('*** Begin Todo')
                ) {
                    runningItems = applyOmpTodoDocument(call.input.input, runningItems)
                }
                if (call.input === input) {
                    reachedTarget = true
                    break
                }
            }
            if (!reachedTarget) {
                runningItems = applyOmpTodoDocument(input.input, runningItems)
            }
            if (runningItems.length > 0) return runningItems
        }

        const completedFromDetails = extractCompletedTasksFromOmpDetails(result)
        const seedItems = completedFromDetails.length > 0
            ? completedFromDetails
            : !ompDocumentDefinesTasks(input.input) && turnContext?.fallbackItems
                ? turnContext.fallbackItems
                : []
        return applyOmpTodoDocument(input.input, seedItems)
    }

    return extractCompletedTasksFromOmpDetails(result)
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
    if (item.status === 'blocked') return 'text-[var(--app-hint)]'
    return 'text-[var(--app-hint)]'
}

function checklistIcon(item: ChecklistItem): ReactNode {
    if (item.status === 'completed') return '☑'
    if (item.status === 'in_progress') return '◉'
    if (item.status === 'blocked') return '⏸'
    return '☐'
}

export const ChecklistList = memo(function ChecklistList(props: { items: ChecklistItem[]; emptyLabel?: string | null }) {
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
})
