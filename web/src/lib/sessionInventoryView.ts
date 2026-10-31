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
}

export type InventorySection =
    | { status: 'unreported' }
    | { status: 'empty' }
    | { status: 'none'; note?: string }
    | { status: 'catalogUnavailable' }
    | { status: 'list'; rows: InventoryRow[]; tools?: boolean; note?: string }



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
    const text = redactConfigSecrets(value)
        .replace(/https?:\/\/\S+/gi, '')
        .replace(/\s+/g, ' ')
        .trim()
    if (!text || /:\/\//.test(text)) return undefined
    return text
}

function row(
    title: string,
    source: string | undefined,
    detail: string | undefined,
    ref: SessionConfigItemSelector,
    enabled: boolean | undefined,
    flavor: string | null | undefined,
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
        openable: true,
        ref: { ...ref, ...(visibleSource ? { source: visibleSource } : {}) },
    }
}

function rowsOrEmpty(rows: InventoryRow[]): InventorySection {
    return rows.length === 0 ? { status: 'empty' } : { status: 'list', rows }
}

export function mcpSection(inventory: SessionInventory | null | undefined, flavor?: string | null): InventorySection {
    const mcp = inventory?.mcp
    if (!mcp) return { status: 'unreported' }
    const rows = mcp.servers.flatMap((server) => {
        const next = row(server.name, server.source, undefined, { kind: 'mcp', name: server.name, source: server.source }, server.enabled, flavor)
        return next ? [next] : []
    })
    if (mcp.kind === 'tools') return { status: 'list', rows, tools: true }
    return rowsOrEmpty(rows)
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
        }, item.enabled, flavor)
        return next ? [next] : []
    })
    return rowsOrEmpty(rows)
}

export function skillsSection(inventory: SessionInventory | null | undefined, flavor?: string | null): InventorySection {
    const skills = inventory?.skills
    if (!skills) return { status: 'unreported' }
    if (skills.catalogUnavailable) return { status: 'catalogUnavailable' }
    return rowsOrEmpty(skills.items.flatMap((skill) => {
        const next = row(skill.name, skill.source, skill.description, { kind: 'skill', name: skill.name, source: skill.source }, skill.enabled, flavor)
        return next ? [next] : []
    }))
}

function promptRow(item: SessionPromptItem): InventoryRow | null {
    const title = visibleInventoryText(item.title) ?? item.title
    if (!title) return null
    const detail = visibleInventoryText(item.pathLabel)
    const preview = visibleInventoryText(item.preview)
    return {
        key: `prompt:${item.id}`,
        title,
        ...(detail ? { detail } : {}),
        ...(preview ? { preview } : {}),
        scopeLabel: item.scope,
        enabled: true,
        mutable: false,
        lock: null,
        toggle: false,
        openable: item.hasText !== false,
        ...(item.load ? { load: item.load } : {}),
        ...(item.match ? { match: item.match } : {}),
        ...(item.note ? { note: item.note } : {}),
        ...(item.codexCapped ? { codexCapped: true } : {}),
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
