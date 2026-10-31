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
    index: z.number().int().min(0).max(50).optional(),
    enabled: z.boolean().optional(),
})

export const SessionInventorySkillSchema = z.object({
    name: z.string().min(1).max(200),
    description: z.string().max(500).optional(),
    source: SessionInventorySourceSchema.optional(),
    enabled: z.boolean().optional(),
})

export const SessionPromptScopeSchema = z.enum(['injected', 'user', 'project', 'managed'])
export const SessionPromptLoadSchema = z.enum(['path', 'demand'])

/** List row for one system or user instruction. Body text is not a field. */
export const SessionPromptItemSchema = z.object({
    id: z.string().min(1).max(200),
    role: z.enum(['system', 'user']),
    scope: SessionPromptScopeSchema,
    title: z.string().min(1).max(200),
    pathLabel: z.string().min(1).max(300).optional(),
    preview: z.string().max(160).optional(),
    truncated: z.boolean().optional(),
    load: SessionPromptLoadSchema.optional(),
    match: z.string().max(300).optional(),
    note: z.string().max(80).optional(),
    hasText: z.boolean().optional(),
    codexCapped: z.boolean().optional(),
})

const SessionPromptBlockSchema = z.object({
    availability: z.enum(['listed', 'none']),
    note: z.string().max(80).optional(),
    items: z.array(SessionPromptItemSchema).max(400),
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
    prompts: z.object({
        system: SessionPromptBlockSchema.optional(),
        user: SessionPromptBlockSchema.optional(),
    }).optional(),
})

export type SessionInventorySource = z.infer<typeof SessionInventorySourceSchema>
export type SessionInventoryMcpServer = z.infer<typeof SessionInventoryMcpServerSchema>
export type SessionInventoryHook = z.infer<typeof SessionInventoryHookSchema>
export type SessionInventorySkill = z.infer<typeof SessionInventorySkillSchema>
export type SessionInventory = z.infer<typeof SessionInventorySchema>
export type SessionPromptItem = z.infer<typeof SessionPromptItemSchema>
export type SessionPromptLoad = z.infer<typeof SessionPromptLoadSchema>
export type SessionPromptScope = z.infer<typeof SessionPromptScopeSchema>

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
        const reported = typeof record.error === 'string' ? record.error.trim() : 'Failed to read session config'
        return { success: false, error: reported ? redactConfigSecrets(reported) : '' }
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
    kind: z.enum(['mcp', 'skill', 'hook', 'prompt']),
    name: z.string().min(1).max(200).optional(),
    source: SessionInventorySourceSchema.optional(),
    event: z.string().min(1).max(80).optional(),
    matcher: z.string().min(1).max(120).optional(),
    commandName: z.string().min(1).max(80).optional(),
    index: z.number().int().min(0).max(50).optional(),
    id: z.string().min(1).max(200).optional(),
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
    z.object({
        kind: z.literal('prompt'),
        id: z.string().min(1).max(200),
        title: z.string().min(1).max(200),
        markdown: z.string().max(DETAIL_TEXT_LIMIT),
        truncated: z.boolean(),
        load: SessionPromptLoadSchema.optional(),
        match: z.string().max(300).optional(),
        note: z.string().max(80).optional(),
        codexCapped: z.boolean().optional(),
        frontmatter: z.string().max(2000).optional(),
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
        .replace(/\b(bearer)\s+[^\s"']+/gi, '$1 ***')
        .replace(/\b(sk-|ghp_|github_pat_|xox[baprs]-|hapi_[a-z0-9]+_)[A-Za-z0-9_-]{8,}/g, '***')
        .replace(/(^|[^A-Za-z0-9])([A-Za-z][A-Za-z0-9_]*(?:API_KEY|ACCESS_KEY|SECRET|TOKEN|PASSWORD))\s*=\s*[^\s"']+/g, '$1$2=***')
        .replace(/(--(?:api[-_]?key|token|secret|password|passwd|key))(=|\s+)\S+/gi, '$1$2***')
        .replace(/(^|[^A-Za-z0-9_])(token|api[_-]?key|secret|password|passwd|key)(\s*[:=]\s*)[^\s"']+/gi, '$1$2$3***')
}

/** null when that agent honors a per-item boolean. Otherwise the switch stays disabled. */
export function sessionConfigLock(
    flavor: string | null | undefined,
    kind: 'mcp' | 'skill' | 'hook' | 'prompt',
    source: string | undefined,
): 'source' | 'unsupported' | null {
    if (kind === 'prompt') return 'source'
    if (source !== 'user' && source !== 'project') return 'source'
    const name = (flavor ?? '').trim().toLowerCase()
    if (kind === 'mcp' && name === 'codex' && source === 'user') return null
    if (kind === 'mcp' && name === 'cursor' && source === 'user') return null
    return 'unsupported'
}

function recordField(raw: unknown, key: string): unknown {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
    const found = Object.entries(raw).find(([entryKey]) => entryKey === key)
    return found?.[1]
}

function failure(raw: unknown, fallback: string): { success: false; error: string } {
    const error = recordField(raw, 'error')
    if (typeof error !== 'string') return { success: false, error: fallback }
    const trimmed = error.trim()
    return { success: false, error: trimmed ? redactConfigSecrets(trimmed) : '' }
}

export function parseSessionConfigDetail(raw: unknown): SessionConfigDetailResult {
    if (recordField(raw, 'success') !== true) return failure(raw, 'Failed to read session config')
    const parsed = SessionConfigDetailSchema.safeParse(raw)
    if (!parsed.success) return { success: false, error: 'Invalid session config' }
    if (parsed.data.kind === 'hook') return { success: true, ...parsed.data, script: redactConfigSecrets(parsed.data.script) }
    if (parsed.data.kind === 'skill') return { success: true, ...parsed.data, markdown: redactConfigSecrets(parsed.data.markdown) }
    if (parsed.data.kind === 'prompt') {
        return {
            success: true,
            ...parsed.data,
            markdown: redactConfigSecrets(parsed.data.markdown),
            ...(parsed.data.frontmatter ? { frontmatter: redactConfigSecrets(parsed.data.frontmatter) } : {}),
        }
    }
    return { success: true, ...parsed.data }
}

export function parseSessionConfigToggle(raw: unknown): SessionConfigToggleResult {
    if (recordField(raw, 'success') !== true) return failure(raw, 'Failed to update session config')
    const enabled = recordField(raw, 'enabled')
    if (typeof enabled !== 'boolean') return { success: false, error: 'Invalid session config' }
    return { success: true, enabled }
}
