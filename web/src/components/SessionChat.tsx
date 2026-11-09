import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { SessionEntityStoreProvider } from '@/hooks/useSessionEntityStore'
import { PRESERVE_SESSION_SIDEBAR_SCROLL } from '@/lib/sessionNavigation'
import { transferComposerDraftThenNavigate } from '@/lib/composer-draft-transfer'
import { stopSpeaking } from '@/realtime/messageSummarySpeaker'
import {
    ModelRefusalToastConsumer,
    SessionAbortRestoreBridge,
    SessionEntityStoreIngestionBridge,
    useSessionChatPipeline,
} from '@/components/sessionChatHelpers'
import {
    SessionHeaderSlot,
    SessionStatusSlot,
    SessionTeamAndInactiveSlot,
} from '@/components/AssistantChat/SessionChatSurfaces'
import { SessionRuntimeController } from '@/components/SessionChat/SessionRuntimeController'
import { SessionWorkArea } from '@/components/SessionChat/SessionWorkArea'
import { createSessionBase } from '@/components/SessionChat/sessionState'
import type { SessionChatProps } from '@/components/SessionChat/types'

/** Keying resets drafts, runtime, scratchlist, view state and subscriptions together. */
export function SessionChat(props: SessionChatProps) {
    const sessionId = props.sessionId ?? props.session?.id ?? ''
    return <SessionChatInner key={sessionId} {...props} />
}

/** Session identity, navigation and explicit UI state are the shell's only inputs. */
function SessionChatInner(props: SessionChatProps) {
    const sessionId = props.sessionId ?? props.session?.id ?? ''
    const navigate = useNavigate()
    const [historyActionPending, setHistoryActionPending] = useState(false)
    const [forceScrollToken, setForceScrollToken] = useState(0)
    const [outlineOpen, setOutlineOpen] = useState(props.initialOutlineOpen ?? false)
    const [terminalVisible, setTerminalVisible] = useState(false)
    const baseSession = useMemo(() => props.session ?? createSessionBase(sessionId), [props.session, sessionId])
    const pipelineInput = {
        sessionId,
        session: props.session,
        messages: props.messages,
        hasMoreMessages: props.hasMoreMessages,
    }
    const { entityStore } = useSessionChatPipeline(pipelineInput)
    useEffect(() => stopSpeaking, [])
    useEffect(() => {
        if (!props.initialOutlineOpen) return
        setOutlineOpen(true)
        props.onInitialOutlineConsumed?.()
    }, [props.initialOutlineOpen, props.onInitialOutlineConsumed])
    const onForkConversation = useCallback(async (messageLocalId?: string) => {
        setHistoryActionPending(true)
        try {
            const result = await props.api.forkConversation(sessionId, messageLocalId)
            await navigate({
                to: '/sessions/$sessionId',
                params: { sessionId: result.sessionId },
                ...PRESERVE_SESSION_SIDEBAR_SCROLL,
            })
        } finally {
            setHistoryActionPending(false)
        }
    }, [navigate, props.api, sessionId])
    const onRewindConversation = useCallback(async (messageLocalId: string) => {
        setHistoryActionPending(true)
        try {
            await props.api.rewindConversation(sessionId, messageLocalId)
            props.onRefresh()
        } finally {
            setHistoryActionPending(false)
        }
    }, [props.api, props.onRefresh, sessionId])
    const handleToggleFiles = useCallback(() => {
        setOutlineOpen(false)
        void navigate({
            to: '/sessions/$sessionId/files',
            params: { sessionId },
            ...PRESERVE_SESSION_SIDEBAR_SCROLL,
        })
    }, [navigate, sessionId])
    const handleToggleConfig = useCallback(() => {
        setOutlineOpen(false)
        void navigate({
            to: '/sessions/$sessionId/config',
            params: { sessionId },
            ...PRESERVE_SESSION_SIDEBAR_SCROLL,
        })
    }, [navigate, sessionId])
    const handleViewTerminal = useCallback(() => {
        void navigate({
            to: '/sessions/$sessionId/terminal',
            params: { sessionId },
            ...PRESERVE_SESSION_SIDEBAR_SCROLL,
        })
    }, [navigate, sessionId])
    const handleToggleOutline = useCallback(() => setOutlineOpen((open) => !open), [])
    const handleToggleTerminal = useCallback(() => setTerminalVisible((visible) => !visible), [])
    const handleAcceptedChatSend = useCallback(() => setForceScrollToken((token) => token + 1), [])
    const handleSessionReopened = useCallback(async (newSessionId: string) => {
        await transferComposerDraftThenNavigate(sessionId, newSessionId, () => navigate({
            to: '/sessions/$sessionId',
            params: { sessionId: newSessionId },
            replace: true,
            ...PRESERVE_SESSION_SIDEBAR_SCROLL,
        }))
    }, [navigate, sessionId])
    const surfaceProps = { ...props, sessionId, entityStore, baseSession }
    return (
        <SessionEntityStoreProvider store={entityStore}>
            <SessionEntityStoreIngestionBridge {...pipelineInput} entityStore={entityStore} />
            <ModelRefusalToastConsumer entityStore={entityStore} sessionId={sessionId} />
            {props.onAbortRestore ? <SessionAbortRestoreBridge entityStore={entityStore} onAbortRestore={props.onAbortRestore} /> : null}
            <div className="flex h-full min-h-0 flex-col">
                <SessionHeaderSlot
                    api={props.api}
                    sessionId={sessionId}
                    fallbackSession={props.session}
                    entityStore={entityStore}
                    cursorChatOnDisk={props.cursorChatOnDisk}
                    titleSuggestionAvailable={props.titleSuggestionAvailable}
                    reopenDisabledReason={props.reopenDisabledReason}
                    reopenHint={props.reopenHint}
                    outlineOpen={outlineOpen}
                    terminalVisible={terminalVisible}
                    onBack={props.onBack}
                    onToggleFiles={handleToggleFiles}
                    onToggleOutline={handleToggleOutline}
                    onToggleConfig={handleToggleConfig}
                    onToggleTerminal={handleToggleTerminal}
                    onSessionReopened={handleSessionReopened}
                />
                <SessionStatusSlot entityStore={entityStore} />
                <div className="flex flex-col min-h-0 flex-1">
                    <SessionTeamAndInactiveSlot
                        api={props.api}
                        sessionId={sessionId}
                        fallbackSession={props.session}
                        entityStore={entityStore}
                        cursorChatOnDisk={props.cursorChatOnDisk}
                    />
                    <SessionRuntimeController {...surfaceProps} onAcceptedChatSend={handleAcceptedChatSend}>
                        <SessionWorkArea
                            {...surfaceProps}
                            terminalVisible={terminalVisible}
                            outlineOpen={outlineOpen}
                            forceScrollToken={forceScrollToken}
                            historyActionPending={historyActionPending}
                            onForkConversation={onForkConversation}
                            onRewindConversation={onRewindConversation}
                            onOutlineOpenChange={setOutlineOpen}
                            onViewFiles={handleToggleFiles}
                            onViewTerminal={handleViewTerminal}
                        />
                    </SessionRuntimeController>
                </div>
            </div>
        </SessionEntityStoreProvider>
    )
}
