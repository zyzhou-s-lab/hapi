import { useAuiState } from '@assistant-ui/react'
import { useOptionalHappyChatStaticContext } from '@/components/AssistantChat/context'
import { useOptionalSessionEntityStore } from '@/hooks/useSessionEntityStore'
import { useTranslation } from '@/lib/use-translation'
import { MessageActionButton } from './MessageActionButton'

function ShareIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <circle cx="18" cy="5" r="3" />
            <circle cx="6" cy="12" r="3" />
            <circle cx="18" cy="19" r="3" />
            <path d="M8.6 10.7 15.4 6.3" />
            <path d="M8.6 13.3 15.4 17.7" />
        </svg>
    )
}

export function ShareTurnButton(props: {
    messageElementId: string
    className?: string
    fallbackText?: string
    getFallbackText?: () => string
}) {
    const ctx = useOptionalHappyChatStaticContext()
    const store = useOptionalSessionEntityStore()
    const { t } = useTranslation()
    const messageId = useAuiState((s) => s.message.id)
    const hasStoreData = Boolean(store && store.getSnapshot().blocksWithThreadIds.length > 0)
    const auiFallbackUserText = useAuiState(({ message, thread }) => {
        if (hasStoreData) return ''
        const currentIndex = thread.messages.findIndex((candidate) => candidate.id === message.id)
        if (currentIndex < 0) return ''
        for (let index = currentIndex; index >= 0; index -= 1) {
            const candidate = thread.messages[index]
            if (candidate?.role !== 'user') continue
            return candidate.content
                .filter((part) => part.type === 'text')
                .map((part) => part.text)
                .join('\n')
                .trim()
        }
        return ''
    })
    const onShareTurn = ctx?.onShareTurn
    if (!onShareTurn) return null

    return (
        <MessageActionButton
            data-hapi-share-action="true"
            label={t('message.shareTurn')}
            className={props.className}
            onClick={(event) => {
                event.stopPropagation()
                const fallbackUserText = hasStoreData && store
                    ? (store.getPrecedingUserText(messageId) ?? '')
                    : auiFallbackUserText
                const rawFallback = props.getFallbackText ? props.getFallbackText() : props.fallbackText
                const fallbackText = rawFallback?.trim() ?? ''
                const messageElement = event.currentTarget.closest('[data-hapi-message-role]')
                onShareTurn(
                    messageElement instanceof HTMLElement ? messageElement : props.messageElementId,
                    event.clientY,
                    fallbackUserText.length > 0
                        ? { html: '', text: fallbackUserText, role: 'user' }
                        : fallbackText.length > 0
                            ? { html: '', text: fallbackText, role: 'assistant' }
                        : undefined
                )
            }}
        >
            <ShareIcon className="h-3.5 w-3.5" />
        </MessageActionButton>
    )
}
