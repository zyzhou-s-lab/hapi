import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { I18nProvider } from '@/lib/i18n-context'
import type { ToolCallBlock } from '@/chat/types'
import {
    partitionTurn,
    summarizeTurnActivity,
    type TurnContentPart,
} from '@/components/AssistantChat/messages/turnBlockModel'
import {
    DockedQuestionWizard,
    DockedTodoProgressBar,
    TimelineTurnBlockView,
} from '@/components/AssistantChat/messages/TimelineTurnBlock'
import { TurnTimelineDemo } from '@/components/AssistantChat/messages/TurnTimelineDemo'

function tool(id: string, name: string, extra: Partial<ToolCallBlock['tool']> = {}): ToolCallBlock {
    return {
        kind: 'tool-call',
        id,
        localId: null,
        createdAt: 1,
        children: [],
        tool: {
            id,
            name,
            state: 'completed',
            input: {},
            createdAt: 1,
            startedAt: 1,
            completedAt: 2,
            execStartedAt: null,
            execCompletedAt: null,
            description: null,
            ...extra,
        },
    }
}

function call(block: ToolCallBlock): TurnContentPart {
    return { type: 'tool-call', toolName: block.tool.name, toolCallId: block.id, artifact: block }
}

describe('TimelineTurnBlock & summarizeTurnActivity', () => {
    it('computes active Todo working header while streaming and Oxford-comma past-tense summary when completed', () => {
        const partition = partitionTurn([
            { type: 'reasoning', text: 'Inspecting local bundle first.' },
            call(tool('b1', 'Bash', { input: { command: 'ls -la' }, description: 'List files' })),
            call(tool('b2', 'Bash', { input: { command: 'pwd' }, description: 'Print working dir' })),
            call(tool('b3', 'Bash', { input: { command: 'whoami' }, description: 'Check user' })),
            call(tool('r1', 'Read', { input: { file_path: 'src/index.html' } })),
            call(tool('f1', 'WebFetch', {
                input: { url: 'https://example.com/docs/web-guide' },
                description: 'Web documentation guide',
                result: { bytes: 22425, lines: 584, content: 'Docs body' },
            })),
        ], null)

        const summary = summarizeTurnActivity(partition, {
            activeTodoText: 'Inspecting local configuration and app resources',
        })

        expect(summary.workingHeader).toBe('Inspecting local configuration and app resources...')
        expect(summary.completedHeader).toBe('Ran 3 commands, viewed a file, and fetched a page')
        expect(summary.counts).toMatchObject({
            commands: 3,
            reads: 1,
            webFetches: 1,
            thoughts: 1,
        })
    })

    it('renders live working state with expandable Level-1 rail & Level-2 cards, then auto-collapses on completion', () => {
        const parts: TurnContentPart[] = [
            { type: 'reasoning', text: 'Checking local files and web docs.' },
            call(tool('b1', 'Bash', {
                input: { command: 'ls -la ~/Library' },
                description: 'Check Library folder',
                result: { stdout: 'total 16\ndrwxr-xr-x AppSupport' },
            })),
            call(tool('f1', 'WebFetch', {
                input: { url: 'https://docs.example.com/en/desktop' },
                description: 'Desktop documentation',
                result: { bytes: 10240, lines: 240, content: 'Desktop docs' },
            })),
            call(tool('s1', 'WebSearch', {
                input: { query: 'timeline tool cards' },
                result: {
                    results: [
                        { title: 'Developer Docs', url: 'https://docs.example.com/guide', domain: 'docs.example.com' },
                        { title: 'Support Center', url: 'https://support.example.com/en', domain: 'support.example.com' },
                    ],
                },
            })),
            { type: 'text', text: 'Final alignment summary.' },
        ]
        const partition = partitionTurn(parts, null)

        const { rerender } = render(
            <I18nProvider>
                <TimelineTurnBlockView
                    partition={partition}
                    streaming={true}
                    durationMs={5000}
                    initiallyOpen={true}
                    activeTodoText="Researching documentation"
                />
            </I18nProvider>
        )

        const header = screen.getByTestId('turn-level0-header')
        expect(header).toHaveAttribute('aria-expanded', 'true')
        expect(header.textContent).toContain('Researching documentation...')
        expect(header.textContent).toContain('5.0s')
        expect(screen.queryByTestId('turn-working-sparkle')).toBeNull()
        expect(screen.getByTestId('turn-level1-rail')).toBeInTheDocument()

        expect(screen.queryByText('Check Library folder')).toBeNull()
        expect(screen.queryByText('Desktop documentation')).toBeNull()
        expect(screen.getByText('ls -la ~/Library')).toBeInTheDocument()
        expect(screen.getAllByText('docs.example.com').length).toBeGreaterThanOrEqual(1)
        expect(screen.getByText('2 results')).toBeInTheDocument()

        fireEvent.click(screen.getByText('ls -la ~/Library'))
        expect(screen.getByTestId('turn-level2-bash')).toBeInTheDocument()
        expect(screen.getByText('total 16', { exact: false })).toBeInTheDocument()
        fireEvent.click(screen.getAllByText('docs.example.com')[0]!)
        expect(screen.getByTestId('turn-level2-webfetch')).toBeInTheDocument()
        expect(screen.getByText('Desktop documentation')).toBeInTheDocument()
        expect(screen.getByText('10.0 KB · 240 lines')).toBeInTheDocument()
        rerender(
            <I18nProvider>
                <TimelineTurnBlockView
                    partition={partition}
                    streaming={false}
                    durationMs={8000}
                    initiallyOpen={true}
                    activeTodoText={null}
                />
            </I18nProvider>
        )

        expect(header).toHaveAttribute('aria-expanded', 'false')
        expect(header.textContent).toContain('Ran a command, fetched a page, and searched the web')
        expect(screen.getByTestId('turn-level1-shell')).toHaveAttribute('data-open', 'false')
        expect(screen.getByTestId('turn-trailing-answer').textContent).toContain('Final alignment summary.')
    })

    it('renders docked Todo bar (1 of 2 -> 2 of 2 Done) and DockedQuestionWizard', () => {
        const { rerender, unmount } = render(
            <DockedTodoProgressBar
                todos={[
                    { id: '1', content: 'Inspect bundle', activeForm: 'Inspecting bundle', status: 'in_progress' },
                    { id: '2', content: 'Verify UI', status: 'pending' },
                ]}
            />
        )

        expect(screen.getByText('1 of 2')).toBeInTheDocument()
        expect(screen.getAllByText('Inspecting bundle').length).toBeGreaterThanOrEqual(1)

        rerender(
            <DockedTodoProgressBar
                todos={[
                    { id: '1', content: 'Inspect bundle', status: 'completed' },
                    { id: '2', content: 'Verify UI', status: 'completed' },
                ]}
            />
        )
        expect(screen.getByText('2 of 2')).toBeInTheDocument()
        expect(screen.getByText('Done')).toBeInTheDocument()
        unmount()

        let submitted: Record<string, string> | null = null
        render(
            <DockedQuestionWizard
                questions={[
                    { id: 'q1', question: 'First question?', options: [{ label: 'Opt A' }, { label: 'Opt B' }] },
                    { id: 'q2', question: 'Second question?', options: [{ label: 'Opt C' }] },
                ]}
                onSubmit={(ans) => {
                    submitted = ans
                }}
            />
        )

        expect(screen.getByText('1 of 2')).toBeInTheDocument()
        fireEvent.click(screen.getByText('Opt A'))
        expect(screen.getByText('2 of 2')).toBeInTheDocument()
        fireEvent.click(screen.getByText('Opt C'))
        expect(submitted).toEqual({ q1: 'Opt A', q2: 'Opt C' })
    })

    it('transitions from asking-user to resumed-working (Turn 2 active with rail-step-spinner) before completed', () => {
        render(
            <I18nProvider>
                <TurnTimelineDemo />
            </I18nProvider>
        )

        fireEvent.click(screen.getByTestId('stage-btn-asking-user'))
        expect(screen.getByTestId('docked-question-wizard')).toBeInTheDocument()

        fireEvent.click(screen.getByTestId('question-option-1'))
        fireEvent.click(screen.getByTestId('question-option-1'))
        fireEvent.click(screen.getByTestId('question-option-1'))

        expect(screen.getByTestId('submitted-qa-bubble')).toBeInTheDocument()
        const followUpBlock = screen.getByTestId('turn-followup-block')
        expect(followUpBlock).toBeInTheDocument()
        expect(followUpBlock.querySelector('[data-testid="rail-step-spinner"]')).not.toBeNull()
        expect(screen.getByTestId('demo-stop-running-btn')).toBeInTheDocument()
    })

    it('shows rail spinner on running step, transitions to checkmark on completion, and disappears as next step runs', () => {
        vi.useFakeTimers()
        try {
            const step1Running = partitionTurn(
                [
                    call(tool('b1', 'Bash', { state: 'running', input: { command: 'ls -la', description: 'List files' } })),
                    call(tool('r1', 'Read', { state: 'completed', input: { file_path: 'src/a.ts' } })),
                ],
                null
            )
            const { rerender } = render(
                <I18nProvider>
                    <TimelineTurnBlockView
                        partition={step1Running}
                        streaming={true}
                        durationMs={1000}
                        initiallyOpen={true}
                        activeTodoText="Listing files"
                    />
                </I18nProvider>
            )

            const initialSpinner = screen.getByTestId('rail-step-spinner')
            expect(initialSpinner).toHaveAttribute('data-active-row-index', '0')
            expect(initialSpinner).toHaveAttribute('data-indicator-color', '#da7756')
            expect(initialSpinner.getAttribute('style')).toContain('translate3d(0, 14px, 0)')
            expect(screen.queryByTestId('rail-step-checkmark')).toBeNull()

            const step1DoneStep2Running = partitionTurn(
                [
                    call(tool('b1', 'Bash', { state: 'completed', input: { command: 'ls -la', description: 'List files' } })),
                    call(tool('r1', 'Read', { state: 'running', input: { file_path: 'src/a.ts' } })),
                ],
                null
            )
            rerender(
                <I18nProvider>
                    <TimelineTurnBlockView
                        partition={step1DoneStep2Running}
                        streaming={true}
                        durationMs={2000}
                        initiallyOpen={true}
                        activeTodoText="Reading file"
                    />
                </I18nProvider>
            )

            const checkmarkMorph = screen.getByTestId('rail-step-checkmark')
            expect(checkmarkMorph).toBeInTheDocument()
            expect(checkmarkMorph).toHaveAttribute('data-indicator-color', '#da7756')
            expect(screen.getByTestId('rail-step-closing-ring')).toBeInTheDocument()
            expect(screen.getByTestId('rail-step-check-pop')).toBeInTheDocument()

            const movedSpinner = screen.getByTestId('rail-step-spinner')
            expect(movedSpinner).toHaveAttribute('data-active-row-index', '1')
            expect(movedSpinner).toHaveAttribute('data-target-offset-y', '44')
            expect(movedSpinner).toHaveAttribute('data-handoff-phase', 'completing-prev')
            expect(movedSpinner).toHaveAttribute('data-indicator-color', '#da7756')

            act(() => {
                vi.advanceTimersByTime(850)
            })
            expect(screen.getByTestId('rail-step-spinner')).toHaveAttribute('data-handoff-phase', 'sliding')
            expect(screen.getByTestId('rail-step-spinner').getAttribute('style')).toContain('translate3d(0, 44px, 0)')

            act(() => {
                vi.advanceTimersByTime(200)
            })
            expect(screen.queryByTestId('rail-step-checkmark')).toBeNull()
            expect(screen.getByTestId('rail-step-spinner')).toBeInTheDocument()
        } finally {
            vi.useRealTimers()
        }
    })

    it('does not apply inherited whitespace-pre-wrap on the trailing markdown container when renderTrailingText is provided', () => {
        const partition = partitionTurn(
            [
                call(tool('b1', 'Bash', { state: 'completed', input: { command: 'ls' } })),
                { type: 'text', text: '### Title\n\nParagraph 1\n\n- Item A\n- Item B' },
            ],
            null
        )
        render(
            <I18nProvider>
                <TimelineTurnBlockView
                    partition={partition}
                    streaming={false}
                    durationMs={1000}
                    initiallyOpen={false}
                    renderTrailingText={(txt) => <div data-testid="custom-md">{txt}</div>}
                />
            </I18nProvider>
        )
        const trailingContainer = screen.getByTestId('turn-trailing-answer')
        expect(trailingContainer.className).not.toContain('whitespace-pre-wrap')
        expect(screen.getByTestId('custom-md')).toBeInTheDocument()
    })

    it('keeps rail spinner active on a frontier Thinking row during post-Ran LLM gaps and fast completed tool arrivals, and translates todo verbs', () => {
        vi.useFakeTimers()
        try {
            const bashRunning = partitionTurn(
                [
                    call(tool('b1', 'Bash', { state: 'running', input: { command: 'gh pr merge 28', description: 'Merging PR #28' } })),
                ],
                null
            )
            const { rerender } = render(
                <I18nProvider>
                    <TimelineTurnBlockView
                        partition={bashRunning}
                        streaming={true}
                        durationMs={1000}
                        initiallyOpen={true}
                    />
                </I18nProvider>
            )

            expect(screen.getByTestId('rail-step-spinner')).toHaveAttribute('data-active-row-index', '0')
            expect(screen.queryByTestId('rail-frontier-row')).toBeNull()

            // Bash finishes (Ran), LLM is now thinking before the next step arrives
            const bashCompletedGap = partitionTurn(
                [
                    call(tool('b1', 'Bash', { state: 'completed', input: { command: 'gh pr merge 28', description: 'Merging PR #28' } })),
                ],
                null
            )
            rerender(
                <I18nProvider>
                    <TimelineTurnBlockView
                        partition={bashCompletedGap}
                        streaming={true}
                        durationMs={2000}
                        initiallyOpen={true}
                    />
                </I18nProvider>
            )

            expect(screen.getByTestId('rail-step-checkmark')).toBeInTheDocument()
            expect(screen.getByTestId('rail-frontier-row')).toBeInTheDocument()
            expect(screen.getByTestId('rail-step-spinner')).toHaveAttribute('data-active-row-index', '1')
            expect(screen.getByTestId('rail-step-spinner')).toHaveAttribute('data-handoff-phase', 'completing-prev')

            act(() => {
                vi.advanceTimersByTime(1000)
            })
            expect(screen.queryByTestId('rail-step-checkmark')).toBeNull()
            // Spinner remains mounted and spinning on the frontier row (index 1) during the post-Ran LLM wait
            expect(screen.getByTestId('rail-step-spinner')).toHaveAttribute('data-active-row-index', '1')
            expect(screen.getByTestId('rail-step-spinner')).toHaveAttribute('data-handoff-phase', 'sliding')

            // Now a Thought + fast already-completed TodoWrite arrive in a single batch
            const fastBatchArrived = partitionTurn(
                [
                    call(tool('b1', 'Bash', { state: 'completed', input: { command: 'gh pr merge 28', description: 'Merging PR #28' } })),
                    { type: 'reasoning', text: 'Recording todo progress.' },
                    call(tool('t1', 'TodoWrite', {
                        state: 'completed',
                        input: { i: 'Committing markdown fix', todos: [{ content: 'Deploy release', status: 'in_progress' }] },
                    })),
                ],
                null
            )
            rerender(
                <I18nProvider>
                    <TimelineTurnBlockView
                        partition={fastBatchArrived}
                        streaming={true}
                        durationMs={3000}
                        initiallyOpen={true}
                    />
                </I18nProvider>
            )

            // TodoWrite translates cleanly (never raw 'turn.verb.todo') and plays fast-arrival completion morph
            expect(screen.queryByText('turn.verb.todo')).toBeNull()
            expect(screen.getByText('Updated todos')).toBeInTheDocument()
            expect(screen.getByTestId('rail-step-checkmark')).toBeInTheDocument()
            expect(screen.getByTestId('rail-step-spinner')).toHaveAttribute('data-active-row-index', '3')

            act(() => {
                vi.advanceTimersByTime(1000)
            })
            expect(screen.getByTestId('rail-step-spinner')).toHaveAttribute('data-active-row-index', '3')
            expect(screen.getByTestId('rail-step-spinner')).toHaveAttribute('data-handoff-phase', 'sliding')

            // Next running Bash replaces the frontier row at index 3 without a blank 820ms hold
            const nextBashRunning = partitionTurn(
                [
                    call(tool('b1', 'Bash', { state: 'completed', input: { command: 'gh pr merge 28', description: 'Merging PR #28' } })),
                    { type: 'reasoning', text: 'Recording todo progress.' },
                    call(tool('t1', 'TodoWrite', {
                        state: 'completed',
                        input: { i: 'Committing markdown fix', todos: [{ content: 'Deploy release', status: 'in_progress' }] },
                    })),
                    call(tool('b2', 'Bash', { state: 'running', input: { command: 'git fetch origin', description: 'Fetching merged main branch' } })),
                ],
                null
            )
            rerender(
                <I18nProvider>
                    <TimelineTurnBlockView
                        partition={nextBashRunning}
                        streaming={true}
                        durationMs={4000}
                        initiallyOpen={true}
                    />
                </I18nProvider>
            )

            expect(screen.queryByTestId('rail-frontier-row')).toBeNull()
            expect(screen.getByTestId('rail-step-spinner')).toHaveAttribute('data-active-row-index', '3')
            expect(screen.getByTestId('rail-step-spinner')).toHaveAttribute('data-handoff-phase', 'sliding')
        } finally {
            vi.useRealTimers()
        }
    })

    it('renders rail spinners simultaneously on all concurrently running subagents and keeps remaining subagents spinning when one finishes', () => {
        vi.useFakeTimers()
        try {
            const concurrentRunning = partitionTurn(
                [
                    call(tool('parent-task', 'task', {
                        state: 'running',
                        input: { i: 'Dispatching two subagents to inspect code' },
                    })),
                    call(tool('sub-1', 'Task', {
                        state: 'running',
                        input: { description: 'Inspect compaction event handling', subagent_type: 'Explore' },
                    })),
                    call(tool('sub-2', 'Task', {
                        state: 'running',
                        input: { description: 'Inspect concurrent subagent spinner logic', subagent_type: 'Explore' },
                    })),
                ],
                null
            )

            const { rerender } = render(
                <I18nProvider>
                    <TimelineTurnBlockView
                        partition={concurrentRunning}
                        streaming={true}
                        durationMs={1200}
                        initiallyOpen={true}
                    />
                </I18nProvider>
            )

            const spinners = screen.getAllByTestId('rail-step-spinner')
            expect(spinners).toHaveLength(3)
            expect(spinners.map((el) => el.getAttribute('data-active-row-index'))).toEqual(['0', '1', '2'])
            expect(screen.queryByText('Queued')).toBeNull()

            // First row completes while sub-1 and sub-2 continue running concurrently
            const firstCompleted = partitionTurn(
                [
                    call(tool('parent-task', 'task', {
                        state: 'completed',
                        input: { i: 'Dispatching two subagents to inspect code' },
                    })),
                    call(tool('sub-1', 'Task', {
                        state: 'running',
                        input: { description: 'Inspect compaction event handling', subagent_type: 'Explore' },
                    })),
                    call(tool('sub-2', 'Task', {
                        state: 'running',
                        input: { description: 'Inspect concurrent subagent spinner logic', subagent_type: 'Explore' },
                    })),
                ],
                null
            )

            rerender(
                <I18nProvider>
                    <TimelineTurnBlockView
                        partition={firstCompleted}
                        streaming={true}
                        durationMs={2000}
                        initiallyOpen={true}
                    />
                </I18nProvider>
            )

            // Row 0 plays completion morph while Rows 1 and 2 continue spinning immediately without Queued hold
            expect(screen.getByTestId('rail-step-checkmark')).toBeInTheDocument()
            const remainingSpinners = screen.getAllByTestId('rail-step-spinner')
            expect(remainingSpinners).toHaveLength(2)
            expect(remainingSpinners.map((el) => el.getAttribute('data-active-row-index'))).toEqual(['1', '2'])
            expect(remainingSpinners[0]).toHaveAttribute('data-handoff-phase', 'sliding')
            expect(screen.queryByText('Queued')).toBeNull()
        } finally {
            vi.useRealTimers()
        }
    })

    it('keeps Running verb label during morph hold, settles Thinking row when trailing answer text takes over, and preserves header span DOM identity across header updates', () => {
        vi.useFakeTimers()
        try {
            const step1Running = partitionTurn(
                [
                    call(tool('b1', 'Bash', { state: 'running', input: { command: 'ls', description: 'List files' } })),
                ],
                null
            )
            const { rerender } = render(
                <I18nProvider>
                    <TimelineTurnBlockView
                        partition={step1Running}
                        streaming={true}
                        durationMs={1000}
                        initiallyOpen={true}
                    />
                </I18nProvider>
            )

            const headerSpanBefore = screen.getByTestId('turn-level0-header').querySelector('span')
            expect(headerSpanBefore).not.toBeNull()

            // Step 1 finishes and Step 2 starts running simultaneously -> during morph hold, Step 2 verb stays 'Running' (not 'Queued')
            const step2Running = partitionTurn(
                [
                    call(tool('b1', 'Bash', { state: 'completed', input: { command: 'ls', description: 'List files' } })),
                    call(tool('b2', 'Bash', { state: 'running', input: { command: 'pwd', description: 'Print working directory' } })),
                ],
                null
            )
            rerender(
                <I18nProvider>
                    <TimelineTurnBlockView
                        partition={step2Running}
                        streaming={true}
                        durationMs={1500}
                        initiallyOpen={true}
                    />
                </I18nProvider>
            )

            const headerSpanAfter = screen.getByTestId('turn-level0-header').querySelector('span')
            expect(headerSpanAfter).toBe(headerSpanBefore)
            expect(screen.getByTestId('rail-step-spinner')).toHaveAttribute('data-handoff-phase', 'completing-prev')
            expect(screen.queryByText('Queued')).toBeNull()
            expect(screen.getByText('Running')).toBeInTheDocument()

            // Step 2 finishes and a trailing reasoning step streams ('Thinking...')
            const reasoningStreaming = partitionTurn(
                [
                    call(tool('b1', 'Bash', { state: 'completed', input: { command: 'ls', description: 'List files' } })),
                    call(tool('b2', 'Bash', { state: 'completed', input: { command: 'pwd', description: 'Print working directory' } })),
                    { type: 'reasoning', text: 'Synthesizing final response.' },
                ],
                null
            )
            rerender(
                <I18nProvider>
                    <TimelineTurnBlockView
                        partition={reasoningStreaming}
                        streaming={true}
                        durationMs={2000}
                        initiallyOpen={true}
                    />
                </I18nProvider>
            )

            expect(screen.getByText('Thinking...')).toBeInTheDocument()
            expect(screen.getByTestId('rail-step-spinner')).toHaveAttribute('data-active-row-index', '2')

            // Taking-over answer text begins streaming -> reasoning row settles to 'Thought', no frontier row spawns, and rail spinner stops
            const answerTakingOver = partitionTurn(
                [
                    call(tool('b1', 'Bash', { state: 'completed', input: { command: 'ls', description: 'List files' } })),
                    call(tool('b2', 'Bash', { state: 'completed', input: { command: 'pwd', description: 'Print working directory' } })),
                    { type: 'reasoning', text: 'Synthesizing final response.' },
                    { type: 'text', text: 'Here is the final answer taking over.' },
                ],
                null
            )
            rerender(
                <I18nProvider>
                    <TimelineTurnBlockView
                        partition={answerTakingOver}
                        streaming={true}
                        durationMs={2500}
                        initiallyOpen={true}
                    />
                </I18nProvider>
            )

            expect(screen.getByText('Thought')).toBeInTheDocument()
            expect(screen.queryByTestId('rail-frontier-row')).toBeNull()
            expect(screen.queryByTestId('rail-step-spinner')).toBeNull()
            expect(screen.getByTestId('turn-trailing-answer').textContent).toContain('Here is the final answer taking over.')
        } finally {
            vi.useRealTimers()
        }
    })

    it('renders the timeline working indicator and rail spinner immediately for an empty streaming turn instead of returning null', () => {
        const emptyPartition = partitionTurn([], null)
        expect(emptyPartition.hasActivity).toBe(false)

        render(
            <I18nProvider>
                <TimelineTurnBlockView
                    partition={emptyPartition}
                    streaming={true}
                    durationMs={500}
                    initiallyOpen={true}
                />
            </I18nProvider>
        )

        expect(screen.getByTestId('turn-level0-header')).toHaveTextContent('Thinking...')
        expect(screen.getByTestId('rail-frontier-row')).toHaveTextContent('Thinking...')
        expect(screen.getByTestId('rail-step-spinner')).toHaveAttribute('data-active-row-index', '0')
    })

    it('renders ContextCompaction as a Level 1 timeline step, morphs to checkmark on completion, and expands Level 2 summary', () => {
        vi.useFakeTimers()
        try {
            const startedCompaction = partitionTurn(
                [
                    call(tool('b1', 'Bash', { state: 'completed', input: { command: 'ls', description: 'Listing files' } })),
                    call(tool('c1', 'ContextCompaction', {
                        state: 'running',
                        input: {
                            type: 'omp-compaction',
                            phase: 'started',
                            action: 'context-full',
                            reason: 'threshold',
                        },
                    })),
                ],
                null
            )

            const { rerender } = render(
                <I18nProvider>
                    <TimelineTurnBlockView
                        partition={startedCompaction}
                        streaming={true}
                        durationMs={1500}
                        initiallyOpen={true}
                    />
                </I18nProvider>
            )

            expect(screen.getByTestId('turn-level0-header')).toHaveTextContent('Compacting conversation...')
            expect(screen.getByText('Compacting conversation')).toBeInTheDocument()
            expect(screen.getAllByText('context-full · threshold').length).toBeGreaterThan(0)
            expect(screen.getByTestId('rail-step-spinner')).toHaveAttribute('data-active-row-index', '1')

            // Compaction finishes in place (same id 'c1') while the turn is still streaming (waiting for next LLM output)
            const finishedCompaction = partitionTurn(
                [
                    call(tool('b1', 'Bash', { state: 'completed', input: { command: 'ls', description: 'Listing files' } })),
                    call(tool('c1', 'ContextCompaction', {
                        state: 'completed',
                        input: {
                            type: 'omp-compaction',
                            phase: 'finished',
                            action: 'context-full',
                            outcome: 'completed',
                            result: {
                                tokensBefore: 156000,
                                shortSummary: 'Summarized earlier session context and tool results.',
                            },
                        },
                    })),
                ],
                null
            )

            rerender(
                <I18nProvider>
                    <TimelineTurnBlockView
                        partition={finishedCompaction}
                        streaming={true}
                        durationMs={2500}
                        initiallyOpen={true}
                    />
                </I18nProvider>
            )

            expect(screen.getByText('Compacted conversation')).toBeInTheDocument()
            expect(screen.getByText('156k tokens')).toBeInTheDocument()
            expect(screen.getByTestId('rail-step-checkmark')).toBeInTheDocument()
            expect(screen.getByTestId('rail-frontier-row')).toHaveTextContent('Thinking...')
            expect(screen.getByTestId('rail-step-spinner')).toHaveAttribute('data-active-row-index', '2')
            fireEvent.click(screen.getByText('Compacted conversation'))
            expect(screen.getByTestId('turn-level2-compaction')).toHaveTextContent('Summarized earlier session context and tool results.')
        } finally {
            vi.useRealTimers()
        }
    })

    it('displays tool intent only while running and hides intent once completed, while showing live elapsed duration on the header', () => {
        const runningPartition = partitionTurn(
            [
                call(tool('r1', 'Read', {
                    state: 'running',
                    input: { file_path: '/repo/src/TimelineTurnBlock.tsx', i: 'Reading TimelineTurnBlock header logic' },
                })),
                call(tool('e1', 'Edit', {
                    state: 'running',
                    input: {
                        file_path: '/repo/src/turnBlockModel.ts',
                        old_string: 'const a = 1',
                        new_string: 'const a = 2\nconst b = 3',
                        i: 'Updating describeTurnToolStep intent visibility',
                    },
                })),
                call(tool('g1', 'Grep', {
                    state: 'running',
                    input: { pattern: 'turn-level0-header', path: '/repo/src', i: 'Searching for header testid' },
                })),
                call(tool('td1', 'TodoWrite', {
                    state: 'running',
                    input: {
                        todos: [{ id: '1', content: 'Update timeline intent', status: 'in_progress' }],
                        i: 'Updating todo progress',
                    },
                })),
                call(tool('ag1', 'Task', {
                    state: 'running',
                    description: 'Auditing timeline transitions',
                    input: { prompt: 'Check timeline transitions' },
                })),
            ],
            null
        )

        const { rerender } = render(
            <I18nProvider>
                <TimelineTurnBlockView
                    partition={runningPartition}
                    streaming={true}
                    durationMs={12000}
                    initiallyOpen={true}
                />
            </I18nProvider>
        )

        const header = screen.getByTestId('turn-level0-header')
        expect(header.textContent).toContain('12.0s')
        expect(screen.getByText('Reading TimelineTurnBlock header logic')).toBeInTheDocument()
        expect(screen.getByText('Updating describeTurnToolStep intent visibility')).toBeInTheDocument()
        expect(screen.getByText('Searching for header testid')).toBeInTheDocument()
        expect(screen.getByText('Updating todo progress')).toBeInTheDocument()
        expect(screen.getByText('Auditing timeline transitions')).toBeInTheDocument()

        const completedPartition = partitionTurn(
            [
                call(tool('r1', 'Read', {
                    state: 'completed',
                    input: { file_path: '/repo/src/TimelineTurnBlock.tsx', i: 'Reading TimelineTurnBlock header logic' },
                    result: 'line 1\nline 2\nline 3',
                })),
                call(tool('e1', 'Edit', {
                    state: 'completed',
                    input: {
                        file_path: '/repo/src/turnBlockModel.ts',
                        old_string: 'const a = 1',
                        new_string: 'const a = 2\nconst b = 3',
                        i: 'Updating describeTurnToolStep intent visibility',
                    },
                })),
                call(tool('g1', 'Grep', {
                    state: 'completed',
                    input: { pattern: 'turn-level0-header', path: '/repo/src', i: 'Searching for header testid' },
                    result: 'src/TimelineTurnBlock.tsx:1150',
                })),
                call(tool('td1', 'TodoWrite', {
                    state: 'completed',
                    input: {
                        todos: [{ id: '1', content: 'Update timeline intent', status: 'in_progress' }],
                        i: 'Updating todo progress',
                    },
                })),
                call(tool('ag1', 'Task', {
                    state: 'completed',
                    description: 'Auditing timeline transitions',
                    input: { prompt: 'Check timeline transitions' },
                    result: 'All clear',
                })),
            ],
            null
        )

        rerender(
            <I18nProvider>
                <TimelineTurnBlockView
                    partition={completedPartition}
                    streaming={true}
                    durationMs={27000}
                    initiallyOpen={true}
                />
            </I18nProvider>
        )

        expect(header.textContent).toContain('27.0s')
        expect(screen.queryByText('Reading TimelineTurnBlock header logic')).toBeNull()
        expect(screen.queryByText('Updating describeTurnToolStep intent visibility')).toBeNull()
        expect(screen.queryByText('Searching for header testid')).toBeNull()
        expect(screen.queryByText('Updating todo progress')).toBeNull()
        expect(screen.queryByText('Auditing timeline transitions')).toBeNull()

        expect(screen.getByText('TimelineTurnBlock.tsx')).toBeInTheDocument()
        expect(screen.getByText('3 lines')).toBeInTheDocument()
        expect(screen.getByText('turnBlockModel.ts')).toBeInTheDocument()
        expect(screen.getByText('for turn-level0-header in src')).toBeInTheDocument()
        expect(screen.getByText('Done')).toBeInTheDocument()
    })
})
