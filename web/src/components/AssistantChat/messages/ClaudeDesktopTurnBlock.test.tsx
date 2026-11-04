import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { I18nProvider } from '@/lib/i18n-context'
import type { ToolCallBlock } from '@/chat/types'
import {
    partitionTurn,
    summarizeTurnForClaudeDesktop,
    type TurnContentPart,
} from '@/components/AssistantChat/messages/turnBlockModel'
import {
    ClaudeAskUserQuestionWizard,
    ClaudeDesktopTurnBlockView,
    ClaudeDockedTodoBar,
} from '@/components/AssistantChat/messages/ClaudeDesktopTurnBlock'

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

describe('ClaudeDesktopTurnBlock & summarizeTurnForClaudeDesktop', () => {
    it('computes active Todo working header while streaming and Oxford-comma past-tense summary when completed', () => {
        const partition = partitionTurn([
            { type: 'reasoning', text: 'Inspecting local bundle first.' },
            call(tool('b1', 'Bash', { input: { command: 'ls -la' }, description: 'List files' })),
            call(tool('b2', 'Bash', { input: { command: 'pwd' }, description: 'Print working dir' })),
            call(tool('b3', 'Bash', { input: { command: 'whoami' }, description: 'Check user' })),
            call(tool('r1', 'Read', { input: { file_path: 'src/index.html' } })),
            call(tool('f1', 'WebFetch', {
                input: { url: 'https://code.claude.com/docs/en/claude-code-on-the-web' },
                description: 'Claude Code on the web',
                result: { bytes: 22425, lines: 584, content: 'Docs body' },
            })),
        ], null)

        const summary = summarizeTurnForClaudeDesktop(partition, {
            activeTodoText: 'Inspecting local Claude Desktop configuration and app resources',
        })

        expect(summary.workingHeader).toBe('Inspecting local Claude Desktop configuration and app resources...')
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
                result: { stdout: 'total 16\ndrwxr-xr-x Claude' },
            })),
            call(tool('f1', 'WebFetch', {
                input: { url: 'https://code.claude.com/docs/en/desktop' },
                description: 'Claude Code Desktop',
                result: { bytes: 10240, lines: 240, content: 'Desktop docs' },
            })),
            call(tool('s1', 'WebSearch', {
                input: { query: 'claude code desktop' },
                result: {
                    results: [
                        { title: 'Claude Code Docs', url: 'https://code.claude.com/docs', domain: 'code.claude.com' },
                        { title: 'Anthropic Support', url: 'https://support.claude.com/en', domain: 'support.claude.com' },
                    ],
                },
            })),
            { type: 'text', text: 'Final alignment summary.' },
        ]
        const partition = partitionTurn(parts, null)

        const { rerender } = render(
            <I18nProvider>
                <ClaudeDesktopTurnBlockView
                    partition={partition}
                    streaming={true}
                    durationMs={5000}
                    initiallyOpen={true}
                    activeTodoText="Researching official documentation"
                />
            </I18nProvider>
        )

        // While streaming: Level-0 header shows active Todo with shimmer, and Level-1 rail is open
        const header = screen.getByTestId('claude-level0-header')
        expect(header).toHaveAttribute('aria-expanded', 'true')
        expect(header.textContent).toContain('Researching official documentation...')
        expect(screen.getByTestId('claude-working-sparkle')).toBeInTheDocument()
        expect(screen.getByTestId('claude-level1-rail')).toBeInTheDocument()

        // Right-aligned badges on Level-1 rows
        expect(screen.getByText('code.claude.com')).toBeInTheDocument()
        expect(screen.getByText('2 results')).toBeInTheDocument()

        // Clicking Bash step opens Level-2 Bash card inline
        fireEvent.click(screen.getByText('Check Library folder'))
        expect(screen.getByTestId('claude-level2-bash')).toBeInTheDocument()
        expect(screen.getByText('total 16', { exact: false })).toBeInTheDocument()

        // Clicking WebFetch step opens Level-2 WebFetch card inline
        fireEvent.click(screen.getByText('Claude Code Desktop'))
        expect(screen.getByTestId('claude-level2-webfetch')).toBeInTheDocument()
        expect(screen.getByText('10.0 KB · 240 lines')).toBeInTheDocument()

        // Transition streaming true -> false: auto-collapses and switches header to aggregated past-tense summary
        rerender(
            <I18nProvider>
                <ClaudeDesktopTurnBlockView
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
        expect(screen.queryByTestId('claude-level1-rail')).toBeNull()
        expect(screen.getByTestId('claude-trailing-answer').textContent).toContain('Final alignment summary.')
    })

    it('renders docked Todo bar (1 of 2 -> 2 of 2 Done) and AskUserQuestion wizard', () => {
        const { rerender, unmount } = render(
            <ClaudeDockedTodoBar
                todos={[
                    { id: '1', content: 'Inspect bundle', activeForm: 'Inspecting bundle', status: 'in_progress' },
                    { id: '2', content: 'Verify UI', status: 'pending' },
                ]}
            />
        )

        expect(screen.getByText('1 of 2')).toBeInTheDocument()
        expect(screen.getByText('Inspecting bundle')).toBeInTheDocument()

        rerender(
            <ClaudeDockedTodoBar
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
            <ClaudeAskUserQuestionWizard
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
})
