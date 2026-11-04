import { useEffect, useMemo, useState } from 'react'
import type { ToolCallBlock } from '@/chat/types'
import {
    partitionTurn,
    type TurnContentPart,
} from '@/components/AssistantChat/messages/turnBlockModel'
import { TurnBlockView } from '@/components/AssistantChat/messages/TurnBlock'
import {
    DockedQuestionWizard,
    DockedTodoProgressBar,
    SubmittedQuestionSummaryBubble,
    TimelineTurnBlockView,
    TurnActivityIndicator,
    TurnActivitySparkleIcon,
    type DockedQuestionItem,
    type DockedTodoItem,
    type TranscriptViewMode,
    type TurnActivityIndicatorVariant,
} from '@/components/AssistantChat/messages/TimelineTurnBlock'
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
    return {
        parts: [thought1, bash1, bash2, bash3, read1, thought2, webFetch1, webSearch1, edit1],
        streaming: false,
        durationMs: 19400,
        todos,
        activeTodoText: null,
        followUpParts: [followUpThought, followUpEdit, followUpBash, trailingAnswer],
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

export function TurnTimelineDemo() {
    const [stage, setStage] = useState<DemoLifecycleStage>('working-step-3')
    const [layoutMode, setLayoutMode] = useState<'side-by-side' | 'timeline-only'>('side-by-side')
    const [viewMode, setViewMode] = useState<TranscriptViewMode>('normal')
    const [lang, setLang] = useState<'en' | 'zh-CN'>('zh-CN')
    const [autoPlaying, setAutoPlaying] = useState(false)
    const [submittedAnswers, setSubmittedAnswers] = useState<Record<string, string> | null>(null)
    const [showSpecTable, setShowSpecTable] = useState(true)
    const [indicatorVariant, setIndicatorVariant] = useState<TurnActivityIndicatorVariant>('equalizer-bars')
    const [indicatorColor, setIndicatorColor] = useState<string>('#da7756')
    const [activeToolIdx, setActiveToolIdx] = useState<number>(0)

    useEffect(() => {
        if (stage !== 'working-step-3') return
        const timer = window.setInterval(() => {
            setActiveToolIdx((prev) => (prev + 1) % 8)
        }, 2500)
        return () => window.clearInterval(timer)
    }, [stage])

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

    useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            if (e.ctrlKey && e.key.toLowerCase() === 'o') {
                e.preventDefault()
                setViewMode((current) =>
                    current === 'normal' ? 'thinking' : current === 'thinking' ? 'verbose' : 'normal'
                )
            }
        }
        window.addEventListener('keydown', handler)
        return () => window.removeEventListener('keydown', handler)
    }, [])

    const stageData = useMemo(() => buildStageData(stage, activeToolIdx), [stage, activeToolIdx])
    const partition = useMemo(() => partitionTurn(stageData.parts, null), [stageData.parts])
    const followUpPartition = useMemo(
        () => (stageData.followUpParts ? partitionTurn(stageData.followUpParts, null) : null),
        [stageData.followUpParts]
    )
    return (
        <div
            className="min-h-screen bg-[var(--app-bg)] text-[var(--app-fg)] flex flex-col"
            data-testid="turn-timeline-workbench"
        >
            {/* Top Workbench Control Bar */}
            <header className="sticky top-0 z-20 border-b border-[var(--app-border)] bg-[var(--app-bg)]/95 backdrop-blur px-4 py-3">
                <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-2.5">
                        <TurnActivitySparkleIcon size={18} />
                        <div>
                            <h1 className="text-sm font-semibold tracking-tight">
                                HAPI Turn Timeline & Tool Card Workbench
                            </h1>
                            <p className="text-[11.5px] text-[var(--app-hint)]">
                                3-Level Timeline Hierarchy (<code className="font-mono">variant="timeline"</code>) vs. Classic TurnBlock (<code className="font-mono">variant="classic"</code>)
                            </p>
                        </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2 text-xs">
                        {/* Auto-Play Lifecycle Button */}
                        <button
                            type="button"
                            data-testid="demo-autoplay-btn"
                            onClick={() => {
                                if (autoPlaying) {
                                    setAutoPlaying(false)
                                } else {
                                    setStage('working-step-1')
                                    setAutoPlaying(true)
                                }
                            }}
                            className={cn(
                                'inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 font-medium transition-colors',
                                autoPlaying
                                    ? 'border-[#da7756] bg-[#da7756] text-white'
                                    : 'border-[#da7756]/60 bg-[#da7756]/10 text-[#da7756] hover:bg-[#da7756]/20'
                            )}
                        >
                            <span>{autoPlaying ? '⏸ Pause Simulation' : '▶ Play Working → Auto-Collapse'}</span>
                        </button>

                        {/* Transcript View Mode (Normal / Thinking / Verbose) */}
                        <div
                            className="inline-flex items-center rounded-lg border border-[var(--app-border)] bg-[var(--app-subtle-bg)]/50 p-0.5"
                            role="group"
                            aria-label="Transcript view mode"
                        >
                            {(['normal', 'thinking', 'verbose'] as const).map((mode) => (
                                <button
                                    key={mode}
                                    type="button"
                                    data-testid={`view-mode-${mode}`}
                                    onClick={() => setViewMode(mode)}
                                    className={cn(
                                        'rounded-md px-2 py-1 text-[11.5px] font-medium capitalize transition-colors',
                                        viewMode === mode
                                            ? 'bg-[var(--app-bg)] text-[var(--app-fg)] shadow-sm'
                                            : 'text-[var(--app-hint)] hover:text-[var(--app-fg)]'
                                    )}
                                >
                                    {mode}
                                </button>
                            ))}
                        </div>

                        {/* Comparison Mode */}
                        <div className="inline-flex items-center rounded-lg border border-[var(--app-border)] bg-[var(--app-subtle-bg)]/50 p-0.5">
                            <button
                                type="button"
                                data-testid="layout-side-by-side"
                                onClick={() => setLayoutMode('side-by-side')}
                                className={cn(
                                    'rounded-md px-2 py-1 text-[11.5px] font-medium transition-colors',
                                    layoutMode === 'side-by-side'
                                        ? 'bg-[var(--app-bg)] text-[var(--app-fg)] shadow-sm'
                                        : 'text-[var(--app-hint)] hover:text-[var(--app-fg)]'
                                )}
                            >
                                Side-by-Side Diff
                            </button>
                            <button
                                type="button"
                                data-testid="layout-timeline-only"
                                onClick={() => setLayoutMode('timeline-only')}
                                className={cn(
                                    'rounded-md px-2 py-1 text-[11.5px] font-medium transition-colors',
                                    layoutMode === 'timeline-only'
                                        ? 'bg-[var(--app-bg)] text-[var(--app-fg)] shadow-sm'
                                        : 'text-[var(--app-hint)] hover:text-[var(--app-fg)]'
                                )}
                            >
                                Timeline Focus
                            </button>
                        </div>

                        {/* Language toggle */}
                        <button
                            type="button"
                            onClick={() => setLang((l) => (l === 'en' ? 'zh-CN' : 'en'))}
                            className="rounded-lg border border-[var(--app-border)] px-2.5 py-1 text-[11.5px] text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
                        >
                            {lang === 'en' ? 'EN / 中文' : '中文 / EN'}
                        </button>
                    </div>
                </div>

                {/* Lifecycle Stage Stepper Bar */}
                <div className="mx-auto mt-2.5 flex max-w-6xl flex-wrap items-center gap-1.5">
                    {STAGES.map((item) => {
                        const active = stage === item.id
                        return (
                            <button
                                key={item.id}
                                type="button"
                                data-testid={`stage-btn-${item.id}`}
                                onClick={() => {
                                    setAutoPlaying(false)
                                    setStage(item.id)
                                }}
                                className={cn(
                                    'rounded-lg border px-2.5 py-1.5 text-left transition-all',
                                    active
                                        ? 'border-[#da7756] bg-[#da7756]/10 text-[var(--app-fg)]'
                                        : 'border-[var(--app-border)]/70 bg-[var(--app-subtle-bg)]/35 text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]'
                                )}
                            >
                                <div className="text-[11.5px] font-medium">{item.stepLabel}</div>
                                <div className="text-[10.5px] text-[var(--app-hint)] line-clamp-1 max-w-[230px]">
                                    {item.subtitle}
                                </div>
                            </button>
                        )
                    })}
                </div>
            </header>

            {/* Main Content Area */}
            <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 px-4 py-5">
                {/* Compact Rail Indicator Accent Color Bar */}
                <section
                    className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] px-4 py-2.5 shadow-xs"
                    data-testid="rail-indicator-toolbar"
                >
                    <div className="flex items-center gap-2 text-xs text-[var(--app-hint)]">
                        <span
                            className="inline-block h-2.5 w-2.5 rounded-full"
                            style={{ backgroundColor: indicatorColor }}
                        />
                        <span>
                            导轨状态流转：<strong className="font-medium text-[var(--app-fg)]">旋转圆弧 → 360° 闭环收缩 → 同色实心打勾弹出 → 保持 → 沿导轨平滑滑向下一行</strong>
                        </span>
                    </div>
                    <div className="flex items-center gap-1.5">
                        <span className="text-[11.5px] text-[var(--app-hint)] mr-1">导轨指示器配色：</span>
                        {INDICATOR_COLORS.map((c) => (
                            <button
                                key={c.id}
                                type="button"
                                onClick={() => setIndicatorColor(c.value)}
                                className={cn(
                                    'inline-flex items-center gap-1.5 rounded-lg border px-2 py-1 text-[11px] font-medium transition-all',
                                    indicatorColor === c.value
                                        ? 'border-[var(--app-fg)] bg-[var(--app-subtle-bg)] text-[var(--app-fg)] shadow-xs'
                                        : 'border-[var(--app-border)] text-[var(--app-hint)] hover:text-[var(--app-fg)]'
                                )}
                            >
                                <span
                                    className="h-2.5 w-2.5 rounded-full"
                                    style={{ backgroundColor: c.value }}
                                />
                                <span>{c.label.split(' ')[0]}</span>
                            </button>
                        ))}
                    </div>
                </section>

                {/* User Prompt Bubble */}
                <div className="flex justify-end">
                    <div className="max-w-xl rounded-2xl border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-4 py-2.5 text-[14px] text-[var(--app-fg)]">
                        How should HAPI’s frontend structure working tool cards, 3-level expansion, and docked progress widgets?
                    </div>
                </div>

                {/* Comparison Grid */}
                <div
                    className={cn(
                        'grid gap-6',
                        layoutMode === 'side-by-side' ? 'grid-cols-1 lg:grid-cols-2' : 'grid-cols-1 max-w-3xl mx-auto w-full'
                    )}
                >
                    {/* Column 1: Timeline TurnBlock */}
                    <section className="flex flex-col justify-between rounded-2xl border border-[var(--app-border)] bg-[var(--app-bg)] p-4 shadow-sm">
                        <div>
                            <div className="mb-3 flex items-center justify-between border-b border-[var(--app-border)]/70 pb-2.5">
                                <div className="flex items-center gap-2">
                                    <span className="inline-block h-2 w-2 rounded-full bg-[#da7756]" />
                                    <h2 className="text-xs font-semibold uppercase tracking-wider text-[var(--app-fg)]">
                                        Timeline Layout (<code className="font-mono">variant="timeline"</code>)
                                    </h2>
                                </div>
                                <span className="rounded bg-[#da7756]/15 px-2 py-0.5 text-[11px] font-medium text-[#da7756]">
                                    3-Level Rail + Shimmer + Auto-Collapse
                                </span>
                            </div>

                            <TimelineTurnBlockView
                                partition={partition}
                                streaming={stageData.streaming}
                                durationMs={stageData.durationMs}
                                initiallyOpen={stageData.streaming}
                                activeTodoText={stageData.activeTodoText}
                                viewMode={viewMode}
                                lang={lang}
                                indicatorVariant={indicatorVariant}
                                indicatorColor={indicatorColor}
                            />

                            {submittedAnswers || stage === 'resumed-working' || stage === 'completed' ? (
                                <SubmittedQuestionSummaryBubble
                                    questions={DEMO_QUESTIONS}
                                    answers={
                                        submittedAnswers ?? {
                                            'header-style': DEMO_QUESTIONS[0]!.options[0]!.label,
                                            'level2-cards': DEMO_QUESTIONS[1]!.options[0]!.label,
                                            'todo-dock': DEMO_QUESTIONS[2]!.options[0]!.label,
                                        }
                                    }
                                />
                            ) : null}

                            {followUpPartition ? (
                                <div className="mt-2" data-testid="turn-followup-block">
                                    <TimelineTurnBlockView
                                        partition={followUpPartition}
                                        streaming={stageData.followUpStreaming}
                                        durationMs={stageData.followUpDurationMs}
                                        initiallyOpen={stageData.followUpStreaming}
                                        activeTodoText={stageData.followUpActiveTodoText}
                                        viewMode={viewMode}
                                        lang={lang}
                                        indicatorVariant={indicatorVariant}
                                        indicatorColor={indicatorColor}
                                    />
                                </div>
                            ) : null}
                        </div>

                        {/* Simulated Docked Composer Area */}
                        <div className="mt-6 pt-3 border-t border-[var(--app-border)]/50">
                            {stage === 'asking-user' ? (
                                <div className="mb-2">
                                    <DockedQuestionWizard
                                        questions={DEMO_QUESTIONS}
                                        onSubmit={(ans) => {
                                            setSubmittedAnswers(ans)
                                            setStage('resumed-working')
                                        }}
                                        onSkip={() => setStage('resumed-working')}
                                    />
                                </div>
                            ) : null}

                            <DockedTodoProgressBar
                                todos={stageData.todos}
                                defaultExpanded={stage === 'working-step-1'}
                                lang={lang}
                            />

                            <div className="rounded-b-xl border border-[var(--app-border)] bg-[var(--app-subtle-bg)]/35 px-3.5 py-2.5">
                                <div className="flex items-center justify-between text-[13px] text-[var(--app-hint)]">
                                    <span>
                                        {stageData.streaming || stageData.followUpStreaming
                                            ? (lang === 'zh-CN'
                                                ? '↵ 发送，⌘↵ 排队等待稍后执行…'
                                                : '↵ to send, ⌘↵ to queue for later...')
                                            : (lang === 'zh-CN'
                                                ? '输入消息…（Enter 发送，Shift+Enter 换行）'
                                                : 'Write a message... (Enter to send, Shift+Enter for newline)')}
                                    </span>
                                    <div className="flex items-center gap-2">
                                        <span className="rounded border border-[var(--app-border)] px-1.5 py-0.5 text-[11px] font-mono">
                                            Ctrl+O: {viewMode}
                                        </span>
                                        {stageData.streaming || stageData.followUpStreaming ? (
                                            <button
                                                type="button"
                                                data-testid="demo-stop-running-btn"
                                                onClick={() => setStage('completed')}
                                                title={lang === 'zh-CN' ? '停止当前运行 (Esc)' : 'Stop (Esc)'}
                                                className="inline-flex h-6 w-6 items-center justify-center rounded-full border border-[var(--app-fg)]/40 bg-[var(--app-fg)]/10 text-[var(--app-fg)] hover:bg-[var(--app-fg)]/20"
                                            >
                                                <span className="h-2 w-2 rounded-[1.5px] bg-current" />
                                            </button>
                                        ) : null}
                                    </div>
                                </div>
                            </div>
                        </div>
                    </section>

                    {/* Column 2: Current HAPI Classic TurnBlock (for direct visual diff) */}
                    {layoutMode === 'side-by-side' ? (
                        <section className="flex flex-col justify-between rounded-2xl border border-[var(--app-border)] bg-[var(--app-bg)] p-4 opacity-95">
                            <div>
                                <div className="mb-3 flex items-center justify-between border-b border-[var(--app-border)]/70 pb-2.5">
                                    <div className="flex items-center gap-2">
                                        <span className="inline-block h-2 w-2 rounded-full bg-[var(--app-hint)]" />
                                        <h2 className="text-xs font-semibold uppercase tracking-wider text-[var(--app-hint)]">
                                            Current HAPI Classic (<code className="font-mono">variant="classic"</code>)
                                        </h2>
                                    </div>
                                    <span className="rounded bg-[var(--app-subtle-bg)] px-2 py-0.5 text-[11px] text-[var(--app-hint)]">
                                        Bordered Table + Uncollapsed Reasoning
                                    </span>
                                </div>

                                <TurnBlockView
                                    partition={partition}
                                    streaming={stageData.streaming}
                                    durationMs={stageData.durationMs}
                                    initiallyOpen={true}
                                    variant="classic"
                                />
                            </div>

                            <div className="mt-6 rounded-xl border border-dashed border-[var(--app-border)] p-3 text-[12px] text-[var(--app-hint)] space-y-1">
                                <div className="font-medium text-[var(--app-fg)]">Key Gaps in Classic View:</div>
                                <div>• Heavy outer <code className="font-mono">rounded-2xl border divide-y</code> box instead of borderless timeline</div>
                                <div>• Static single-tool header (<code className="font-mono">{partition.title}</code>) instead of active Todo shimmer / past-tense aggregation</div>
                                <div>• Reasoning rows render as raw uncollapsed paragraphs instead of collapsible <code className="font-mono">Thought &gt;</code> rows</div>
                                <div>• Expanding a tool opens modal <code className="font-mono">INPUT / OUTPUT</code> sections instead of compact inline cards</div>
                            </div>
                        </section>
                    ) : null}
                </div>

                {/* Architectural Gap & Alignment Matrix */}
                <section className="rounded-2xl border border-[var(--app-border)] bg-[var(--app-bg)] overflow-hidden">
                    <button
                        type="button"
                        onClick={() => setShowSpecTable((v) => !v)}
                        className="flex w-full items-center justify-between bg-[var(--app-subtle-bg)]/40 px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)]/70"
                    >
                        <span>Timeline vs. Classic TurnBlock Architecture Matrix</span>
                        <span className="text-[11px] font-normal text-[var(--app-hint)]">
                            {showSpecTable ? 'Hide Matrix ▲' : 'Show Matrix ▼'}
                        </span>
                    </button>

                    {showSpecTable ? (
                        <div className="overflow-x-auto">
                            <table className="w-full border-collapse text-left text-[12.5px]">
                                <thead>
                                    <tr className="border-b border-[var(--app-border)] bg-[var(--app-subtle-bg)]/25 text-[11px] uppercase text-[var(--app-hint)]">
                                        <th className="px-4 py-2.5">Surface / Layer</th>
                                        <th className="px-4 py-2.5">Target Timeline Behavior</th>
                                        <th className="px-4 py-2.5">Current Classic (<code className="font-mono">TurnBlock.tsx</code>)</th>
                                        <th className="px-4 py-2.5">Implementation Symbol</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-[var(--app-border)]/60">
                                    <tr>
                                        <td className="px-4 py-2.5 font-medium">Level 0: Working Header</td>
                                        <td className="px-4 py-2.5 text-[var(--app-hint)]">
                                            Borderless row showing active Todo (<code className="font-mono">Inspecting local workspace... &gt;</code>) with text shimmer; clickable while running
                                        </td>
                                        <td className="px-4 py-2.5 text-[var(--app-hint)]">
                                            Bordered box header with static first/last tool intent (<code className="font-mono">turnBlockModel.ts:380</code>)
                                        </td>
                                        <td className="px-4 py-2.5 font-mono text-[11.5px]">
                                            summarizeTurnActivity().workingHeader + .turn-text-shimmer
                                        </td>
                                    </tr>
                                    <tr>
                                        <td className="px-4 py-2.5 font-medium">Level 0: Completion & Auto-Collapse</td>
                                        <td className="px-4 py-2.5 text-[var(--app-hint)]">
                                            Auto-collapses on completion and switches header to <code className="font-mono">Ran 3 commands, viewed a file, and fetched a page</code>
                                        </td>
                                        <td className="px-4 py-2.5 text-[var(--app-hint)]">
                                            Keeps single tool intent string even after completion
                                        </td>
                                        <td className="px-4 py-2.5 font-mono text-[11.5px]">
                                            formatTurnAggregatedSummary(counts) + streaming transition useEffect
                                        </td>
                                    </tr>
                                    <tr>
                                        <td className="px-4 py-2.5 font-medium">Level 1: Step Timeline Rail</td>
                                        <td className="px-4 py-2.5 text-[var(--app-hint)]">
                                            Indented <code className="font-mono">border-l</code> vertical rail; collapsible <code className="font-mono">Thought &gt;</code>; right-aligned domain/count badges (<code className="font-mono">docs.example.com</code>, <code className="font-mono">10 results</code>)
                                        </td>
                                        <td className="px-4 py-2.5 text-[var(--app-hint)]">
                                            Full-width <code className="font-mono">divide-y</code> rows; raw uncollapsed reasoning paragraphs; past-tense verbs only
                                        </td>
                                        <td className="px-4 py-2.5 font-mono text-[11.5px]">
                                            TimelineThoughtRow + TimelineToolStepRow + describeTurnToolStep()
                                        </td>
                                    </tr>
                                    <tr>
                                        <td className="px-4 py-2.5 font-medium">Level 2: Inline Tool Cards</td>
                                        <td className="px-4 py-2.5 text-[var(--app-hint)]">
                                            Compact Bash box (header + copy + scrollable stdout), WebFetch card (title + URL + <code className="font-mono">21.9 KB · 584 lines</code>), WebSearch favicon+domain list
                                        </td>
                                        <td className="px-4 py-2.5 text-[var(--app-hint)]">
                                            Embeds modal <code className="font-mono">ToolDetailDialogContent</code> with heavy <code className="font-mono">INPUT</code>/<code className="font-mono">OUTPUT</code> trace headers
                                        </td>
                                        <td className="px-4 py-2.5 font-mono text-[11.5px]">
                                            StepInlinePreviewCard (bash | web-fetch | web-search | file-diff | file-read)
                                        </td>
                                    </tr>
                                    <tr>
                                        <td className="px-4 py-2.5 font-medium">Docked Todo & Question Wizard</td>
                                        <td className="px-4 py-2.5 text-[var(--app-hint)]">
                                            Docked above composer: <code className="font-mono">1 of 4 Active task ^</code> → <code className="font-mono">4 of 4 Done</code>; <code className="font-mono">&lt; 1 of 3 &gt;</code> question wizard + Q&A user bubble
                                        </td>
                                        <td className="px-4 py-2.5 text-[var(--app-hint)]">
                                            <code className="font-mono">TodoPanel.tsx</code> disconnected from TurnBlock header; <code className="font-mono">AskUserQuestionFooter</code> inline in scrollback
                                        </td>
                                        <td className="px-4 py-2.5 font-mono text-[11.5px]">
                                            DockedTodoProgressBar + DockedQuestionWizard + SubmittedQuestionSummaryBubble
                                        </td>
                                    </tr>
                                </tbody>
                            </table>
                        </div>
                    ) : null}
                </section>
            </main>
        </div>
    )
}
