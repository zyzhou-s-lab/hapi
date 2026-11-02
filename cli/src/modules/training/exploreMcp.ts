import { z } from 'zod'
import { EXPLORE_DELETE_CONFIRM_HEADER } from '@hapi/protocol'
import { formatWorkResult, type WorkHub } from './trainingMcp'

type Result = { status: number; body: unknown }

const lineId = z.string().optional().describe('Exploration id. Omit to use the exploration this session belongs to.')

export const EXPLORE_TOOLS = [
    'get_hypothesis',
    'set_hypothesis',
    'list_explorations',
    'get_exploration',
    'create_exploration',
    'delete_exploration',
    'list_linked_sessions',
    'link_session',
    'unlink_session',
    'list_verification_cards',
    'add_verification_card',
    'remove_verification_card',
    'list_references',
    'add_reference',
    'remove_reference',
] as const

export type ExploreTool = typeof EXPLORE_TOOLS[number]

export const exploreToolSchemas: Record<ExploreTool, z.ZodTypeAny> = {
    get_hypothesis: z.object({ lineId }),
    set_hypothesis: z.object({ lineId, hypothesis: z.string().max(4000).describe('The one hypothesis this exploration serves. Empty clears it.') }),
    list_explorations: z.object({}),
    get_exploration: z.object({ lineId }),
    create_exploration: z.object({
        name: z.string().describe('Exploration name'),
        hypothesis: z.string().optional().describe('The one hypothesis this exploration serves'),
        machineId: z.string().optional().describe('Machine that owns the directory. Defaults to this machine.'),
        path: z.string().optional().describe('Absolute directory this exploration covers. Defaults to this session directory.'),
    }),
    delete_exploration: z.object({ lineId }),
    list_linked_sessions: z.object({ lineId }),
    link_session: z.object({ lineId, sessionId: z.string().optional().describe('Session id to attach. Omit to use this session.') }),
    unlink_session: z.object({ lineId, sessionId: z.string().optional().describe('Session id to detach. Omit to use this session.') }),
    list_verification_cards: z.object({ lineId }),
    add_verification_card: z.object({
        lineId,
        run: z.string().describe('Registered run name'),
        metrics: z.array(z.string()).optional().describe('Metric names to draw. Omit to draw every metric.'),
        xAxis: z.string().optional().describe('Metric used as the x axis'),
        cardId: z.string().optional().describe('Verification card id to update. Omit to append a card.'),
    }),
    remove_verification_card: z.object({ lineId, cardId: z.string().describe('Verification card id') }),
    list_references: z.object({ lineId }),
    add_reference: z.object({
        lineId,
        format: z.enum(['apa7', 'vancouver']).describe('Citation style the citation string is already formatted in'),
        citation: z.string().min(1).max(2000).describe('Already formatted citation'),
    }),
    remove_reference: z.object({ lineId, referenceId: z.string().describe('Reference id') }),
}

const titles: Record<ExploreTool, string> = {
    get_hypothesis: 'Get Hypothesis',
    set_hypothesis: 'Set Hypothesis',
    list_explorations: 'List Explorations',
    get_exploration: 'Get Exploration',
    create_exploration: 'Create Exploration',
    delete_exploration: 'Delete Exploration',
    list_linked_sessions: 'List Linked Sessions',
    link_session: 'Link Session',
    unlink_session: 'Unlink Session',
    list_verification_cards: 'List Verification Cards',
    add_verification_card: 'Add Verification Card',
    remove_verification_card: 'Remove Verification Card',
    list_references: 'List References',
    add_reference: 'Add Reference',
    remove_reference: 'Remove Reference',
}

const descriptions: Record<ExploreTool, string> = {
    get_hypothesis: 'read the single hypothesis of an exploration.',
    set_hypothesis: 'replace the single hypothesis of an exploration. one exploration serves one hypothesis.',
    list_explorations: 'list this account explorations with id, name and hypothesis.',
    get_exploration: 'read one exploration: hypothesis, linked sessions, verification cards and references.',
    create_exploration: 'create an exploration for one directory and one hypothesis.',
    delete_exploration: 'delete an exploration and its references and verification cards.',
    list_linked_sessions: 'list sessions linked to an exploration.',
    link_session: 'link a session this account can see to an exploration.',
    unlink_session: 'unlink a session from an exploration.',
    list_verification_cards: 'list the training cards bound to an exploration.',
    add_verification_card: 'bind another registered run to an exploration as its own training card.',
    remove_verification_card: 'remove one training card from an exploration.',
    list_references: 'list the formatted references of an exploration.',
    add_reference: 'add one already formatted citation, tagged apa7 or vancouver.',
    remove_reference: 'remove one reference from an exploration.',
}

export function exploreToolTitle(name: ExploreTool): string {
    return titles[name]
}

export function exploreToolDescription(name: ExploreTool): string {
    return descriptions[name]
}

type ExploreContext = { sessionId?: string; machineId?: string; path?: string }

export async function callExploreTool(
    hub: WorkHub,
    name: ExploreTool,
    args: Record<string, unknown>,
    context: ExploreContext,
): Promise<{ text: string; isError: boolean }> {
    const needsLine = name !== 'list_explorations' && name !== 'create_exploration'
    const explicit = textArg(args.lineId)
    let resolved = explicit
    if (needsLine && !resolved) {
        const found = await resolveLine(hub, context)
        if ('status' in found) return formatWorkResult(found.status, found.body)
        resolved = found.lineId
        if (!resolved) return { text: 'this session is not on an exploration', isError: true }
    }
    const response = await dispatch(hub, name, args, resolved, context)
    return formatWorkResult(response.status, response.body)
}

function textArg(value: unknown): string {
    return typeof value === 'string' ? value.trim() : ''
}

async function resolveLine(hub: WorkHub, context: ExploreContext): Promise<{ lineId: string } | Result> {
    const query = new URLSearchParams()
    if (context.sessionId) query.set('sessionId', context.sessionId)
    if (context.machineId) query.set('machineId', context.machineId)
    if (context.path) query.set('path', context.path)
    const response = await hub.request(`/cli/work/session-line?${query.toString()}`)
    if (response.status < 200 || response.status >= 300) return response
    const lineId = response.body && typeof response.body === 'object' && 'lineId' in response.body ? response.body.lineId : null
    return { lineId: typeof lineId === 'string' ? lineId : '' }
}

async function dispatch(hub: WorkHub, name: ExploreTool, args: Record<string, unknown>, lineId: string, context: ExploreContext): Promise<Result> {
    const line = encodeURIComponent(lineId)
    switch (name) {
        case 'list_explorations':
            return hub.request('/cli/work/explorations')
        case 'get_exploration':
            return hub.request(`/cli/work/explorations/${line}`)
        case 'get_hypothesis': {
            const response = await hub.request(`/cli/work/explorations/${line}`)
            if (response.status < 200 || response.status >= 300) return response
            const exploration = response.body && typeof response.body === 'object' && 'exploration' in response.body
                ? response.body.exploration as { hypothesis?: string | null }
                : null
            return { status: 200, body: { lineId, hypothesis: exploration?.hypothesis ?? null } }
        }
        case 'set_hypothesis':
            return hub.request(`/cli/work/explorations/${line}/hypothesis`, { method: 'PUT', body: { hypothesis: args.hypothesis ?? '' } })
        case 'create_exploration': {
            const machineId = textArg(args.machineId) || context.machineId || ''
            const path = textArg(args.path) || context.path || ''
            if (!machineId || !path) return { status: 400, body: { error: 'machineId and path are required' } }
            return hub.request('/cli/work/explorations', {
                method: 'POST',
                body: { name: args.name, hypothesis: args.hypothesis, machineId, path },
            })
        }
        case 'delete_exploration':
            return hub.request(`/cli/work/explorations/${line}`, {
                method: 'DELETE',
                headers: { [EXPLORE_DELETE_CONFIRM_HEADER]: '1' },
            })
        case 'list_linked_sessions':
            return hub.request(`/cli/work/explorations/${line}/sessions`)
        case 'link_session':
        case 'unlink_session': {
            const sessionId = textArg(args.sessionId) || context.sessionId || ''
            if (!sessionId) return { status: 400, body: { error: 'sessionId is required' } }
            const encoded = encodeURIComponent(sessionId)
            return hub.request(`/cli/work/explorations/${line}/sessions/${encoded}`, {
                method: name === 'link_session' ? 'PUT' : 'DELETE',
            })
        }
        case 'list_verification_cards':
            return hub.request(`/cli/work/explorations/${line}/cards`)
        case 'add_verification_card':
            return hub.request(`/cli/work/explorations/${line}/cards`, {
                method: 'POST',
                body: { run: args.run, metrics: args.metrics, xAxis: args.xAxis, cardId: args.cardId },
            })
        case 'remove_verification_card':
            return hub.request(`/cli/work/explorations/${line}/cards/${encodeURIComponent(textArg(args.cardId))}`, { method: 'DELETE' })
        case 'list_references':
            return hub.request(`/cli/work/explorations/${line}/references`)
        case 'add_reference':
            return hub.request(`/cli/work/explorations/${line}/references`, {
                method: 'POST',
                body: { format: args.format, citation: args.citation },
            })
        case 'remove_reference':
            return hub.request(`/cli/work/explorations/${line}/references/${encodeURIComponent(textArg(args.referenceId))}`, { method: 'DELETE' })
    }
}
