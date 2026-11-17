import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { SessionChatProps } from '@/components/SessionChat/types'

/** Separate chat sends wait for delivery without entering the main composer's recovery path. */
export function useGitChatSend(options: Pick<SessionChatProps, 'onSend' | 'sendSettlement' | 'sendError'> & {
    sessionId: string
    disabled: boolean
    onDelivered: () => void
}) {
    const sentTexts = useMemo(() => new Set<string>(), [options.sessionId])
    const pending = useRef<{ attemptId: string | null; resolve: (delivered: boolean) => void } | null>(null)
    const latestSettlement = useRef(options.sendSettlement)
    latestSettlement.current = options.sendSettlement

    useEffect(() => {
        const delivery = pending.current
        if (delivery && options.sendSettlement?.attemptId === delivery.attemptId) {
            delivery.resolve(options.sendSettlement.status === 'success')
        }
    }, [options.sendSettlement])
    useEffect(() => () => {
        pending.current?.resolve(false)
        pending.current = null
    }, [options.sessionId])

    const send = useCallback(async (text: string): Promise<boolean> => {
        if (options.disabled || pending.current) return false
        const completion = Promise.withResolvers<boolean>()
        const delivery = { attemptId: null as string | null, resolve: completion.resolve }
        pending.current = delivery
        sentTexts.add(text)
        try {
            // Never consume the main composer's draft, attachments, schedule or one-shot intent.
            const acceptance = await options.onSend(text, undefined, null)
            if (acceptance === false || pending.current !== delivery) return false
            delivery.attemptId = acceptance.attemptId
            const settled = latestSettlement.current
            if (settled?.attemptId === acceptance.attemptId) completion.resolve(settled.status === 'success')
            const delivered = await completion.promise
            if (delivered) options.onDelivered()
            return delivered
        } finally {
            if (pending.current === delivery) pending.current = null
        }
    }, [options.disabled, options.onSend, options.onDelivered, sentTexts])

    return {
        send,
        composerSendError: options.sendError && sentTexts.has(options.sendError.text) ? null : options.sendError,
    }
}
