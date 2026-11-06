import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ToolCallBlock } from '@/chat/types'
import {
    partitionTurn,
    type TurnContentPart,
} from '@/components/AssistantChat/messages/turnBlockModel'
import {
    TimelineTurnBlockView,
    TurnActivitySparkleIcon,
    type TranscriptViewMode,
    type TurnActivityIndicatorVariant,
} from '@/components/AssistantChat/messages/TimelineTurnBlock'
import {
    DockedQuestionWizard,
    DockedTodoProgressBar,
    SubmittedQuestionSummaryBubble,
    type DockedQuestionItem,
    type DockedTodoItem,
} from '@/components/AssistantChat/messages/TurnDockedWidgets'
import { cn } from '@/lib/utils'

export type DemoLifecycleStage =
    | 'working-step-1'
    | 'working-step-2'
    | 'working-step-3'
    | 'asking-user'
    | 'resumed-working'
    | 'completed'
function makeToolPart(input: {
    id: string
    name: string
    state: 'running' | 'completed' | 'error' | 'pending'
    toolInput: Record<string, unknown>
    result?: unknown
    description?: string
}): TurnContentPart {
    const block: ToolCallBlock = {
        kind: 'tool-call',
        id: input.id,
        localId: input.id,
        createdAt: 1700000000000,
        children: [],
        tool: {
            id: input.id,
            name: input.name,
            state: input.state,
            input: input.toolInput,
            result: input.result,
            createdAt: 1700000000000,
            startedAt: 1700000000000,
            completedAt: input.state === 'completed' ? 1700000005000 : null,
            execStartedAt: null,
            execCompletedAt: null,
            description: input.description ?? null,
        },
    }
    return {
        type: 'tool-call',
        toolCallId: input.id,
        toolName: input.name,
        artifact: block,
        status: { type: input.state === 'running' || input.state === 'pending' ? 'running' : 'complete' },
    }
}

const DEMO_QUESTIONS: DockedQuestionItem[] = [
    {
        id: 'header-style',
        question: 'How should HAPI render the Level-0 TurnBlock header while tools are running?',
        options: [
            {
                label: 'Sync with active Todo + text shimmer (Timeline style)',
                description: 'Shows in-progress task title while working, then auto-collapses to aggregated past-tense summary on completion',
            },
            {
                label: 'Show only current tool command',
                description: 'Displays the raw tool intent without Todo synchronization',
            },
            {
                label: 'Keep static bordered card header',
                description: 'Retains classic HAPI rounded-2xl bordered table header',
            },
        ],
    },
    {
        id: 'level2-cards',
        question: 'Which Level-2 inline tool preview cards should expand inside the vertical timeline rail?',
        options: [
            {
                label: 'Compact Bash, WebFetch, WebSearch & Diff cards',
                description: 'Dedicated lightweight inline cards without modal INPUT/OUTPUT chrome',
            },
            {
                label: 'Full modal ToolDetailDialogContent inline',
                description: 'Renders full trace sections inside the timeline',
            },
        ],
    },
    {
        id: 'todo-dock',
        question: 'Where should Todo progress and AskUserQuestion prompts be anchored?',
        options: [
            {
                label: 'Docked above the bottom composer card',
                description: 'Shows 1 of 4 -> 4 of 4 Done bar and < 1 of 3 > wizard above composer',
            },
            {
                label: 'Pinned inline inside the chat scrollback',
                description: 'Renders inside the message stream',
            },
        ],
    },
]

const WEB_SEARCH_RESULTS = [
    {
        title: 'Remote Session Architecture - Documentation',
        url: 'https://docs.example.com/en/remote-sessions',
        domain: 'docs.example.com',
    },
    {
        title: 'Desktop Workspace & Panes Guide',
        url: 'https://docs.example.com/en/desktop',
        domain: 'docs.example.com',
    },
    {
        title: 'Configure Preview Servers & Local Environments',
        url: 'https://docs.example.com/en/desktop#environment-configuration',
        domain: 'docs.example.com',
    },
    {
        title: 'Interactive Tool Permissions & Auto Mode | Help Center',
        url: 'https://support.example.com/en/articles/interactive-permissions',
        domain: 'support.example.com',
    },
    {
        title: 'hapi/web: Frontend turn timeline & tool card components',
        url: 'https://github.com/mouriya-s-lab/hapi',
        domain: 'github.com',
    },
]

function buildStageData(stage: DemoLifecycleStage, activeToolIdx = 6): {
    parts: TurnContentPart[]
    streaming: boolean
    durationMs: number
    todos: DockedTodoItem[]
    activeTodoText: string | null
    followUpParts: TurnContentPart[] | null
    followUpStreaming: boolean
    followUpDurationMs: number | null
    followUpActiveTodoText: string | null
} {
    const thought1: TurnContentPart = {
        type: 'reasoning',
        text: 'The user wants to inspect how working tool cards group, expand across 3 levels, and auto-collapse upon completion. Let me inspect the local workspace configuration and TurnBlock implementation first.',
        status: { type: 'complete' },
    }
    const step3ToolState = (idx: number): 'running' | 'completed' | 'pending' => {
        if (activeToolIdx === idx) return 'running'
        if (activeToolIdx > idx) return 'completed'
        return 'pending'
    }

    const bash1 = makeToolPart({
        id: 'tool-bash-1',
        name: 'Bash',
        state: stage === 'working-step-1'
            ? 'running'
            : stage === 'working-step-3'
                ? step3ToolState(0)
                : 'completed',
        toolInput: {
            command: 'ls -la "$HOME/.hapi" "web/src/components/AssistantChat/messages"',
            description: 'Inspect local workspace configuration and session directories',
        },
        result: {
            stdout: [
                'drwxr-xr-x@ 12 user  staff    384 Nov  4 14:10 .',
                '-rw-r--r--@  1 user  staff   1962 Nov  4 13:58 settings.json',
                '-rw-r--r--@  1 user  staff  11420 Nov  4 14:02 TurnBlock.tsx',
                '-rw-r--r--@  1 user  staff  14890 Nov  4 14:02 turnBlockModel.ts',
            ].join('\n'),
        },
    })

    const bash2 = makeToolPart({
        id: 'tool-bash-2',
        name: 'Bash',
        state: stage === 'working-step-3' ? step3ToolState(1) : 'completed',
        description: 'Search frontend styles for timeline status and shimmer utilities',
        toolInput: {
            command: 'rg -n "turn-timeline-status-enter|turn-text-shimmer|collapsible-panel" web/src/index.css',
            description: 'Search frontend styles for timeline status and shimmer utilities',
        },
        result: {
            stdout: [
                '475:.collapsible-panel {',
                '931:.turn-text-shimmer {',
                '945:.turn-timeline-status-enter {',
            ].join('\n'),
        },
    })

    const bash3 = makeToolPart({
        id: 'tool-bash-3',
        name: 'Bash',
        state: stage === 'working-step-3' ? step3ToolState(2) : 'completed',
        description: 'Check TurnBlock and turnBlockModel in HAPI web frontend',
        toolInput: {
            command: 'git log -n 3 --oneline -- web/src/components/AssistantChat/messages/TurnBlock.tsx',
            description: 'Check TurnBlock and turnBlockModel in HAPI web frontend',
        },
        result: {
            stdout: [
                'e3a569c6 fix(web): prefer tool intent for TurnBlock title and truncate to one line',
                'd84df101 feat(web): fold turn steps under TurnBlock',
            ].join('\n'),
        },
    })

    const read1 = makeToolPart({
        id: 'tool-read-1',
        name: 'Read',
        state: stage === 'working-step-2'
            ? 'running'
            : stage === 'working-step-3'
                ? step3ToolState(3)
                : 'completed',
        description: 'TurnBlock.tsx',
        toolInput: {
            file_path: 'web/src/components/AssistantChat/messages/TurnBlock.tsx',
        },
        result: {
            content: [
                'export function TurnBlockView(props: {',
                '    partition: TurnPartition',
                '    streaming: boolean',
                '    durationMs: number | null',
                '    initiallyOpen: boolean',
                '    variant?: "classic" | "timeline"',
                '}) {',
                '    const sawStream = useRef(props.streaming)',
                '    useEffect(() => {',
                '        if (sawStream.current && !props.streaming) setOpen(false)',
                '        sawStream.current = props.streaming',
                '    }, [props.streaming])',
                '}',
            ].join('\n'),
        },
    })

    const thought2: TurnContentPart = {
        type: 'reasoning',
        text: 'Now let me fetch the reference documentation and compare the 3-level expansion hierarchy (Level 0 summary -> Level 1 vertical rail -> Level 2 compact preview cards) with classic TurnBlock.',
        status: { type: 'complete' },
    }

    const webFetch1 = makeToolPart({
        id: 'tool-webfetch-1',
        name: 'WebFetch',
        state: stage === 'working-step-3' ? step3ToolState(4) : 'completed',
        description: 'Interactive Turn Timeline & View Modes',
        toolInput: {
            url: 'https://docs.example.com/en/turn-timeline',
            description: 'Interactive Turn Timeline & View Modes',
        },
        result: {
            title: 'Interactive Turn Timeline & View Modes',
            bytes: 22425,
            lines: 584,
            content: 'Each conversation turn groups intermediate tool calls and reasoning under a collapsible timeline header. Switch transcript view modes (Normal, Thinking, Verbose) with Ctrl+O.',
        },
    })

    const webSearch1 = makeToolPart({
        id: 'tool-websearch-1',
        name: 'WebSearch',
        state: stage === 'working-step-3' ? step3ToolState(5) : 'completed',
        description: 'Searched the web',
        toolInput: {
            query: 'turn timeline tool cards grouping preview',
        },
        result: {
            results: WEB_SEARCH_RESULTS,
        },
    })

    const edit1 = makeToolPart({
        id: 'tool-edit-1',
        name: 'Edit',
        state: stage === 'working-step-3' ? step3ToolState(6) : 'completed',
        description: 'Update TurnBlockView to support timeline layout',
        toolInput: {
            file_path: 'web/src/components/AssistantChat/messages/TurnBlock.tsx',
            old_string: '<div className="divide-y divide-[var(--app-divider)] overflow-hidden rounded-2xl border border-[var(--app-border)]">',
            new_string: '<TimelineTurnBlockView\n    partition={props.partition}\n    streaming={props.streaming}\n    activeTodoText={props.activeTodoText}\n/>',
        },
        result: { ok: true },
    })

    const trailingAnswer: TurnContentPart = {
        type: 'text',
        text: [
            'Here is how the **Timeline** turn layout structures working tool cards across 3 levels:',
            '',
            '1. **Level 0 (Group Summary Header)**: Borderless row showing the active Todo task with `.turn-text-shimmer` while working, then automatically collapsing on completion into an aggregated past-tense summary (`Ran 3 commands, viewed a file, edited a file, fetched a page, and searched the web`).',
            '2. **Level 1 (Vertical Step Timeline Rail)**: Indented `border-l` rail with collapsible `Thought` rows, present-participle running verbs (`Running`, `Viewing`, `Fetching`), and right-aligned metadata badges (`docs.example.com`, `5 results`, `+4 -1`).',
            '3. **Level 2 (Inline Compact Preview Cards)**: Purpose-built inline Bash (copy + scrollable stdout), WebFetch (URL + byte/line footer), WebSearch (favicon + domain list), and File Diff cards.',
        ].join('\n'),
        status: { type: 'complete' },
    }

    if (stage === 'working-step-1') {
        const todos: DockedTodoItem[] = [
            { id: '1', content: 'Inspect local workspace configuration and session directories', activeForm: 'Inspecting local workspace configuration and session directories', status: 'in_progress' },
            { id: '2', content: 'Search frontend bundle for timeline group and step cards', activeForm: 'Searching frontend bundle for timeline group and step cards', status: 'pending' },
            { id: '3', content: 'Fetch reference documentation and compare with classic TurnBlock', activeForm: 'Fetching reference documentation and comparing with classic TurnBlock', status: 'pending' },
            { id: '4', content: 'Verify 3-level expansion, auto-collapse, and docked composer widgets', activeForm: 'Verifying 3-level expansion, auto-collapse, and docked composer widgets', status: 'pending' },
        ]
        return {
            parts: [thought1, bash1],
            streaming: true,
            durationMs: 4200,
            todos,
            activeTodoText: todos[0]?.activeForm ?? null,
            followUpParts: null,
            followUpStreaming: false,
            followUpDurationMs: null,
            followUpActiveTodoText: null,
        }
    }

    if (stage === 'working-step-2') {
        const todos: DockedTodoItem[] = [
            { id: '1', content: 'Inspect local workspace configuration and session directories', status: 'completed' },
            { id: '2', content: 'Search frontend bundle for timeline group and step cards', activeForm: 'Searching frontend bundle for timeline group and step cards', status: 'in_progress' },
            { id: '3', content: 'Fetch reference documentation and compare with classic TurnBlock', status: 'pending' },
            { id: '4', content: 'Verify 3-level expansion, auto-collapse, and docked composer widgets', status: 'pending' },
        ]
        return {
            parts: [thought1, bash1, bash2, bash3, read1],
            streaming: true,
            durationMs: 11800,
            todos,
            activeTodoText: todos[1]?.activeForm ?? null,
            followUpParts: null,
            followUpStreaming: false,
            followUpDurationMs: null,
            followUpActiveTodoText: null,
        }
    }

    if (stage === 'working-step-3' || stage === 'asking-user') {
        const todos: DockedTodoItem[] = [
            { id: '1', content: 'Inspect local workspace configuration and session directories', status: 'completed' },
            { id: '2', content: 'Search frontend bundle for timeline group and step cards', status: 'completed' },
            { id: '3', content: 'Fetch reference documentation and compare with classic TurnBlock', activeForm: 'Fetching reference documentation and comparing with classic TurnBlock', status: stage === 'asking-user' ? 'completed' : 'in_progress' },
            { id: '4', content: 'Verify 3-level expansion, auto-collapse, and docked composer widgets', activeForm: 'Verifying 3-level expansion, auto-collapse, and docked composer widgets', status: stage === 'asking-user' ? 'in_progress' : 'pending' },
        ]
        return {
            parts: [thought1, bash1, bash2, bash3, read1, thought2, webFetch1, webSearch1, edit1],
            streaming: stage === 'working-step-3',
            durationMs: 19400,
            todos,
            activeTodoText: stage === 'working-step-3' ? (todos[2]?.activeForm ?? null) : null,
            followUpParts: null,
            followUpStreaming: false,
            followUpDurationMs: null,
            followUpActiveTodoText: null,
        }
    }

    const followUpThought: TurnContentPart = {
        type: 'reasoning',
        text: 'User confirmed the Timeline header sync, compact inline preview cards, and docked Todo/Question widgets. Now wiring session.todos into TurnBlock and running verification tests.',
        status: { type: 'complete' },
    }

    const followUpEdit = makeToolPart({
        id: 'tool-edit-followup-1',
        name: 'Edit',
        state: 'completed',
        description: 'Wire session.todos and timeline variant into TurnBlock.tsx',
        toolInput: {
            file_path: 'web/src/components/AssistantChat/messages/TurnBlock.tsx',
            old_string: 'return <TurnBlockView partition={partition} streaming={streaming} />',
            new_string: 'return <TurnBlockView variant="timeline" activeTodoText={activeTodoText} partition={partition} streaming={streaming} />',
        },
        result: { ok: true },
    })

    const followUpBash = makeToolPart({
        id: 'tool-bash-followup-2',
        name: 'Bash',
        state: stage === 'resumed-working' ? 'running' : 'completed',
        description: 'Run unit tests and typecheck for TurnBlock timeline view',
        toolInput: {
            command: 'bun typecheck && bunx vitest run src/components/AssistantChat/messages/TimelineTurnBlock.test.tsx',
            description: 'Run unit tests and typecheck for TurnBlock timeline view',
        },
        result: {
            stdout: [
                '$ tsc --noEmit',
                ' ✓ src/components/AssistantChat/messages/TimelineTurnBlock.test.tsx (3 tests) 41ms',
                ' Test Files  1 passed (1)',
            ].join('\n'),
        },
    })

    if (stage === 'resumed-working') {
        const todos: DockedTodoItem[] = [
            { id: '1', content: 'Inspect local workspace configuration and session directories', status: 'completed' },
            { id: '2', content: 'Search frontend bundle for timeline group and step cards', status: 'completed' },
            { id: '3', content: 'Fetch reference documentation and compare with classic TurnBlock', status: 'completed' },
            { id: '4', content: 'Verify 3-level expansion, auto-collapse, and docked composer widgets', activeForm: 'Verifying 3-level expansion, auto-collapse, and docked composer widgets', status: 'in_progress' },
        ]
        return {
            parts: [thought1, bash1, bash2, bash3, read1, thought2, webFetch1, webSearch1, edit1],
            streaming: false,
            durationMs: 19400,
            todos,
            activeTodoText: null,
            followUpParts: [followUpThought, followUpEdit, followUpBash],
            followUpStreaming: true,
            followUpDurationMs: 6800,
            followUpActiveTodoText: todos[3]?.activeForm ?? null,
        }
    }

    const todos: DockedTodoItem[] = [
        { id: '1', content: 'Inspect local workspace configuration and session directories', status: 'completed' },
        { id: '2', content: 'Search frontend bundle for timeline group and step cards', status: 'completed' },
        { id: '3', content: 'Fetch reference documentation and compare with classic TurnBlock', status: 'completed' },
        { id: '4', content: 'Verify 3-level expansion, auto-collapse, and docked composer widgets', status: 'completed' },
    ]
    const followUpTodo = makeToolPart({
        id: 'tool-todo-followup-3',
        name: 'TodoWrite',
        state: 'completed',
        description: 'Mark all 4 frontend timeline verification tasks completed',
        toolInput: {
            todos,
        },
        result: 'Updated 4 todos',
    })
    return {
        parts: [thought1, bash1, bash2, bash3, read1, thought2, webFetch1, webSearch1, edit1],
        streaming: false,
        durationMs: 19400,
        todos,
        activeTodoText: null,
        followUpParts: [followUpThought, followUpEdit, followUpBash, followUpTodo, trailingAnswer],
        followUpStreaming: false,
        followUpDurationMs: 11200,
        followUpActiveTodoText: null,
    }
}

const STAGES: Array<{ id: DemoLifecycleStage; stepLabel: string; subtitle: string }> = [
    {
        id: 'working-step-1',
        stepLabel: '1. Working (Todo 1/4)',
        subtitle: 'Shimmering header synced with Todo #1 + live running Bash step + B1 indicator',
    },
    {
        id: 'working-step-2',
        stepLabel: '2. Working (Todo 2/4)',
        subtitle: '3 completed Bash commands (expandable live!) + Viewing TurnBlock.tsx',
    },
    {
        id: 'working-step-3',
        stepLabel: '3. Working (Todo 3/4)',
        subtitle: 'WebFetch (domain badge) + WebSearch (5 results) + Edit diff (+4 -1)',
    },
    {
        id: 'asking-user',
        stepLabel: '4. Question Wizard',
        subtitle: 'Multi-step < 1 of 3 > wizard docked above composer; submitting starts Stage 5',
    },
    {
        id: 'resumed-working',
        stepLabel: '5. Resumed Working (Todo 4/4)',
        subtitle: 'Turn 1 collapsed + Q&A bubble + Turn 2 actively running + composer queue/stop state',
    },
    {
        id: 'completed',
        stepLabel: '6. Completed (Auto-Collapse)',
        subtitle: 'Turn 2 auto-collapses to past-tense summary & outputs answer; Todo -> 4 of 4 Done',
    },
]

const INDICATOR_COLORS: Array<{ id: string; label: string; value: string }> = [
    { id: 'terracotta', label: '陶土暖橙 (#da7756)', value: '#da7756' },
    { id: 'blue', label: '电光蓝 (#3b82f6)', value: '#3b82f6' },
    { id: 'emerald', label: '翡翠绿 (#10b981)', value: '#10b981' },
    { id: 'amber', label: '琥珀金 (#f59e0b)', value: '#f59e0b' },
]

type DemoPreviewState = {
    stage: DemoLifecycleStage
    viewMode: TranscriptViewMode
    lang: 'en' | 'zh-CN'
    indicatorColor: string
    activeToolIdx: number
    submittedAnswers: Record<string, string> | null
}

type DemoPreviewAction =
    | { type: 'stage'; stage: DemoLifecycleStage }
    | { type: 'view'; viewMode: TranscriptViewMode }
    | { type: 'submit'; answers: Record<string, string> }

function readDemoPreview(): DemoPreviewState {
    const params = new URLSearchParams(typeof window === 'undefined' ? '' : window.location.search)
    const stage = params.get('stage')
    const viewMode = params.get('view')
    const tool = Number(params.get('tool') ?? 0)
    return {
        stage: STAGES.find((item) => item.id === stage)?.id ?? 'working-step-3',
        viewMode: viewMode === 'thinking' || viewMode === 'verbose' ? viewMode : 'normal',
        lang: params.get('lang') === 'en' ? 'en' : 'zh-CN',
        indicatorColor: INDICATOR_COLORS.find((item) => item.value === params.get('color'))?.value ?? '#da7756',
        activeToolIdx: Number.isInteger(tool) && tool >= 0 && tool < 8 ? tool : 0,
        submittedAnswers: null,
    }
}

function DemoViewModes(props: {
    value: TranscriptViewMode
    onChange: (mode: TranscriptViewMode) => void
}) {
    return (
        <div role="group" aria-label="Transcript view mode" className="inline-flex rounded-lg border border-[var(--app-border)] bg-[var(--app-subtle-bg)] p-0.5">
            {(['normal', 'thinking', 'verbose'] as const).map((mode) => (
                <button
                    key={mode}
                    type="button"
                    data-testid={`view-mode-${mode}`}
                    aria-pressed={props.value === mode}
                    onClick={() => props.onChange(mode)}
                    className={cn(
                        'min-h-9 rounded-md px-3 text-xs font-medium capitalize transition-colors',
                        props.value === mode
                            ? 'bg-[var(--app-bg)] text-[var(--app-fg)] shadow-xs'
                            : 'text-[var(--app-hint)] hover:text-[var(--app-fg)]'
                    )}
                >
                    {mode}
                </button>
            ))}
        </div>
    )
}

function DemoConversation(props: {
    state: DemoPreviewState
    onAction: (action: DemoPreviewAction) => void
    mobile?: boolean
}) {
    const { state } = props
    const stageData = useMemo(() => buildStageData(state.stage, state.activeToolIdx), [state.stage, state.activeToolIdx])
    const partition = useMemo(() => partitionTurn(stageData.parts, null), [stageData.parts])
    const followUpPartition = useMemo(
        () => stageData.followUpParts ? partitionTurn(stageData.followUpParts, null) : null,
        [stageData.followUpParts]
    )
    const running = stageData.streaming || stageData.followUpStreaming
    const turnProps = {
        viewMode: state.viewMode,
        lang: state.lang,
        indicatorVariant: 'equalizer-bars' as TurnActivityIndicatorVariant,
        indicatorColor: state.indicatorColor,
    }
    return (
        <>
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-5 sm:px-6" data-testid="demo-transcript">
                <div className="mx-auto max-w-3xl space-y-5">
                    <div className="flex justify-end">
                        <div className="max-w-[90%] rounded-2xl bg-[var(--app-chat-user-bg)] px-4 py-3 text-sm leading-6 text-[var(--app-chat-user-fg)]">
                            How should HAPI’s frontend structure working tool cards, 3-level expansion, and docked progress widgets?
                        </div>
                    </div>
                    <TimelineTurnBlockView
                        partition={partition}
                        streaming={stageData.streaming}
                        durationMs={stageData.durationMs}
                        initiallyOpen={stageData.streaming}
                        activeTodoText={stageData.activeTodoText}
                        {...turnProps}
                    />
                    {state.submittedAnswers || state.stage === 'resumed-working' || state.stage === 'completed' ? (
                        <SubmittedQuestionSummaryBubble
                            questions={DEMO_QUESTIONS}
                            answers={state.submittedAnswers ?? {
                                'header-style': DEMO_QUESTIONS[0]!.options[0]!.label,
                                'level2-cards': DEMO_QUESTIONS[1]!.options[0]!.label,
                                'todo-dock': DEMO_QUESTIONS[2]!.options[0]!.label,
                            }}
                        />
                    ) : null}
                    {followUpPartition ? (
                        <div data-testid="turn-followup-block">
                            <TimelineTurnBlockView
                                partition={followUpPartition}
                                streaming={stageData.followUpStreaming}
                                durationMs={stageData.followUpDurationMs}
                                initiallyOpen={stageData.followUpStreaming}
                                activeTodoText={stageData.followUpActiveTodoText}
                                {...turnProps}
                            />
                        </div>
                    ) : null}
                </div>
            </div>
            <div className="max-h-[65%] shrink-0 overflow-y-auto border-t border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-3 sm:px-5" data-testid="demo-composer-dock">
                <div className="mx-auto max-w-3xl">
                    {state.stage === 'asking-user' ? (
                        <div className="mb-2">
                            <DockedQuestionWizard
                                questions={DEMO_QUESTIONS}
                                onSubmit={(answers) => props.onAction({ type: 'submit', answers })}
                                onSkip={() => props.onAction({ type: 'stage', stage: 'resumed-working' })}
                            />
                        </div>
                    ) : null}
                    <DockedTodoProgressBar todos={stageData.todos} defaultExpanded={state.stage === 'working-step-1'} lang={state.lang} />
                    <div className="rounded-b-xl border border-[var(--app-composer-border)] bg-[var(--app-composer-surface)] px-3 py-3">
                        <div className="flex min-h-10 items-center justify-between gap-3 text-xs text-[var(--app-hint)]">
                            <span className="min-w-0 leading-5">
                                {running
                                    ? (state.lang === 'zh-CN' ? '↵ 发送，⌘↵ 排队等待稍后执行…' : '↵ to send, ⌘↵ to queue for later…')
                                    : (state.lang === 'zh-CN' ? '输入消息…' : 'Write a message…')}
                            </span>
                            {running ? (
                                <button
                                    type="button"
                                    data-testid="demo-stop-running-btn"
                                    aria-label={state.lang === 'zh-CN' ? '停止当前运行' : 'Stop current run'}
                                    onClick={() => props.onAction({ type: 'stage', stage: 'completed' })}
                                    className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[var(--app-button)] text-[var(--app-button-text)] hover:opacity-80"
                                >
                                    <span aria-hidden="true" className="h-3 w-3 rounded-xs bg-current" />
                                </button>
                            ) : null}
                        </div>
                        <div className="mt-1 flex justify-between gap-2 text-[10px] text-[var(--app-hint)]">
                            <span>{state.lang === 'zh-CN' ? '演示输入区' : 'Demo composer'}</span>
                            <span>{props.mobile ? state.viewMode : `Ctrl+O · ${state.viewMode}`}</span>
                        </div>
                    </div>
                </div>
            </div>
        </>
    )
}

function MobilePwaPreview(props: {
    state: DemoPreviewState
    onAction: (action: DemoPreviewAction) => void
}) {
    const iframeRef = useRef<HTMLIFrameElement>(null)
    const containerRef = useRef<HTMLDivElement>(null)
    const [scale, setScale] = useState(1)
    const [src] = useState(() => {
        const url = new URL(window.location.href)
        url.searchParams.set('viewport', 'mobile')
        url.searchParams.set('stage', props.state.stage)
        url.searchParams.set('view', props.state.viewMode)
        url.searchParams.set('lang', props.state.lang)
        url.searchParams.set('color', props.state.indicatorColor)
        url.searchParams.set('tool', String(props.state.activeToolIdx))
        return url.href
    })
    const syncPreview = useCallback(() => {
        iframeRef.current?.contentWindow?.postMessage({ type: 'hapi-demo-preview-state', state: props.state }, window.location.origin)
    }, [props.state])

    useEffect(syncPreview, [syncPreview])
    useEffect(() => {
        const handler = (event: MessageEvent) => {
            if (event.origin !== window.location.origin || event.source !== iframeRef.current?.contentWindow) return
            if (event.data?.type === 'hapi-demo-preview-action') props.onAction(event.data.action)
        }
        window.addEventListener('message', handler)
        return () => window.removeEventListener('message', handler)
    }, [props.onAction])
    useEffect(() => {
        const container = containerRef.current
        if (!container) return
        const measure = () => setScale(Math.min(1, (container.clientWidth || 390) / 390))
        measure()
        if (typeof ResizeObserver === 'undefined') return
        const observer = new ResizeObserver(measure)
        observer.observe(container)
        return () => observer.disconnect()
    }, [])

    return (
        <div ref={containerRef} className="relative mx-auto w-full max-w-[390px] overflow-hidden rounded-[28px] border border-[var(--app-composer-border)] bg-[var(--app-bg)] shadow-sm" style={{ height: 844 * scale }} data-testid="mobile-pwa-frame">
            <iframe
                ref={iframeRef}
                title="HAPI Mobile PWA — 390 × 844"
                data-testid="mobile-pwa-iframe"
                src={src}
                onLoad={syncPreview}
                width={390}
                height={844}
                className="absolute left-0 top-0 block origin-top-left border-0"
                style={{ width: 390, height: 844, transform: `scale(${scale})` }}
            />
        </div>
    )
}

export function TurnTimelineDemo() {
    const [initialPreview] = useState(readDemoPreview)
    const [stage, setStage] = useState<DemoLifecycleStage>(initialPreview.stage)
    const [viewMode, setViewMode] = useState<TranscriptViewMode>(initialPreview.viewMode)
    const [lang, setLang] = useState<'en' | 'zh-CN'>(initialPreview.lang)
    const [autoPlaying, setAutoPlaying] = useState(false)
    const [submittedAnswers, setSubmittedAnswers] = useState<Record<string, string> | null>(null)
    const [todoShowcaseState, setTodoShowcaseState] = useState<'running' | 'completed' | 'multi'>('running')
    const [showTodoGallery, setShowTodoGallery] = useState(true)
    const [mobileOnly] = useState(() => {
        const params = new URLSearchParams(window.location.search)
        return params.get('viewport') === 'mobile' || params.get('mode') === 'mobile'
    })
    const embeddedMobile = mobileOnly && window.parent !== window

    const todoShowcaseRunningPartition = useMemo(
        () =>
            partitionTurn(
                [
                    {
                        type: 'reasoning',
                        text: '**Inspecting deployment state** across remote main, worktrees, and live Hub service.',
                        status: { type: 'complete' },
                    },
                    makeToolPart({
                        id: 'showcase-todo-running',
                        name: 'todo',
                        state: 'completed',
                        description: '初始化任务并开始检查部署状态',
                        toolInput: {
                            i: 'Initializing deployment check todo',
                        },
                        result: {
                            details: {
                                phases: [
                                    {
                                        id: 'phase-1',
                                        name: 'Tasks',
                                        tasks: [
                                            {
                                                id: 'task-1',
                                                content: '检查当前部署状态与未上线改动',
                                                status: 'in_progress',
                                            },
                                        ],
                                    },
                                ],
                            },
                        },
                    }),
                    makeToolPart({
                        id: 'showcase-bash-running',
                        name: 'Bash',
                        state: 'running',
                        description: 'Checking git rev-parse and remote release tags',
                        toolInput: {
                            command: 'git fetch mine && git log --oneline -n 5 HEAD..mine/main',
                            description: 'Checking git rev-parse and remote release tags',
                        },
                    }),
                ],
                null
            ),
        []
    )

    const todoShowcaseCompletedPartition = useMemo(
        () =>
            partitionTurn(
                [
                    {
                        type: 'reasoning',
                        text: '**Inspecting deployment state** across remote main, worktrees, and live Hub service.',
                        status: { type: 'complete' },
                    },
                    makeToolPart({
                        id: 'showcase-bash-1',
                        name: 'Bash',
                        state: 'completed',
                        description: 'Checking git status and branch commits',
                        toolInput: { command: 'git status -sb' },
                        result: { stdout: '## main...mine/main' },
                    }),
                    makeToolPart({
                        id: 'showcase-bash-2',
                        name: 'Bash',
                        state: 'completed',
                        description: 'Checking remote release tags',
                        toolInput: { command: 'gh release list -L 3' },
                        result: { stdout: 'v0.29.0-fork.33\tLatest' },
                    }),
                    makeToolPart({
                        id: 'showcase-bash-3',
                        name: 'Bash',
                        state: 'completed',
                        description: 'Checking production Hub binary hash',
                        toolInput: { command: 'sha256sum /usr/local/bin/hapi' },
                        result: { stdout: '041b2585dec4140d5d6adfb2ac45b1620339f6392be653f289fd6fdf7cab5b57' },
                    }),
                    makeToolPart({
                        id: 'showcase-todo-completed',
                        name: 'todo',
                        state: 'completed',
                        description: '完成部署状态检查',
                        toolInput: {
                            i: 'Marking deployment check complete',
                        },
                        result: {
                            details: {
                                phases: [
                                    {
                                        id: 'phase-1',
                                        name: 'Tasks',
                                        tasks: [
                                            {
                                                id: 'task-1',
                                                content: '检查当前部署状态与未上线改动',
                                                status: 'completed',
                                            },
                                        ],
                                    },
                                ],
                            },
                        },
                    }),
                    {
                        type: 'text',
                        text: '我帮你把 `mine/main`、本机/Mac 的主仓库以及线上 `root@aliyun` 的运行状态全部核对了一遍，目前没有任何未部署的改动。',
                        status: { type: 'complete' },
                    },
                ],
                null
            ),
        []
    )

    const todoShowcaseMultiPartition = useMemo(
        () =>
            partitionTurn(
                [
                    makeToolPart({
                        id: 'showcase-todo-multi',
                        name: 'todo',
                        state: 'completed',
                        description: '更新多任务进度',
                        toolInput: { i: 'Updating multi-step todo card' },
                        result: {
                            details: {
                                phases: [
                                    {
                                        id: 'phase-1',
                                        name: 'Tasks',
                                        tasks: [
                                            {
                                                id: 'task-1',
                                                content: '收敛顶部 SessionStatusPanel 与下方 TodoPanel 的重复信息',
                                                status: 'completed',
                                            },
                                            {
                                                id: 'task-2',
                                                content: '将 Updated todos 改造为圆角任务卡片（进行中转圈 / 完成打勾）',
                                                status: 'in_progress',
                                            },
                                            {
                                                id: 'task-3',
                                                content: '暴露 TurnTimelineDemo 页面供 Mac 直接访问验证',
                                                status: 'pending',
                                            },
                                        ],
                                    },
                                ],
                            },
                        },
                    }),
                    makeToolPart({
                        id: 'showcase-edit-multi',
                        name: 'Edit',
                        state: 'running',
                        description: 'Updating TimelineTurnBlock.tsx with TimelineTodoChecklistCard',
                        toolInput: {
                            file_path: 'web/src/components/AssistantChat/messages/TimelineTurnBlock.tsx',
                            old_string: '<TimelineToolStepRow ... />',
                            new_string: '<TimelineTodoChecklistCard items={checklistItems} />',
                        },
                    }),
                ],
                null
            ),
        []
    )
    const [showSpecTable, setShowSpecTable] = useState(false)
    const [indicatorColor, setIndicatorColor] = useState(initialPreview.indicatorColor)
    const [activeToolIdx, setActiveToolIdx] = useState(initialPreview.activeToolIdx)

    useEffect(() => {
        if (stage !== 'working-step-3' || embeddedMobile) return
        const timer = window.setInterval(() => {
            setActiveToolIdx((prev) => (prev + 1) % 8)
        }, 2500)
        return () => window.clearInterval(timer)
    }, [stage, embeddedMobile])

    useEffect(() => {
        if (!autoPlaying) return
        const order: DemoLifecycleStage[] = [
            'working-step-1',
            'working-step-2',
            'working-step-3',
            'resumed-working',
            'completed',
        ]
        const timer = window.setInterval(() => {
            setStage((current) => {
                const idx = order.indexOf(current)
                if (idx < 0 || idx >= order.length - 1) {
                    setAutoPlaying(false)
                    return 'completed'
                }
                return order[idx + 1]!
            })
        }, 2600)
        return () => window.clearInterval(timer)
    }, [autoPlaying])

    const handlePreviewAction = useCallback((action: DemoPreviewAction) => {
        if (action.type === 'view') {
            setViewMode(action.viewMode)
        } else if (action.type === 'submit') {
            setSubmittedAnswers(action.answers)
            setAutoPlaying(false)
            setStage('resumed-working')
        } else if (action.type === 'stage') {
            setAutoPlaying(false)
            if (action.stage !== 'resumed-working' && action.stage !== 'completed') {
                setSubmittedAnswers(null)
            }
            setStage(action.stage)
        }
        if (embeddedMobile) {
            window.parent.postMessage({ type: 'hapi-demo-preview-action', action }, window.location.origin)
        }
    }, [embeddedMobile])

    useEffect(() => {
        if (!embeddedMobile) return
        const handler = (event: MessageEvent) => {
            if (event.origin !== window.location.origin || event.source !== window.parent) return
            if (event.data?.type !== 'hapi-demo-preview-state') return
            const state: DemoPreviewState = event.data.state
            setStage(state.stage)
            setViewMode(state.viewMode)
            setLang(state.lang)
            setIndicatorColor(state.indicatorColor)
            setActiveToolIdx(state.activeToolIdx)
            setSubmittedAnswers(state.submittedAnswers)
        }
        window.addEventListener('message', handler)
        return () => window.removeEventListener('message', handler)
    }, [embeddedMobile])

    useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            if (e.ctrlKey && e.key.toLowerCase() === 'o') {
                e.preventDefault()
                handlePreviewAction({ type: 'view', viewMode: viewMode === 'normal' ? 'thinking' : viewMode === 'thinking' ? 'verbose' : 'normal' })
            }
        }
        window.addEventListener('keydown', handler)
        return () => window.removeEventListener('keydown', handler)
    }, [viewMode, handlePreviewAction])

    const previewState = useMemo<DemoPreviewState>(() => ({
        stage, viewMode, lang, indicatorColor, activeToolIdx, submittedAnswers,
    }), [stage, viewMode, lang, indicatorColor, activeToolIdx, submittedAnswers])
    const currentStage = STAGES.find((item) => item.id === stage)!

    if (mobileOnly) {
        return (
            <div className="flex h-dvh min-h-0 flex-col overflow-hidden bg-[var(--app-bg)] text-[var(--app-fg)]" data-testid="mobile-pwa-viewport">
                <div aria-hidden="true" className="relative flex h-11 shrink-0 items-center justify-between px-7 pt-[max(4px,env(safe-area-inset-top))] text-xs font-semibold">
                    <span className="tabular-nums">9:41</span>
                    <span className="absolute left-1/2 top-2 h-6 w-20 -translate-x-1/2 rounded-full bg-[var(--app-fg)]" />
                    <span className="text-[10px] tracking-wide">PWA ▰</span>
                </div>
                <header className="shrink-0 border-b border-[var(--app-border)] px-4 pb-3 pt-2">
                    <div className="mb-3 flex items-center justify-between gap-3">
                        <div className="min-w-0">
                            <h1 className="text-sm font-semibold">HAPI <span className="font-normal text-[var(--app-hint)]">/ Turn timeline</span></h1>
                            <p className="mt-0.5 text-[11px] text-[var(--app-hint)]">{lang === 'zh-CN' ? '交互演示 · 本地场景' : 'Interactive demo · local scenario'}</p>
                        </div>
                        <label className="min-w-0 max-w-[150px]">
                            <span className="sr-only">Lifecycle stage</span>
                            <select value={stage} onChange={(event) => handlePreviewAction({ type: 'stage', stage: event.target.value as DemoLifecycleStage })} className="min-h-11 w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-2 text-xs">
                                {STAGES.map((item) => <option key={item.id} value={item.id}>{item.stepLabel}</option>)}
                            </select>
                        </label>
                    </div>
                    <DemoViewModes value={viewMode} onChange={(mode) => handlePreviewAction({ type: 'view', viewMode: mode })} />
                </header>
                <DemoConversation state={previewState} onAction={handlePreviewAction} mobile />
                <div aria-hidden="true" className="flex h-6 shrink-0 items-center justify-center bg-[var(--app-bg)] pb-[max(4px,env(safe-area-inset-bottom))]">
                    <span className="h-1 w-28 rounded-full bg-[var(--app-fg)]" />
                </div>
            </div>
        )
    }

    return (
        <div className="min-h-screen min-w-0 bg-[var(--app-bg)] text-[var(--app-fg)]" data-testid="turn-timeline-workbench">
            <header className="border-b border-[var(--app-border)] bg-[var(--app-subtle-bg)]">
                <div className="mx-auto max-w-[1440px] px-4 py-5 sm:px-6">
                    <div className="flex flex-wrap items-start justify-between gap-4">
                        <div className="max-w-2xl">
                            <div className="mb-2 flex items-center gap-2 text-[11px] font-medium text-[var(--app-hint)]">
                                <TurnActivitySparkleIcon size={16} />
                                <span>HAPI / COMPONENT WORKBENCH</span>
                                <span className="rounded border border-[var(--app-border)] px-1.5 py-0.5 font-mono text-[10px]">Local demo</span>
                            </div>
                            <h1 className="text-xl font-semibold tracking-tight">Turn timeline</h1>
                            <p className="mt-1.5 text-sm leading-6 text-[var(--app-hint)]">在桌面与 Mobile PWA 中查看同一个回合：工作导轨、任务进度与回答。</p>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                            <button
                                type="button"
                                data-testid="demo-autoplay-btn"
                                aria-pressed={autoPlaying}
                                onClick={() => {
                                    if (autoPlaying) {
                                        setAutoPlaying(false)
                                    } else {
                                        setSubmittedAnswers(null)
                                        setStage('working-step-1')
                                        setAutoPlaying(true)
                                    }
                                }}
                                className="inline-flex min-h-10 items-center gap-2 rounded-lg bg-[var(--app-button)] px-3.5 text-xs font-medium text-[var(--app-button-text)] hover:opacity-85"
                            >
                                <span aria-hidden="true">{autoPlaying ? 'Ⅱ' : '▶'}</span>
                                {autoPlaying ? '暂停演示' : '播放回合生命周期'}
                            </button>
                            <DemoViewModes value={viewMode} onChange={(mode) => setViewMode(mode)} />
                            <button type="button" aria-label="Switch transcript language" onClick={() => setLang((value) => value === 'en' ? 'zh-CN' : 'en')} className="min-h-10 rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-3 text-xs hover:bg-[var(--app-subtle-bg)]">
                                {lang === 'en' ? 'EN / 中文' : '中文 / EN'}
                            </button>
                        </div>
                    </div>
                    <nav aria-label="Lifecycle stage" className="mt-5 grid grid-cols-2 gap-1 rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] p-1 sm:grid-cols-3 xl:grid-cols-6">
                        {STAGES.map((item, index) => (
                            <button
                                key={item.id}
                                type="button"
                                data-testid={`stage-btn-${item.id}`}
                                aria-current={stage === item.id ? 'step' : undefined}
                                title={item.subtitle}
                                onClick={() => handlePreviewAction({ type: 'stage', stage: item.id })}
                                className={cn(
                                    'flex min-h-12 items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs transition-colors',
                                    stage === item.id ? 'bg-[var(--app-button)] text-[var(--app-button-text)]' : 'text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]'
                                )}
                            >
                                <span className="font-mono text-[10px] opacity-65">0{index + 1}</span>
                                <span>{item.stepLabel.replace(/^\d+\. /, '')}</span>
                            </button>
                        ))}
                    </nav>
                    <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-[11px] text-[var(--app-hint)]" data-testid="rail-indicator-toolbar">
                        <p className="max-w-2xl leading-5">{currentStage.subtitle}</p>
                        <div role="group" aria-label="Rail indicator color" className="flex items-center gap-1">
                            <span className="mr-1">导轨颜色</span>
                            {INDICATOR_COLORS.map((color) => (
                                <button key={color.id} type="button" title={color.label} aria-label={color.label} aria-pressed={indicatorColor === color.value} onClick={() => setIndicatorColor(color.value)} className={cn('flex h-8 w-8 items-center justify-center rounded-md border', indicatorColor === color.value ? 'border-[var(--app-fg)] bg-[var(--app-bg)]' : 'border-transparent hover:bg-[var(--app-bg)]')}>
                                    <span aria-hidden="true" className="h-3 w-3 rounded-full" style={{ backgroundColor: color.value }} />
                                </button>
                            ))}
                            <kbd className="ml-2 hidden rounded border border-[var(--app-border)] px-1.5 py-0.5 font-mono sm:block">Ctrl+O</kbd>
                        </div>
                    </div>
                </div>
            </header>

            <main className="mx-auto w-full max-w-[1440px] space-y-8 px-4 py-6 sm:px-6">
                <div className="grid min-w-0 gap-8 xl:grid-cols-[minmax(0,1fr)_414px]">
                    <section className="min-w-0" aria-labelledby="desktop-preview-title" data-testid="desktop-preview">
                        <div className="mb-3 flex items-center justify-between gap-3">
                            <h2 id="desktop-preview-title" className="text-sm font-semibold">Desktop</h2>
                            <span className="text-[11px] text-[var(--app-hint)]">实时回合 · {viewMode}</span>
                        </div>
                        <div className="flex h-[844px] min-w-0 flex-col overflow-hidden rounded-xl border border-[var(--app-composer-border)] bg-[var(--app-bg)] shadow-sm">
                            <div className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-[var(--app-border)] px-5">
                                <div className="flex min-w-0 items-center gap-2 text-xs"><span className="font-semibold">HAPI</span><span className="text-[var(--app-hint)]">/ Frontend session</span></div>
                                <span className="rounded bg-[var(--app-subtle-bg)] px-2 py-1 font-mono text-[10px] text-[var(--app-hint)]">Demo</span>
                            </div>
                            <DemoConversation state={previewState} onAction={handlePreviewAction} />
                        </div>
                    </section>
                    <section className="min-w-0" aria-labelledby="mobile-preview-title" data-testid="mobile-preview">
                        <div className="mb-3 flex items-center justify-between gap-3">
                            <h2 id="mobile-preview-title" className="text-sm font-semibold">Mobile PWA</h2>
                            <span className="font-mono text-[11px] text-[var(--app-hint)]">390 × 844</span>
                        </div>
                        <MobilePwaPreview state={previewState} onAction={handlePreviewAction} />
                        <p className="mx-auto mt-3 max-w-[390px] text-[11px] leading-5 text-[var(--app-hint)]">独立 390px 视口，与桌面同步场景和控件。窄屏仅缩小预览外框；可在其中切换阶段、展开工具与回答问题。</p>
                    </section>
                </div>

                <section className="border-t border-[var(--app-border)] pt-4" data-testid="todo-card-redesign-showcase">
                    <button type="button" aria-expanded={showTodoGallery} aria-controls="demo-todo-gallery" onClick={() => setShowTodoGallery((value) => !value)} className="flex min-h-11 w-full items-center justify-between gap-4 text-left">
                        <span className="text-sm font-semibold">Todo 状态参考 <span className="ml-2 text-xs font-normal text-[var(--app-hint)]">进行中、完成与多任务</span></span>
                        <span className="text-xs text-[var(--app-hint)]">{showTodoGallery ? '收起 −' : '展开 +'}</span>
                    </button>
                    {showTodoGallery ? (
                        <div id="demo-todo-gallery" className="mt-3 grid min-w-0 gap-6 lg:grid-cols-2">
                            <div className="min-w-0">
                                <div role="group" aria-label="Todo showcase state" className="mb-4 flex flex-wrap gap-1.5">
                                    {([
                                        { id: 'running', label: '1. 进行中（转圈）' },
                                        { id: 'completed', label: '2. 已完成（折叠打勾）' },
                                        { id: 'multi', label: '3. 多任务流转态' },
                                    ] as const).map((tab) => (
                                        <button key={tab.id} type="button" aria-pressed={todoShowcaseState === tab.id} onClick={() => setTodoShowcaseState(tab.id)} className={cn('min-h-10 rounded-lg border px-3 text-xs', todoShowcaseState === tab.id ? 'border-[var(--app-fg)] bg-[var(--app-subtle-bg)] font-medium' : 'border-[var(--app-border)] text-[var(--app-hint)] hover:text-[var(--app-fg)]')}>
                                            {tab.label}
                                        </button>
                                    ))}
                                </div>
                                <TimelineTurnBlockView
                                    partition={todoShowcaseState === 'running' ? todoShowcaseRunningPartition : todoShowcaseState === 'completed' ? todoShowcaseCompletedPartition : todoShowcaseMultiPartition}
                                    streaming={todoShowcaseState !== 'completed'}
                                    durationMs={todoShowcaseState === 'completed' ? 8400 : 3200}
                                    initiallyOpen={todoShowcaseState !== 'completed'}
                                    viewMode={viewMode}
                                    lang="zh-CN"
                                    indicatorColor={indicatorColor}
                                />
                            </div>
                            <div className="min-w-0 divide-y divide-[var(--app-border)] border-l border-[var(--app-border)] pl-5">
                                <div className="pb-3">
                                    <h3 className="mb-2 text-xs font-medium text-[var(--app-hint)]">A. 进行中的任务</h3>
                                    <TimelineTurnBlockView partition={todoShowcaseRunningPartition} streaming durationMs={3200} initiallyOpen={false} viewMode={viewMode} lang="zh-CN" indicatorColor={indicatorColor} />
                                </div>
                                <div className="pt-3">
                                    <h3 className="mb-2 text-xs font-medium text-[var(--app-hint)]">B. 完成后的任务与回答</h3>
                                    <TimelineTurnBlockView partition={todoShowcaseCompletedPartition} streaming={false} durationMs={8400} initiallyOpen={false} viewMode={viewMode} lang="zh-CN" indicatorColor={indicatorColor} />
                                </div>
                            </div>
                        </div>
                    ) : null}
                </section>
            </main>

            <footer className="border-t border-[var(--app-border)] bg-[var(--app-subtle-bg)]">
                <div className="mx-auto max-w-[1440px] px-4 py-4 sm:px-6">
                    <button type="button" data-testid="demo-contract-toggle" aria-expanded={showSpecTable} aria-controls="demo-contract-reference" onClick={() => setShowSpecTable((value) => !value)} className="flex min-h-10 w-full items-center justify-between gap-4 text-left text-xs text-[var(--app-hint)] hover:text-[var(--app-fg)]">
                        <span><span className="font-medium text-[var(--app-fg)]">回合交互契约</span><span className="ml-3">摘要 → 导轨 → 工具详情 · Todo / 回答独立展示</span></span>
                        <span className="shrink-0">{showSpecTable ? '收起 −' : '查看参考 +'}</span>
                    </button>
                    {showSpecTable ? (
                        <dl id="demo-contract-reference" className="mt-3 grid divide-y divide-[var(--app-border)] text-xs">
                            {[
                                ['Level 0 · 摘要', '运行时显示当前任务；完成后收起工作步骤，并保留任务进度与回答。'],
                                ['Level 1 · 工作导轨', '点击摘要展开步骤；Normal、Thinking 与 Verbose 控制推理和工具分组的展示。'],
                                ['Level 2 · 工具详情', '点击步骤查看 Bash 输出、文件、Diff 与 Web 搜索结果。'],
                                ['底部交互', 'Todo 可展开；Question Wizard 提交后开始下一回合；停止按钮切换到完成态。'],
                            ].map(([label, description]) => (
                                <div key={label} className="grid gap-1 py-3 sm:grid-cols-[160px_minmax(0,1fr)]"><dt className="font-medium">{label}</dt><dd className="leading-5 text-[var(--app-hint)]">{description}</dd></div>
                            ))}
                        </dl>
                    ) : null}
                </div>
            </footer>
        </div>
    )
}
