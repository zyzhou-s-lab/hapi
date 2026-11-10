import * as Popover from '@radix-ui/react-popover'
import { useState } from 'react'
import { useAuiState } from '@assistant-ui/react'
import { CheckIcon, CopyIcon, ForkIcon, InfoIcon, RewindIcon } from '@/components/icons'
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard'
import { useTranslation } from '@/lib/use-translation'
import { MessageMetadata, buildMessageMetadataLabels, type MessageMetadataProps } from './MessageMetadata'
import { MessageTimestamp } from './MessageTimestamp'
import { cn } from '@/lib/utils'
import { ShareTurnButton } from './ShareTurnButton'
import { MessageActionButton } from './MessageActionButton'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'

export type MessageHistoryAction = {
    kind: 'forkCurrent' | 'forkAtMessage' | 'rewind'
    messageLocalId?: string
}

type MessageActionsProps = {
    align: 'start' | 'end'
    messageId?: string
    createdAt?: Date | number
    threadIsRunning?: boolean
    copyText?: string
    getCopyText?: () => string
    metadata?: Omit<MessageMetadataProps, 'className'>
    messageElementId?: string
    showFork?: boolean
    showRewind?: boolean
    historyActionPending?: boolean
    onFork?: () => Promise<void>
    onRewind?: () => Promise<void>
}

type MessageActionsAuiState = {
    message: { id: string }
    thread?: {
        isRunning?: boolean
    } | null
}

/**
 * Primitive selector for `useAuiState` / `useSyncExternalStore`.
 * Must return an Object.is-stable value rather than a fresh object.
 *
 * @internal Exported for unit testing.
 */
export function selectThreadIsRunning(state: MessageActionsAuiState): boolean {
    return state.thread?.isRunning ?? false
}

function MessageActionsView({
    align,
    messageId,
    createdAt,
    threadIsRunning,
    copyText,
    getCopyText,
    metadata,
    messageElementId,
    showFork = false,
    showRewind = false,
    historyActionPending = false,
    onFork,
    onRewind
}: MessageActionsProps & { threadIsRunning: boolean }) {
    const { copied, copy } = useCopyToClipboard()
    const { t } = useTranslation()
    const canCopy = Boolean(copyText || getCopyText)
    const hasMetadata = metadata ? buildMessageMetadataLabels(metadata).length > 0 : false
    const [forkOpen, setForkOpen] = useState(false)
    const [rewindOpen, setRewindOpen] = useState(false)
    const [forkPending, setForkPending] = useState(false)
    const [rewindPending, setRewindPending] = useState(false)
    const actionsLocked = historyActionPending || forkPending || rewindPending || threadIsRunning

    const shareButton = messageElementId ? (
        <ShareTurnButton
            messageId={messageId}
            messageElementId={messageElementId}
            fallbackText={copyText}
            getFallbackText={getCopyText}
        />
    ) : null

    const historyButtons = !actionsLocked ? (
        <>
            {showRewind && onRewind ? (
                <MessageActionButton
                    label={t('message.rewind')}
                    onClick={() => setRewindOpen(true)}
                >
                    <RewindIcon className="h-3.5 w-3.5" />
                </MessageActionButton>
            ) : null}
            {showFork && onFork ? (
                <MessageActionButton
                    label={t('message.fork')}
                    onClick={() => setForkOpen(true)}
                >
                    <ForkIcon className="h-3.5 w-3.5" />
                </MessageActionButton>
            ) : null}
        </>
    ) : null

    const copyButton = canCopy ? (
        <MessageActionButton
            label={copied ? t('message.copied') : t('message.copy')}
            onClick={() => {
                const resolved = getCopyText ? getCopyText() : (copyText ?? '')
                if (resolved) copy(resolved)
            }}
        >
            {copied ? <CheckIcon className="h-3.5 w-3.5 text-green-500" /> : <CopyIcon className="h-3.5 w-3.5" />}
        </MessageActionButton>
    ) : null

    return (
        <>
            <div
                className={cn(
                    'happy-message-actions mt-1 flex h-5 items-center gap-1',
                    align === 'end' ? 'justify-end' : 'justify-start'
                )}
            >
                {align === 'end' ? <DesktopTimestamp createdAt={createdAt} /> : null}
                {align === 'end' && hasMetadata && metadata ? <MessageInfoPopover metadata={metadata} /> : null}
                {align === 'end' ? shareButton : null}
                {align === 'end' ? historyButtons : null}
                {align === 'end' ? copyButton : null}
                {align === 'start' ? copyButton : null}
                {align === 'start' ? historyButtons : null}
                {align === 'start' ? shareButton : null}
                {align === 'start' && hasMetadata && metadata ? <MessageInfoPopover metadata={metadata} /> : null}
                {align === 'start' ? <DesktopTimestamp createdAt={createdAt} /> : null}
            </div>

            <ConfirmDialog
                isOpen={forkOpen}
                onClose={() => {
                    if (!forkPending) setForkOpen(false)
                }}
                title={t('message.fork.confirmTitle')}
                description={t('message.fork.confirmDescription')}
                confirmLabel={t('message.fork')}
                confirmingLabel={t('message.fork.confirming')}
                isPending={forkPending}
                onConfirm={async () => {
                    if (!onFork) return
                    setForkPending(true)
                    try {
                        await onFork()
                        setForkOpen(false)
                    } finally {
                        setForkPending(false)
                    }
                }}
            />

            <ConfirmDialog
                isOpen={rewindOpen}
                onClose={() => {
                    if (!rewindPending) setRewindOpen(false)
                }}
                title={t('message.rewind.confirmTitle')}
                description={t('message.rewind.confirmDescription')}
                confirmLabel={t('message.rewind')}
                confirmingLabel={t('message.rewind.confirming')}
                isPending={rewindPending}
                destructive
                onConfirm={async () => {
                    if (!onRewind) return
                    setRewindPending(true)
                    try {
                        await onRewind()
                        setRewindOpen(false)
                    } finally {
                        setRewindPending(false)
                    }
                }}
            />
        </>
    )
}

function RuntimeMessageActions(props: MessageActionsProps) {
    const threadIsRunning = useAuiState((state) => selectThreadIsRunning(state))
    return <MessageActionsView {...props} threadIsRunning={threadIsRunning} />
}

export function MessageActions(props: MessageActionsProps) {
    if (props.threadIsRunning !== undefined) {
        return <MessageActionsView {...props} threadIsRunning={props.threadIsRunning} />
    }
    return <RuntimeMessageActions {...props} />
}

function DesktopTimestamp(props: { createdAt?: Date | number }) {
    return (
        <span className="inline-flex ml-1 items-center">
            <MessageTimestamp createdAt={props.createdAt} className="text-[10px] leading-none text-[var(--app-hint)]" />
        </span>
    )
}

function MessageInfoPopover({ metadata }: { metadata: Omit<MessageMetadataProps, 'className'> }) {
    const { t } = useTranslation()
    return (
        <Popover.Root>
            <Popover.Trigger asChild>
                <button
                    type="button"
                    title={t('message.info')}
                    aria-label={t('message.info')}
                    className="flex h-5 w-5 items-center justify-center rounded text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
                >
                    <InfoIcon className="h-3.5 w-3.5" />
                </button>
            </Popover.Trigger>
            <Popover.Portal>
                <Popover.Content
                    side="bottom"
                    align="start"
                    sideOffset={6}
                    collisionPadding={8}
                    className="z-50 rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 shadow-lg"
                >
                    <MessageMetadata {...metadata} />
                </Popover.Content>
            </Popover.Portal>
        </Popover.Root>
    )
}
