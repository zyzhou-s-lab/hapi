import { useEffect, useMemo, useState } from 'react'
import type { ToolCallBlock } from '@/chat/types'
import {
    partitionTurn,
    type TurnContentPart,
} from '@/components/AssistantChat/messages/turnBlockModel'
import { TurnBlockView } from '@/components/AssistantChat/messages/TurnBlock'
import {
    ClaudeAskUserQuestionWizard,
    ClaudeDesktopTurnBlockView,
    ClaudeDockedTodoBar,
    ClaudeSparkleIcon,
    ClaudeSubmittedQaBubble,
    type ClaudeDemoQuestionItem,
    type ClaudeDemoTodoItem,
    type ClaudeTranscriptViewMode,
} from '@/components/AssistantChat/messages/ClaudeDesktopTurnBlock'
import { cn } from '@/lib/utils'

export type DemoLifecycleStage =
    | 'working-step-1'
    | 'working-step-2'
    | 'working-step-3'
    | 'asking-user'
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

const DEMO_QUESTIONS: ClaudeDemoQuestionItem[] = [
    {
        id: 'header-style',
        question: 'How should HAPI render the Level-0 TurnBlock header while tools are running?',
        options: [
            {
                label: 'Sync with active Todo + text shimmer (Claude Desktop style)',
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
                description: 'Matches Claude Desktop Code tab (1 of 4 -> 4 of 4 Done + < 1 of 3 > wizard)',
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
        title: 'Claude Code on the web - Claude Code Docs',
        url: 'https://code.claude.com/docs/en/claude-code-on-the-web',
        domain: 'code.claude.com',
    },
    {
        title: 'Using Claude Code with Desktop - Claude Code Docs',
        url: 'https://code.claude.com/docs/en/desktop',
        domain: 'code.claude.com',
    },
    {
        title: 'Configure preview servers & local environments - Claude Docs',
        url: 'https://code.claude.com/docs/en/desktop#environment-configuration',
        domain: 'code.claude.com',
    },
    {
        title: 'Getting started with Claude Code on desktop | Anthropic Help Center',
        url: 'https://support.claude.com/en/articles/claude-code-desktop',
        domain: 'support.claude.com',
    },
    {
        title: 'anthropics/claude-code: Agentic coding tool in your terminal & desktop',
        url: 'https://github.com/anthropics/claude-code',
        domain: 'github.com',
    },
]

function buildStageData(stage: DemoLifecycleStage): {
    parts: TurnContentPart[]
    streaming: boolean
    durationMs: number
    todos: ClaudeDemoTodoItem[]
    activeTodoText: string | null
} {
    const thought1: TurnContentPart = {
        type: 'reasoning',
        text: 'The user wants to know where Claude Desktop saves local environment configurations and how working tool cards group, expand, and auto-collapse. Let me inspect ~/Library/Application Support/Claude and the local ion-dist.asar bundle first.',
        status: { type: 'complete' },
    }

    const bash1 = makeToolPart({
        id: 'tool-bash-1',
        name: 'Bash',
        state: stage === 'working-step-1' ? 'running' : 'completed',
        description: 'Inspect ~/Library/Application Support/Claude and ~/.claude',
        toolInput: {
            command: 'ls -la "$HOME/Library/Application Support/Claude" "$HOME/.claude"',
            description: 'Inspect ~/Library/Application Support/Claude and ~/.claude',
        },
        result: {
            stdout: [
                'drwxr-xr-x@ 26 user  staff     832 Nov  4 14:10 .',
                '-rw-r--r--@  1 user  staff    1962 Nov  4 13:58 claude_desktop_config.json',
                'drwxr-xr-x@  9 user  staff     288 Nov  4 14:02 claude-code-sessions',
                'drwxr-xr-x@  5 user  staff     160 Nov  2 09:41 local-agent-mode-sessions',
            ].join('\n'),
        },
    })

    const bash2 = makeToolPart({
        id: 'tool-bash-2',
        name: 'Bash',
        state: 'completed',
        description: 'Search ion-dist.asar for TimelineGroup and tool summary strings',
        toolInput: {
            command: 'rg -o "TimelineGroup|timeline-status-enter|result-list-box" /Applications/Claude.app/Contents/Resources/ion-dist.asar',
            description: 'Search ion-dist.asar for TimelineGroup and tool summary strings',
        },
        result: {
            stdout: [
                'assets/v1/shared-styles-BawOO5XW.css:timeline-status-enter',
                'assets/v1/c5b91cb82-RJi2TUsc.js:TimelineGroup',
                'assets/v1/c5b91cb82-RJi2TUsc.js:result-list-box',
            ].join('\n'),
        },
    })

    const bash3 = makeToolPart({
        id: 'tool-bash-3',
        name: 'Bash',
        state: 'completed',
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
        state: stage === 'working-step-2' ? 'running' : 'completed',
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
                '    variant?: "classic" | "claude"',
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
        text: 'Now let me fetch the official Claude Code Desktop documentation on code.claude.com and compare its 3-level expansion hierarchy (Level 0 summary -> Level 1 vertical rail -> Level 2 compact preview cards) with HAPI.',
        status: { type: 'complete' },
    }

    const webFetch1 = makeToolPart({
        id: 'tool-webfetch-1',
        name: 'WebFetch',
        state: 'completed',
        description: 'Claude Code on the web',
        toolInput: {
            url: 'https://code.claude.com/docs/en/claude-code-on-the-web',
            description: 'Claude Code on the web',
        },
        result: {
            title: 'Claude Code on the web',
            bytes: 22425,
            lines: 584,
            content: 'In the Code tab, each conversation is a session with its own chat history and project folder. Switch transcript view modes (Normal, Thinking, Verbose) with Ctrl+O.',
        },
    })

    const webSearch1 = makeToolPart({
        id: 'tool-websearch-1',
        name: 'WebSearch',
        state: 'completed',
        description: 'Searched the web',
        toolInput: {
            query: '"claude desktop" code tab tool cards timeline group',
        },
        result: {
            results: WEB_SEARCH_RESULTS,
        },
    })

    const edit1 = makeToolPart({
        id: 'tool-edit-1',
        name: 'Edit',
        state: stage === 'working-step-3' ? 'running' : 'completed',
        description: 'Update TurnBlockView to support Claude Desktop timeline layout',
        toolInput: {
            file_path: 'web/src/components/AssistantChat/messages/TurnBlock.tsx',
            old_string: '<div className="divide-y divide-[var(--app-divider)] overflow-hidden rounded-2xl border border-[var(--app-border)]">',
            new_string: '<ClaudeDesktopTurnBlockView\n    partition={props.partition}\n    streaming={props.streaming}\n    activeTodoText={props.activeTodoText}\n/>',
        },
        result: { ok: true },
    })

    const trailingAnswer: TurnContentPart = {
        type: 'text',
        text: [
            'Here is how Claude Desktop’s **Code** tab structures working tool cards and how HAPI aligns to it:',
            '',
            '1. **Level 0 (Group Summary Header)**: Borderless row showing the active Todo task with `.claude-text-shimmer` while working, then automatically collapsing on completion into an aggregated past-tense summary (`Ran 3 commands, viewed a file, edited a file, fetched a page, and searched the web`).',
            '2. **Level 1 (Vertical Step Timeline Rail)**: Indented `border-l` rail with collapsible `Thought` rows, present-participle running verbs (`Running`, `Viewing`, `Fetching`), and right-aligned metadata badges (`code.claude.com`, `5 results`, `+4 -1`).',
            '3. **Level 2 (Inline Compact Preview Cards)**: Purpose-built inline Bash (copy + scrollable stdout), WebFetch (URL + byte/line footer), WebSearch (favicon + domain list), and File Diff cards.',
        ].join('\n'),
        status: { type: 'complete' },
    }

    if (stage === 'working-step-1') {
        const todos: ClaudeDemoTodoItem[] = [
            { id: '1', content: 'Inspect local Claude Desktop configuration and app resources', activeForm: 'Inspecting local Claude Desktop configuration and app resources', status: 'in_progress' },
            { id: '2', content: 'Search Claude.app UI bundle for TimelineGroup and step cards', activeForm: 'Searching Claude.app UI bundle for TimelineGroup and step cards', status: 'pending' },
            { id: '3', content: 'Fetch official Claude Code Desktop documentation and compare with HAPI', activeForm: 'Fetching official Claude Code Desktop documentation and comparing with HAPI', status: 'pending' },
            { id: '4', content: 'Verify 3-level expansion, auto-collapse, and docked composer widgets', activeForm: 'Verifying 3-level expansion, auto-collapse, and docked composer widgets', status: 'pending' },
        ]
        return {
            parts: [thought1, bash1],
            streaming: true,
            durationMs: 4200,
            todos,
            activeTodoText: todos[0]?.activeForm ?? null,
        }
    }

    if (stage === 'working-step-2') {
        const todos: ClaudeDemoTodoItem[] = [
            { id: '1', content: 'Inspect local Claude Desktop configuration and app resources', status: 'completed' },
            { id: '2', content: 'Search Claude.app UI bundle for TimelineGroup and step cards', activeForm: 'Searching Claude.app UI bundle for TimelineGroup and step cards', status: 'in_progress' },
            { id: '3', content: 'Fetch official Claude Code Desktop documentation and compare with HAPI', status: 'pending' },
            { id: '4', content: 'Verify 3-level expansion, auto-collapse, and docked composer widgets', status: 'pending' },
        ]
        return {
            parts: [thought1, bash1, bash2, bash3, read1],
            streaming: true,
            durationMs: 11800,
            todos,
            activeTodoText: todos[1]?.activeForm ?? null,
        }
    }

    if (stage === 'working-step-3' || stage === 'asking-user') {
        const todos: ClaudeDemoTodoItem[] = [
            { id: '1', content: 'Inspect local Claude Desktop configuration and app resources', status: 'completed' },
            { id: '2', content: 'Search Claude.app UI bundle for TimelineGroup and step cards', status: 'completed' },
            { id: '3', content: 'Fetch official Claude Code Desktop documentation and compare with HAPI', activeForm: 'Fetching official Claude Code Desktop documentation and comparing with HAPI', status: 'in_progress' },
            { id: '4', content: 'Verify 3-level expansion, auto-collapse, and docked composer widgets', status: 'pending' },
        ]
        return {
            parts: [thought1, bash1, bash2, bash3, read1, thought2, webFetch1, webSearch1, edit1],
            streaming: true,
            durationMs: 19400,
            todos,
            activeTodoText: todos[2]?.activeForm ?? null,
        }
    }

    const todos: ClaudeDemoTodoItem[] = [
        { id: '1', content: 'Inspect local Claude Desktop configuration and app resources', status: 'completed' },
        { id: '2', content: 'Search Claude.app UI bundle for TimelineGroup and step cards', status: 'completed' },
        { id: '3', content: 'Fetch official Claude Code Desktop documentation and compare with HAPI', status: 'completed' },
        { id: '4', content: 'Verify 3-level expansion, auto-collapse, and docked composer widgets', status: 'completed' },
    ]
    return {
        parts: [thought1, bash1, bash2, bash3, read1, thought2, webFetch1, webSearch1, edit1, trailingAnswer],
        streaming: false,
        durationMs: 24600,
        todos,
        activeTodoText: null,
    }
}

const STAGES: Array<{ id: DemoLifecycleStage; stepLabel: string; subtitle: string }> = [
    {
        id: 'working-step-1',
        stepLabel: '1. Working (Todo 1/4)',
        subtitle: 'Shimmering header synced with Todo #1 + live running Bash step + terracotta sparkle',
    },
    {
        id: 'working-step-2',
        stepLabel: '2. Working (Todo 2/4)',
        subtitle: '3 completed Bash commands (expandable live!) + Viewing TurnBlock.tsx',
    },
    {
        id: 'working-step-3',
        stepLabel: '3. Working (Todo 3/4)',
        subtitle: 'WebFetch (code.claude.com badge) + WebSearch (5 results) + Edit diff (+4 -1)',
    },
    {
        id: 'asking-user',
        stepLabel: '4. AskUserQuestion Wizard',
        subtitle: 'Multi-step < 1 of 3 > wizard docked above composer + Q&A summary bubble',
    },
    {
        id: 'completed',
        stepLabel: '5. Completed (Auto-Collapse)',
        subtitle: 'Header switches to aggregated past-tense summary & auto-collapses; Todo bar -> 4 of 4 Done',
    },
]

export function ClaudeDesktopAlignmentDemo() {
    const [stage, setStage] = useState<DemoLifecycleStage>('working-step-3')
    const [layoutMode, setLayoutMode] = useState<'side-by-side' | 'claude-only'>('side-by-side')
    const [viewMode, setViewMode] = useState<ClaudeTranscriptViewMode>('normal')
    const [lang, setLang] = useState<'en' | 'zh-CN'>('en')
    const [autoPlaying, setAutoPlaying] = useState(false)
    const [submittedAnswers, setSubmittedAnswers] = useState<Record<string, string> | null>(null)
    const [showSpecTable, setShowSpecTable] = useState(true)

    useEffect(() => {
        if (!autoPlaying) return
        const order: DemoLifecycleStage[] = [
            'working-step-1',
            'working-step-2',
            'working-step-3',
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

    // Support Ctrl+O shortcut to cycle Normal -> Thinking -> Verbose just like Claude Desktop
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

    const stageData = useMemo(() => buildStageData(stage), [stage])
    const partition = useMemo(() => partitionTurn(stageData.parts, null), [stageData.parts])

    return (
        <div
            className="min-h-screen bg-[var(--app-bg)] text-[var(--app-fg)] flex flex-col"
            data-testid="claude-desktop-alignment-workbench"
        >
            {/* Top Workbench Control Bar */}
            <header className="sticky top-0 z-20 border-b border-[var(--app-border)] bg-[var(--app-bg)]/95 backdrop-blur px-4 py-3">
                <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-2.5">
                        <ClaudeSparkleIcon size={18} />
                        <div>
                            <h1 className="text-sm font-semibold tracking-tight">
                                HAPI × Claude Desktop UI Alignment Workbench
                            </h1>
                            <p className="text-[11.5px] text-[var(--app-hint)]">
                                Grounded in macOS Claude Desktop recordings, <code className="font-mono">ion-dist.asar</code>, and <code className="font-mono">code.claude.com/docs/en/desktop</code>
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
                                data-testid="layout-claude-only"
                                onClick={() => setLayoutMode('claude-only')}
                                className={cn(
                                    'rounded-md px-2 py-1 text-[11.5px] font-medium transition-colors',
                                    layoutMode === 'claude-only'
                                        ? 'bg-[var(--app-bg)] text-[var(--app-fg)] shadow-sm'
                                        : 'text-[var(--app-hint)] hover:text-[var(--app-fg)]'
                                )}
                            >
                                Claude Desktop Focus
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
                {/* User Prompt Bubble */}
                <div className="flex justify-end">
                    <div className="max-w-xl rounded-2xl border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-4 py-2.5 text-[14px] text-[var(--app-fg)]">
                        Where does Claude Desktop save local environment configurations, and how should HAPI’s frontend align with Claude Desktop’s working tool cards?
                    </div>
                </div>

                {/* Comparison Grid */}
                <div
                    className={cn(
                        'grid gap-6',
                        layoutMode === 'side-by-side' ? ' grid-cols-1 lg:grid-cols-2' : 'grid-cols-1 max-w-3xl mx-auto w-full'
                    )}
                >
                    {/* Column 1: Claude Desktop Aligned TurnBlock */}
                    <section className="flex flex-col justify-between rounded-2xl border border-[var(--app-border)] bg-[var(--app-bg)] p-4 shadow-sm">
                        <div>
                            <div className="mb-3 flex items-center justify-between border-b border-[var(--app-border)]/70 pb-2.5">
                                <div className="flex items-center gap-2">
                                    <span className="inline-block h-2 w-2 rounded-full bg-[#da7756]" />
                                    <h2 className="text-xs font-semibold uppercase tracking-wider text-[var(--app-fg)]">
                                        Claude Desktop Aligned (<code className="font-mono">variant="claude"</code>)
                                    </h2>
                                </div>
                                <span className="rounded bg-[#da7756]/15 px-2 py-0.5 text-[11px] font-medium text-[#da7756]">
                                    3-Level Rail + Shimmer + Auto-Collapse
                                </span>
                            </div>

                            <ClaudeDesktopTurnBlockView
                                partition={partition}
                                streaming={stageData.streaming}
                                durationMs={stageData.durationMs}
                                initiallyOpen={stageData.streaming}
                                activeTodoText={stageData.activeTodoText}
                                viewMode={viewMode}
                                lang={lang}
                            />

                            {submittedAnswers ? (
                                <ClaudeSubmittedQaBubble
                                    questions={DEMO_QUESTIONS}
                                    answers={submittedAnswers}
                                />
                            ) : null}
                        </div>

                        {/* Simulated Docked Composer Area */}
                        <div className="mt-6 pt-3 border-t border-[var(--app-border)]/50">
                            {stage === 'asking-user' ? (
                                <div className="mb-2">
                                    <ClaudeAskUserQuestionWizard
                                        questions={DEMO_QUESTIONS}
                                        onSubmit={(ans) => {
                                            setSubmittedAnswers(ans)
                                            setStage('completed')
                                        }}
                                        onSkip={() => setStage('completed')}
                                    />
                                </div>
                            ) : null}

                            <ClaudeDockedTodoBar
                                todos={stageData.todos}
                                defaultExpanded={stage === 'working-step-1'}
                                lang={lang}
                            />

                            <div className="rounded-b-xl border border-[var(--app-border)] bg-[var(--app-subtle-bg)]/35 px-3.5 py-2.5">
                                <div className="flex items-center justify-between text-[13px] text-[var(--app-hint)]">
                                    <span>Reply to Claude... (Enter to send, Shift+Enter for newline)</span>
                                    <span className="rounded border border-[var(--app-border)] px-1.5 py-0.5 text-[11px] font-mono">
                                        Ctrl+O: {viewMode}
                                    </span>
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
                        <span>Claude Desktop vs. HAPI Frontend Alignment Matrix (Code & Recording Evidence)</span>
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
                                        <th className="px-4 py-2.5">Claude Desktop (Recordings + ion-dist.asar)</th>
                                        <th className="px-4 py-2.5">Current HAPI (<code className="font-mono">TurnBlock.tsx</code>)</th>
                                        <th className="px-4 py-2.5">Alignment Implementation</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-[var(--app-border)]/60">
                                    <tr>
                                        <td className="px-4 py-2.5 font-medium">Level 0: Working Header</td>
                                        <td className="px-4 py-2.5 text-[var(--app-hint)]">
                                            Borderless row showing active Todo (<code className="font-mono">Inspecting local Claude Desktop... &gt;</code>) with text shimmer; clickable while running
                                        </td>
                                        <td className="px-4 py-2.5 text-[var(--app-hint)]">
                                            Bordered box header with static first/last tool intent (<code className="font-mono">turnBlockModel.ts:380</code>)
                                        </td>
                                        <td className="px-4 py-2.5 font-mono text-[11.5px]">
                                            summarizeTurnForClaudeDesktop().workingHeader + .claude-text-shimmer
                                        </td>
                                    </tr>
                                    <tr>
                                        <td className="px-4 py-2.5 font-medium">Level 0: Completion & Auto-Collapse</td>
                                        <td className="px-4 py-2.5 text-[var(--app-hint)]">
                                            Auto-collapses at <code className="font-mono">f5650 → f5750</code> and switches header to <code className="font-mono">Ran 3 commands, viewed a file, and fetched a page</code>
                                        </td>
                                        <td className="px-4 py-2.5 text-[var(--app-hint)]">
                                            Keeps single tool intent string even after completion
                                        </td>
                                        <td className="px-4 py-2.5 font-mono text-[11.5px]">
                                            formatClaudeAggregatedSummary(counts) + streaming transition useEffect
                                        </td>
                                    </tr>
                                    <tr>
                                        <td className="px-4 py-2.5 font-medium">Level 1: Step Timeline Rail</td>
                                        <td className="px-4 py-2.5 text-[var(--app-hint)]">
                                            Indented <code className="font-mono">border-l</code> vertical rail; collapsible <code className="font-mono">Thought &gt;</code>; right-aligned domain/count badges (<code className="font-mono">code.claude.com</code>, <code className="font-mono">10 results</code>)
                                        </td>
                                        <td className="px-4 py-2.5 text-[var(--app-hint)]">
                                            Full-width <code className="font-mono">divide-y</code> rows; raw uncollapsed reasoning paragraphs; past-tense verbs only
                                        </td>
                                        <td className="px-4 py-2.5 font-mono text-[11.5px]">
                                            ClaudeThoughtRow + ClaudeToolStepRow + describeClaudeToolStep()
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
                                            ClaudeLevel2PreviewCard (bash | web-fetch | web-search | file-diff | file-read)
                                        </td>
                                    </tr>
                                    <tr>
                                        <td className="px-4 py-2.5 font-medium">Docked Todo & AskUserQuestion</td>
                                        <td className="px-4 py-2.5 text-[var(--app-hint)]">
                                            Docked above composer: <code className="font-mono">1 of 4 Active task ^</code> → <code className="font-mono">4 of 4 Done</code>; <code className="font-mono">&lt; 1 of 3 &gt;</code> question wizard + Q&A user bubble
                                        </td>
                                        <td className="px-4 py-2.5 text-[var(--app-hint)]">
                                            <code className="font-mono">TodoPanel.tsx</code> disconnected from TurnBlock header; <code className="font-mono">AskUserQuestionFooter</code> inline in scrollback
                                        </td>
                                        <td className="px-4 py-2.5 font-mono text-[11.5px]">
                                            ClaudeDockedTodoBar + ClaudeAskUserQuestionWizard + ClaudeSubmittedQaBubble
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
