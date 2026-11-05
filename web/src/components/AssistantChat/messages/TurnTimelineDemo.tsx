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
type ComposerDemoVariant = 'c1-reference' | 'c2-balanced' | 'c3-pills' | 'c0-current'
type ComposerDemoViewLayout = 'side-by-side' | 'single' | 'grid'
type ComposerDemoStateMode = 'idle' | 'typing' | 'attachments' | 'streaming'

const COMPOSER_MODELS = [
    { id: 'gpt-5.4', label: 'GPT-5.4', badge: 'Fast' },
    { id: 'claude-opus-4-7', label: 'Claude Opus 4.7', badge: 'Max' },
    { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', badge: 'Balanced' },
    { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', badge: '1M ctx' },
]

const COMPOSER_EFFORTS = [
    { id: 'low', label: 'Low', desc: '快速响应，低推理开销' },
    { id: 'medium', label: 'Medium', desc: '标准思考深度' },
    { id: 'high', label: 'High', desc: '深度推理，适合复杂编码' },
    { id: 'xhigh', label: 'xhigh', desc: '极限推理预算' },
]

const COMPOSER_MODES = [
    { id: 'agent', label: 'Agent', tone: 'neutral', desc: '默认智能体协作模式' },
    { id: 'plan', label: 'Plan', tone: 'info', desc: '先规划方案再执行修改' },
    { id: 'acceptEdits', label: 'Auto-Edit', tone: 'warning', desc: '自动批准文件编辑操作' },
    { id: 'bypassPermissions', label: 'Bypass', tone: 'danger', desc: '跳过所有工具权限确认' },
] as const

function DemoContextProgressRing(props: { percent: number; size?: number }) {
    const size = props.size ?? 14
    const strokeWidth = 2
    const radius = (size - strokeWidth) / 2
    const circumference = 2 * Math.PI * radius
    const clamped = Math.min(100, Math.max(0, props.percent))
    const offset = circumference - (clamped / 100) * circumference
    const colorClass =
        clamped >= 90
            ? 'text-[var(--app-badge-error-text)]'
            : clamped >= 70
                ? 'text-[var(--app-badge-warning-text)]'
                : 'text-[var(--app-hint)]'
    return (
        <svg
            width={size}
            height={size}
            viewBox={`0 0 ${size} ${size}`}
            className={cn('shrink-0 -rotate-90', colorClass)}
            aria-hidden="true"
        >
            <circle
                cx={size / 2}
                cy={size / 2}
                r={radius}
                fill="none"
                stroke="currentColor"
                strokeOpacity={0.22}
                strokeWidth={strokeWidth}
            />
            <circle
                cx={size / 2}
                cy={size / 2}
                r={radius}
                fill="none"
                stroke="currentColor"
                strokeWidth={strokeWidth}
                strokeDasharray={circumference}
                strokeDashoffset={offset}
                strokeLinecap="round"
            />
        </svg>
    )
}

function DemoChevronDownIcon() {
    return (
        <svg
            width="10"
            height="10"
            viewBox="0 0 10 10"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="shrink-0 opacity-70"
            aria-hidden="true"
        >
            <path d="M2.5 3.75L5 6.25L7.5 3.75" />
        </svg>
    )
}

function DemoPlusIcon() {
    return (
        <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
    )
}

function DemoSendArrowIcon() {
    return (
        <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <line x1="12" y1="19" x2="12" y2="5" />
            <polyline points="5 12 12 5 19 12" />
        </svg>
    )
}

function DemoVoiceWaveIcon() {
    return (
        <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <path d="M12 6v12" />
            <path d="M8 9v6" />
            <path d="M16 9v6" />
            <path d="M4 11v2" />
            <path d="M20 11v2" />
        </svg>
    )
}

function DemoAgentModeIcon() {
    return (
        <svg
            width="12.5"
            height="12.5"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="shrink-0 opacity-80"
            aria-hidden="true"
        >
            <circle cx="12" cy="12" r="3" />
            <path d="M12 2v3" />
            <path d="M12 19v3" />
            <path d="M4.93 4.93l2.12 2.12" />
            <path d="M16.95 16.95l2.12 2.12" />
            <path d="M2 12h3" />
            <path d="M19 12h3" />
        </svg>
    )
}

function DemoFolderIcon() {
    return (
        <svg
            width="12.5"
            height="12.5"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.9"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="shrink-0 opacity-75"
            aria-hidden="true"
        >
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
        </svg>
    )
}

function DemoBranchIcon() {
    return (
        <svg
            width="12.5"
            height="12.5"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.9"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="shrink-0 opacity-75"
            aria-hidden="true"
        >
            <line x1="6" y1="3" x2="6" y2="15" />
            <circle cx="18" cy="6" r="3" />
            <circle cx="6" cy="18" r="3" />
            <path d="M18 9a9 9 0 0 1-9 9" />
        </svg>
    )
}

function DemoTerminalIcon() {
    return (
        <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="shrink-0 opacity-75"
            aria-hidden="true"
        >
            <polyline points="4 17 10 11 4 5" />
            <line x1="12" y1="19" x2="20" y2="19" />
        </svg>
    )
}

function DemoGearIcon() {
    return (
        <svg width="13.5" height="13.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
    )
}

function DemoExpandIcon() {
    return (
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="15 3 21 3 21 9" />
            <polyline points="9 21 3 21 3 15" />
            <line x1="21" y1="3" x2="14" y2="10" />
            <line x1="3" y1="21" x2="10" y2="14" />
        </svg>
    )
}

function DemoScratchlistIcon() {
    return (
        <svg width="13.5" height="13.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="16" y1="13" x2="8" y2="13" />
            <line x1="16" y1="17" x2="8" y2="17" />
        </svg>
    )
}

function DemoClockIcon() {
    return (
        <svg width="13.5" height="13.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="9" />
            <polyline points="12 7 12 12 15 15" />
        </svg>
    )
}

function ComposerPreviewCard(props: {
    variant: ComposerDemoVariant
    plusPlacement: 'outside' | 'inside'
    stateMode: ComposerDemoStateMode
    radiusClass: string
    draftText: string
    onDraftChange: (val: string) => void
    selectedModel: string
    onSelectModel: (id: string) => void
    selectedEffort: string
    onSelectEffort: (id: string) => void
    selectedMode: string
    onSelectMode: (id: string) => void
    contextPercent: number
    gitClean: boolean
    interactiveMenus?: boolean
}) {
    const [openMenu, setOpenMenu] = useState<'model' | 'effort' | 'mode' | 'context' | 'git' | null>(null)
    const modelObj = COMPOSER_MODELS.find((m) => m.id === props.selectedModel) ?? COMPOSER_MODELS[0]!
    const effortObj = COMPOSER_EFFORTS.find((e) => e.id === props.selectedEffort) ?? COMPOSER_EFFORTS[2]!
    const modeObj = COMPOSER_MODES.find((m) => m.id === props.selectedMode) ?? COMPOSER_MODES[0]!

    const isStreaming = props.stateMode === 'streaming'
    const hasAttachments = props.stateMode === 'attachments'
    const hasText = props.draftText.trim().length > 0 || props.stateMode === 'typing'

    const modeToneClass =
        modeObj.tone === 'danger'
            ? 'text-[var(--app-badge-error-text)]'
            : modeObj.tone === 'warning'
                ? 'text-[var(--app-badge-warning-text)]'
                : modeObj.tone === 'info'
                    ? 'text-[var(--app-link)]'
                    : 'text-[var(--app-fg)]/80'

    // Baseline C0: Current HAPI internal-toolbar composer
    if (props.variant === 'c0-current') {
        return (
            <div className="w-full space-y-1" data-testid="composer-variant-c0">
                {/* Current Top StatusBar */}
                <div className="flex items-center justify-between px-2 pb-1 text-[11.5px] text-[var(--app-hint)]">
                    <div className="flex items-center gap-2">
                        <span className="inline-flex items-center gap-1.5 text-[var(--app-badge-success-text)]">
                            <span className="h-2 w-2 rounded-full bg-current" />
                            <span>online</span>
                        </span>
                        <span className="inline-flex items-center gap-1 font-mono text-[11px]">
                            <DemoBranchIcon />
                            <span>main</span>
                            {!props.gitClean ? (
                                <span className="inline-flex items-center gap-1">
                                    <span className="text-[var(--app-badge-success-text)]">+48</span>
                                    <span className="text-[var(--app-badge-error-text)]">-12</span>
                                </span>
                            ) : null}
                        </span>
                        <span className="inline-flex items-center gap-1.5">
                            <span className="h-1 w-10 overflow-hidden rounded-full bg-[var(--app-border)]">
                                <span
                                    className="block h-full bg-[var(--app-hint)]"
                                    style={{ width: `${props.contextPercent}%` }}
                                />
                            </span>
                            <span className="text-[10.5px]">{props.contextPercent}% · 138k / 250k</span>
                        </span>
                    </div>
                    <div className="flex items-center gap-2 text-[11px]">
                        <span>effort: {effortObj.label.toLowerCase()}</span>
                        <span className={modeToneClass}>{modeObj.label.toLowerCase()}</span>
                    </div>
                </div>

                {/* Current Heavy 2-Row Frame with all buttons inside */}
                <div className="rounded-[24px] border border-[var(--app-border)] bg-[var(--app-secondary-bg)]/90 shadow-sm">
                    {hasAttachments ? (
                        <div className="flex flex-wrap gap-1.5 px-3.5 pt-2.5">
                            <span className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1 text-[11px]">
                                <span className="inline-block h-2 w-2 rounded-full bg-[#10b981]" />
                                <span className="font-mono">composer-ref.webp</span>
                            </span>
                        </div>
                    ) : null}
                    <div className="px-4 pt-3 pb-1.5">
                        <textarea
                            rows={props.stateMode === 'typing' ? 2 : 1}
                            value={props.draftText}
                            onChange={(e) => props.onDraftChange(e.target.value)}
                            placeholder="Write a message... (@ to mention sessions, / for skills)"
                            className="w-full resize-none bg-transparent text-[14px] leading-relaxed text-[var(--app-fg)] placeholder-[var(--app-hint)] focus:outline-none"
                        />
                    </div>
                    {/* Crowded internal toolbar */}
                    <div className="flex flex-wrap items-center justify-between gap-1 px-2.5 pb-2">
                        <div className="flex flex-wrap items-center gap-0.5 text-[var(--app-fg)]/65">
                            <button type="button" className="flex h-7 w-7 items-center justify-center rounded-full hover:bg-[var(--app-bg)]">
                                <DemoPlusIcon />
                            </button>
                            <button type="button" className="flex h-7 w-7 items-center justify-center rounded-full hover:bg-[var(--app-bg)]" title="Settings">
                                <DemoGearIcon />
                            </button>
                            <button type="button" className="flex h-7 w-7 items-center justify-center rounded-full hover:bg-[var(--app-bg)]" title="Expand">
                                <DemoExpandIcon />
                            </button>
                            <button type="button" className="inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-[11.5px] font-medium hover:bg-[var(--app-bg)]">
                                <span>{modelObj.label}</span>
                                <DemoChevronDownIcon />
                            </button>
                            <button type="button" className="inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-[11.5px] font-medium hover:bg-[var(--app-bg)]">
                                <span>{effortObj.label}</span>
                                <DemoChevronDownIcon />
                            </button>
                            <button type="button" className="flex h-7 w-7 items-center justify-center rounded-full hover:bg-[var(--app-bg)]" title="Terminal">
                                <DemoTerminalIcon />
                            </button>
                            <button type="button" className="flex h-7 w-7 items-center justify-center rounded-full hover:bg-[var(--app-bg)]" title="Scratchlist">
                                <DemoScratchlistIcon />
                            </button>
                            <button type="button" className="flex h-7 w-7 items-center justify-center rounded-full hover:bg-[var(--app-bg)]" title="Schedule">
                                <DemoClockIcon />
                            </button>
                        </div>
                        <div className="flex items-center gap-1">
                            <button type="button" className="flex h-7 w-7 items-center justify-center rounded-full text-[var(--app-fg)]/60 hover:bg-[var(--app-bg)]">
                                <DemoVoiceWaveIcon />
                            </button>
                            <button
                                type="button"
                                className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--app-fg)] text-[var(--app-bg)]"
                            >
                                <DemoSendArrowIcon />
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        )
    }

    const isPillVariant = props.variant === 'c3-pills'
    const isBalancedVariant = props.variant === 'c2-balanced'
    const effectivePlusInside = isBalancedVariant ? true : props.plusPlacement === 'inside'

    const chipBaseClass = isPillVariant
        ? 'inline-flex items-center gap-1 rounded-full border border-[var(--app-border)]/80 bg-[var(--app-subtle-bg)]/55 px-2.5 py-1 text-[11.5px] font-medium text-[var(--app-fg)]/80 transition-colors hover:border-[var(--app-fg)]/30 hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]'
        : 'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[12px] font-medium text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)]/70 hover:text-[var(--app-fg)]'

    return (
        <div className="relative w-full" data-testid={`composer-variant-${props.variant}`}>
            {/* Top-Left Status Row: online + git status (Outside & Above Input Box Top-Left) */}
            <div
                className="flex items-center justify-between px-2 pb-1.5 text-[11.5px]"
                data-testid="composer-top-left-status"
            >
                <div className="flex flex-wrap items-center gap-2">
                    <span className="inline-flex items-center gap-1.5 text-[var(--app-badge-success-text)]">
                        <span
                            className={cn(
                                'h-2 w-2 rounded-full bg-current',
                                isStreaming && 'animate-pulse'
                            )}
                        />
                        <span>{isStreaming ? 'responding...' : 'online'}</span>
                    </span>

                    <span className="text-[var(--app-border)]" aria-hidden="true">·</span>

                    <button
                        type="button"
                        data-testid="top-left-git-status"
                        onClick={() => props.interactiveMenus && setOpenMenu(openMenu === 'git' ? null : 'git')}
                        title="Git 分支与工作区状态（点击查看改动文件）"
                        className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 font-mono text-[11px] text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)]/70 hover:text-[var(--app-fg)]"
                    >
                        <span className="inline-flex items-center gap-1 text-[var(--app-fg)]/85">
                            <DemoBranchIcon />
                            <span>main</span>
                        </span>
                        {props.gitClean ? (
                            <span className="text-[10.5px] text-[var(--app-hint)]">clean</span>
                        ) : (
                            <>
                                <span className="inline-flex items-center gap-1 font-medium">
                                    <span className="text-[var(--app-badge-success-text)]">+48</span>
                                    <span className="text-[var(--app-badge-error-text)]">-12</span>
                                </span>
                                <span className="text-[10.5px] text-[var(--app-hint)]">· 2 files</span>
                            </>
                        )}
                    </button>
                </div>
            </div>

            {/* Pure Input Box */}
            <div
                className={cn(
                    'border border-[var(--app-border)] bg-[var(--app-bg)] transition-shadow focus-within:border-[var(--app-fg)]/30',
                    props.radiusClass,
                    'shadow-[0_2px_10px_rgba(15,23,42,0.04)]'
                )}
                data-testid="composer-pure-input-box"
            >
                {/* Optional Attachment Previews inside top of input box */}
                {hasAttachments ? (
                    <div className="flex flex-wrap items-center gap-2 px-3.5 pt-2.5">
                        <div className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--app-border)] bg-[var(--app-subtle-bg)]/45 px-2.5 py-1 text-[11.5px] text-[var(--app-fg)]">
                            <span className="inline-block h-2 w-2 rounded-full bg-[#10b981]" />
                            <span className="font-mono">Snapzy_Composer_Ref.webp</span>
                            <span className="text-[10.5px] text-[var(--app-hint)]">42 KB</span>
                        </div>
                        <div className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--app-border)] bg-[var(--app-subtle-bg)]/45 px-2.5 py-1 text-[11.5px] text-[var(--app-fg)]">
                            <span className="font-mono text-[#3b82f6]">@HappyComposer.tsx</span>
                        </div>
                    </div>
                ) : null}

                {/* Clean Input Row: only [optional +] + textarea + [voice/send] */}
                <div
                    className={cn(
                        'flex gap-2 px-3.5 py-2.5',
                        props.stateMode === 'typing' ? 'items-end' : 'items-center'
                    )}
                >
                    {effectivePlusInside ? (
                        <button
                            type="button"
                            title="添加图片或文件附件 (+)"
                            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
                        >
                            <DemoPlusIcon />
                        </button>
                    ) : null}

                    <textarea
                        rows={props.stateMode === 'typing' ? 2 : 1}
                        value={props.draftText}
                        onChange={(e) => props.onDraftChange(e.target.value)}
                        placeholder="Ask anything, @ to mention, / for skills..."
                        className="min-h-[24px] flex-1 resize-none bg-transparent py-0.5 text-[14px] leading-relaxed text-[var(--app-fg)] placeholder-[var(--app-hint)]/80 focus:outline-none"
                    />

                    <div className="flex shrink-0 items-center gap-1.5">
                        <button
                            type="button"
                            title="语音输入 (Voice)"
                            className="flex h-7 w-7 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
                        >
                            <DemoVoiceWaveIcon />
                        </button>
                        {isStreaming ? (
                            <button
                                type="button"
                                title="停止生成 (Esc)"
                                className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--app-fg)] text-[var(--app-bg)] shadow-xs transition-opacity hover:opacity-90"
                            >
                                <span className="h-2.5 w-2.5 rounded-[2px] bg-current" />
                            </button>
                        ) : (
                            <button
                                type="button"
                                title="发送消息 (Enter)"
                                className={cn(
                                    'flex h-8 w-8 items-center justify-center rounded-full transition-all',
                                    hasText
                                        ? 'bg-[var(--app-fg)] text-[var(--app-bg)] shadow-xs hover:opacity-90'
                                        : 'bg-[var(--app-fg)]/85 text-[var(--app-bg)] hover:bg-[var(--app-fg)]'
                                )}
                            >
                                <DemoSendArrowIcon />
                            </button>
                        )}
                    </div>
                </div>
            </div>

            {/* External Bottom Controls Bar (Outside & Below Input Box) */}
            <div
                className="mt-2 flex flex-wrap items-center justify-between gap-y-1.5 px-1.5 text-[12px]"
                data-testid="composer-external-bottom-bar"
            >
                {isBalancedVariant ? (
                    <>
                        {/* C2 Left: Mode + Model + Effort */}
                        <div className="flex flex-wrap items-center gap-1.5">
                            <button
                                type="button"
                                onClick={() => props.interactiveMenus && setOpenMenu(openMenu === 'mode' ? null : 'mode')}
                                className={cn(chipBaseClass, modeToneClass)}
                            >
                                <DemoAgentModeIcon />
                                <span>{modeObj.label}</span>
                                <DemoChevronDownIcon />
                            </button>
                            <button
                                type="button"
                                onClick={() => props.interactiveMenus && setOpenMenu(openMenu === 'model' ? null : 'model')}
                                className={chipBaseClass}
                            >
                                <span>{modelObj.label}</span>
                                <DemoChevronDownIcon />
                            </button>
                            <button
                                type="button"
                                onClick={() => props.interactiveMenus && setOpenMenu(openMenu === 'effort' ? null : 'effort')}
                                className={chipBaseClass}
                            >
                                <span>{effortObj.label}</span>
                                <DemoChevronDownIcon />
                            </button>
                        </div>

                        {/* C2 Right: Quick Tools (Terminal / Scratchlist / Schedule) + Context Ring */}
                        <div className="flex items-center gap-1 text-[var(--app-hint)]">
                            <button
                                type="button"
                                className="inline-flex h-6 w-6 items-center justify-center rounded-md hover:bg-[var(--app-subtle-bg)]/70 hover:text-[var(--app-fg)]"
                                title="打开终端 (Terminal)"
                            >
                                <DemoTerminalIcon />
                            </button>
                            <button
                                type="button"
                                className="inline-flex h-6 w-6 items-center justify-center rounded-md hover:bg-[var(--app-subtle-bg)]/70 hover:text-[var(--app-fg)]"
                                title="草稿箱 (Scratchlist)"
                            >
                                <DemoScratchlistIcon />
                            </button>
                            <button
                                type="button"
                                className="inline-flex h-6 w-6 items-center justify-center rounded-md hover:bg-[var(--app-subtle-bg)]/70 hover:text-[var(--app-fg)]"
                                title="定时发送 (Schedule)"
                            >
                                <DemoClockIcon />
                            </button>
                            <span className="mx-0.5 h-3 w-px bg-[var(--app-border)]" aria-hidden="true" />
                            <button
                                type="button"
                                onClick={() => props.interactiveMenus && setOpenMenu(openMenu === 'context' ? null : 'context')}
                                className={chipBaseClass}
                                title="点击查看上下文 Token 详情"
                            >
                                <DemoContextProgressRing percent={props.contextPercent} />
                                <span className="font-mono text-[11.5px]">{props.contextPercent}%</span>
                            </button>
                        </div>
                    </>
                ) : (
                    <>
                        {/* C1 (Reference Screenshot) & C3 Left: [+] + [Agent v] + [GPT-5.4 v] + [High v] */}
                        <div className="flex flex-wrap items-center gap-1.5">
                            {!effectivePlusInside ? (
                                <button
                                    type="button"
                                    title="添加附件 (+)"
                                    className={cn(
                                        chipBaseClass,
                                        'h-6 w-6 justify-center px-0'
                                    )}
                                >
                                    <DemoPlusIcon />
                                </button>
                            ) : null}

                            <button
                                type="button"
                                data-testid="external-mode-selector"
                                onClick={() => props.interactiveMenus && setOpenMenu(openMenu === 'mode' ? null : 'mode')}
                                className={cn(chipBaseClass, modeToneClass)}
                            >
                                <DemoAgentModeIcon />
                                <span>{modeObj.label}</span>
                                <DemoChevronDownIcon />
                            </button>

                            <button
                                type="button"
                                data-testid="external-model-selector"
                                onClick={() => props.interactiveMenus && setOpenMenu(openMenu === 'model' ? null : 'model')}
                                className={chipBaseClass}
                            >
                                <span>{modelObj.label}</span>
                                <DemoChevronDownIcon />
                            </button>

                            <button
                                type="button"
                                data-testid="external-effort-selector"
                                onClick={() => props.interactiveMenus && setOpenMenu(openMenu === 'effort' ? null : 'effort')}
                                className={chipBaseClass}
                            >
                                <span>{effortObj.label}</span>
                                <DemoChevronDownIcon />
                            </button>
                        </div>

                        {/* C1 & C3 Right: [Context 55%] */}
                        <div className="flex items-center gap-2 text-[var(--app-hint)]">
                            <button
                                type="button"
                                data-testid="external-context-trigger"
                                onClick={() => props.interactiveMenus && setOpenMenu(openMenu === 'context' ? null : 'context')}
                                className={chipBaseClass}
                                title="上下文窗口使用率（点击展开详情）"
                            >
                                <DemoContextProgressRing percent={props.contextPercent} />
                                <span className="font-mono text-[11.5px]">{props.contextPercent}%</span>
                            </button>
                        </div>
                    </>
                )}
            </div>

            {/* Interactive Floating Popover Menus when clicked */}
            {props.interactiveMenus && openMenu ? (
                <div
                    className="mt-2 rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] p-2.5 shadow-lg text-xs space-y-1.5"
                    data-testid={`composer-popover-${openMenu}`}
                >
                    <div className="flex items-center justify-between border-b border-[var(--app-border)]/60 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-[var(--app-hint)]">
                            {openMenu === 'model'
                                ? '选择模型 (Model)'
                                : openMenu === 'effort'
                                    ? '选择推理强度 (Reasoning Effort)'
                                    : openMenu === 'mode'
                                        ? '选择智能体/权限模式 (Agent & Permission Mode)'
                                        : openMenu === 'git'
                                            ? 'Git 工作区状态 (main)'
                                            : '上下文窗口详情 (Context Usage)'}
                        <button
                            type="button"
                            onClick={() => setOpenMenu(null)}
                            className="rounded px-1.5 py-0.5 text-[10.5px] hover:bg-[var(--app-subtle-bg)] text-[var(--app-fg)]"
                        >
                            收起
                        </button>
                    </div>

                    {openMenu === 'model' ? (
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-1">
                            {COMPOSER_MODELS.map((m) => (
                                <button
                                    key={m.id}
                                    type="button"
                                    onClick={() => {
                                        props.onSelectModel(m.id)
                                        setOpenMenu(null)
                                    }}
                                    className={cn(
                                        'flex items-center justify-between rounded-lg px-2.5 py-1.5 text-left transition-colors',
                                        props.selectedModel === m.id
                                            ? 'bg-[var(--app-subtle-bg)] font-semibold text-[var(--app-fg)]'
                                            : 'text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)]/50 hover:text-[var(--app-fg)]'
                                    )}
                                >
                                    <span>{m.label}</span>
                                    <span className="rounded bg-[var(--app-border)]/50 px-1.5 py-0.5 text-[10px] font-mono">
                                        {m.badge}
                                    </span>
                                </button>
                            ))}
                        </div>
                    ) : null}

                    {openMenu === 'effort' ? (
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-1">
                            {COMPOSER_EFFORTS.map((ef) => (
                                <button
                                    key={ef.id}
                                    type="button"
                                    onClick={() => {
                                        props.onSelectEffort(ef.id)
                                        setOpenMenu(null)
                                    }}
                                    className={cn(
                                        'flex flex-col rounded-lg border px-2.5 py-1.5 text-left transition-colors',
                                        props.selectedEffort === ef.id
                                            ? 'border-[#da7756] bg-[#da7756]/10 text-[var(--app-fg)]'
                                            : 'border-[var(--app-border)]/60 text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)]/50 hover:text-[var(--app-fg)]'
                                    )}
                                >
                                    <span className="font-semibold">{ef.label}</span>
                                    <span className="text-[10px] opacity-80">{ef.desc}</span>
                                </button>
                            ))}
                        </div>
                    ) : null}

                    {openMenu === 'mode' ? (
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-1">
                            {COMPOSER_MODES.map((mo) => (
                                <button
                                    key={mo.id}
                                    type="button"
                                    onClick={() => {
                                        props.onSelectMode(mo.id)
                                        setOpenMenu(null)
                                    }}
                                    className={cn(
                                        'flex items-center justify-between rounded-lg border px-2.5 py-1.5 text-left transition-colors',
                                        props.selectedMode === mo.id
                                            ? 'border-[#da7756] bg-[#da7756]/10 text-[var(--app-fg)]'
                                            : 'border-[var(--app-border)]/60 text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)]/50 hover:text-[var(--app-fg)]'
                                    )}
                                >
                                    <div>
                                        <div className="font-semibold">{mo.label}</div>
                                        <div className="text-[10.5px] opacity-80">{mo.desc}</div>
                                    </div>
                                    {props.selectedMode === mo.id ? (
                                        <span className="h-2 w-2 rounded-full bg-[#da7756]" />
                                    ) : null}
                                </button>
                            ))}
                        </div>
                    ) : null}

                    {openMenu === 'context' ? (
                        <div className="flex flex-wrap items-center justify-between gap-2 px-1 py-1 text-[11.5px]">
                            <div className="space-y-0.5">
                                <div>
                                    已使用：<strong className="font-mono">137.5k / 250k tokens ({props.contextPercent}%)</strong>
                                </div>
                                <div className="text-[var(--app-hint)]">
                                    缓存命中 (Cache Read)：<span className="font-mono">94.2k tokens</span> · 剩余可用：<span className="font-mono">112.5k (45%)</span>
                                </div>
                            </div>
                            <span className="rounded-md bg-[#10b981]/15 px-2 py-0.5 font-mono text-[11px] text-[#10b981]">
                                StatusBar 已融合至此进度环
                            </span>
                        </div>
                    ) : null}

                    {openMenu === 'git' ? (
                        <div className="space-y-1.5 px-1 py-1 text-[11.5px]">
                            <div className="flex items-center justify-between text-[var(--app-hint)]">
                                <span>
                                    当前分支：<strong className="font-mono text-[var(--app-fg)]">main</strong>（跟踪 <code className="font-mono">mine/main</code>）
                                </span>
                                <span className="font-mono text-[11px]">
                                    {props.gitClean ? 'working tree clean' : '2 modified · +48 -12'}
                                </span>
                            </div>
                            {!props.gitClean ? (
                                <div className="space-y-1 rounded-lg border border-[var(--app-border)]/60 bg-[var(--app-subtle-bg)]/30 p-2 font-mono text-[11px]">
                                    <div className="flex items-center justify-between">
                                        <span className="truncate text-[var(--app-fg)]">M web/src/components/AssistantChat/HappyComposer.tsx</span>
                                        <span className="shrink-0 space-x-1">
                                            <span className="text-[var(--app-badge-success-text)]">+36</span>
                                            <span className="text-[var(--app-badge-error-text)]">-8</span>
                                        </span>
                                    </div>
                                    <div className="flex items-center justify-between">
                                        <span className="truncate text-[var(--app-fg)]">M web/src/components/AssistantChat/StatusBar.tsx</span>
                                        <span className="shrink-0 space-x-1">
                                            <span className="text-[var(--app-badge-success-text)]">+12</span>
                                            <span className="text-[var(--app-badge-error-text)]">-4</span>
                                        </span>
                                    </div>
                                </div>
                            ) : null}
                        </div>
                    ) : null}
                </div>
            ) : null}
        </div>
    )
}

function ComposerExternalControlsStudio(props: {
    variant: ComposerDemoVariant
    onVariantChange: (v: ComposerDemoVariant) => void
    plusPlacement: 'outside' | 'inside'
    onPlusPlacementChange: (p: 'outside' | 'inside') => void
    selectedModel: string
    onSelectModel: (m: string) => void
    selectedEffort: string
    onSelectEffort: (e: string) => void
    selectedMode: string
    onSelectMode: (m: string) => void
}) {
    const [viewLayout, setViewLayout] = useState<ComposerDemoViewLayout>('side-by-side')
    const [stateMode, setStateMode] = useState<ComposerDemoStateMode>('idle')
    const [radiusClass, setRadiusClass] = useState<string>('rounded-[20px]')
    const [gitClean, setGitClean] = useState<boolean>(false)
    const [draftText, setDraftText] = useState<string>('')
    const [contextPercent, setContextPercent] = useState<number>(55)

    const handleStateModeChange = (mode: ComposerDemoStateMode) => {
        setStateMode(mode)
        if (mode === 'typing' && !draftText) {
            setDraftText('帮我把输入框底部的模型、推理强度和模式选项移到输入框外面下方，保持输入区域纯粹干净。')
        } else if (mode === 'idle') {
            setDraftText('')
        }
    }

    return (
        <section
            className="rounded-2xl border-2 border-[#da7756]/35 bg-[var(--app-bg)] p-4 sm:p-5 shadow-sm space-y-4"
            data-testid="composer-style-studio"
        >
            {/* Studio Header */}
            <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[var(--app-border)]/70 pb-3.5">
                <div className="space-y-1">
                    <h2 className="text-base font-semibold tracking-tight text-[var(--app-fg)]">
                        Composer 输入框外置选项栏样式工作台（选项下移至输入框外部下方）
                    </h2>
                    <p className="text-xs text-[var(--app-hint)]">
                        输入框左上方保留 <code className="font-mono">online</code> 连接状态与 <code className="inline-flex items-center gap-1 font-mono"><DemoBranchIcon /> main +48 -12</code> Git 状态；模型选择（<code className="font-mono">GPT-5.4 ∨</code>）、推理强度（<code className="font-mono">High ∨</code>）、代理模式（<code className="font-mono">Agent ∨</code>）及上下文使用率（<code className="font-mono">55%</code>）置于输入框外部下方。
                    </p>
                </div>

                {/* View Mode Switcher */}
                <div className="inline-flex items-center rounded-lg border border-[var(--app-border)] bg-[var(--app-subtle-bg)]/50 p-0.5 text-[11.5px]">
                    {(
                        [
                            { id: 'side-by-side', label: '新旧同屏对比 (vs 当前 HAPI)' },
                            { id: 'single', label: '单栏大图预览' },
                            { id: 'grid', label: '4 种方案全景对比' },
                        ] as const
                    ).map((tab) => (
                        <button
                            key={tab.id}
                            type="button"
                            onClick={() => setViewLayout(tab.id)}
                            className={cn(
                                'rounded-md px-2.5 py-1 font-medium transition-colors',
                                viewLayout === tab.id
                                    ? 'bg-[var(--app-bg)] text-[var(--app-fg)] shadow-xs'
                                    : 'text-[var(--app-hint)] hover:text-[var(--app-fg)]'
                            )}
                        >
                            {tab.label}
                        </button>
                    ))}
                </div>
            </div>

            {/* Variant & Fine-Tuning Control Strip */}
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--app-border)]/80 bg-[var(--app-subtle-bg)]/25 px-3.5 py-2.5 text-xs">
                {/* Variant Selector */}
                <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[11.5px] font-medium text-[var(--app-hint)] mr-1">外置布局方案：</span>
                    {(
                        [
                            { id: 'c1-reference', label: '方案 C1 · 复刻参考图（左上 online+Git · 左下 + / Agent / Model / Effort · 右下 55%）' },
                            { id: 'c2-balanced', label: '方案 C2 · 双侧工具分栏（左上 online+Git · 左下模式与模型 · 右下工具与 55%）' },
                            { id: 'c3-pills', label: '方案 C3 · 外置微边框胶囊芯片（左上 online+Git · 下方胶囊按钮）' },
                        ] as const
                    ).map((v) => (
                        <button
                            key={v.id}
                            type="button"
                            data-testid={`select-composer-${v.id}`}
                            onClick={() => props.onVariantChange(v.id)}
                            className={cn(
                                'rounded-lg border px-2.5 py-1 text-[11.5px] font-medium transition-all',
                                props.variant === v.id
                                    ? 'border-[#da7756] bg-[#da7756]/12 text-[var(--app-fg)] shadow-2xs'
                                    : 'border-[var(--app-border)] bg-[var(--app-bg)] text-[var(--app-hint)] hover:text-[var(--app-fg)]'
                            )}
                        >
                            {v.label}
                        </button>
                    ))}
                </div>

                {/* Fine-tuning toggles */}
                <div className="flex flex-wrap items-center gap-2">
                    {/* Plus icon placement */}
                    <div className="inline-flex items-center rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] p-0.5 text-[11px]">
                        <button
                            type="button"
                            onClick={() => props.onPlusPlacementChange('outside')}
                            className={cn(
                                'rounded px-2 py-0.5 font-medium transition-colors',
                                props.plusPlacement === 'outside'
                                    ? 'bg-[var(--app-subtle-bg)] text-[var(--app-fg)]'
                                    : 'text-[var(--app-hint)]'
                            )}
                        >
                            + 在框外左下
                        </button>
                        <button
                            type="button"
                            onClick={() => props.onPlusPlacementChange('inside')}
                            className={cn(
                                'rounded px-2 py-0.5 font-medium transition-colors',
                                props.plusPlacement === 'inside'
                                    ? 'bg-[var(--app-subtle-bg)] text-[var(--app-fg)]'
                                    : 'text-[var(--app-hint)]'
                            )}
                        >
                            + 在框内左侧
                        </button>
                    </div>

                    {/* State Mode */}
                    <div className="inline-flex items-center rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] p-0.5 text-[11px]">
                        {(
                            [
                                { id: 'idle', label: '空状态' },
                                { id: 'typing', label: '输入中' },
                                { id: 'attachments', label: '含附件' },
                                { id: 'streaming', label: '运行中' },
                            ] as const
                        ).map((st) => (
                            <button
                                key={st.id}
                                type="button"
                                onClick={() => handleStateModeChange(st.id)}
                                className={cn(
                                    'rounded px-2 py-0.5 font-medium transition-colors',
                                    stateMode === st.id
                                        ? 'bg-[var(--app-subtle-bg)] text-[var(--app-fg)]'
                                        : 'text-[var(--app-hint)]'
                                )}
                            >
                                {st.label}
                            </button>
                        ))}
                    </div>

                    {/* Corner Radius */}
                    <div className="inline-flex items-center rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] p-0.5 text-[11px]">
                        {(
                            [
                                { cls: 'rounded-[16px]', label: '圆角 16px' },
                                { cls: 'rounded-[20px]', label: '圆角 20px' },
                                { cls: 'rounded-[26px]', label: '圆角 26px' },
                            ] as const
                        ).map((r) => (
                            <button
                                key={r.cls}
                                type="button"
                                onClick={() => setRadiusClass(r.cls)}
                                className={cn(
                                    'rounded px-2 py-0.5 font-medium transition-colors',
                                    radiusClass === r.cls
                                        ? 'bg-[var(--app-subtle-bg)] text-[var(--app-fg)]'
                                        : 'text-[var(--app-hint)]'
                                )}
                            >
                                {r.label}
                            </button>
                        ))}
                    </div>

                    {/* Git status toggle */}
                    <button
                        type="button"
                        onClick={() => setGitClean((v) => !v)}
                        className={cn(
                            'rounded-lg border px-2 py-1 text-[11px] font-medium transition-colors',
                            !gitClean
                                ? 'border-[var(--app-fg)]/40 bg-[var(--app-subtle-bg)] text-[var(--app-fg)]'
                                : 'border-[var(--app-border)] bg-[var(--app-bg)] text-[var(--app-hint)]'
                        )}
                    >
                        {gitClean ? 'Git: clean（点击切换有改动）' : 'Git: +48 -12 · 2 files'}
                    </button>
                </div>
            </div>

            {/* Main Interactive Preview Canvas */}
            {viewLayout === 'side-by-side' ? (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 items-end">
                    {/* Left: Selected External-Controls Design */}
                    <div className="rounded-xl border border-[#da7756]/40 bg-[var(--app-subtle-bg)]/15 p-4 sm:p-5 space-y-3">
                        <div className="flex items-center justify-between text-xs">
                            <div className="flex items-center gap-2">
                                <span className="inline-block h-2 w-2 rounded-full bg-[#da7756]" />
                                <span className="font-semibold text-[var(--app-fg)]">
                                    新方案：选项外置在输入框下方（点击下方选项可弹出菜单）
                                </span>
                            </div>
                            <span className="font-mono text-[11px] text-[#da7756]">
                                {props.variant === 'c1-reference'
                                    ? 'C1 · 复刻参考图'
                                    : props.variant === 'c2-balanced'
                                        ? 'C2 · 双侧平衡'
                                        : 'C3 · 胶囊芯片'}
                            </span>
                        </div>

                        <div className="pt-2">
                            <ComposerPreviewCard
                                variant={props.variant}
                                plusPlacement={props.plusPlacement}
                                stateMode={stateMode}
                                radiusClass={radiusClass}
                                draftText={draftText}
                                onDraftChange={setDraftText}
                                selectedModel={props.selectedModel}
                                onSelectModel={props.onSelectModel}
                                selectedEffort={props.selectedEffort}
                                onSelectEffort={props.onSelectEffort}
                                selectedMode={props.selectedMode}
                                onSelectMode={props.onSelectMode}
                                contextPercent={contextPercent}
                                gitClean={gitClean}
                                interactiveMenus={true}
                            />
                        </div>
                    </div>

                    {/* Right: Current HAPI Composer (Baseline C0) */}
                    <div className="rounded-xl border border-[var(--app-border)]/80 bg-[var(--app-subtle-bg)]/15 p-4 sm:p-5 space-y-3 opacity-90">
                        <div className="flex items-center justify-between text-xs">
                            <div className="flex items-center gap-2">
                                <span className="inline-block h-2 w-2 rounded-full bg-[var(--app-hint)]" />
                                <span className="font-medium text-[var(--app-hint)]">
                                    当前 HAPI 样式（顶栏 StatusBar + 框内底部拥挤工具栏）
                                </span>
                            </div>
                            <span className="font-mono text-[11px] text-[var(--app-hint)]">
                                C0 · Baseline
                            </span>
                        </div>

                        <ComposerPreviewCard
                            variant="c0-current"
                            plusPlacement="inside"
                            stateMode={stateMode}
                            radiusClass={radiusClass}
                            draftText={draftText}
                            onDraftChange={setDraftText}
                            selectedModel={props.selectedModel}
                            onSelectModel={props.onSelectModel}
                            selectedEffort={props.selectedEffort}
                            onSelectEffort={props.onSelectEffort}
                            selectedMode={props.selectedMode}
                            onSelectMode={props.onSelectMode}
                            contextPercent={contextPercent}
                            gitClean={gitClean}
                            interactiveMenus={false}
                        />
                    </div>
                </div>
            ) : viewLayout === 'single' ? (
                <div className="mx-auto max-w-3xl rounded-xl border border-[#da7756]/40 bg-[var(--app-subtle-bg)]/15 p-6 space-y-3">
                    <div className="flex items-center justify-between text-xs text-[var(--app-hint)]">
                        <span className="font-medium text-[var(--app-fg)]">
                            单栏沉浸预览（可直接打字或点击下方 `Agent ∨` / `GPT-5.4 ∨` / `High ∨` / `55%` 交互）
                        </span>
                        <div className="flex items-center gap-2">
                            <span>上下文占比模拟：</span>
                            {[28, 55, 78, 94].map((pct) => (
                                <button
                                    key={pct}
                                    type="button"
                                    onClick={() => setContextPercent(pct)}
                                    className={cn(
                                        'rounded px-1.5 py-0.5 font-mono text-[11px]',
                                        contextPercent === pct
                                            ? 'bg-[var(--app-fg)] text-[var(--app-bg)]'
                                            : 'bg-[var(--app-subtle-bg)] text-[var(--app-hint)]'
                                    )}
                                >
                                    {pct}%
                                </button>
                            ))}
                        </div>
                    </div>
                    <ComposerPreviewCard
                        variant={props.variant}
                        plusPlacement={props.plusPlacement}
                        stateMode={stateMode}
                        radiusClass={radiusClass}
                        draftText={draftText}
                        onDraftChange={setDraftText}
                        selectedModel={props.selectedModel}
                        onSelectModel={props.onSelectModel}
                        selectedEffort={props.selectedEffort}
                        onSelectEffort={props.onSelectEffort}
                        selectedMode={props.selectedMode}
                        onSelectMode={props.onSelectMode}
                        contextPercent={contextPercent}
                        gitClean={gitClean}
                        interactiveMenus={true}
                    />
                </div>
            ) : (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                    {(
                        [
                            {
                                id: 'c1-reference' as const,
                                title: '方案 C1 · 复刻参考图（左下 + / Agent / Model / Effort · 右下 55%）',
                            },
                            {
                                id: 'c2-balanced' as const,
                                title: '方案 C2 · 双侧平衡（框内左 + · 左下环境 · 右下模型与 55%）',
                            },
                            {
                                id: 'c3-pills' as const,
                                title: '方案 C3 · 外置微边框胶囊芯片（触控屏友好）',
                            },
                            {
                                id: 'c0-current' as const,
                                title: '对比基线 C0 · 当前 HAPI（顶栏 StatusBar + 框内底部工具栏）',
                            },
                        ]
                    ).map((item) => (
                        <div
                            key={item.id}
                            className={cn(
                                'rounded-xl border p-4 space-y-3',
                                props.variant === item.id
                                    ? 'border-[#da7756] bg-[#da7756]/5'
                                    : 'border-[var(--app-border)]/80 bg-[var(--app-subtle-bg)]/15'
                            )}
                        >
                            <div className="flex items-center justify-between text-xs">
                                <span className="font-semibold text-[var(--app-fg)]">{item.title}</span>
                                {item.id !== 'c0-current' ? (
                                    <button
                                        type="button"
                                        onClick={() => props.onVariantChange(item.id)}
                                        className="rounded border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-0.5 text-[11px] text-[var(--app-hint)] hover:text-[var(--app-fg)]"
                                    >
                                        {props.variant === item.id ? '当前选中 ✓' : '设为选中'}
                                    </button>
                                ) : null}
                            </div>
                            <ComposerPreviewCard
                                variant={item.id}
                                plusPlacement={props.plusPlacement}
                                stateMode={stateMode}
                                radiusClass={radiusClass}
                                draftText={draftText}
                                onDraftChange={setDraftText}
                                selectedModel={props.selectedModel}
                                onSelectModel={props.onSelectModel}
                                selectedEffort={props.selectedEffort}
                                onSelectEffort={props.onSelectEffort}
                                selectedMode={props.selectedMode}
                                onSelectMode={props.onSelectMode}
                                contextPercent={contextPercent}
                                gitClean={gitClean}
                                interactiveMenus={item.id !== 'c0-current'}
                            />
                        </div>
                    ))}
                </div>
            )}
        </section>
    )
}


export function TurnTimelineDemo() {
    const [stage, setStage] = useState<DemoLifecycleStage>('working-step-3')
    const [layoutMode, setLayoutMode] = useState<'side-by-side' | 'timeline-only'>('side-by-side')
    const [viewMode, setViewMode] = useState<TranscriptViewMode>('normal')
    const [lang, setLang] = useState<'en' | 'zh-CN'>('zh-CN')
    const [autoPlaying, setAutoPlaying] = useState(false)
    const [submittedAnswers, setSubmittedAnswers] = useState<Record<string, string> | null>(null)
    const [todoShowcaseState, setTodoShowcaseState] = useState<'running' | 'completed' | 'multi'>('running')

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
    const [showSpecTable, setShowSpecTable] = useState(true)
    const [indicatorVariant] = useState<TurnActivityIndicatorVariant>('equalizer-bars')
    const [indicatorColor, setIndicatorColor] = useState<string>('#da7756')
    const [activeToolIdx, setActiveToolIdx] = useState<number>(0)
    const [composerVariant, setComposerVariant] = useState<ComposerDemoVariant>('c2-balanced')
    const [composerPlusPlacement, setComposerPlusPlacement] = useState<'outside' | 'inside'>('inside')
    const [composerModel, setComposerModel] = useState<string>('gpt-5.4')
    const [composerEffort, setComposerEffort] = useState<string>('high')
    const [composerMode, setComposerMode] = useState<string>('agent')
    const [dockedDraft, setDockedDraft] = useState<string>('')

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
                {/* Interactive Composer External-Controls Style Studio */}
                <ComposerExternalControlsStudio
                    variant={composerVariant}
                    onVariantChange={setComposerVariant}
                    plusPlacement={composerPlusPlacement}
                    onPlusPlacementChange={setComposerPlusPlacement}
                    selectedModel={composerModel}
                    onSelectModel={setComposerModel}
                    selectedEffort={composerEffort}
                    onSelectEffort={setComposerEffort}
                    selectedMode={composerMode}
                    onSelectMode={setComposerMode}
                />

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

                {/* Updated Todos Card Redesign Showcase */}
                <section
                    className="rounded-2xl border border-[var(--app-border)] bg-[var(--app-bg)] p-4 sm:p-5 shadow-xs space-y-4"
                    data-testid="todo-card-redesign-showcase"
                >
                    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--app-border)]/70 pb-3">
                        <div>
                            <div className="flex items-center gap-2">
                                <span className="inline-block h-2.5 w-2.5 rounded-full bg-[#10b981]" />
                                <h2 className="text-sm font-semibold text-[var(--app-fg)]">
                                    Updated Todos 任务卡片新样式预览（进行中转圈 → 完成后打勾）
                                </h2>
                            </div>
                            <p className="mt-0.5 text-xs text-[var(--app-hint)]">
                                自动将回合内的 <code className="font-mono">todo</code> / <code className="font-mono">TodoWrite</code> 渲染为独立圆角任务卡片，并自动折叠同一回合内被后续覆盖的历史快照与已恢复错误。
                            </p>
                        </div>
                        <div className="inline-flex items-center rounded-lg border border-[var(--app-border)] bg-[var(--app-subtle-bg)]/50 p-0.5">
                            {(
                                [
                                    { id: 'running', label: '1. 进行中（转圈）' },
                                    { id: 'completed', label: '2. 已完成（折叠打勾）' },
                                    { id: 'multi', label: '3. 多任务流转态' },
                                ] as const
                            ).map((tab) => (
                                <button
                                    key={tab.id}
                                    type="button"
                                    onClick={() => setTodoShowcaseState(tab.id)}
                                    className={cn(
                                        'rounded-md px-2.5 py-1 text-[11.5px] font-medium transition-colors',
                                        todoShowcaseState === tab.id
                                            ? 'bg-[var(--app-bg)] text-[var(--app-fg)] shadow-xs'
                                            : 'text-[var(--app-hint)] hover:text-[var(--app-fg)]'
                                    )}
                                >
                                    {tab.label}
                                </button>
                            ))}
                        </div>
                    </div>

                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
                        {/* Left: Interactive single turn switching between running & completed */}
                        <div className="rounded-xl border border-[var(--app-border)]/80 bg-[var(--app-subtle-bg)]/20 p-4 space-y-2.5">
                            <div className="flex items-center justify-between text-xs text-[var(--app-hint)]">
                                <span className="font-medium text-[var(--app-fg)]">
                                    交互预览（点击右上角按钮切换流转态）
                                </span>
                                <span className="font-mono text-[11px]">
                                    {todoShowcaseState === 'running'
                                        ? 'status = in_progress (spinner)'
                                        : todoShowcaseState === 'completed'
                                            ? 'status = completed (check)'
                                            : 'completed + in_progress + pending'}
                                </span>
                            </div>
                            <TimelineTurnBlockView
                                partition={
                                    todoShowcaseState === 'running'
                                        ? todoShowcaseRunningPartition
                                        : todoShowcaseState === 'completed'
                                            ? todoShowcaseCompletedPartition
                                            : todoShowcaseMultiPartition
                                }
                                streaming={todoShowcaseState !== 'completed'}
                                durationMs={todoShowcaseState === 'completed' ? 8400 : 3200}
                                initiallyOpen={todoShowcaseState !== 'completed'}
                                viewMode={viewMode}
                                lang="zh-CN"
                                indicatorColor={indicatorColor}
                            />
                        </div>

                        {/* Right: Side-by-side static comparison of Running vs Completed */}
                        <div className="rounded-xl border border-[var(--app-border)]/80 bg-[var(--app-subtle-bg)]/20 p-4 space-y-4">
                            <div className="space-y-1.5">
                                <div className="text-[11.5px] font-medium text-[var(--app-hint)]">
                                    A. 正在进行时（圆角卡片 + 左侧旋转圆弧）：
                                </div>
                                <TimelineTurnBlockView
                                    partition={todoShowcaseRunningPartition}
                                    streaming={true}
                                    durationMs={3200}
                                    initiallyOpen={false}
                                    viewMode={viewMode}
                                    lang="zh-CN"
                                    indicatorColor={indicatorColor}
                                />
                            </div>
                            <div className="border-t border-[var(--app-border)]/60 pt-3 space-y-1.5">
                                <div className="text-[11.5px] font-medium text-[var(--app-hint)]">
                                    B. 回合完成后（自动折叠导轨 + 卡片实心圆打勾）：
                                </div>
                                <TimelineTurnBlockView
                                    partition={todoShowcaseCompletedPartition}
                                    streaming={false}
                                    durationMs={8400}
                                    initiallyOpen={false}
                                    viewMode={viewMode}
                                    lang="zh-CN"
                                    indicatorColor={indicatorColor}
                                />
                            </div>
                        </div>
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
                            {/* Top-Left Status Row: online + git status above Docked Todo / Input Box */}
                            <div className="flex items-center justify-between px-2 pb-1.5 text-[11.5px]">
                                <div className="flex flex-wrap items-center gap-2">
                                    <span className="inline-flex items-center gap-1.5 text-[var(--app-badge-success-text)]">
                                        <span
                                            className={cn(
                                                'h-2 w-2 rounded-full bg-current',
                                                (stageData.streaming || stageData.followUpStreaming) && 'animate-pulse'
                                            )}
                                        />
                                        <span>
                                            {stageData.streaming || stageData.followUpStreaming ? 'responding...' : 'online'}
                                        </span>
                                    </span>
                                    <span className="text-[var(--app-border)]" aria-hidden="true">·</span>
                                    <span className="inline-flex items-center gap-1.5 font-mono text-[11px] text-[var(--app-hint)]">
                                        <span className="inline-flex items-center gap-1 text-[var(--app-fg)]/85">
                                            <DemoBranchIcon />
                                            <span>main</span>
                                        </span>
                                        <span className="inline-flex items-center gap-1 font-medium">
                                            <span className="text-[var(--app-badge-success-text)]">+48</span>
                                            <span className="text-[var(--app-badge-error-text)]">-12</span>
                                        </span>
                                        <span className="text-[10.5px] text-[var(--app-hint)]">· 2 files</span>
                                    </span>
                                </div>
                            </div>

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
                            {/* Input Box (Docked under Todo bar) */}
                            <div className="rounded-b-2xl border border-[var(--app-border)] bg-[var(--app-bg)] px-3.5 py-2.5 shadow-2xs">
                                <div className="flex items-center justify-between gap-2">
                                    {composerPlusPlacement === 'inside' ? (
                                        <button
                                            type="button"
                                            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
                                            title="添加附件 (+)"
                                        >
                                            <DemoPlusIcon />
                                        </button>
                                    ) : null}
                                    <input
                                        type="text"
                                        value={dockedDraft}
                                        onChange={(e) => setDockedDraft(e.target.value)}
                                        placeholder={
                                            stageData.streaming || stageData.followUpStreaming
                                                ? (lang === 'zh-CN'
                                                    ? '↵ 发送，⌘↵ 排队等待稍后执行…'
                                                    : '↵ to send, ⌘↵ to queue for later...')
                                                : 'Ask anything, @ to mention, / for skills...'
                                        }
                                        className="min-w-0 flex-1 bg-transparent text-[13px] text-[var(--app-fg)] placeholder-[var(--app-hint)] focus:outline-none"
                                    />
                                    <div className="flex shrink-0 items-center gap-1.5">
                                        <span className="rounded border border-[var(--app-border)] px-1.5 py-0.5 text-[10.5px] font-mono text-[var(--app-hint)]">
                                            Ctrl+O: {viewMode}
                                        </span>
                                        {stageData.streaming || stageData.followUpStreaming ? (
                                            <button
                                                type="button"
                                                data-testid="demo-stop-running-btn"
                                                onClick={() => setStage('completed')}
                                                title={lang === 'zh-CN' ? '停止当前运行 (Esc)' : 'Stop (Esc)'}
                                                className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-[var(--app-fg)] text-[var(--app-bg)] hover:opacity-90"
                                            >
                                                <span className="h-2 w-2 rounded-[1.5px] bg-current" />
                                            </button>
                                        ) : (
                                            <button
                                                type="button"
                                                title={lang === 'zh-CN' ? '发送消息 (Enter)' : 'Send (Enter)'}
                                                className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-[var(--app-fg)] text-[var(--app-bg)] hover:opacity-90"
                                            >
                                                <DemoSendArrowIcon />
                                            </button>
                                        )}
                                    </div>
                                </div>
                            </div>

                            {/* External Options Bar Below Input Box */}
                            <div className="mt-2 flex flex-wrap items-center justify-between gap-2 px-1 text-[11.5px] text-[var(--app-hint)]">
                                <div className="flex flex-wrap items-center gap-1.5">
                                    {composerPlusPlacement === 'outside' ? (
                                        <button
                                            type="button"
                                            className="inline-flex h-6 w-6 items-center justify-center rounded-md hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
                                            title="添加附件 (+)"
                                        >
                                            <DemoPlusIcon />
                                        </button>
                                    ) : null}
                                    <button
                                        type="button"
                                        className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-medium text-[var(--app-fg)]/80 hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
                                    >
                                        <DemoAgentModeIcon />
                                        <span>{COMPOSER_MODES.find((m) => m.id === composerMode)?.label ?? 'Agent'}</span>
                                        <DemoChevronDownIcon />
                                    </button>
                                    <button
                                        type="button"
                                        className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-medium hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
                                    >
                                        <span>{COMPOSER_MODELS.find((m) => m.id === composerModel)?.label ?? 'GPT-5.4'}</span>
                                        <DemoChevronDownIcon />
                                    </button>
                                    <button
                                        type="button"
                                        className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-medium hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
                                    >
                                        <span>{COMPOSER_EFFORTS.find((e) => e.id === composerEffort)?.label ?? 'High'}</span>
                                        <DemoChevronDownIcon />
                                    </button>
                                </div>
                                <div className="flex items-center gap-1 text-[var(--app-hint)]">
                                    <button
                                        type="button"
                                        className="inline-flex h-6 w-6 items-center justify-center rounded-md hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
                                        title="打开终端 (Terminal)"
                                    >
                                        <DemoTerminalIcon />
                                    </button>
                                    <button
                                        type="button"
                                        className="inline-flex h-6 w-6 items-center justify-center rounded-md hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
                                        title="草稿箱 (Scratchlist)"
                                    >
                                        <DemoScratchlistIcon />
                                    </button>
                                    <button
                                        type="button"
                                        className="inline-flex h-6 w-6 items-center justify-center rounded-md hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
                                        title="定时发送 (Schedule)"
                                    >
                                        <DemoClockIcon />
                                    </button>
                                    <span className="mx-0.5 h-3 w-px bg-[var(--app-border)]" aria-hidden="true" />
                                    <div className="flex items-center gap-1.5 px-1 font-mono text-[11px]">
                                        <DemoContextProgressRing percent={55} size={13} />
                                        <span>55%</span>
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
