import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import type { ApiClient } from '@/api/client'
import { captureMessageWindowScope, markMessagesConsumed, markMessagesRequeued, removeOptimisticMessage } from '@/lib/message-window-store'
import { useTranslation } from '@/lib/use-translation'
import { useToast } from '@/lib/toast-context'

type RetryIndeterminateMessageInput = {
    sessionId: string
    messageId: string
}

export function useRetryIndeterminateMessage(api: ApiClient | null) {
    const { t } = useTranslation()
    const { addToast } = useToast()
    const [isScopeCurrent] = useState(captureMessageWindowScope)
    return useMutation({
        mutationFn: async (input: RetryIndeterminateMessageInput) => {
            if (!api || !isScopeCurrent()) throw new Error('API unavailable')
            return api.retryIndeterminateMessage(input.sessionId, input.messageId)
        },
        onSuccess: (result, input) => {
            if (!isScopeCurrent()) return
            if (result.status === 'retried' || result.status === 'already-queued') {
                markMessagesRequeued(input.sessionId, result.localId ? [result.localId] : [])
            }
            if (result.status === 'invoked' && result.message.localId && typeof result.message.invokedAt === 'number') {
                markMessagesConsumed(input.sessionId, [result.message.localId], result.message.invokedAt)
            }
            if (result.status === 'retry-unavailable' || result.status === 'not-found') {
                if (result.status === 'not-found') {
                    removeOptimisticMessage(input.sessionId, input.messageId)
                }
                addToast({
                    title: t('queuedMessages.retryFailed'),
                    body: result.status === 'not-found'
                        ? t('queuedMessages.retryMissing')
                        : t('queuedMessages.retryUnavailable'),
                    sessionId: input.sessionId,
                    url: window.location.href,
                })
            }
        },
        onError: (error, input) => {
            if (!isScopeCurrent()) return
            addToast({
                title: t('queuedMessages.retryFailed'),
                body: error instanceof Error ? error.message : '',
                sessionId: input.sessionId,
                url: window.location.href,
            })
        },
    })
}
