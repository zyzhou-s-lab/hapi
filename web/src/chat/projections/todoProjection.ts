import type { ToolCallBlock } from '@/chat/types'

export type CanonicalTodoStatus = 'pending' | 'in_progress' | 'completed' | 'blocked'

export interface CanonicalTodoItem {
    /** Optional: OMP DSL text commands lack ids and match by text; session-level OMP todos use "<phase>:<idx>" ids */
    readonly id?: string
    readonly text: string
    readonly activeForm?: string
    readonly status: CanonicalTodoStatus
}

export interface OmpTodoTurnCall {
    readonly input: unknown
    readonly result?: unknown
}

export interface OmpTodoTurnContext {
    readonly hasInit: boolean
    readonly referencedPhaseNames: ReadonlySet<string>
    readonly calls?: ReadonlyArray<OmpTodoTurnCall>
    readonly fallbackItems?: readonly CanonicalTodoItem[]
}

export interface CanonicalTodoSnapshot {
    readonly items: readonly CanonicalTodoItem[]
    readonly totalCount: number
    readonly completedCount: number
    readonly inProgressCount: number
    readonly pendingCount: number
    readonly blockedCount: number
    readonly activeItem: CanonicalTodoItem | null
    readonly activeLabel: string | null
}

function isObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function normalizeStatus(value: unknown, blocked?: unknown): CanonicalTodoStatus {
    if (value === 'completed' || value === 'in_progress' || value === 'blocked') {
        return value
    }
    if (value === 'pending') {
        return blocked === true ? 'blocked' : 'pending'
    }
    if (typeof value === 'string') {
        const lower = value.trim().toLowerCase().replace(/[\s-]+/g, '_')
        if (lower === 'completed' || lower === 'done' || lower === 'complete') return 'completed'
        if (lower === 'in_progress' || lower === 'inprogress' || lower === 'active' || lower === 'running' || lower === 'started') {
            return 'in_progress'
        }
        if (lower === 'blocked') return 'blocked'
    }
    return blocked === true ? 'blocked' : 'pending'
}

export function resolveTodoToolKind(toolName: string): 'todo' | 'plan' | null {
    const lower = toolName.trim().toLowerCase()
    if (lower === 'todo' || lower === 'todowrite' || lower === 'todo_write') {
        return 'todo'
    }
    if (lower === 'update_plan' || lower === 'updateplan') {
        return 'plan'
    }
    return null
}

interface ParseOptions {
    textKey: string
    fallbackTextKey?: string
}

function parseChecklistEntries(raw: unknown, options: ParseOptions): CanonicalTodoItem[] {
    if (!Array.isArray(raw)) {
        return []
    }

    const items: CanonicalTodoItem[] = []
    for (const entry of raw) {
        if (!isObject(entry)) {
            continue
        }

        const primaryText = entry[options.textKey]
        const fallbackText = options.fallbackTextKey ? entry[options.fallbackTextKey] : undefined
        const textValue = typeof primaryText === 'string'
            ? primaryText
            : typeof fallbackText === 'string'
                ? fallbackText
                : null
        if (!textValue) {
            continue
        }

        const trimmed = textValue.trim()
        if (!trimmed) {
            continue
        }

        const activeFormValue = typeof entry.activeForm === 'string' && entry.activeForm.trim().length > 0
            ? entry.activeForm.trim()
            : undefined

        items.push({
            id: typeof entry.id === 'string' && entry.id.length > 0 ? entry.id : undefined,
            text: trimmed,
            ...(activeFormValue ? { activeForm: activeFormValue } : {}),
            status: normalizeStatus(entry.status, entry.blocked),
        })
    }

    return items
}

function unquoteJsonOrBare(token: string): string {
    const trimmed = token.trim()
    if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
        try {
            const parsed: unknown = JSON.parse(trimmed)
            if (typeof parsed === 'string') return parsed
        } catch {
            return trimmed.slice(1, -1)
        }
    }
    return trimmed
}

function extractFirstQuotedArg(rest: string): string | null {
    const match = rest.match(/"((?:\\.|[^"\\])*)"/)
    if (!match) return null
    return unquoteJsonOrBare(match[0])
}

/**
 * Parse an OMP `todo` input document (`*** Begin Todo ... *** End Todo`) into
 * checklist items when structured result data is not yet available (e.g. while
 * the tool call is still streaming or pending).
 */
type OmpTrackedItem = CanonicalTodoItem & {
    readonly phase?: string
}


function extractOmpTodoDocString(input: unknown): string | null {
    if (typeof input === 'string') return input
    if (isObject(input) && typeof input.input === 'string') return input.input
    return null
}

function isOmpTodoDocumentText(raw: string): boolean {
    return raw.includes('*** Begin Todo') || /^\s*(INIT|PHASE|ADD|START|DONE|BLOCK|UNBLOCK|DROP|RM)\b/m.test(raw)
}

function ompDocumentDefinesTasks(doc: string): boolean {
    for (const rawLine of doc.split(/\r?\n/)) {
        const line = rawLine.trim()
        if (/^(?:INIT|ADD)\s+"/.test(line)) return true
    }
    return false
}

export function applyOmpTodoDocument(
    raw: string,
    baseItems: readonly CanonicalTodoItem[] = [],
): CanonicalTodoItem[] {
    if (!isOmpTodoDocumentText(raw)) {
        return [...baseItems]
    }

    let items: OmpTrackedItem[] = baseItems.map((item) => {
        const match = item.id ? /^(.+):\d+$/.exec(item.id) : null
        return {
            ...item,
            phase: match ? match[1] : undefined,
        }
    })
    let currentPhase: string | undefined

    for (const rawLine of raw.split(/\r?\n/)) {
        const line = rawLine.trim()
        if (!line || line === '*** Begin Todo' || line === '*** End Todo' || line === 'VIEW') {
            continue
        }
        if (/^INIT\s+"/.test(line)) {
            items = []
            currentPhase = 'Tasks'
            continue
        }
        const phaseHeaderMatch = line.match(/^PHASE\s+(.+)$/)
        if (phaseHeaderMatch) {
            const phaseName = extractFirstQuotedArg(phaseHeaderMatch[1])?.trim()
            if (phaseName) currentPhase = phaseName
            continue
        }
        if (/^DONE\s+ALL(?:\s|$)/.test(line)) {
            items = items.map((item) => ({ ...item, status: 'completed' }))
            continue
        }
        const donePhaseMatch = line.match(/^DONE\s+PHASE\s+(.+)$/)
        if (donePhaseMatch) {
            const phaseName = extractFirstQuotedArg(donePhaseMatch[1])?.trim()
            if (phaseName) {
                const hasMatchingPhase = items.some((item) => item.phase === phaseName)
                items = items.map((item) =>
                    !hasMatchingPhase || item.phase === phaseName
                        ? { ...item, status: 'completed' }
                        : item,
                )
            }
            continue
        }
        if (/^(?:DROP|RM)\s+ALL(?:\s|$)/.test(line)) {
            items = []
            continue
        }
        const dropPhaseMatch = line.match(/^(?:DROP|RM)\s+PHASE\s+(.+)$/)
        if (dropPhaseMatch) {
            const phaseName = extractFirstQuotedArg(dropPhaseMatch[1])?.trim()
            if (phaseName) {
                items = items.filter((item) => item.phase !== phaseName)
            }
            continue
        }

        const match = line.match(/^(ADD|START|DONE|BLOCK|UNBLOCK|DROP|RM)\s+(.*)$/)
        if (!match) continue
        const [, op, rest] = match
        if (/^(PHASE|ALL)\b/.test(rest.trim())) continue

        const rawTitle = extractFirstQuotedArg(rest)
        const text = rawTitle?.trim() ?? ''
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
                    : item,
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

    return items.map(({ phase: _phase, ...rest }) => rest)
}

interface ParsedOmpPhaseBlock {
    name?: string
    items: CanonicalTodoItem[]
}

function selectRelevantOmpPhases(
    phases: ParsedOmpPhaseBlock[],
    turnContext?: OmpTodoTurnContext,
): ParsedOmpPhaseBlock[] {
    if (phases.length <= 1) return phases
    if (turnContext?.hasInit) return phases

    const hasPhaseActiveOrPending = (phase: ParsedOmpPhaseBlock): boolean =>
        phase.items.some((item) => item.status === 'in_progress' || item.status === 'pending')
    const anyPhaseActiveOrPending = phases.some(hasPhaseActiveOrPending)
    const isPhaseSettled = (phase: ParsedOmpPhaseBlock): boolean =>
        phase.items.length > 0 && (
            anyPhaseActiveOrPending
                ? !hasPhaseActiveOrPending(phase)
                : phase.items.every((item) => item.status === 'completed')
        )

    if (phases.every(isPhaseSettled)) {
        return [phases[phases.length - 1]]
    }

    let firstUnsettledIdx = -1
    for (let i = 0; i < phases.length; i += 1) {
        if (!isPhaseSettled(phases[i])) {
            firstUnsettledIdx = i
            break
        }
    }

    return phases.filter((phase, idx) => {
        if (!isPhaseSettled(phase)) return true
        if (phase.name && turnContext?.referencedPhaseNames.has(phase.name)) return true
        // Only keep a settled phase if it sits AFTER the first active/pending phase
        return firstUnsettledIdx !== -1 && idx > firstUnsettledIdx
    })
}

function scopeChecklistItemsByOmpPhaseId(
    items: CanonicalTodoItem[],
    turnContext?: OmpTodoTurnContext,
): CanonicalTodoItem[] {
    if (items.length <= 1) return items
    const grouped: ParsedOmpPhaseBlock[] = []
    const indexByPhaseId = new Map<string, number>()

    for (const item of items) {
        if (!item.id) return items
        const match = item.id.match(/^([^:]+):(\d+)$/)
        if (!match) return items
        const phaseId = match[1]
        let groupIdx = indexByPhaseId.get(phaseId)
        if (groupIdx === undefined) {
            groupIdx = grouped.length
            indexByPhaseId.set(phaseId, groupIdx)
            grouped.push({ name: phaseId, items: [] })
        }
        grouped[groupIdx].items.push(item)
    }

    if (grouped.length === 0) return items
    return selectRelevantOmpPhases(grouped, turnContext).flatMap((phase) => phase.items)
}

function extractOmpPhaseNamesFromInput(raw: string): { hasInit: boolean; phaseNames: string[] } {
    let hasInit = false
    const phaseNames: string[] = []
    for (const rawLine of raw.split(/\r?\n/)) {
        const line = rawLine.trim()
        if (!line || line === '*** Begin Todo' || line === '*** End Todo') continue
        if (/^INIT\b/.test(line)) {
            hasInit = true
            continue
        }
        const phaseHeaderMatch = line.match(/^PHASE\s+(.+)$/)
        if (phaseHeaderMatch) {
            const name = extractFirstQuotedArg(phaseHeaderMatch[1])
            if (name) phaseNames.push(name.trim())
            continue
        }
        const phaseTargetMatch = line.match(/^(?:DONE|DROP|RM|BLOCK|UNBLOCK)\s+PHASE\s+(.+)$/)
        if (phaseTargetMatch) {
            const name = extractFirstQuotedArg(phaseTargetMatch[1])
            if (name) phaseNames.push(name.trim())
        }
    }
    return { hasInit, phaseNames }
}

function isOmpCallResultError(result: unknown): boolean {
    return isObject(result) && (result.isError === true || result.is_error === true)
}

export function collectOmpTodoTurnContext(
    toolCalls: ReadonlyArray<OmpTodoTurnCall>,
    fallbackItems?: readonly CanonicalTodoItem[],
): OmpTodoTurnContext {
    let hasInit = false
    const referencedPhaseNames = new Set<string>()
    const validCalls: OmpTodoTurnCall[] = []
    for (const call of toolCalls) {
        if (isOmpCallResultError(call.result)) continue
        validCalls.push(call)
        const rawDetails = isObject(call.result) && isObject(call.result.details)
            ? call.result.details
            : isObject(call.result)
                ? call.result
                : null
        if (rawDetails) {
            if (
                rawDetails.op === 'init'
                || (Array.isArray(rawDetails.operations) && rawDetails.operations.includes('init'))
                || (Array.isArray(rawDetails.changes) && rawDetails.changes.some((c) => isObject(c) && c.op === 'init'))
            ) {
                hasInit = true
            }
            if (Array.isArray(rawDetails.changes)) {
                for (const change of rawDetails.changes) {
                    if (isObject(change) && typeof change.phase === 'string' && change.phase.trim()) {
                        referencedPhaseNames.add(change.phase.trim())
                    }
                }
            }
            if (Array.isArray(rawDetails.completedTasks)) {
                for (const entry of rawDetails.completedTasks) {
                    if (isObject(entry) && typeof entry.phase === 'string' && entry.phase.trim()) {
                        referencedPhaseNames.add(entry.phase.trim())
                    }
                }
            }
        }
        const rawInput = extractOmpTodoDocString(call.input)
        if (!rawInput) continue
        const parsed = extractOmpPhaseNamesFromInput(rawInput)
        if (parsed.hasInit) hasInit = true
        for (const name of parsed.phaseNames) {
            if (name) referencedPhaseNames.add(name)
        }
    }
    return { hasInit, referencedPhaseNames, calls: validCalls, fallbackItems }
}

/**
 * Parse an OMP `todo` tool plain-text summary (e.g. `- [x] Task (completed)`).
 * Scopes output to the current task's phases so completed phases inherited from
 * earlier tasks in the same OMP session do not leak into subsequent checklist cards.
 */
function parseOmpTodoResultText(raw: string, turnContext?: OmpTodoTurnContext): CanonicalTodoItem[] {
    const phases: ParsedOmpPhaseBlock[] = []
    let currentPhase: ParsedOmpPhaseBlock | null = null

    for (const rawLine of raw.split(/\r?\n/)) {
        const phaseHeaderMatch = rawLine.match(/^ {2}([^-\s][^:]*):\s*$/)
        if (phaseHeaderMatch) {
            currentPhase = { name: phaseHeaderMatch[1].trim(), items: [] }
            phases.push(currentPhase)
            continue
        }

        const match = rawLine.match(/^\s*-\s*\[(x| )\]\s+(.+?)\s*$/i)
        if (!match) continue
        const checked = match[1].toLowerCase() === 'x'
        let text = match[2].trim()
        let status: CanonicalTodoStatus = checked ? 'completed' : 'pending'

        const suffixMatch = text.match(/^(.*?)\s+\((in progress|in_progress|completed|pending|blocked(?::\s*[^)]*)?)\)\s*$/i)
        if (suffixMatch) {
            text = suffixMatch[1].trim()
            const rawStatus = suffixMatch[2].toLowerCase()
            if (rawStatus.startsWith('blocked')) {
                status = 'blocked'
            } else if (rawStatus === 'in progress' || rawStatus === 'in_progress') {
                status = 'in_progress'
            } else if (rawStatus === 'completed') {
                status = 'completed'
            } else {
                status = 'pending'
            }
        }

        if (text) {
            if (!currentPhase) {
                currentPhase = { items: [] }
                phases.push(currentPhase)
            }
            currentPhase.items.push({ text, status })
        }
    }

    if (phases.length === 0) return []
    const selectedPhases = selectRelevantOmpPhases(phases, turnContext)
    return selectedPhases.flatMap((phase) => phase.items)
}

function extractStructuredTodoChecklist(
    input: unknown,
    result: unknown,
    turnContext?: OmpTodoTurnContext,
): CanonicalTodoItem[] | null {
    if (isObject(input) && Object.prototype.hasOwnProperty.call(input, 'todos')) {
        const items = scopeChecklistItemsByOmpPhaseId(
            parseChecklistEntries(input.todos, {
                textKey: 'content',
                fallbackTextKey: 'text',
            }),
            turnContext,
        )
        if (items.length > 0) return items
    }

    if (isObject(result)) {
        if (Object.prototype.hasOwnProperty.call(result, 'todos')) {
            const items = scopeChecklistItemsByOmpPhaseId(
                parseChecklistEntries(result.todos, {
                    textKey: 'content',
                    fallbackTextKey: 'text',
                }),
                turnContext,
            )
            if (items.length > 0) return items
        }
        if (Object.prototype.hasOwnProperty.call(result, 'newTodos')) {
            const items = scopeChecklistItemsByOmpPhaseId(
                parseChecklistEntries(result.newTodos, {
                    textKey: 'content',
                    fallbackTextKey: 'text',
                }),
                turnContext,
            )
            if (items.length > 0) return items
        }
        // OMP `todo` tool result shape: `{ details: { phases: [{ id, name, tasks: [{ id, title, status }] }] }, content: [{ type: 'text', text }] }`
        const details = isObject(result.details) ? result.details : null
        const phases = details && Array.isArray(details.phases)
            ? details.phases
            : Array.isArray(result.phases)
                ? result.phases
                : null
        if (phases) {
            const parsedPhases: ParsedOmpPhaseBlock[] = []
            for (const phase of phases) {
                if (!isObject(phase) || !Array.isArray(phase.tasks)) continue
                const phaseName = typeof phase.name === 'string' ? phase.name.trim() : undefined
                const phaseItems = parseChecklistEntries(phase.tasks, {
                    textKey: 'title',
                    fallbackTextKey: 'content',
                })
                if (phaseItems.length > 0) {
                    parsedPhases.push({ name: phaseName, items: phaseItems })
                }
            }
            const ompItems = selectRelevantOmpPhases(parsedPhases, turnContext)
                .flatMap((phase) => phase.items)
            if (ompItems.length > 0) return ompItems
        }
        if (Array.isArray(result.content)) {
            for (const block of result.content) {
                if (isObject(block) && typeof block.text === 'string') {
                    const parsed = parseOmpTodoResultText(block.text, turnContext)
                    if (parsed.length > 0) return parsed
                }
            }
        }
        if (typeof result.text === 'string') {
            const parsed = parseOmpTodoResultText(result.text, turnContext)
            if (parsed.length > 0) return parsed
        }
    }

    if (typeof result === 'string') {
        const parsed = parseOmpTodoResultText(result, turnContext)
        if (parsed.length > 0) return parsed
    }

    return null
}

function extractCompletedTasksFromOmpDetails(result: unknown): CanonicalTodoItem[] {
    const rawDetails = isObject(result) && isObject(result.details)
        ? result.details
        : isObject(result)
            ? result
            : null
    if (!rawDetails || !Array.isArray(rawDetails.completedTasks)) return []
    const items: CanonicalTodoItem[] = []
    for (const entry of rawDetails.completedTasks) {
        if (!isObject(entry)) continue
        const text = typeof entry.content === 'string' && entry.content.trim() !== ''
            ? entry.content.trim()
            : typeof entry.task === 'string' && entry.task.trim() !== ''
                ? entry.task.trim()
                : typeof entry.title === 'string' && entry.title.trim() !== ''
                    ? entry.title.trim()
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
    turnContext?: OmpTodoTurnContext,
): CanonicalTodoItem[] {
    if (isOmpCallResultError(result)) return []

    const structured = extractStructuredTodoChecklist(input, result, turnContext)
    if (structured !== null) return structured

    const rawDoc = extractOmpTodoDocString(input)
    if (rawDoc !== null && isOmpTodoDocumentText(rawDoc)) {
        if (turnContext?.calls && turnContext.calls.length > 0) {
            const turnDefinesOwnTasks = turnContext.calls.some((call) => {
                if (extractStructuredTodoChecklist(call.input, call.result, turnContext) !== null) return true
                const callDoc = extractOmpTodoDocString(call.input)
                return callDoc !== null && ompDocumentDefinesTasks(callDoc)
            }) || ompDocumentDefinesTasks(rawDoc)

            let runningItems: CanonicalTodoItem[] =
                !turnDefinesOwnTasks && turnContext.fallbackItems
                    ? turnContext.fallbackItems.map((item) => ({ ...item }))
                    : []
            let reachedTarget = false
            for (const call of turnContext.calls) {
                if (isOmpCallResultError(call.result)) continue
                const callStructured = extractStructuredTodoChecklist(call.input, call.result, turnContext)
                if (callStructured !== null) {
                    runningItems = callStructured.map((item) => ({ ...item }))
                } else {
                    const callDoc = extractOmpTodoDocString(call.input)
                    if (callDoc !== null && isOmpTodoDocumentText(callDoc)) {
                        runningItems = applyOmpTodoDocument(callDoc, runningItems)
                    }
                }
                if (call.input === input) {
                    reachedTarget = true
                    break
                }
            }
            if (!reachedTarget) {
                runningItems = applyOmpTodoDocument(rawDoc, runningItems)
            }
            if (runningItems.length > 0) return runningItems
        }

        const completedFromDetails = extractCompletedTasksFromOmpDetails(result)
        const seedItems = completedFromDetails.length > 0
            ? completedFromDetails
            : !ompDocumentDefinesTasks(rawDoc) && turnContext?.fallbackItems
                ? turnContext.fallbackItems
                : []
        return applyOmpTodoDocument(rawDoc, seedItems)
    }

    return extractCompletedTasksFromOmpDetails(result)
}

export function extractUpdatePlanChecklist(input: unknown, result: unknown): CanonicalTodoItem[] {
    if (isObject(input) && Object.prototype.hasOwnProperty.call(input, 'plan')) {
        return parseChecklistEntries(input.plan, {
            textKey: 'step',
        })
    }

    if (isObject(result)) {
        return parseChecklistEntries(result.plan, {
            textKey: 'step',
        })
    }

    return []
}

function buildSnapshot(items: readonly CanonicalTodoItem[]): CanonicalTodoSnapshot {
    let completedCount = 0
    let inProgressCount = 0
    let pendingCount = 0
    let blockedCount = 0
    let activeItem: CanonicalTodoItem | null = null

    for (const item of items) {
        if (item.status === 'completed') {
            completedCount += 1
        } else if (item.status === 'in_progress') {
            inProgressCount += 1
            if (!activeItem) {
                activeItem = item
            }
        } else if (item.status === 'blocked') {
            blockedCount += 1
        } else {
            pendingCount += 1
        }
    }

    const activeLabel = activeItem ? (activeItem.activeForm || activeItem.text) : null

    return {
        items,
        totalCount: items.length,
        completedCount,
        inProgressCount,
        pendingCount,
        blockedCount,
        activeItem,
        activeLabel,
    }
}

/**
 * Single tool-level entry point: projects a `TodoWrite` / `todo` / `UpdatePlan`
 * `ToolCallBlock` into a canonical snapshot, including same-turn optimistic
 * delta merging when `block.tool.result == null`.
 */
export function projectToolTodoSnapshot(
    block: ToolCallBlock,
    allTurnToolBlocks?: readonly ToolCallBlock[],
    fallbackItems?: readonly CanonicalTodoItem[],
): CanonicalTodoSnapshot {
    const kind = resolveTodoToolKind(block.tool.name)
    if (!kind) {
        return buildSnapshot([])
    }

    if (block.tool.state === 'error') {
        return buildSnapshot([])
    }

    const turnCalls: OmpTodoTurnCall[] = []
    if (kind === 'todo' && allTurnToolBlocks && allTurnToolBlocks.length > 0) {
        for (const candidate of allTurnToolBlocks) {
            if (
                resolveTodoToolKind(candidate.tool.name) === 'todo'
                && candidate.tool.state !== 'error'
                && !isOmpCallResultError(candidate.tool.result)
            ) {
                turnCalls.push({
                    input: candidate.tool.input,
                    result: candidate.tool.result,
                })
            }
            if (candidate.id === block.id) break
        }
    }

    const turnContext = kind === 'todo' && (turnCalls.length > 0 || (fallbackItems && fallbackItems.length > 0))
        ? collectOmpTodoTurnContext(turnCalls, fallbackItems)
        : undefined

    const rawItems = kind === 'todo'
        ? extractTodoChecklist(block.tool.input, block.tool.result, turnContext)
        : extractUpdatePlanChecklist(block.tool.input, block.tool.result)

    let items = rawItems
    const isFullTodoWritePayload =
        isObject(block.tool.input) && Object.prototype.hasOwnProperty.call(block.tool.input, 'todos')
    if ((allTurnToolBlocks || fallbackItems) && block.tool.result == null && !isFullTodoWritePayload) {
        let baseItems: CanonicalTodoItem[] = fallbackItems ? [...fallbackItems] : []
        for (const candidate of allTurnToolBlocks ?? []) {
            if (candidate.id === block.id) break
            const candidateKind = resolveTodoToolKind(candidate.tool.name)
            if (!candidateKind) continue
            const prior = candidateKind === 'todo'
                ? extractTodoChecklist(candidate.tool.input, candidate.tool.result, turnContext)
                : extractUpdatePlanChecklist(candidate.tool.input, candidate.tool.result)
            if (prior.length > 0) {
                baseItems = prior
            }
        }
        if (baseItems.length > 0) {
            const merged = baseItems.map((item) => ({ ...item }))
            for (const delta of rawItems) {
                const existingIdx = merged.findIndex((m) =>
                    (delta.id && m.id && delta.id === m.id) || m.text === delta.text,
                )
                if (existingIdx >= 0) {
                    merged[existingIdx] = {
                        ...merged[existingIdx],
                        status: delta.status,
                        ...(delta.id ? { id: delta.id } : {}),
                        ...(delta.activeForm ? { activeForm: delta.activeForm } : {}),
                    }
                } else {
                    merged.push({ ...delta })
                }
            }
            items = merged
        }
    }

    if (
        block.tool.state === 'running'
        && items.length > 0
        && !items.some((item) => item.status === 'in_progress')
    ) {
        const firstPendingIdx = items.findIndex((item) => item.status === 'pending')
        if (firstPendingIdx >= 0) {
            items = items.map((item, idx) => (idx === firstPendingIdx ? { ...item, status: 'in_progress' } : item))
        }
    }

    return buildSnapshot(items)
}

/**
 * Single session-level entry point: projects `session.todos` (or `{ todos }`)
 * into a canonical snapshot with identical OMP phase-scoping and status counts.
 */
export function projectSessionTodoSnapshot(
    rawTodos: unknown,
    turnContext?: OmpTodoTurnContext,
): CanonicalTodoSnapshot {
    if (Array.isArray(rawTodos)) {
        return buildSnapshot(extractTodoChecklist({ todos: rawTodos }, null, turnContext))
    }
    if (isObject(rawTodos)) {
        return buildSnapshot(extractTodoChecklist(rawTodos, null, turnContext))
    }
    return buildSnapshot([])
}
