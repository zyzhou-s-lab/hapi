import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useAuiState } from '@assistant-ui/react'
import { useOptionalHappyChatStaticContext, type HappyChatStaticContextValue } from '@/components/AssistantChat/context'
import { useOptionalSessionEntityStore } from '@/hooks/useSessionEntityStore'
import { useTranslation } from '@/lib/use-translation'
import { MessageActionButton } from './MessageActionButton'
import { renderCollapsedRailForShareCapture } from './TurnExecutionRail'
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

type ShareTurnButtonProps = {
    messageId?: string
    messageElementId: string
    className?: string
    fallbackText?: string
    getFallbackText?: () => string
}

type ShareCaptureRailSlot = {
    readonly key: string
    readonly placeholder: HTMLElement
    readonly sourceRail: HTMLElement
}

type PendingShareCapture = {
    readonly id: number
    readonly hostElement: HTMLElement
    readonly stageElement: HTMLDivElement
    readonly targetElement: HTMLElement
    readonly railSlots: readonly ShareCaptureRailSlot[]
    readonly clientY: number
    readonly fallbackSnapshot?: { html: string; text: string; role?: 'user' | 'assistant' }
}

function collectTurnRangeElements(target: HTMLElement): HTMLElement[] {
    let start: Element | null = target
    while (start?.previousElementSibling && start.getAttribute('data-hapi-message-role') !== 'user') {
        start = start.previousElementSibling
    }
    if (!start || start.getAttribute('data-hapi-message-role') !== 'user') {
        start = target
    }

    const elements: HTMLElement[] = []
    let current: Element | null = start
    while (current instanceof HTMLElement) {
        if (current !== start && current.getAttribute('data-hapi-message-role') === 'user') {
            break
        }
        elements.push(current)
        current = current.nextElementSibling
    }
    return elements.length > 0 ? elements : [target]
}

function stripDuplicateIds(root: HTMLElement): void {
    root.removeAttribute('id')
    for (const el of Array.from(root.querySelectorAll('[id]'))) {
        el.removeAttribute('id')
    }
}

function buildPendingShareCapture(params: {
    id: number
    target: HTMLElement
    clientY: number
    fallbackSnapshot?: { html: string; text: string; role?: 'user' | 'assistant' }
}): PendingShareCapture | null {
    const rangeElements = collectTurnRangeElements(params.target)
    const hasCollapsedRailInRange = rangeElements.some(
        (el) => el.querySelector('[data-testid="turn-level1-shell"][data-open="false"]') !== null
    )
    if (!hasCollapsedRailInRange) {
        return null
    }

    const hostElement = params.target.closest<HTMLElement>('.chat-scroll-content')
        ?? params.target.parentElement
        ?? params.target
    const stageElement = document.createElement('div')
    stageElement.setAttribute('data-testid', 'turn-share-offscreen-stage')
    stageElement.setAttribute('data-hapi-share-exclude', 'true')
    stageElement.setAttribute('aria-hidden', 'true')
    stageElement.style.cssText = [
        'position:fixed',
        'left:-10000px',
        'top:0',
        'width:720px',
        'pointer-events:none',
        'opacity:0',
        'z-index:-1',
    ].join(';')

    const railSlots: ShareCaptureRailSlot[] = []
    let clonedTarget: HTMLElement | null = null
    let slotIndex = 0

    for (const originalEl of rangeElements) {
        const cloneEl = originalEl.cloneNode(true)
        if (!(cloneEl instanceof HTMLElement)) continue
        stripDuplicateIds(cloneEl)
        cloneEl.removeAttribute('data-thread-entry-id')
        cloneEl.removeAttribute('data-message-id')

        const sourceRails = Array.from(originalEl.querySelectorAll<HTMLElement>('[data-testid="turn-execution-rail"]'))
        const cloneRails = Array.from(cloneEl.querySelectorAll<HTMLElement>('[data-testid="turn-execution-rail"]'))
        const count = Math.min(sourceRails.length, cloneRails.length)
        for (let i = 0; i < count; i += 1) {
            const sourceRail = sourceRails[i]!
            const cloneRail = cloneRails[i]!
            if (sourceRail.querySelector('[data-testid="turn-level1-shell"][data-open="false"]') === null) {
                continue
            }
            const placeholder = document.createElement('div')
            placeholder.className = 'w-full'
            cloneRail.replaceWith(placeholder)
            railSlots.push({
                key: `share-rail-${params.id}-${slotIndex++}`,
                placeholder,
                sourceRail,
            })
        }

        stageElement.appendChild(cloneEl)
        if (originalEl === params.target) {
            clonedTarget = cloneEl
        }
    }

    const targetElement = clonedTarget ?? (stageElement.firstElementChild as HTMLElement | null)
    if (!targetElement || railSlots.length === 0) {
        return null
    }

    return {
        id: params.id,
        hostElement,
        stageElement,
        targetElement,
        railSlots,
        clientY: params.clientY,
        fallbackSnapshot: params.fallbackSnapshot,
    }
}

function OffscreenTurnShareCaptureHost(props: {
    capture: PendingShareCapture
    onShareTurn: NonNullable<HappyChatStaticContextValue['onShareTurn']>
    onComplete: (id: number) => void
}) {
    const { capture, onShareTurn, onComplete } = props

    useLayoutEffect(() => {
        capture.hostElement.appendChild(capture.stageElement)
        let cancelled = false
        let raf1 = 0
        let raf2 = 0

        const finishCapture = () => {
            if (cancelled) return
            try {
                void capture.stageElement.getBoundingClientRect()
                onShareTurn(capture.targetElement, capture.clientY, capture.fallbackSnapshot)
            } finally {
                capture.stageElement.remove()
                onComplete(capture.id)
            }
        }

        const scheduleFrames = () => {
            if (cancelled) return
            if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
                raf1 = window.requestAnimationFrame(() => {
                    if (cancelled) return
                    raf2 = window.requestAnimationFrame(finishCapture)
                })
            } else {
                finishCapture()
            }
        }

        const ownerDoc = capture.stageElement.ownerDocument
        if (ownerDoc?.fonts?.ready) {
            void ownerDoc.fonts.ready.catch(() => undefined).then(scheduleFrames)
        } else {
            scheduleFrames()
        }

        return () => {
            cancelled = true
            if (raf1 && typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') {
                window.cancelAnimationFrame(raf1)
            }
            if (raf2 && typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') {
                window.cancelAnimationFrame(raf2)
            }
            capture.stageElement.remove()
        }
    }, [capture, onShareTurn, onComplete])

    return (
        <>
            {capture.railSlots.map((slot) =>
                createPortal(renderCollapsedRailForShareCapture(slot.sourceRail), slot.placeholder, slot.key)
            )}
        </>
    )
}

function ShareTurnButtonView(props: ShareTurnButtonProps & { getFallbackUserText: () => string }) {
    const ctx = useOptionalHappyChatStaticContext()
    const { t } = useTranslation()
    const onShareTurn = ctx?.onShareTurn
    const [pendingCapture, setPendingCapture] = useState<PendingShareCapture | null>(null)
    const captureIdRef = useRef(0)

    const handleCaptureComplete = useCallback((completedId: number) => {
        setPendingCapture((current) => (current?.id === completedId ? null : current))
    }, [])

    if (!onShareTurn) return null

    return (
        <>
            <MessageActionButton
                data-hapi-share-action="true"
                label={t('message.shareTurn')}
                className={props.className}
                onClick={(event) => {
                    event.stopPropagation()
                    const fallbackUserText = props.getFallbackUserText()
                    const rawFallback = props.getFallbackText ? props.getFallbackText() : props.fallbackText
                    const fallbackText = rawFallback?.trim() ?? ''
                    const fallbackSnapshot = fallbackUserText.length > 0
                        ? { html: '', text: fallbackUserText, role: 'user' as const }
                        : fallbackText.length > 0
                            ? { html: '', text: fallbackText, role: 'assistant' as const }
                            : undefined
                    const messageElement = event.currentTarget.closest('[data-hapi-message-role]')
                        ?? (typeof document !== 'undefined' ? document.getElementById(props.messageElementId) : null)
                    if (messageElement instanceof HTMLElement) {
                        const nextCapture = buildPendingShareCapture({
                            id: ++captureIdRef.current,
                            target: messageElement,
                            clientY: event.clientY,
                            fallbackSnapshot,
                        })
                        if (nextCapture) {
                            setPendingCapture(nextCapture)
                            return
                        }
                    }
                    onShareTurn(
                        messageElement instanceof HTMLElement ? messageElement : props.messageElementId,
                        event.clientY,
                        fallbackSnapshot
                    )
                }}
            >
                <ShareIcon className="h-3.5 w-3.5" />
            </MessageActionButton>
            {pendingCapture ? (
                <OffscreenTurnShareCaptureHost
                    key={pendingCapture.id}
                    capture={pendingCapture}
                    onShareTurn={onShareTurn}
                    onComplete={handleCaptureComplete}
                />
            ) : null}
        </>
    )
}

function RuntimeShareTurnButton(props: ShareTurnButtonProps) {
    const store = useOptionalSessionEntityStore()
    const messageId = useAuiState((s) => s.message.id)
    const hasStoreData = Boolean(store && store.getSnapshot().blocksWithThreadIds.length > 0)
    const auiFallbackUserText = useAuiState(({ message, thread }) => {
        if (hasStoreData || !thread?.messages) return ''
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
    return (
        <ShareTurnButtonView
            {...props}
            messageId={messageId}
            getFallbackUserText={() => (
                hasStoreData && store ? (store.getPrecedingUserText(messageId) ?? '') : auiFallbackUserText
            )}
        />
    )
}

export function ShareTurnButton(props: ShareTurnButtonProps) {
    const store = useOptionalSessionEntityStore()
    const hasStoreData = Boolean(store && store.getSnapshot().blocksWithThreadIds.length > 0)
    if (props.messageId !== undefined && hasStoreData && store) {
        return (
            <ShareTurnButtonView
                {...props}
                getFallbackUserText={() => store.getPrecedingUserText(props.messageId!) ?? ''}
            />
        )
    }
    return <RuntimeShareTurnButton {...props} />
}
