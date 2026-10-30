import type { SessionConfigItemSelector, SessionInventory, SessionInventorySource } from '@hapi/protocol/schemas'

export type InventoryRow = {
    key: string
    title: string
    detail?: string
    source?: SessionInventorySource
    enabled: boolean
    mutable: boolean
    ref: SessionConfigItemSelector
}

export type InventorySection =
    | { status: 'unreported' }
    | { status: 'empty' }
    | { status: 'none' }
    | { status: 'catalogUnavailable' }
    | { status: 'list'; rows: InventoryRow[]; tools?: boolean }

const SECRET_TEXT = /token|api[_-]?key|secret|password|bearer|authorization/i

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
    const text = value
        .replace(/https?:\/\/\S+/gi, '')
        .replace(/\b(?:token|api[_-]?key|secret|password|bearer)\b\s*[:=]\s*\S+/gi, '')
        .replace(/\s+/g, ' ')
        .trim()
    if (!text || /:\/\//.test(text) || SECRET_TEXT.test(text)) return undefined
    return text
}

function row(title: string, source: string | undefined, detail: string | undefined, ref: SessionConfigItemSelector, enabled: boolean | undefined): InventoryRow | null {
    const visibleTitle = visibleInventoryText(title)
    if (!visibleTitle) return null
    const visibleDetail = visibleInventoryText(detail)
    const visibleSource = asSource(source)
    const mutable = visibleSource === 'user' || visibleSource === 'project'
    return {
        key: `${ref.kind}:${visibleSource ?? ''}:${visibleTitle}:${visibleDetail ?? ''}`,
        title: visibleTitle,
        ...(visibleDetail ? { detail: visibleDetail } : {}),
        ...(visibleSource ? { source: visibleSource } : {}),
        enabled: enabled !== false,
        mutable,
        ref: { ...ref, ...(visibleSource ? { source: visibleSource } : {}) },
    }
}

function rowsOrEmpty(rows: InventoryRow[]): InventorySection {
    return rows.length === 0 ? { status: 'empty' } : { status: 'list', rows }
}

export function mcpSection(inventory: SessionInventory | null | undefined): InventorySection {
    const mcp = inventory?.mcp
    if (!mcp) return { status: 'unreported' }
    const rows = mcp.servers.flatMap((server) => {
        const next = row(server.name, server.source, undefined, { kind: 'mcp', name: server.name, source: server.source }, server.enabled)
        return next ? [next] : []
    })
    if (mcp.kind === 'tools') return { status: 'list', rows, tools: true }
    return rowsOrEmpty(rows)
}

export function hooksSection(inventory: SessionInventory | null | undefined): InventorySection {
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
        }, item.enabled)
        return next ? [next] : []
    })
    return rowsOrEmpty(rows)
}

export function skillsSection(inventory: SessionInventory | null | undefined): InventorySection {
    const skills = inventory?.skills
    if (!skills) return { status: 'unreported' }
    if (skills.catalogUnavailable) return { status: 'catalogUnavailable' }
    return rowsOrEmpty(skills.items.flatMap((skill) => {
        const next = row(skill.name, skill.source, skill.description, { kind: 'skill', name: skill.name, source: skill.source }, skill.enabled)
        return next ? [next] : []
    }))
}
