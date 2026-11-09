import type { ApiClient } from '@/api/client'
import type { AttachmentMetadata, DecryptedMessage, Session, SlashCommand } from '@/types/api'
import type { Suggestion } from '@/hooks/useActiveSuggestions'
import type { ComposerSendError } from '@/components/AssistantChat/composer/types'
import type { MessageDeliveryMode } from '@hapi/protocol'
import type { OlderLoadOutcome } from '@/lib/message-window-store'
import type { SendMessageAcceptance, SendMessageSettlement } from '@/hooks/mutations/useSendMessage'
import type { SessionEntityStore } from '@/chat/store/sessionEntityStore'

export type SessionChatProps = {
    api: ApiClient
    sessionId?: string
    titleSuggestionAvailable?: boolean
    session?: Session
    cursorChatOnDisk?: boolean
    reopenDisabledReason?: string
    reopenHint?: string
    messages?: DecryptedMessage[]
    messagesWarning: string | null
    hasMoreMessages: boolean
    isSyncingTail: boolean
    isLoadingMoreMessages: boolean
    isSending: boolean
    sendSettlement: SendMessageSettlement | null
    viewMode: 'tail' | 'history'
    messagesVersion?: number
    historyVersion: number
    onBack: () => void
    onRefresh: () => void
    onLoadMore: (onBeforeApply?: (historyVersion: number) => boolean) => Promise<OlderLoadOutcome>
    onCancelLoadMore: () => void
    onSend: (
        text: string,
        attachments?: AttachmentMetadata[],
        scheduledAt?: number | null,
        deliveryMode?: MessageDeliveryMode,
    ) => Promise<SendMessageAcceptance | false>
    resolveSessionIdForUpload?: (sessionId: string) => Promise<string>
    onUploadSessionResolved?: (sessionId: string) => void
    onViewModeChange: (mode: 'tail' | 'history') => void
    onRetryMessage?: (localId: string) => void
    autocompleteSuggestions?: (query: string) => Promise<Suggestion[]>
    availableSlashCommands?: readonly SlashCommand[]
    sendError?: ComposerSendError | null
    onClearSendError?: () => void
    onSuppressSendErrorRestore?: (id: number) => void
    initialOutlineOpen?: boolean
    onInitialOutlineConsumed?: () => void
    onAbortRestore?: (text: string) => void
}

export type SessionSurfaceProps = SessionChatProps & {
    sessionId: string
    entityStore: SessionEntityStore
    baseSession: Session
}
