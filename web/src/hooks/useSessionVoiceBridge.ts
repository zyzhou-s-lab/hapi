import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApiClient } from '@/api/client'
import type { AttachmentMetadata, DecryptedMessage, Session } from '@/types/api'
import type { MessageDeliveryMode } from '@hapi/protocol'
import type { SendMessageAcceptance } from '@/hooks/mutations/useSendMessage'
import { getMessageWindowState, subscribeMessageWindow } from '@/lib/message-window-store'
import { useVoiceOptional, type VoiceContextValue } from '@/lib/voice-context'
import { VoiceBackendSession, registerSessionStore, registerVoiceHooksStore, voiceHooks } from '@/realtime'

export { VoiceBackendSession }

export function useSessionVoiceBridge(props: {
    api: ApiClient
    session: Session
    messages?: DecryptedMessage[]
    onSend: (
        text: string,
        attachments?: AttachmentMetadata[],
        scheduledAt?: number | null,
        deliveryMode?: MessageDeliveryMode,
    ) => Promise<SendMessageAcceptance | boolean>
    onRefresh: () => void
}): {
    voice: VoiceContextValue | null
    voiceBackendReady: boolean
    setVoiceBackendReady: (ready: boolean) => void
    handleVoiceToggle: () => Promise<void>
    handleVoiceMicToggle: () => void
} {
    // Voice bridge state and event forwarding for the active session.
    // Voice assistant integration
    const voice = useVoiceOptional()
    const [voiceBackendReady, setVoiceBackendReady] = useState(false)

    // Register session store for voice client tools
    useEffect(() => {
        registerSessionStore({
            getSession: () => props.session as { agentState?: { requests?: Record<string, unknown> } } | null,
            sendMessage: (_sessionId: string, message: string) => props.onSend(message),
            approvePermission: async (_sessionId: string, requestId: string) => {
                await props.api.approvePermission(props.session.id, requestId)
                props.onRefresh()
            },
            denyPermission: async (_sessionId: string, requestId: string) => {
                await props.api.denyPermission(props.session.id, requestId)
                props.onRefresh()
            }
        })
    }, [props.session, props.api, props.onSend, props.onRefresh])

    useEffect(() => {
        registerVoiceHooksStore(
            (sessionId) => (sessionId === props.session.id ? props.session : null),
            (sessionId) => (
                sessionId === props.session.id
                    ? (props.messages ?? getMessageWindowState(props.session.id).messages)
                    : []
            )
        )
    }, [props.session, props.messages])

    // Track and report new messages to voice assistant
    // Note: voiceHooks internally checks isVoiceSessionStarted() so we don't need to check voice.status here
    const seenMessageIdsRef = useRef<{ sessionId: string; ids: Set<string> }>({
        sessionId: props.session.id,
        ids: new Set(),
    })

    useEffect(() => {
        if (seenMessageIdsRef.current.sessionId !== props.session.id) {
            seenMessageIdsRef.current = {
                sessionId: props.session.id,
                ids: new Set(),
            }
        }
        const reportMessages = (messages: readonly DecryptedMessage[]) => {
            const seen = seenMessageIdsRef.current.ids
            const newMessages: DecryptedMessage[] = []
            for (const msg of messages) {
                if (!seen.has(msg.id)) {
                    seen.add(msg.id)
                    newMessages.push(msg)
                }
            }
            if (newMessages.length > 0) {
                voiceHooks.onMessages(props.session.id, newMessages)
            }
        }
        if (props.messages !== undefined) {
            reportMessages(props.messages)
            return
        }
        reportMessages(getMessageWindowState(props.session.id).messages)
        return subscribeMessageWindow(props.session.id, () => {
            reportMessages(getMessageWindowState(props.session.id).messages)
        })
    }, [props.messages, props.session.id])

    // Report ready event when thinking stops
    // Note: voiceHooks internally checks isVoiceSessionStarted() so we don't need to check voice.status here
    const prevThinkingRef = useRef(props.session.thinking)

    useEffect(() => {
        // Detect transition: thinking → not thinking
        if (prevThinkingRef.current && !props.session.thinking) {
            voiceHooks.onReady(props.session.id)
        }

        prevThinkingRef.current = props.session.thinking
    }, [props.session.thinking, props.session.id])

    // Report permission requests to voice assistant
    // Note: voiceHooks internally checks isVoiceSessionStarted() so we don't need to check voice.status here
    const prevRequestIdsRef = useRef<Set<string>>(new Set())

    useEffect(() => {
        const requests = props.session.agentState?.requests ?? {}
        const currentIds = new Set(Object.keys(requests))

        for (const [requestId, request] of Object.entries(requests)) {
            if (!prevRequestIdsRef.current.has(requestId)) {
                voiceHooks.onPermissionRequested(
                    props.session.id,
                    requestId,
                    (request as { tool?: string }).tool ?? 'unknown',
                    (request as { arguments?: unknown }).arguments
                )
            }
        }

        prevRequestIdsRef.current = currentIds
    }, [props.session.agentState?.requests, props.session.id])

    const handleVoiceToggle = useCallback(async () => {
        if (!voice) return
        if (voice.status === 'connected' || voice.status === 'connecting') {
            await voice.stopVoice()
        } else {
            await voice.startVoice(props.session.id)
        }
    }, [voice, props.session.id])

    const handleVoiceMicToggle = useCallback(() => {
        if (!voice) return
        voice.toggleMic()
    }, [voice])
    return {
        voice,
        voiceBackendReady,
        setVoiceBackendReady,
        handleVoiceToggle,
        handleVoiceMicToggle,
    }

}
