import type { ToolCallBlock } from '@/chat/types'
import { resolveTodoToolKind } from '@/chat/projections/todoProjection'
import { isSubagentToolName } from '@/chat/subagentTool'
import { isAskUserQuestionToolName } from '@/components/ToolCard/askUserQuestion'
import { isRequestUserInputToolName } from '@/components/ToolCard/requestUserInput'
import { resolveToolViewName } from '@/components/ToolCard/toolNameAliases'

export type ToolRenderSlot = 'rail' | 'turn-todo-section'
export type ToolPinPolicy = 'never' | 'always' | 'until-recovered' | 'until-resolved'
export type ToolInteractiveFooter = 'none' | 'permission' | 'ask-user-question'

export interface ToolPresentationRule {
    readonly slot: ToolRenderSlot
    readonly pinPolicy: ToolPinPolicy
    readonly interactiveFooter: ToolInteractiveFooter
}

const DEFAULT_RAIL_RULE: ToolPresentationRule = {
    slot: 'rail',
    pinPolicy: 'never',
    interactiveFooter: 'none',
}

/**
 * Classifies where a tool call renders and whether it stays pinned when the
 * execution rail is collapsed.
 *
 * Rules:
 * 1. Todo / UpdatePlan tool with a valid (or optimistically merged) checklist and `state !== 'error'`:
 *    -> `{ slot: 'turn-todo-section', pinPolicy: 'never', interactiveFooter: 'none' }`
 * 2. Todo / UpdatePlan tool in unrecovered `state === 'error'`:
 *    -> `{ slot: 'rail', pinPolicy: 'until-recovered', interactiveFooter: 'none' }`
 *    (The sibling `<TurnTodoSection />` retains the last valid Todo snapshot so the board never flickers.)
 * 3. AskUserQuestion / RequestUserInput awaiting user response:
 *    -> `{ slot: 'rail', pinPolicy: 'until-resolved', interactiveFooter: 'ask-user-question' }`
 * 4. Permission awaiting user approval:
 *    -> `{ slot: 'rail', pinPolicy: 'until-resolved', interactiveFooter: 'permission' }`
 * 5. Unrecovered tool error:
 *    -> `{ slot: 'rail', pinPolicy: 'until-recovered', interactiveFooter: 'none' }`
 * 6. Subagent / Task tool:
 *    -> `{ slot: 'rail', pinPolicy: 'always', interactiveFooter: 'none' }`
 *    -> `{ slot: 'rail', pinPolicy: 'never', interactiveFooter: 'none' }`
 */
export function classifyToolPresentation(
    block: ToolCallBlock,
    context?: { readonly hasValidTodoChecklist?: boolean; readonly errorRecovered?: boolean }
): ToolPresentationRule {
    const tool = block.tool
    const todoKind = resolveTodoToolKind(tool.name)

    if (todoKind !== null) {
        if (tool.state === 'error') {
            return {
                slot: 'rail',
                pinPolicy: context?.errorRecovered ? 'never' : 'until-recovered',
                interactiveFooter: 'none',
            }
        }
        if (context?.hasValidTodoChecklist) {
            return {
                slot: 'turn-todo-section',
                pinPolicy: 'never',
                interactiveFooter: 'none',
            }
        }
    }

    if (isAskUserQuestionToolName(tool.name) || isRequestUserInputToolName(tool.name)) {
        return {
            slot: 'rail',
            pinPolicy: 'until-resolved',
            interactiveFooter: 'ask-user-question',
        }
    }

    if (tool.name === 'CodexPermission' || tool.permission?.status === 'pending') {
        return {
            slot: 'rail',
            pinPolicy: 'until-resolved',
            interactiveFooter: 'permission',
        }
    }

    if (tool.state === 'error') {
        return {
            slot: 'rail',
            pinPolicy: context?.errorRecovered ? 'never' : 'until-recovered',
            interactiveFooter: 'none',
        }
    }

    const resolvedName = resolveToolViewName(tool.name)
    if (isSubagentToolName(tool.name) || isSubagentToolName(resolvedName)) {
        return {
            slot: 'rail',
            pinPolicy: 'always',
            interactiveFooter: 'none',
        }
    }

    return DEFAULT_RAIL_RULE
}
