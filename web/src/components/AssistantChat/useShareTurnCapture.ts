import { useCallback, useMemo, useRef, useState, type RefObject } from 'react'
import type { ApiClient } from '@/api/client'
import type { Session } from '@/types/api'
import { useTranslation } from '@/lib/use-translation'
import { getSessionModelLabel } from '@/lib/sessionModelLabel'
import { getSessionTitle } from '@/lib/sessionTitle'
import { isFastServiceTier } from '@/components/AssistantChat/codexFastMode'
import { useSessionHeaderMetadata } from '@/hooks/useSessionHeaderMetadata'
import { useMachines } from '@/hooks/queries/useMachines'
import { useMachineLabels } from '@/hooks/useMachineLabels'
import { resolveSessionHeaderMachineLabel } from '@/components/SessionHeader'
import { formatRelativeTime } from '@/lib/relativeTime'
import { formatSessionHeaderTimestamp } from '@/lib/sessionHeaderTimestamp'
import { getShareTurnReasoningLabel, selectShareTurnMetadata } from '@/lib/shareTurnMetadata'
import { useMinuteTick } from '@/hooks/useMinuteTick'
export type ShareTurnState = {
    id: number
    snapshots: ShareTurnSnapshot[]
    sourceContentWidth: number | null
} | null

export type ShareTurnSnapshot = {
    html: string
    text: string
    role?: 'user' | 'assistant'
}

export function findNearestMessageElement(content: HTMLElement, clientY?: number): HTMLElement | null {
    const messages = Array.from(content.querySelectorAll('.happy-thread-messages > [id]'))
        .filter((element): element is HTMLElement => element instanceof HTMLElement)
    if (messages.length === 0) return null
    if (typeof clientY !== 'number' || !Number.isFinite(clientY)) {
        return messages[messages.length - 1] ?? null
    }

    let best: HTMLElement | null = null
    let bestDistance = Number.POSITIVE_INFINITY
    for (const message of messages) {
        const rect = message.getBoundingClientRect()
        const distance = clientY < rect.top
            ? rect.top - clientY
            : clientY > rect.bottom
                ? clientY - rect.bottom
                : 0
        if (distance < bestDistance) {
            best = message
            bestDistance = distance
        }
    }
    return best
}

export function prependMissingUserSnapshot(
    snapshots: ShareTurnSnapshot[],
    fallbackSnapshot?: ShareTurnSnapshot
): ShareTurnSnapshot[] {
    const hasUser = snapshots.some((snapshot) =>
        snapshot.role === 'user' || snapshot.html.includes('data-hapi-message-role="user"')
    )
    if (hasUser || fallbackSnapshot?.role !== 'user' || fallbackSnapshot.text.trim().length === 0) {
        return snapshots
    }
    return [fallbackSnapshot, ...snapshots]
}

export function useShareTurnCapture(props: {
    api: ApiClient
    session: Session
    serviceTier?: string | null
    contentRef: RefObject<HTMLDivElement | null>
}) {
    const { t, locale } = useTranslation()
    const { contentRef } = props
    const shareTurnIdRef = useRef(0)
    const { preferences: headerMetadata } = useSessionHeaderMetadata()
    const { machines } = useMachines(props.api, true)
    const machineLabelsById = useMachineLabels(machines)
    const [shareTurn, setShareTurn] = useState<ShareTurnState>(null)
    const shareDialogOpen = shareTurn !== null
    const shareTitle = shareTurn ? getSessionTitle(props.session) : ''
    const shareRelativeTimeTick = useMinuteTick(headerMetadata.lastActive && shareDialogOpen)
    const shareMetadataItems = useMemo(() => {
        const agentFlavor = props.session.metadata?.flavor ?? null
        const agentLabel = agentFlavor?.trim() || null
        const machineLabel = resolveSessionHeaderMachineLabel(props.session, machineLabelsById)
        const modelLabel = getSessionModelLabel(props.session)
        const reasoningLabel = getShareTurnReasoningLabel(
            agentFlavor,
            props.session.modelReasoningEffort,
            props.session.effort,
            headerMetadata.showLabels
        )
        const lastActiveAt = props.session.activeAt || props.session.updatedAt || props.session.createdAt
        const lastActiveLabel = lastActiveAt > 0 ? formatRelativeTime(lastActiveAt, t) : null
        const createdAtLabel = formatSessionHeaderTimestamp(props.session.createdAt, locale)
        const updatedAtLabel = formatSessionHeaderTimestamp(props.session.updatedAt, locale)
        const worktreeBranch = props.session.metadata?.worktree?.branch?.trim() || null
        const showFastBadge = agentFlavor === 'codex'
            && isFastServiceTier(props.serviceTier ?? props.session.serviceTier)

        return selectShareTurnMetadata(headerMetadata, {
            agent: agentLabel ? { text: agentLabel, flavor: agentFlavor } : undefined,
            machine: machineLabel ? {
                text: `${headerMetadata.showLabels ? `${t('session.item.machine')}: ` : ''}${machineLabel}`,
            } : undefined,
            lastActive: lastActiveLabel ? { text: lastActiveLabel } : undefined,
            model: modelLabel ? {
                text: `${headerMetadata.showLabels ? `${t(modelLabel.key)}: ` : ''}${modelLabel.value}`,
            } : undefined,
            reasoning: reasoningLabel ? { text: reasoningLabel } : undefined,
            fastMode: showFastBadge ? { text: 'fast' } : undefined,
            createdAt: createdAtLabel ? {
                text: `${headerMetadata.showLabels ? `${t('session.header.createdAt')}: ` : ''}${createdAtLabel}`,
            } : undefined,
            updatedAt: updatedAtLabel ? {
                text: `${headerMetadata.showLabels ? `${t('session.header.updatedAt')}: ` : ''}${updatedAtLabel}`,
            } : undefined,
            worktree: worktreeBranch ? {
                text: `${headerMetadata.showLabels ? `${t('session.item.worktree')}: ` : ''}${worktreeBranch}`,
            } : undefined,
        })
    }, [headerMetadata, locale, machineLabelsById, props.serviceTier, props.session, shareDialogOpen, shareRelativeTimeTick, t])
    const handleShareTurn = useCallback((
        messageTarget: HTMLElement | string | null,
        clientY?: number,
        fallbackSnapshot?: ShareTurnSnapshot
    ) => {
        const content = contentRef.current
        if (!content) return
        const messageContainer = content.querySelector<HTMLElement>('.happy-thread-messages')
        const sourceContentWidth = messageContainer?.getBoundingClientRect().width
            ?? content.getBoundingClientRect().width

        let target: HTMLElement | null = typeof messageTarget === 'string'
            ? document.getElementById(messageTarget)
            : messageTarget
        if (!(target instanceof HTMLElement) || !content.contains(target)) {
            target = findNearestMessageElement(content, clientY)
        }
        if (!(target instanceof HTMLElement) || !content.contains(target)) {
            setShareTurn({
                id: ++shareTurnIdRef.current,
                snapshots: fallbackSnapshot ? [fallbackSnapshot] : [],
                sourceContentWidth: sourceContentWidth > 0 ? sourceContentWidth : null,
            })
            return
        }

        let start: Element | null = target
        while (start?.previousElementSibling && start.getAttribute('data-hapi-message-role') !== 'user') {
            start = start.previousElementSibling
        }
        if (!start || start.getAttribute('data-hapi-message-role') !== 'user') {
            start = target
        }

        const snapshots: ShareTurnSnapshot[] = []
        let current: Element | null = start
        while (current instanceof HTMLElement) {
            if (current !== start && current.getAttribute('data-hapi-message-role') === 'user') {
                break
            }
            const role = current.getAttribute('data-hapi-message-role')
            if (role === 'user' || role === 'assistant') {
                snapshots.push({
                    html: current.outerHTML,
                    text: (current.innerText || current.textContent || '').trim()
                })
            }
            current = current.nextElementSibling
        }

        if (snapshots.length === 0 && target instanceof HTMLElement) {
            snapshots.push({
                html: target.outerHTML,
                text: (target.innerText || target.textContent || '').trim()
            })
        }
        if (snapshots.length === 0 && fallbackSnapshot) {
            snapshots.push(fallbackSnapshot)
        }
        const completeSnapshots = prependMissingUserSnapshot(snapshots, fallbackSnapshot)

        setShareTurn({
            id: ++shareTurnIdRef.current,
            snapshots: completeSnapshots,
            sourceContentWidth: sourceContentWidth > 0 ? sourceContentWidth : null,
        })
    }, [contentRef])

    const closeShareTurn = useCallback(() => {
        setShareTurn(null)
    }, [])

    return {
        shareTurn,
        shareTitle,
        shareMetadataItems,
        handleShareTurn,
        closeShareTurn,
    }
}
