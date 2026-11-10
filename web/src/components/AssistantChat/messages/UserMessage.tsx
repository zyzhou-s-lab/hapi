import { useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { MessagePrimitive, useAuiState, type TextMessagePart } from '@assistant-ui/react'
import { useHappyChatStaticContext, useOptionalHappyChatSessionStateContext } from '@/components/AssistantChat/context'
import { useOptionalSessionEntityStore, useOptionalSessionVisibleEntity } from '@/hooks/useSessionEntityStore'
import type { HappyChatMessageMetadata } from '@/lib/assistant-runtime'
import { MessageStatusIndicator } from '@/components/AssistantChat/messages/MessageStatusIndicator'
import { MessageAttachments } from '@/components/AssistantChat/messages/MessageAttachments'
import { UserBubbleContent, getUserBubbleClassName, shouldShowMessageStatus } from '@/components/AssistantChat/messages/user-bubble'
import { CliOutputBlock } from '@/components/CliOutputBlock'
import { getConversationMessageAnchorId } from '@/chat/outline'
import { MessageActions } from '@/components/AssistantChat/messages/MessageActions'
import { useTranslation } from '@/lib/use-translation'
import {
    useFlavorCapabilities,
    getFlavorForkCapability
} from '@/hooks/queries/useFlavorCapabilities'
import { useSessionActions } from '@/hooks/mutations/useSessionActions'
import { setForkedFromText } from '@/lib/fork-restore'

function RewindIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
            aria-hidden="true"
        >
            <path d="M3 7v6h6" />
            <path d="M21 17a9 9 0 0 0-15-6.7L3 13" />
        </svg>
    )
}

type UserMessageData = {
    messageId: string
    storeBacked: boolean
    hubMessageId?: string
    text: string
    status?: HappyChatMessageMetadata['status']
    localId: string | null
    attachments?: HappyChatMessageMetadata['attachments']
    isCliOutput: boolean
    steered: boolean
    cliText: string
    createdAt?: number
    threadIsRunning?: boolean
}

function UserMessageView(props: UserMessageData) {
    const {
        messageId,
        storeBacked,
        hubMessageId,
        text,
        status,
        localId,
        attachments,
        isCliOutput,
        steered,
        cliText,
        createdAt,
        threadIsRunning,
    } = props
    const ctx = useHappyChatStaticContext()
    const { t } = useTranslation()
    const [rewindError, setRewindError] = useState<string | null>(null)
    const navigate = useNavigate()
    const sessionFlavor = ctx.metadata?.flavor ?? null
    const { data: capabilities } = useFlavorCapabilities(ctx.api)
    const rewindSupported =
        Boolean(sessionFlavor) &&
        getFlavorForkCapability(capabilities, sessionFlavor).fork === 'at-message'
    const { forkSession, isPending: sessionActionPending } = useSessionActions(
        ctx.api,
        ctx.sessionId,
        sessionFlavor
    )
    const elementId = getConversationMessageAnchorId(messageId)
    const canRetry = status === 'failed' && Boolean(localId) && Boolean(ctx.onRetryMessage)
    const onRetry = canRetry && localId ? () => ctx.onRetryMessage!(localId) : undefined
    const showStatus = shouldShowMessageStatus(status)
    const canRewind = rewindSupported && typeof hubMessageId === 'string' && hubMessageId.length > 0

    const handleRewind = async () => {
        if (!canRewind || !hubMessageId) return
        setRewindError(null)
        try {
            const result = await forkSession({
                forkPoint: { messageId: hubMessageId }
            })
            if (result.type === 'blocked') return
            const { newSessionId } = result
            if (text) {
                setForkedFromText(newSessionId, text)
            }
            await navigate({
                to: '/sessions/$sessionId',
                params: { sessionId: newSessionId }
            })
        } catch (err) {
            setRewindError(err instanceof Error ? err.message : 'Rewind failed')
        }
    }

    const RootComponent = storeBacked ? 'div' : MessagePrimitive.Root
    const rootDataProps = storeBacked
        ? { 'data-message-id': messageId, 'data-thread-entry-id': messageId }
        : {}

    if (isCliOutput) {
        return (
            <RootComponent
                id={elementId}
                data-hapi-message-role="user"
                {...rootDataProps}
                className="aui-message-root happy-message scroll-mt-4 px-1 min-w-0 max-w-full overflow-x-clip"
            >
                <div className="ml-auto w-full max-w-[92%]">
                    <CliOutputBlock text={cliText} />
                    <MessageActions
                        align="end"
                        messageId={messageId}
                        createdAt={createdAt}
                        threadIsRunning={threadIsRunning}
                        copyText={cliText}
                        messageElementId={elementId}
                    />
                </div>
            </RootComponent>
        )
    }

    const hasText = text.length > 0
    const hasAttachments = attachments && attachments.length > 0

    return (
        <RootComponent
            id={elementId}
            data-hapi-message-role="user"
            {...rootDataProps}
            className={`aui-message-root happy-message ${getUserBubbleClassName(status)} group/msg scroll-mt-4`}
        >
            <div className="flex flex-col gap-1">
                <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                        {hasText ? <UserBubbleContent text={text} /> : null}
                        {hasAttachments ? <MessageAttachments attachments={attachments} /> : null}
                    </div>
                    {showStatus ? (
                        <div className="happy-message-actions-first-line flex shrink-0 items-center gap-1">
                            <MessageStatusIndicator status={status} onRetry={onRetry} />
                        </div>
                    ) : null}
                </div>
                <div className="flex justify-end items-center gap-2">
                    {canRewind && (
                        <button
                            type="button"
                            title="Rewind to this message"
                            aria-label="Rewind to this message"
                            onClick={handleRewind}
                            disabled={sessionActionPending}
                            className="rounded p-0.5 text-[var(--app-hint)] opacity-60 transition-[opacity,color] hover:text-[var(--app-fg)] disabled:cursor-not-allowed disabled:opacity-40 sm:opacity-0 sm:group-hover/msg:opacity-100"
                        >
                            <RewindIcon className="h-3.5 w-3.5" />
                        </button>
                    )}
                    <MessageActions
                        align="end"
                        messageId={messageId}
                        createdAt={createdAt}
                        threadIsRunning={threadIsRunning}
                        copyText={hasText ? text : undefined}
                        messageElementId={elementId}
                    />
                </div>
                {rewindError && (
                    <div className="mt-0.5 text-right text-[10px] text-red-500" role="alert">
                        {rewindError}
                    </div>
                )}
                {steered ? (
                    <span
                        title={t('queuedMessages.steeredBadgeTitle')}
                        className="mt-1 inline-flex items-center gap-0.5 text-[10px] leading-none text-[var(--app-hint)]"
                    >
                        {t('queuedMessages.steeredBadge')}
                    </span>
                ) : null}
            </div>
        </RootComponent>
    )
}

function StoreUserMessage({ messageId }: { messageId: string }) {
    const visibleEntity = useOptionalSessionVisibleEntity(messageId)
    const sessionState = useOptionalHappyChatSessionStateContext()
    if (!visibleEntity || (visibleEntity.kind !== 'user-text' && visibleEntity.kind !== 'cli-output')) {
        return null
    }
    return (
        <UserMessageView
            messageId={messageId}
            storeBacked
            hubMessageId={visibleEntity.kind === 'user-text' ? visibleEntity.id : undefined}
            text={visibleEntity.kind === 'user-text' ? visibleEntity.text : ''}
            status={visibleEntity.kind === 'user-text' && visibleEntity.status !== 'queued' ? visibleEntity.status : undefined}
            localId={visibleEntity.kind === 'user-text' ? (visibleEntity.localId ?? null) : null}
            attachments={visibleEntity.kind === 'user-text' ? visibleEntity.attachments : undefined}
            isCliOutput={visibleEntity.kind === 'cli-output'}
            steered={visibleEntity.kind === 'user-text' && visibleEntity.steered === true}
            cliText={visibleEntity.kind === 'cli-output' ? visibleEntity.text : ''}
            createdAt={visibleEntity.createdAt}
            threadIsRunning={Boolean(sessionState?.sessionThinking)}
        />
    )
}

function RuntimeUserMessage() {
    const role = useAuiState(({ message }) => message.role)
    const messageId = useAuiState(({ message }) => message.id)
    const visibleEntity = useOptionalSessionVisibleEntity(messageId)
    const hasStoreUserEntity = Boolean(
        visibleEntity && (visibleEntity.kind === 'user-text' || visibleEntity.kind === 'cli-output')
    )
    const auiHubMessageId = useAuiState(({ message }) => {
        if (hasStoreUserEntity || message.role !== 'user') return undefined
        const custom = message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined
        return custom?.hubMessageId
    })
    const auiText = useAuiState(({ message }) => {
        if (hasStoreUserEntity || message.role !== 'user') return ''
        return message.content.find((part) => part.type === 'text')?.text ?? ''
    })
    const auiStatus = useAuiState((s) => {
        if (hasStoreUserEntity || s.message.role !== 'user') return undefined
        const custom = s.message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined
        return custom?.status
    })
    const auiLocalId = useAuiState((s) => {
        if (hasStoreUserEntity || s.message.role !== 'user') return null
        const custom = s.message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined
        return custom?.localId ?? null
    })
    const auiAttachments = useAuiState((s) => {
        if (hasStoreUserEntity || s.message.role !== 'user') return undefined
        const custom = s.message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined
        return custom?.attachments
    })
    const auiIsCliOutput = useAuiState((s) => {
        if (hasStoreUserEntity) return false
        const custom = s.message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined
        return custom?.kind === 'cli-output'
    })
    const auiSteered = useAuiState(({ message }) => (
        hasStoreUserEntity
            ? false
            : (message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined)?.steered === true
    ))
    const auiCliText = useAuiState((s) => {
        if (hasStoreUserEntity) return ''
        const custom = s.message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined
        if (custom?.kind !== 'cli-output') return ''
        return s.message.content.find((part): part is TextMessagePart => part.type === 'text')?.text ?? ''
    })
    if (role !== 'user') return null
    return (
        <UserMessageView
            messageId={messageId}
            storeBacked={false}
            hubMessageId={hasStoreUserEntity && visibleEntity ? (visibleEntity.kind === 'user-text' ? visibleEntity.id : undefined) : auiHubMessageId}
            text={hasStoreUserEntity && visibleEntity ? (visibleEntity.kind === 'user-text' ? visibleEntity.text : '') : auiText}
            status={hasStoreUserEntity && visibleEntity ? (visibleEntity.kind === 'user-text' && visibleEntity.status !== 'queued' ? visibleEntity.status : undefined) : auiStatus}
            localId={hasStoreUserEntity && visibleEntity ? (visibleEntity.kind === 'user-text' ? (visibleEntity.localId ?? null) : null) : auiLocalId}
            attachments={hasStoreUserEntity && visibleEntity ? (visibleEntity.kind === 'user-text' ? visibleEntity.attachments : undefined) : auiAttachments}
            isCliOutput={hasStoreUserEntity && visibleEntity ? visibleEntity.kind === 'cli-output' : Boolean(auiIsCliOutput)}
            steered={hasStoreUserEntity && visibleEntity ? (visibleEntity.kind === 'user-text' && visibleEntity.steered === true) : auiSteered}
            cliText={hasStoreUserEntity && visibleEntity ? (visibleEntity.kind === 'cli-output' ? visibleEntity.text : '') : auiCliText}
        />
    )
}

export function HappyUserMessage(props: { messageId?: string } = {}) {
    const store = useOptionalSessionEntityStore()
    if (store && props.messageId) {
        return <StoreUserMessage messageId={props.messageId} />
    }
    return <RuntimeUserMessage />
}
