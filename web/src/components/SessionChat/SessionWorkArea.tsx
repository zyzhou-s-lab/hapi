import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { measureComposerDockInset } from '@/components/AssistantChat/threadScrollHelpers'
import { SessionAgentTerminalSlot, SessionThreadSection } from '@/components/AssistantChat/SessionChatSurfaces'
import { chatComposerGridPlacement } from '@/components/sessionChatHelpers'
import { SessionComposerSection } from './SessionRuntimeController'
import type { SessionSurfaceProps } from './types'

/** Layout state belongs here; live session data remains in the mounted slots. */
export function SessionWorkArea(props: SessionSurfaceProps & {
    terminalVisible: boolean
    outlineOpen: boolean
    forceScrollToken: number
    historyActionPending: boolean
    onForkConversation: (messageLocalId?: string) => Promise<void>
    onRewindConversation: (messageLocalId: string) => Promise<void>
    onOutlineOpenChange: (open: boolean) => void
    onViewFiles: () => void
    onViewTerminal: () => void
}) {
    const [terminalAvailable, setTerminalAvailable] = useState(
        props.session?.active === true && props.session.metadata?.startingMode === 'pty'
    )
    const terminalShown = props.terminalVisible && terminalAvailable
    const composerDockRef = useRef<HTMLDivElement>(null)
    const composerExpandedRef = useRef(false)
    const [composerExpanded, setComposerExpanded] = useState(false)
    const [composerDockHeight, setComposerDockHeight] = useState(0)
    const handleComposerExpandedChange = useCallback((expanded: boolean) => {
        composerExpandedRef.current = expanded
        setComposerExpanded(expanded)
        if (expanded) setComposerDockHeight(0)
    }, [])
    useLayoutEffect(() => {
        const dock = composerDockRef.current
        if (!dock) return
        const publish = () => {
            const hidden = dock.getClientRects().length === 0
            const next = measureComposerDockInset(dock.getBoundingClientRect().height, {
                expanded: composerExpandedRef.current,
                hidden,
            })
            setComposerDockHeight((previous) => previous === next ? previous : next)
        }
        publish()
        if (typeof ResizeObserver === 'undefined') return
        const observer = new ResizeObserver(publish)
        observer.observe(dock)
        const viewport = window.visualViewport
        viewport?.addEventListener('resize', publish)
        window.addEventListener('resize', publish)
        return () => {
            observer.disconnect()
            viewport?.removeEventListener('resize', publish)
            window.removeEventListener('resize', publish)
        }
    }, [])
    const composerGrid = chatComposerGridPlacement({
        terminalShown,
        composerExpanded,
        outlineOpen: props.outlineOpen,
    })
    const composerFloating = !terminalShown && !composerExpanded
    const threadBottomInsetPx = measureComposerDockInset(composerDockHeight, {
        expanded: composerExpanded,
        hidden: terminalShown,
    })
    useLayoutEffect(() => {
        const dock = composerDockRef.current
        if (!dock) return
        const next = measureComposerDockInset(dock.getBoundingClientRect().height, {
            expanded: composerExpandedRef.current,
            hidden: dock.getClientRects().length === 0,
        })
        setComposerDockHeight((previous) => previous === next ? previous : next)
    }, [composerExpanded, terminalShown, props.outlineOpen])
    return (
        <div className="relative flex min-h-0 flex-1 flex-col">
            <SessionAgentTerminalSlot
                sessionId={props.sessionId}
                fallbackSession={props.session}
                terminalVisible={props.terminalVisible}
                onTerminalAvailableChange={setTerminalAvailable}
            />
            <div className={composerGrid.stage}>
                <div className={composerGrid.thread}>
                    <SessionThreadSection
                        api={props.api}
                        sessionId={props.sessionId}
                        baseSession={props.baseSession}
                        entityStore={props.entityStore}
                        viewMode={props.viewMode}
                        messagesVersion={props.messagesVersion}
                        historyVersion={props.historyVersion}
                        isSyncingTail={props.isSyncingTail}
                        messagesWarning={props.messagesWarning}
                        hasMoreMessages={props.hasMoreMessages}
                        isLoadingMoreMessages={props.isLoadingMoreMessages}
                        onRefresh={props.onRefresh}
                        onRetryMessage={props.onRetryMessage}
                        historyActionPending={props.historyActionPending}
                        onForkConversation={props.onForkConversation}
                        onRewindConversation={props.onRewindConversation}
                        onViewModeChange={props.onViewModeChange}
                        onLoadMore={props.onLoadMore}
                        onCancelLoadMore={props.onCancelLoadMore}
                        forceScrollToken={props.forceScrollToken}
                        outlineOpen={props.outlineOpen}
                        bottomInsetPx={threadBottomInsetPx}
                        onOutlineOpenChange={props.onOutlineOpenChange}
                    />
                </div>
                <div ref={composerDockRef} data-testid="composer-dock" className={composerGrid.dock}>
                    <SessionComposerSection
                        {...props}
                        composerFloating={composerFloating}
                        onExpandedChange={handleComposerExpandedChange}
                        onViewFiles={props.onViewFiles}
                        onViewTerminal={props.onViewTerminal}
                    />
                </div>
            </div>
        </div>
    )
}
