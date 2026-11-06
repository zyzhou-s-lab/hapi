import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { ToolCallBlock } from '@/chat/types'
import { ChecklistList, collectOmpTodoTurnContext, extractTodoChecklist, extractUpdatePlanChecklist } from '@/components/ToolCard/checklist'
import { getToolPresentation } from '@/components/ToolCard/knownTools'
import { getToolViewComponent } from '@/components/ToolCard/views/_all'
import { UpdatePlanView } from '@/components/ToolCard/views/UpdatePlanView'

function makeUpdatePlanBlock(input: unknown, result?: unknown): ToolCallBlock {
    return {
        kind: 'tool-call',
        id: 'tool-1',
        localId: null,
        createdAt: 0,
        tool: {
            id: 'tool-1',
            name: 'update_plan',
            state: 'completed',
            input,
            createdAt: 0,
            startedAt: 0,
            completedAt: 0,
            execStartedAt: null,
            execCompletedAt: null,
            description: null,
            result
        },
        children: []
    }
}

describe('extractUpdatePlanChecklist', () => {
    it('prefers input.plan over result.plan', () => {
        const items = extractUpdatePlanChecklist(
            {
                plan: [
                    { step: 'Patch root cause', status: 'completed' }
                ]
            },
            {
                plan: [
                    { step: 'Result fallback', status: 'pending' }
                ]
            }
        )

        expect(items).toEqual([
            { text: 'Patch root cause', status: 'completed', id: undefined }
        ])
    })

    it('falls back to result.plan when input.plan is absent', () => {
        const items = extractUpdatePlanChecklist(
            {},
            {
                plan: [
                    { step: 'Re-run build validation', status: 'in_progress' }
                ]
            }
        )

        expect(items).toEqual([
            { text: 'Re-run build validation', status: 'in_progress', id: undefined }
        ])
    })

    it('keeps valid steps and normalizes unknown status to pending', () => {
        const items = extractUpdatePlanChecklist(
            {
                plan: [
                    { step: 'Summarize fix', status: 'unknown_status' },
                    { step: 123, status: 'completed' },
                    { status: 'pending' }
                ]
            },
            null
        )

        expect(items).toEqual([
            { text: 'Summarize fix', status: 'pending', id: undefined }
        ])
    })
})

describe('extractTodoChecklist', () => {
    it('uses result.newTodos when input.todos is unavailable', () => {
        const items = extractTodoChecklist(
            null,
            {
                newTodos: [
                    { id: 'todo-1', content: 'Ship it', status: 'completed' }
                ]
            }
        )

        expect(items).toEqual([
            { id: 'todo-1', text: 'Ship it', status: 'completed' }
        ])
    })

    it('keeps a blocked flag distinct from pending and still reads a raw blocked status', () => {
        expect(extractTodoChecklist({
            todos: [
                { content: 'wait', status: 'pending', blocked: true, id: 'b' },
                { content: 'drop', status: 'abandoned' }
            ]
        }, null)).toEqual([
            { id: 'b', text: 'wait', status: 'blocked' },
            { id: undefined, text: 'drop', status: 'pending' }
        ])
        expect(extractTodoChecklist(null, {
            phases: [{ name: 'Ship', tasks: [{ content: 'wait', status: 'blocked', id: 'b' }] }]
        })).toEqual([
            { id: 'b', text: 'wait', status: 'blocked' }
        ])
    })

    it('excludes earlier completed phases when a subsequent turn appends and completes a new phase', () => {
        const priorPhase = {
            name: 'Tasks',
            tasks: [
                { id: 'task-1', content: 'Deduplicate SessionStatusPanel', status: 'completed' },
                { id: 'task-2', content: 'Implement TimelineTodoChecklistCard', status: 'completed' },
            ],
        }
        const startInput = {
            input: [
                '*** Begin Todo',
                'PHASE "Markdown Table Pipe Repair"',
                'ADD "Escape pipes in table code spans" "Fix remark-repair-tables" 10',
                'START "Escape pipes in table code spans"',
                '*** End Todo',
            ].join('\n'),
        }
        const startResult = {
            details: {
                op: 'batch',
                operations: ['append', 'start'],
                changes: [
                    {
                        op: 'append',
                        phase: 'Markdown Table Pipe Repair',
                        items: [{ id: 'task-5', title: 'Escape pipes in table code spans' }],
                    },
                    {
                        op: 'start',
                        task: 'Escape pipes in table code spans',
                    },
                ],
                phases: [
                    priorPhase,
                    {
                        name: 'Markdown Table Pipe Repair',
                        tasks: [
                            { id: 'task-5', content: 'Escape pipes in table code spans', status: 'in_progress' },
                        ],
                    },
                ],
            },
        }
        expect(extractTodoChecklist(startInput, startResult)).toEqual([
            { id: 'task-5', text: 'Escape pipes in table code spans', status: 'in_progress' },
        ])

        const doneInput = {
            input: [
                '*** Begin Todo',
                'DONE "Escape pipes in table code spans" "fix(web): escape pipes"',
                '*** End Todo',
            ].join('\n'),
        }
        const doneResult = {
            details: {
                op: 'done',
                operations: ['done'],
                changes: [
                    {
                        op: 'done',
                        task: 'Escape pipes in table code spans',
                    },
                ],
                completedTasks: [
                    {
                        task: 'Escape pipes in table code spans',
                        commit: '848b095',
                    },
                ],
                phases: [
                    priorPhase,
                    {
                        name: 'Markdown Table Pipe Repair',
                        tasks: [
                            { id: 'task-5', content: 'Escape pipes in table code spans', status: 'completed' },
                        ],
                    },
                ],
            },
        }
        const turnContext = collectOmpTodoTurnContext([
            { input: startInput, result: startResult },
            { input: doneInput, result: doneResult },
        ])
        expect(extractTodoChecklist(doneInput, doneResult, turnContext)).toEqual([
            { id: 'task-5', text: 'Escape pipes in table code spans', status: 'completed' },
        ])
    })

    it('scopes session-level input.todos with OMP phase-prefixed IDs to the active phase', () => {
        const items = extractTodoChecklist(
            {
                todos: [
                    { id: 'Fix lag:1', content: 'Inspect session switch', status: 'completed', priority: 'medium' },
                    { id: 'Fix lag:2', content: 'Commit and merge', status: 'completed', priority: 'medium' },
                    { id: 'Fix scroll:1', content: 'Reproduce scroll jump', status: 'completed', priority: 'medium' },
                    { id: 'Fix scroll:2', content: 'Anchor viewport', status: 'in_progress', priority: 'medium' }
                ]
            },
            undefined
        )
        expect(items).toEqual([
            { id: 'Fix scroll:1', text: 'Reproduce scroll jump', status: 'completed' },
            { id: 'Fix scroll:2', text: 'Anchor viewport', status: 'in_progress' }
        ])
    })

    it('advances past an earlier phase with only blocked/completed tasks when a later phase has an active task', () => {
        const items = extractTodoChecklist(
            {
                todos: [
                    { id: 'Phase 1:1', content: 'Add multi-port dev isolation section to V3.1 spec', status: 'pending', blocked: true, priority: 'medium' },
                    { id: 'Phase 2:1', content: 'Implement PR 1 CSS layer cleanup', status: 'in_progress', priority: 'medium' }
                ]
            },
            undefined
        )
        expect(items).toEqual([
            { id: 'Phase 2:1', text: 'Implement PR 1 CSS layer cleanup', status: 'in_progress' }
        ])
    })

    it('replays incremental OMP todo calls across a turn and marks all tasks completed on DONE ALL when phases are cleared or text-only', () => {
        const addAndStartInput = {
            input: [
                '*** Begin Todo',
                'PHASE "Phase 2: Unified Projection & Docked Widgets"',
                'ADD "2.1: Create web/src/chat/projections/todoProjection.ts + unit tests" "Create module" 10',
                'ADD "2.2: Migrate Checklist, TimelineTurnBlock, TurnTimelineDemo, and ToolMessage to todoProjection" "Migrate consumers" 15',
                'ADD "2.3 & 2.4: Extract TurnDockedWidgets.tsx & delete classic TurnBlockView" "Extract widgets" 15',
                'ADD "2.5: Run vitest + typecheck and commit PR 2" "Verify and commit" 10',
                'START "2.1: Create web/src/chat/projections/todoProjection.ts + unit tests"',
                '*** End Todo',
            ].join('\n'),
        }
        const rejectedDoneStartInput = {
            input: [
                '*** Begin Todo',
                'DONE "2.1: Create web/src/chat/projections/todoProjection.ts + unit tests"',
                'START "2.2: Migrate Checklist, TimelineTurnBlock, TurnTimelineDemo, and ToolMessage to todoProjection"',
                '*** End Todo',
            ].join('\n'),
        }
        const startThirdInput = {
            input: [
                '*** Begin Todo',
                'START "2.3 & 2.4: Extract TurnDockedWidgets.tsx & delete classic TurnBlockView"',
                '*** End Todo',
            ].join('\n'),
        }
        const doneAllInput = {
            input: [
                '*** Begin Todo',
                'DONE ALL "refactor(web): unify todoProjection, extract TurnDockedWidgets, and remove classic TurnBlockView (PR 2)"',
                '*** End Todo',
            ].join('\n'),
        }

        const turnContext = collectOmpTodoTurnContext([
            { input: addAndStartInput, result: [{ type: 'text', text: 'Initialized phase 2' }] },
            { input: rejectedDoneStartInput, result: { isError: true, content: 'Uncommitted changes require commit message' } },
            { input: startThirdInput, result: [{ type: 'text', text: 'Started 2.3 & 2.4' }] },
            { input: doneAllInput, result: { details: { op: 'done', operations: ['done'], phases: [] } } },
        ])

        expect(extractTodoChecklist(startThirdInput, [{ type: 'text', text: 'Started 2.3 & 2.4' }], turnContext)).toEqual([
            { text: '2.1: Create web/src/chat/projections/todoProjection.ts + unit tests', status: 'pending' },
            { text: '2.2: Migrate Checklist, TimelineTurnBlock, TurnTimelineDemo, and ToolMessage to todoProjection', status: 'pending' },
            { text: '2.3 & 2.4: Extract TurnDockedWidgets.tsx & delete classic TurnBlockView', status: 'in_progress' },
            { text: '2.5: Run vitest + typecheck and commit PR 2', status: 'pending' },
        ])

        expect(extractTodoChecklist(doneAllInput, { details: { op: 'done', operations: ['done'], phases: [] } }, turnContext)).toEqual([
            { text: '2.1: Create web/src/chat/projections/todoProjection.ts + unit tests', status: 'completed' },
            { text: '2.2: Migrate Checklist, TimelineTurnBlock, TurnTimelineDemo, and ToolMessage to todoProjection', status: 'completed' },
            { text: '2.3 & 2.4: Extract TurnDockedWidgets.tsx & delete classic TurnBlockView', status: 'completed' },
            { text: '2.5: Run vitest + typecheck and commit PR 2', status: 'completed' },
        ])
    })
})

describe('update_plan tool presentation', () => {
    it('shows plan title, step count, and expanded body when steps exist', () => {
        const presentation = getToolPresentation({
            toolName: 'update_plan',
            input: {
                plan: [
                    { step: 'Reproduce web build failure', status: 'completed' },
                    { step: 'Trace broken build path', status: 'completed' }
                ]
            },
            result: undefined,
            childrenCount: 0,
            description: null,
            metadata: null
        })

        expect(presentation.title).toBe('Plan')
        expect(presentation.subtitle).toBe('2 steps')
        expect(presentation.minimal).toBe(false)
    })

    it('stays minimal when there are no valid steps', () => {
        const presentation = getToolPresentation({
            toolName: 'update_plan',
            input: { plan: [{ status: 'completed' }] },
            result: undefined,
            childrenCount: 0,
            description: null,
            metadata: null
        })

        expect(presentation.subtitle).toBeNull()
        expect(presentation.minimal).toBe(true)
    })
})

describe('UpdatePlanView', () => {
    it('renders checklist rows with status styling', () => {
        render(
            <UpdatePlanView
                block={makeUpdatePlanBlock({
                    plan: [
                        { step: 'Reproduce web build failure', status: 'completed' },
                        { step: 'Trace broken build path', status: 'in_progress' },
                        { step: 'Summarize fix', status: 'unknown_status' }
                    ]
                })}
                metadata={null}
            />
        )

        const completed = screen.getByText(/Reproduce web build failure/)
        const inProgress = screen.getByText(/Trace broken build path/)
        const pending = screen.getByText(/Summarize fix/)

        expect(completed).toBeInTheDocument()
        expect(completed.className).toContain('line-through')
        expect(inProgress.className).toContain('text-[var(--app-link)]')
        expect(pending.className).toContain('text-[var(--app-hint)]')
    })

    it('is registered as the compact tool view', () => {
        expect(getToolViewComponent('update_plan')).toBe(UpdatePlanView)
    })
})

describe('ChecklistList', () => {
    it('renders blank steps as empty placeholders', () => {
        render(
            <ChecklistList
                items={[
                    { text: '   ', status: 'pending' }
                ]}
            />
        )

        expect(screen.getByText(/\(empty\)/)).toBeInTheDocument()
    })

})
