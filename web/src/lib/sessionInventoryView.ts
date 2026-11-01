import { redactConfigSecrets, sessionConfigLock, type SessionConfigItemSelector, type SessionInventory, type SessionInventorySource, type SessionPromptItem, type SessionPromptLoad } from '@hapi/protocol/schemas'

export type InventoryRow = {
    key: string
    title: string
    detail?: string
    preview?: string
    source?: SessionInventorySource
    scopeLabel?: string
    enabled: boolean
    mutable: boolean
    lock: 'source' | 'unsupported' | null
    toggle: boolean
    openable: boolean
    load?: SessionPromptLoad
    match?: string
    note?: string
    codexCapped?: boolean
    ref: SessionConfigItemSelector
    filePath?: string
    line?: number
    scriptPath?: string
    loaded?: boolean
    /** Project server: the row can be probed again after the first check. */
    checkable?: boolean
}

export type InventoryGroup = {
    label?: string
    rows: InventoryRow[]
}

export type InventorySection =
    | { status: 'unreported' }
    | { status: 'empty' }
    | { status: 'none'; note?: string }
    | { status: 'catalogUnavailable' }
    | { status: 'list'; rows: InventoryRow[]; groups?: InventoryGroup[]; tools?: boolean; note?: string }



function asSource(value: string | undefined): SessionInventorySource | undefined {
    if (
        value === 'injected'
        || value === 'user'
        || value === 'project'
        || value === 'plugin'
        || value === 'system'
        || value === 'tool'
    ) {
        return value
    }
    return undefined
}

export function visibleInventoryText(value: string | undefined): string | undefined {
    if (!value) return undefined
    const redacted = redactConfigSecrets(value)
    const withoutHttp = redacted.replace(/https?:\/\/\S+/gi, '')
    if (/:\/\//.test(withoutHttp)) return undefined
    const text = withoutHttp.replace(/\s+/g, ' ').trim()
    return text || undefined
}

function row(
    title: string,
    source: string | undefined,
    detail: string | undefined,
    ref: SessionConfigItemSelector,
    enabled: boolean | undefined,
    flavor: string | null | undefined,
    filePath?: string,
    line?: number,
    scriptPath?: string,
): InventoryRow | null {
    const visibleTitle = visibleInventoryText(title)
    if (!visibleTitle) return null
    const visibleDetail = visibleInventoryText(detail)
    const visibleSource = asSource(source)
    const lock = sessionConfigLock(flavor, ref.kind, visibleSource)
    return {
        key: `${ref.kind}:${visibleSource ?? ''}:${visibleTitle}:${ref.index ?? 0}:${visibleDetail ?? ''}`,
        title: visibleTitle,
        ...(visibleDetail ? { detail: visibleDetail } : {}),
        ...(visibleSource ? { source: visibleSource } : {}),
        enabled: enabled !== false,
        mutable: lock === null,
        lock,
        toggle: true,
        openable: Boolean(filePath || scriptPath),
        ref: { ...ref, ...(visibleSource ? { source: visibleSource } : {}) },
        ...(filePath ? { filePath } : {}),
        ...(line ? { line } : {}),
        ...(scriptPath ? { scriptPath } : {}),
    }
}

function rowsOrEmpty(rows: InventoryRow[]): InventorySection {
    return rows.length === 0 ? { status: 'empty' } : { status: 'list', rows }
}

export function mcpSection(inventory: SessionInventory | null | undefined, flavor?: string | null): InventorySection {
    const mcp = inventory?.mcp
    if (!mcp) return { status: 'unreported' }
    const rows = mcp.servers.flatMap((server) => {
        const next = row(server.name, server.source, undefined, { kind: 'mcp', name: server.name, source: server.source }, server.enabled, flavor, server.filePath, server.line)
        if (!next) return []
        const checkable = mcp.kind === 'servers' && server.source === 'project'
        return [{
            ...next,
            ...(server.loaded === undefined ? {} : { loaded: server.loaded }),
            ...(checkable ? { checkable: true } : {}),
        }]
    })
    if (rows.length === 0) return { status: 'empty' }
    if (mcp.kind === 'tools') return { status: 'list', rows, tools: true }
    const groups = mcpGroups(rows)
    return { status: 'list', rows, ...(groups ? { groups } : {}) }
}

function mcpGroups(rows: InventoryRow[]): InventoryGroup[] | undefined {
    if (!rows.some((item) => item.filePath)) return undefined
    const order: string[] = []
    const byFile = new Map<string, InventoryRow[]>()
    const loose: InventoryRow[] = []
    for (const item of rows) {
        const file = item.filePath
        if (!file) {
            loose.push(item)
            continue
        }
        const list = byFile.get(file)
        if (list) list.push(item)
        else {
            order.push(file)
            byFile.set(file, [item])
        }
    }
    return [
        ...order.map((file) => ({ label: groupLabel(file, byFile.get(file) ?? []), rows: byFile.get(file) ?? [] })),
        ...(loose.length > 0 ? [{ rows: loose }] : []),
    ]
}

/** User files live outside the session, so the header shows `~/...` instead of the absolute path. The row still opens the original path. */
function groupLabel(file: string, rows: InventoryRow[]): string {
    if (!rows.every((item) => item.source === 'user')) return file
    const unix = /^\/(?:Users|home)\/[^/]+(\/.*)$/.exec(file)
    if (unix?.[1]) return `~${unix[1]}`
    const win = /^[A-Za-z]:[\\/]Users[\\/][^\\/]+([\\/].*)$/.exec(file)
    if (win?.[1]) return `~${win[1].replaceAll('\\', '/')}`
    return file
}

export function hooksSection(inventory: SessionInventory | null | undefined, flavor?: string | null): InventorySection {
    const hooks = inventory?.hooks
    if (!hooks) return { status: 'unreported' }
    if (hooks.availability === 'none') return { status: 'none' }
    const rows = hooks.items.flatMap((item) => {
        const detail = [item.matcher, item.commandName].filter((part): part is string => Boolean(part)).join(' · ')
        const next = row(item.event, item.source, detail || undefined, {
            kind: 'hook',
            event: item.event,
            source: item.source,
            ...(item.matcher ? { matcher: item.matcher } : {}),
            ...(item.commandName ? { commandName: item.commandName } : {}),
            ...(item.index ? { index: item.index } : {}),
        }, item.enabled, flavor, item.filePath, item.line, item.scriptPath)
        return next ? [next] : []
    })
    return rowsOrEmpty(rows)
}

export function agentsSection(inventory: SessionInventory | null | undefined, flavor?: string | null): InventorySection {
    const agents = inventory?.agents
    if (!agents) return { status: 'unreported' }
    return rowsOrEmpty(agents.items.flatMap((agent) => {
        const next = row(agent.name, agent.source, agent.description, {
            kind: 'skill',
            name: agent.name,
            source: agent.source,
        }, true, flavor, agent.filePath, agent.line)
        if (!next) return []
        return [{
            ...next,
            key: `agent:${agent.source ?? ''}:${agent.name}`,
            toggle: false,
            mutable: false,
            lock: null,
        }]
    }))
}

export function skillsSection(inventory: SessionInventory | null | undefined, flavor?: string | null): InventorySection {
    const skills = inventory?.skills
    if (!skills) return { status: 'unreported' }
    if (skills.catalogUnavailable) return { status: 'catalogUnavailable' }
    return rowsOrEmpty(skills.items.flatMap((skill) => {
        const next = row(skill.name, skill.source, skill.description, { kind: 'skill', name: skill.name, source: skill.source }, skill.enabled, flavor, skill.filePath)
        return next ? [next] : []
    }))
}

function promptRow(item: SessionPromptItem): InventoryRow | null {
    const name = visibleInventoryText(item.title) ?? item.title
    if (!name) return null
    const path = visibleInventoryText(item.pathLabel)
    const preview = visibleInventoryText(item.preview)
    return {
        key: `prompt:${item.id}`,
        title: name,
        ...(path ? { detail: path } : {}),
        ...(preview ? { preview } : {}),
        scopeLabel: item.scope,
        enabled: true,
        mutable: false,
        lock: null,
        toggle: false,
        openable: Boolean(item.filePath),
        ...(item.load ? { load: item.load } : {}),
        ...(item.loaded === undefined ? {} : { loaded: item.loaded }),
        ...(item.match ? { match: item.match } : {}),
        ...(item.codexCapped ? { codexCapped: true } : {}),
        ...(item.filePath ? { filePath: item.filePath } : {}),
        ref: { kind: 'prompt', id: item.id },
    }
}

export function promptSection(
    inventory: SessionInventory | null | undefined,
    role: 'system' | 'user',
): InventorySection {
    const block = inventory?.prompts?.[role]
    if (!block) return { status: 'unreported' }
    if (block.availability === 'none') {
        return block.note ? { status: 'none', note: block.note } : { status: 'empty' }
    }
    const rows = block.items.flatMap((item) => {
        const next = promptRow(item)
        return next ? [next] : []
    })
    if (rows.length === 0) return block.note ? { status: 'none', note: block.note } : { status: 'empty' }
    return { status: 'list', rows, ...(block.note ? { note: block.note } : {}) }
}
