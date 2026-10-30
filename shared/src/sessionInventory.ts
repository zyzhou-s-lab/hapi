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
})

export const SessionInventoryHookSchema = z.object({
    event: z.string().min(1).max(80),
    matcher: z.string().min(1).max(120).optional(),
    source: SessionInventorySourceSchema,
    commandName: z.string().min(1).max(80).optional(),
})

export const SessionInventorySkillSchema = z.object({
    name: z.string().min(1).max(200),
    description: z.string().max(500).optional(),
    source: SessionInventorySourceSchema.optional(),
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
