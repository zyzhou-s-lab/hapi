import type { ReactNode } from 'react'
import type { MessageDeliveryMode } from '@hapi/protocol'
import type { ApiClient } from '@/api/client'
import type { TurnPartition } from '@/components/AssistantChat/messages/turnBlockModel'
import type { ProjectedSubturn } from '@/components/AssistantChat/messages/turnProjection'
import { QueuedMessagesBar } from '@/components/AssistantChat/QueuedMessagesBar'
import type { PendingSchedule } from '@/components/AssistantChat/ScheduleTimePicker'
import { FeatureErrorBoundary } from '@/components/FeatureErrorBoundary'
import { ScratchlistDrawerHost } from '@/components/sessionChatHelpers'
import { TodoPanel } from '@/fork-features/task-panel/TodoPanel'
import type { SendMessageAcceptance } from '@/hooks/mutations/useSendMessage'
import type { ScratchlistEntry } from '@/lib/scratchlist'
import type { AttachmentMetadata, TodoItem } from '@/types/api'

export type ChatSlotDefinition<TCtx> = {
    id: string
    order: number
    visible?: (ctx: TCtx) => boolean
    Component: (props: { ctx: TCtx }) => ReactNode
}

export function defineChatSlots<TCtx>(
    slots: readonly ChatSlotDefinition<TCtx>[]
): readonly ChatSlotDefinition<TCtx>[] {
    return Object.freeze(
        [...slots].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
    )
}

function SlotEntry<TCtx>(props: { slot: ChatSlotDefinition<TCtx>; ctx: TCtx }) {
    if (props.slot.visible && !props.slot.visible(props.ctx)) {
        return null
    }
    return <props.slot.Component ctx={props.ctx} />
}

export function ChatSlotHost<TCtx>(props: {
    slots: readonly ChatSlotDefinition<TCtx>[]
    ctx: TCtx
    resetKey?: string | number
}): ReactNode {
    return (
        <>
            {props.slots.map((slot) => (
                <FeatureErrorBoundary key={slot.id} name={slot.id} resetKey={props.resetKey}>
                    <SlotEntry slot={slot} ctx={props.ctx} />
                </FeatureErrorBoundary>
            ))}
        </>
    )
}

export type TurnSlotContext = {
    subturn: ProjectedSubturn
    partition: TurnPartition
    streaming: boolean
    durationMs: number | null
    streamingStartedAt?: number | null
    open: boolean
    setOpen: (next: boolean) => void
    activeTodoText?: string | null
    fallbackTodos?: readonly TodoItem[] | null
    viewMode: 'normal' | 'thinking' | 'verbose'
    lang: 'en' | 'zh-CN'
    accentColor: string
    renderTrailingText?: (text: string, streaming: boolean) => ReactNode
}

export type ComposerDockSlotContext = {
    sessionId: string
    api: ApiClient
    todos: TodoItem[] | undefined
    sessionThinking: boolean
    scratchlistMode: boolean
    scratchlistEntries: ScratchlistEntry[]
    onScratchlistMove: (id: string, direction: 'up' | 'down') => void | Promise<void>
    onScratchlistDelete: (id: string) => void | Promise<void>
    onSend: (
        text: string,
        attachments?: AttachmentMetadata[],
        scheduledAt?: number | null,
        deliveryMode?: MessageDeliveryMode,
    ) => Promise<boolean | SendMessageAcceptance>
    onExitScratchlistMode: () => void
    scratchlistDisabled: boolean
    pendingSchedule: PendingSchedule | null
    pendingScheduleRevision: number
    onRestorePendingSchedule: (restored: PendingSchedule | null) => void
    canSteer: boolean
}

export const COMPOSER_DOCK_SLOTS = defineChatSlots<ComposerDockSlotContext>([
    {
        id: 'todo-panel',
        order: 10,
        Component: ({ ctx }) => (
            <TodoPanel
                sessionId={ctx.sessionId}
                todos={ctx.todos}
                sessionThinking={ctx.sessionThinking}
            />
        ),
    },
    {
        id: 'scratchlist-drawer',
        order: 20,
        visible: (ctx) => ctx.scratchlistMode,
        Component: ({ ctx }) => (
            <ScratchlistDrawerHost
                sessionId={ctx.sessionId}
                api={ctx.api}
                entries={ctx.scratchlistEntries}
                onMove={ctx.onScratchlistMove}
                onDelete={ctx.onScratchlistDelete}
                onSend={ctx.onSend}
                onExitScratchlistMode={ctx.onExitScratchlistMode}
                disabled={ctx.scratchlistDisabled}
            />
        ),
    },
    {
        id: 'queued-messages-bar',
        order: 30,
        Component: ({ ctx }) => (
            <QueuedMessagesBar
                sessionId={ctx.sessionId}
                api={ctx.api}
                pendingSchedule={ctx.pendingSchedule}
                pendingScheduleRevision={ctx.pendingScheduleRevision}
                onEdit={({ pendingSchedule: restored }) => {
                    ctx.onRestorePendingSchedule(restored)
                }}
                canSteer={ctx.canSteer}
            />
        ),
    },
])
