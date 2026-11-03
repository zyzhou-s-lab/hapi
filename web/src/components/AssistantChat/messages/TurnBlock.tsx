import { useEffect, useRef, useState } from 'react'
import { TextMessagePartProvider, useAuiState } from '@assistant-ui/react'
import { formatDuration } from '@/chat/presentation'
import type { ToolCallBlock } from '@/chat/types'
import { useOptionalHappyChatContext } from '@/components/AssistantChat/context'
import { NotifySummaryText } from '@/components/AssistantChat/messages/NotifySummaryText'
import { GeneratedFileCard, GeneratedImageCard } from '@/components/AssistantChat/messages/ToolMessage'
import { partitionTurn, turnDurationMs, type TurnContentPart, type TurnPartition, type TurnRow, type TurnToolRow } from '@/components/AssistantChat/messages/turnBlockModel'
import { PermissionFooter } from '@/components/ToolCard/PermissionFooter'
import { AskUserQuestionFooter } from '@/components/ToolCard/AskUserQuestionFooter'
import { RequestUserInputFooter } from '@/components/ToolCard/RequestUserInputFooter'
import { isAskUserQuestionToolName } from '@/components/ToolCard/askUserQuestion'
import { isRequestUserInputToolName } from '@/components/ToolCard/requestUserInput'
import { ToolDetailDialogContent } from '@/components/ToolCard/ToolCard'
import { extractImagesFromResult } from '@/components/ToolCard/views/_results'
import { useReasoningCollapse } from '@/hooks/useReasoningCollapse'
import type { HappyChatMessageMetadata } from '@/lib/assistant-runtime'
import { useTranslation } from '@/lib/use-translation'
import { cn } from '@/lib/utils'

function contentParts(content: readonly { type: string }[]): TurnContentPart[] {
    return content.flatMap((part): TurnContentPart[] => {
        if (part.type === 'text' || part.type === 'reasoning') {
            const text = 'text' in part && typeof part.text === 'string' ? part.text : ''
            const status = 'status' in part && part.status && typeof part.status === 'object'
                ? part.status as { type?: string }
                : undefined
            return [{ type: part.type, text, status }]
        }
        if (part.type !== 'tool-call') return []
        const tool = part as {
            toolCallId?: string
            toolName?: string
            result?: unknown
            isError?: boolean
            artifact?: unknown
            status?: { type?: string }
        }
        return [{
            type: 'tool-call',
            toolCallId: tool.toolCallId,
            toolName: tool.toolName,
            result: tool.result,
            isError: tool.isError,
            artifact: tool.artifact,
            status: tool.status,
        }]
    })
}

function Chevron(props: { open: boolean }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={cn('shrink-0 transition-transform duration-200', props.open ? 'rotate-90' : '')}
            aria-hidden="true"
        >
            <polyline points="9 18 15 12 9 6" />
        </svg>
    )
}

function PermissionButtons(props: { block: ToolCallBlock }) {
    const ctx = useOptionalHappyChatContext()
    const { t } = useTranslation()
    const permission = props.block.tool.permission
    const [busy, setBusy] = useState<'allow' | 'deny' | null>(null)
    const [failed, setFailed] = useState(false)
    if (!permission || permission.status !== 'pending' || !ctx) return null

    const run = (decision: 'allow' | 'deny') => {
        if (busy || ctx.disabled) return
        setBusy(decision)
        setFailed(false)
        const request = decision === 'allow'
            ? ctx.api.approvePermission(ctx.sessionId, permission.id)
            : ctx.api.denyPermission(ctx.sessionId, permission.id)
        void request.then(() => {
            ctx.onRefresh()
        }).catch(() => {
            setFailed(true)
        }).finally(() => {
            setBusy(null)
        })
    }

    return (
        <div className="flex shrink-0 items-center gap-1.5">
            <button
                type="button"
                className="min-h-11 rounded-full bg-[var(--app-tool-card-bg)] px-3 text-sm font-medium text-[var(--app-badge-success-text)] disabled:opacity-50"
                disabled={ctx.disabled || busy !== null}
                onClick={() => run('allow')}
            >
                {t('tool.allow')}
            </button>
            <button
                type="button"
                className="min-h-11 rounded-full bg-[var(--app-tool-card-bg)] px-3 text-sm font-medium text-[var(--app-badge-error-text)] disabled:opacity-50"
                disabled={ctx.disabled || busy !== null}
                onClick={() => run('deny')}
            >
                {t('tool.deny')}
            </button>
            {failed ? <span className="text-xs text-[var(--app-badge-error-text)]">{t('turn.permissionFailed')}</span> : null}
        </div>
    )
}

function TurnText(props: { text: string; streaming: boolean }) {
    return (
        <TextMessagePartProvider text={props.text} isRunning={props.streaming}>
            <NotifySummaryText type="text" text={props.text} status={{ type: props.streaming ? 'running' : 'complete' }} />
        </TextMessagePartProvider>
    )
}

function ToolStep(props: { row: TurnToolRow }) {
    const ctx = useOptionalHappyChatContext()
    const { t } = useTranslation()
    const [open, setOpen] = useState(false)
    const asks = isAskUserQuestionToolName(props.row.block.tool.name)
    const requestsInput = isRequestUserInputToolName(props.row.block.tool.name)
    const interactive = Boolean((asks || requestsInput) && props.row.permission && ctx)
    const images = extractImagesFromResult(props.row.block.tool.result)
    const thumb = images[0]
    return (
        <div data-hapi-share-exclude="true">
            <div className="flex min-h-11 items-center gap-3 px-4 py-2">
                <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-2 text-left text-[15px] leading-6"
                    aria-expanded={open}
                    onClick={() => setOpen((value) => !value)}
                >
                    {props.row.error ? <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--app-badge-error-text)]" /> : null}
                    <span className={cn('shrink-0', props.row.error ? 'text-[var(--app-badge-error-text)]' : 'text-[var(--app-hint)]')}>{t(props.row.verb)}</span>
                    {props.row.intent ? <span className="min-w-0 flex-1 truncate font-medium text-[var(--app-fg)]">{props.row.intent}</span> : <span className="min-w-0 flex-1" />}
                    {thumb ? <img src={thumb} alt="" className="h-10 w-10 shrink-0 rounded-md border border-[var(--app-border)] object-cover" /> : null}
                    <Chevron open={open} />
                </button>
                {props.row.permission && !open && !interactive ? <PermissionButtons block={props.row.block} /> : null}
            </div>
            {interactive && ctx ? (
                <div className="px-4 pb-3">
                    {asks ? (
                        <AskUserQuestionFooter
                            api={ctx.api}
                            sessionId={ctx.sessionId}
                            tool={props.row.block.tool}
                            disabled={ctx.disabled}
                            onDone={ctx.onRefresh}
                        />
                    ) : (
                        <RequestUserInputFooter
                            api={ctx.api}
                            sessionId={ctx.sessionId}
                            tool={props.row.block.tool}
                            disabled={ctx.disabled}
                            onDone={ctx.onRefresh}
                        />
                    )}
                </div>
            ) : null}
            {open && !interactive ? (
                <div className="px-4 pb-3">
                    <ToolDetailDialogContent block={props.row.block} metadata={ctx?.metadata ?? null} hideTiming />
                    {props.row.permission && ctx ? (
                        <PermissionFooter
                            api={ctx.api}
                            sessionId={ctx.sessionId}
                            metadata={ctx.metadata}
                            tool={props.row.block.tool}
                            disabled={ctx.disabled}
                            onDone={ctx.onRefresh}
                        />
                    ) : null}
                </div>
            ) : null}
        </div>
    )
}

function Step(props: { row: TurnRow; folded: boolean; keepVisible: boolean }) {
    const quiet = !props.keepVisible
        && props.row.kind !== 'image'
        && props.row.kind !== 'file'
        && !(props.row.kind === 'tool' && props.row.pinned)
    if (props.row.kind === 'text' && props.row.trailing) return null
    return (
        <div className={cn(quiet && props.folded && 'hidden')} data-hapi-turn-quiet={quiet ? 'true' : undefined}>
            {props.row.kind === 'text' ? (
                <div className="px-4 py-3 text-[15px] leading-6 text-[var(--app-fg)]">
                    <TurnText text={props.row.text} streaming={false} />
                </div>
            ) : null}
            {props.row.kind === 'reasoning' ? (
                <div data-hapi-share-exclude="true" className="px-4 py-3 text-[15px] leading-6 text-[var(--app-fg)]">{props.row.text}</div>
            ) : null}
            {props.row.kind === 'tool' ? <ToolStep row={props.row} /> : null}
            {props.row.kind === 'image' ? (
                <div className="px-4 py-3"><GeneratedImageCard block={props.row.block} /></div>
            ) : null}
            {props.row.kind === 'file' ? (
                <div className="px-4 py-3"><GeneratedFileCard block={props.row.block} /></div>
            ) : null}
        </div>
    )
}

export function TurnBlockView(props: {
    partition: TurnPartition
    streaming: boolean
    durationMs: number | null
    initiallyOpen: boolean
}) {
    const { t } = useTranslation()
    const [open, setOpen] = useState(props.initiallyOpen)
    const sawStream = useRef(props.streaming)

    useEffect(() => {
        if (sawStream.current && !props.streaming) setOpen(false)
        sawStream.current = props.streaming
    }, [props.streaming])

    const trailing = props.partition.rows.filter((row): row is Extract<TurnRow, { kind: 'text' }> => row.kind === 'text' && row.trailing)
    if (!props.partition.hasActivity) {
        if (trailing.length === 0) return null
        return (
            <>
                {trailing.map((row) => (
                    <div key={row.key} className="mt-3">
                        <TurnText text={row.text} streaming={props.streaming} />
                    </div>
                ))}
            </>
        )
    }

    const failed = props.partition.rows.some((row) => row.kind === 'tool' && row.error && row.pinned)
    const hasSteps = props.partition.rows.some((row) => row.kind === 'reasoning' || row.kind === 'tool')
    const durationMs = props.durationMs
    const steps = props.partition.rows.map((row, index) => {
        const keepVisible = row.kind === 'text' && props.partition.rows.slice(index + 1).some((later) => later.kind === 'image' || later.kind === 'file')
        return <Step key={row.key} row={row} folded={hasSteps && !open} keepVisible={keepVisible} />
    })

    if (!hasSteps) {
        return (
            <div className="my-3">
                {steps}
                {trailing.map((row) => (
                    <div key={row.key} className="mt-3">
                        <TurnText text={row.text} streaming={props.streaming} />
                    </div>
                ))}
            </div>
        )
    }

    return (
        <div className="my-3">
            <div className="divide-y divide-[var(--app-divider)] overflow-hidden rounded-2xl border border-[var(--app-border)]" data-hapi-turn-block-list="true">
                <button
                    type="button"
                    className="flex min-h-11 w-full items-center gap-1.5 bg-transparent px-4 py-2.5 text-left text-xs font-medium text-[var(--app-hint)]"
                    aria-expanded={open}
                    onClick={() => setOpen((value) => !value)}
                >
                    <Chevron open={open} />
                    <span className={cn('inline-block h-1.5 w-1.5 shrink-0 rounded-full', failed ? 'bg-[var(--app-badge-error-text)]' : 'bg-current', props.streaming && 'animate-pulse')} />
                    <span className="min-w-0 flex-1 truncate">{t(props.partition.title)}</span>
                    {durationMs != null && durationMs > 0 ? <span className="shrink-0 font-normal tabular-nums">{formatDuration(durationMs)}</span> : null}
                </button>
                {steps}
            </div>
            {trailing.map((row) => (
                <div key={row.key} className="mt-3">
                    <TurnText text={row.text} streaming={props.streaming} />
                </div>
            ))}
        </div>
    )
}

export function TurnBlock() {
    const ctx = useOptionalHappyChatContext()
    const { reasoningCollapsed } = useReasoningCollapse()
    const content = useAuiState((state) => state.message.role === 'assistant' ? state.message.content : [])
    const streaming = useAuiState((state) => state.message.status?.type === 'running')
    const createdAt = useAuiState((state) => state.message.createdAt.getTime())
    const custom = useAuiState((state) => state.message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined)
    const partition = partitionTurn(contentParts(content), ctx?.metadata ?? null)
    const [now, setNow] = useState(() => Date.now())

    useEffect(() => {
        if (!streaming) return
        const timer = window.setInterval(() => setNow(Date.now()), 1000)
        return () => window.clearInterval(timer)
    }, [streaming])

    return (
        <TurnBlockView
            partition={partition}
            streaming={streaming}
            initiallyOpen={streaming && !reasoningCollapsed}
            durationMs={turnDurationMs({
                roundSummary: custom?.roundSummary,
                invokedAt: custom?.invokedAt,
                createdAt,
                now,
                streaming,
            })}
        />
    )
}

export function messageHasTurnActivity(content: readonly { type: string }[]): boolean {
    return partitionTurn(contentParts(content), null).hasActivity
}
