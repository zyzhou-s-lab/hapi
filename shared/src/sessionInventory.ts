import { z } from 'zod'

/** Where a reported MCP server, hook, or skill came from. Commands, URLs, and tokens are never fields. */
export const SessionInventorySourceSchema = z.enum([
    'injected',
    'user',
    'project',
    'plugin',
    'system',
    'tool',
])

export const SessionInventoryMcpServerSchema = z.object({
    name: z.string().min(1).max(200),
    source: SessionInventorySourceSchema,
    enabled: z.boolean().optional(),
})

export const SessionInventoryHookSchema = z.object({
    event: z.string().min(1).max(80),
    matcher: z.string().min(1).max(120).optional(),
    source: SessionInventorySourceSchema,
    commandName: z.string().min(1).max(80).optional(),
    enabled: z.boolean().optional(),
})

export const SessionInventorySkillSchema = z.object({
    name: z.string().min(1).max(200),
    description: z.string().max(500).optional(),
    source: SessionInventorySourceSchema.optional(),
    enabled: z.boolean().optional(),
})

/**
 * Live session-RPC payload. A missing section was not collected.
 * Commands, URLs, and tokens are not fields. The hub does not store this.
 */
export const SessionInventorySchema = z.object({
    mcp: z.object({
        kind: z.enum(['servers', 'tools']),
        servers: z.array(SessionInventoryMcpServerSchema).max(200),
    }).optional(),
    hooks: z.object({
        availability: z.enum(['listed', 'none']),
        items: z.array(SessionInventoryHookSchema).max(400),
    }).optional(),
    skills: z.object({
        catalogUnavailable: z.boolean().optional(),
        items: z.array(SessionInventorySkillSchema).max(400),
    }).optional(),
})

export type SessionInventorySource = z.infer<typeof SessionInventorySourceSchema>
export type SessionInventoryMcpServer = z.infer<typeof SessionInventoryMcpServerSchema>
export type SessionInventoryHook = z.infer<typeof SessionInventoryHookSchema>
export type SessionInventorySkill = z.infer<typeof SessionInventorySkillSchema>
export type SessionInventory = z.infer<typeof SessionInventorySchema>

export type SessionConfigRpcResult =
    | ({ success: true } & SessionInventory)
    | { success: false; error: string }

/** Keep only schema fields. Commands, URLs, and tokens on a CLI payload are dropped. */
export function parseSessionConfigRpc(raw: unknown): SessionConfigRpcResult {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return { success: false, error: 'Invalid session config' }
    }
    const record = raw as { success?: unknown; error?: unknown }
    if (record.success !== true) {
        const error = typeof record.error === 'string' && record.error.trim().length > 0
            ? record.error
            : 'Failed to read session config'
        return { success: false, error }
    }
    const parsed = SessionInventorySchema.safeParse(raw)
    if (!parsed.success) {
        return { success: false, error: 'Invalid session config' }
    }
    return { success: true, ...parsed.data }
}

const DETAIL_TEXT_LIMIT = 128 * 1024
const SCRIPT_TEXT_LIMIT = 32 * 1024

export const SessionConfigItemSelectorSchema = z.object({
    kind: z.enum(['mcp', 'skill', 'hook']),
    name: z.string().min(1).max(200).optional(),
    source: SessionInventorySourceSchema.optional(),
    event: z.string().min(1).max(80).optional(),
    matcher: z.string().min(1).max(120).optional(),
    commandName: z.string().min(1).max(80).optional(),
})

const SessionConfigToolSchema = z.object({
    name: z.string().min(1).max(200),
    description: z.string().max(500).optional(),
})

export const SessionConfigDetailSchema = z.discriminatedUnion('kind', [
    z.object({
        kind: z.literal('skill'),
        name: z.string().min(1).max(200),
        source: SessionInventorySourceSchema.optional(),
        enabled: z.boolean(),
        mutable: z.boolean(),
        markdown: z.string().max(DETAIL_TEXT_LIMIT),
        truncated: z.boolean(),
    }),
    z.object({
        kind: z.literal('mcp'),
        name: z.string().min(1).max(200),
        source: SessionInventorySourceSchema,
        enabled: z.boolean(),
        mutable: z.boolean(),
        tools: z.array(SessionConfigToolSchema).max(200),
        toolsUnavailable: z.boolean().optional(),
    }),
    z.object({
        kind: z.literal('hook'),
        event: z.string().min(1).max(80),
        matcher: z.string().min(1).max(120).optional(),
        commandName: z.string().min(1).max(80).optional(),
        source: SessionInventorySourceSchema,
        enabled: z.boolean(),
        mutable: z.boolean(),
        script: z.string().max(SCRIPT_TEXT_LIMIT),
        truncated: z.boolean(),
    }),
])

export type SessionConfigItemSelector = z.infer<typeof SessionConfigItemSelectorSchema>
export type SessionConfigDetail = z.infer<typeof SessionConfigDetailSchema>
export type SessionConfigDetailResult =
    | ({ success: true } & SessionConfigDetail)
    | { success: false; error: string }
export type SessionConfigToggleResult =
    | { success: true; enabled: boolean }
    | { success: false; error: string }

export function redactConfigSecrets(value: string): string {
    return value
        .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1***@')
        .replace(/\b(bearer)\s+\S+/gi, '$1 ***')
        .replace(/(--(?:api[-_]?key|token|secret|password|passwd|key))(=|\s+)\S+/gi, '$1$2***')
        .replace(/\b(token|api[_-]?key|secret|password|passwd|key)\b(\s*[:=]\s*)\S+/gi, '$1$2***')
}

function recordField(raw: unknown, key: string): unknown {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
    const found = Object.entries(raw).find(([entryKey]) => entryKey === key)
    return found?.[1]
}

function failure(raw: unknown, fallback: string): { success: false; error: string } {
    const error = recordField(raw, 'error')
    return {
        success: false,
        error: typeof error === 'string' && error.trim().length > 0 ? error : fallback,
    }
}

export function parseSessionConfigDetail(raw: unknown): SessionConfigDetailResult {
    if (recordField(raw, 'success') !== true) return failure(raw, 'Failed to read session config')
    const parsed = SessionConfigDetailSchema.safeParse(raw)
    if (!parsed.success) return { success: false, error: 'Invalid session config' }
    return { success: true, ...parsed.data }
}

export function parseSessionConfigToggle(raw: unknown): SessionConfigToggleResult {
    if (recordField(raw, 'success') !== true) return failure(raw, 'Failed to update session config')
    const enabled = recordField(raw, 'enabled')
    if (typeof enabled !== 'boolean') return { success: false, error: 'Invalid session config' }
    return { success: true, enabled }
}
