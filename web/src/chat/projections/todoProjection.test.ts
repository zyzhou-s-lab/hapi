import { describe, expect, it } from 'vitest'
import type { ToolCallBlock } from '@/chat/types'
import {
    collectOmpTodoTurnContext,
    extractTodoChecklist,
    extractUpdatePlanChecklist,
    projectSessionTodoSnapshot,
    projectToolTodoSnapshot,
} from '@/chat/projections/todoProjection'

function makeToolCallBlock(
    id: string,
    name: string,
    input: unknown,
    result?: unknown,
): ToolCallBlock {
    return {
        kind: 'tool-call',
        id,
        localId: null,
        createdAt: 0,
        tool: {
            id,
            name,
            state: result == null ? 'running' : 'completed',
            input,
            createdAt: 0,
            startedAt: 0,
            completedAt: result == null ? null : 1,
            execStartedAt: null,
            execCompletedAt: null,
            description: null,
            result,
        },
        children: [],
    }
}

describe('todoProjection', () => {
    it('extracts OMP turn context from INIT, PHASE, and phase-targeted commands', () => {
        const ctx = collectOmpTodoTurnContext([
            {
                input: {
                    input: [
                        '*** Begin Todo',
                        'PHASE "Phase 2"',
                        'ADD "Task A" "desc" 10',
                        'DONE PHASE "Phase 1"',
                        '*** End Todo',
                    ].join('\n'),
                },
            },
        ])
        expect(ctx.hasInit).toBe(false)
        expect(Array.from(ctx.referencedPhaseNames)).toEqual(['Phase 2', 'Phase 1'])
    })

    it('produces identical counts and activeLabel between projectToolTodoSnapshot and projectSessionTodoSnapshot for OMP multi-phase state', () => {
        const toolBlock = makeToolCallBlock(
            'todo-2',
            'todo',
            {
                input: [
                    '*** Begin Todo',
                    'PHASE "PR 2 Implementation"',
                    'ADD "Unify todoProjection" "desc" 15',
                    'START "Unify todoProjection"',
                    '*** End Todo',
                ].join('\n'),
            },
            {
                details: {
                    phases: [
                        {
                            id: 'phase-1',
                            name: 'PR 1 CSS Layering',
                            tasks: [
                                { id: 'task-1', title: 'Wrap index.css in @layer', status: 'completed' },
                            ],
                        },
                        {
                            id: 'phase-2',
                            name: 'PR 2 Implementation',
                            tasks: [
                                { id: 'task-2', title: 'Unify todoProjection', status: 'in_progress' },
                                { id: 'task-3', title: 'Extract TurnDockedWidgets', status: 'pending' },
                            ],
                        },
                    ],
                },
            },
        )

        const sessionTodos = [
            { id: 'phase-1:0', content: 'Wrap index.css in @layer', status: 'completed' },
            { id: 'phase-2:0', content: 'Unify todoProjection', status: 'in_progress' },
            { id: 'phase-2:1', content: 'Extract TurnDockedWidgets', status: 'pending' },
        ]

        const toolSnapshot = projectToolTodoSnapshot(toolBlock, [toolBlock])
        const sessionSnapshot = projectSessionTodoSnapshot(sessionTodos)

        expect(toolSnapshot.totalCount).toBe(2)
        expect(toolSnapshot.completedCount).toBe(0)
        expect(toolSnapshot.inProgressCount).toBe(1)
        expect(toolSnapshot.pendingCount).toBe(1)
        expect(toolSnapshot.activeLabel).toBe('Unify todoProjection')

        expect(sessionSnapshot.totalCount).toBe(toolSnapshot.totalCount)
        expect(sessionSnapshot.completedCount).toBe(toolSnapshot.completedCount)
        expect(sessionSnapshot.inProgressCount).toBe(toolSnapshot.inProgressCount)
        expect(sessionSnapshot.pendingCount).toBe(toolSnapshot.pendingCount)
        expect(sessionSnapshot.activeLabel).toBe(toolSnapshot.activeLabel)
        expect(sessionSnapshot.items.map((item) => ({ text: item.text, status: item.status }))).toEqual(
            toolSnapshot.items.map((item) => ({ text: item.text, status: item.status })),
        )
    })

    it('merges optimistic in-flight delta against earlier same-turn TodoWrite snapshot when result is null', () => {
        const call1 = makeToolCallBlock(
            'todo-1',
            'todo',
            {
                input: [
                    '*** Begin Todo',
                    'INIT "Goal" "Measure" "Done"',
                    'ADD "Step 1" "desc" 10',
                    'ADD "Step 2" "desc" 10',
                    'START "Step 1"',
                    '*** End Todo',
                ].join('\n'),
            },
            {
                details: {
                    phases: [
                        {
                            id: 'phase-1',
                            name: 'Tasks',
                            tasks: [
                                { id: 'task-1', title: 'Step 1', status: 'in_progress' },
                                { id: 'task-2', title: 'Step 2', status: 'pending' },
                            ],
                        },
                    ],
                },
            },
        )

        const call2Optimistic = makeToolCallBlock(
            'todo-2',
            'todo',
            {
                input: [
                    '*** Begin Todo',
                    'DONE "Step 1"',
                    'START "Step 2"',
                    '*** End Todo',
                ].join('\n'),
            },
            undefined,
        )

        const snapshot = projectToolTodoSnapshot(call2Optimistic, [call1, call2Optimistic])
        expect(snapshot.items).toEqual([
            { id: 'task-1', text: 'Step 1', status: 'completed' },
            { id: 'task-2', text: 'Step 2', status: 'in_progress' },
        ])
        expect(snapshot.completedCount).toBe(1)
        expect(snapshot.inProgressCount).toBe(1)
        expect(snapshot.activeLabel).toBe('Step 2')
    })

    it('prefers activeForm over text for activeLabel when present', () => {
        const snapshot = projectSessionTodoSnapshot([
            { id: '1', content: 'Inspect bundle', activeForm: 'Inspecting bundle', status: 'in_progress' },
            { id: '2', content: 'Verify UI', status: 'pending' },
        ])
        expect(snapshot.activeItem).toEqual({
            id: '1',
            text: 'Inspect bundle',
            activeForm: 'Inspecting bundle',
            status: 'in_progress',
        })
        expect(snapshot.activeLabel).toBe('Inspecting bundle')
    })

    it('projects update_plan tool calls and re-exports extractTodoChecklist / extractUpdatePlanChecklist', () => {
        const planBlock = makeToolCallBlock(
            'plan-1',
            'update_plan',
            {
                plan: [
                    { step: 'Audit CSS cascade', status: 'completed' },
                    { step: 'Unify todoProjection', status: 'in_progress' },
                ],
            },
        )
        const snapshot = projectToolTodoSnapshot(planBlock)
        expect(snapshot.totalCount).toBe(2)
        expect(snapshot.completedCount).toBe(1)
        expect(snapshot.activeLabel).toBe('Unify todoProjection')
        expect(extractUpdatePlanChecklist(planBlock.tool.input, planBlock.tool.result)).toEqual(snapshot.items)
        expect(extractTodoChecklist({ todos: [{ content: 'One', status: 'completed' }] }, null)).toEqual([
            { id: undefined, text: 'One', status: 'completed' },
        ])
    })
})
