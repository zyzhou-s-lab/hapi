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
        expect(screen.queryByTestId('turn-working-sparkle')).toBeNull()
        expect(screen.getByTestId('turn-level1-rail')).toBeInTheDocument()

        expect(screen.getAllByText('docs.example.com').length).toBeGreaterThanOrEqual(1)
        expect(screen.getByText('2 results')).toBeInTheDocument()

        fireEvent.click(screen.getByText('Check Library folder'))
        expect(screen.getByTestId('turn-level2-bash')).toBeInTheDocument()
        expect(screen.getByText('total 16', { exact: false })).toBeInTheDocument()

        fireEvent.click(screen.getAllByText('Desktop documentation')[0]!)
        expect(screen.getByTestId('turn-level2-webfetch')).toBeInTheDocument()
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
})
