import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { RefObject } from 'react'
import type { TimelineEntryRef } from '@/chat/store/sessionEntityStore'
import { captureScrollAnchor } from '@/components/AssistantChat/threadScrollHelpers'
import { getConversationMessageAnchorId } from '@/chat/outline'

export const ENTRY_ESTIMATE_PX = 300
export const ENTRY_OVERSCAN_PX = 600
const REVEAL_EVENT = 'hapi:reveal-thread-entry'
type RevealRequest = { id: string; complete: (mounted: boolean) => void }

/** A jump must also mount an already-visible placeholder, where no scroll event fires. */
export function revealThreadEntry(viewport: HTMLElement, id: string): Promise<boolean> {
    return new Promise((complete) => {
        const handled = !viewport.dispatchEvent(new CustomEvent<RevealRequest>(REVEAL_EVENT, {
            detail: { id, complete }, cancelable: true,
        }))
        if (!handled) complete(false)
    })
}

function seed(entries: readonly TimelineEntryRef[]): ReadonlySet<string> {
    return new Set(entries.slice(entries.length <= 3 ? 0 : -2).map((entry) => entry.id))
}

/** Heights belong to this mounted session only. Unknown history never forces eager JSX. */
export function useThreadEntryWindow(
    owner: object,
    entries: readonly TimelineEntryRef[],
    viewportRef?: RefObject<HTMLDivElement | null>,
    followsTail?: () => boolean,
) {
    const heights = useMemo(() => new Map<string, number>(), [owner])
    const [windowState, setWindowState] = useState(() => ({ owner, ids: seed(entries) }))
    if (windowState.owner !== owner) {
        setWindowState({ owner, ids: seed(entries) })
    }
    const mountedIds = windowState.owner === owner && windowState.ids.size > 0
        ? windowState.ids : seed(entries)
    const pendingRestore = useRef<null | (() => void)>(null)
    const reveal = useRef<RevealRequest | null>(null)
    const passRef = useRef<() => void>(() => {})
    const frame = useRef<number | null>(null)
    const measuredWidth = useRef<number | null>(null)
    const viewport = useCallback(() => viewportRef?.current
        ?? document.querySelector<HTMLElement>('.chat-scroll-y')
        ?? document.querySelector<HTMLElement>('.app-scroll-y'), [viewportRef])
    const schedule = useCallback(() => {
        if (frame.current !== null) return
        frame.current = requestAnimationFrame(() => {
            frame.current = null
            passRef.current()
        })
    }, [])

    useLayoutEffect(() => {
        if (reveal.current && !entries.some((entry) => entry.id === reveal.current?.id)) {
            reveal.current.complete(false)
            reveal.current = null
        }
        const node = viewport()
        if (!node) return
        for (const element of node.querySelectorAll<HTMLElement>('[data-thread-entry-id]:not([data-hapi-offscreen-placeholder])')) {
            const height = element.getBoundingClientRect().height || element.offsetHeight
            if (height > 0) heights.set(element.dataset.threadEntryId!, height)
        }
        pendingRestore.current?.()
        pendingRestore.current = null
        if (reveal.current && [...node.querySelectorAll<HTMLElement>('[data-thread-entry-id]:not([data-hapi-offscreen-placeholder])')]
            .some((element) => element.dataset.threadEntryId === reveal.current?.id)) {
            reveal.current.complete(true)
            reveal.current = null
        }
    })

    useLayoutEffect(() => {
        passRef.current = () => {
            const node = viewport()
            if (!node || node.clientHeight <= 0) return
            const bounds = node.getBoundingClientRect()
            const widthChanged = measuredWidth.current !== null && measuredWidth.current !== node.clientWidth
            if (widthChanged) heights.clear()
            measuredWidth.current = node.clientWidth
            const elements = new Map([...node.querySelectorAll<HTMLElement>('[data-thread-entry-id]')]
                .map((element) => [element.dataset.threadEntryId!, element]))
            const next = new Set<string>()
            const target = reveal.current?.id
            let admissions = 0
            let deferred = false
            let runningTop = 0
            for (const entry of entries) {
                const element = elements.get(entry.id)
                const rect = element?.getBoundingClientRect()
                if (element && !element.hasAttribute('data-hapi-offscreen-placeholder')) {
                    const measured = rect?.height || element.offsetHeight
                    if (measured > 0) heights.set(entry.id, measured)
                }
                const height = heights.get(entry.id) ?? ENTRY_ESTIMATE_PX
                const explicit = rect && (rect.height > 0 || rect.top !== 0 || rect.bottom !== 0)
                const top = explicit ? rect.top - bounds.top + node.scrollTop : runningTop
                const bottom = top + (explicit ? rect.height : height)
                runningTop = bottom + 12
                const wanted = entries.length <= 3 || entry.id === target
                    || (bottom >= node.scrollTop - ENTRY_OVERSCAN_PX
                        && top <= node.scrollTop + node.clientHeight + ENTRY_OVERSCAN_PX)
                if (!wanted) continue
                if (mountedIds.has(entry.id) || entry.id === target || admissions < 2) {
                    next.add(entry.id)
                    if (!mountedIds.has(entry.id)) admissions += 1
                } else deferred = true
            }
            if (next.size === 0 && entries.length > 0) next.add(entries[entries.length - 1]!.id)
            const changed = widthChanged || next.size !== mountedIds.size || [...next].some((id) => !mountedIds.has(id))
            if (changed) {
                const anchor = captureScrollAnchor(node)
                const tail = followsTail?.() ?? node.scrollHeight - node.scrollTop - node.clientHeight < 2
                const previousOverflowAnchor = node.style.overflowAnchor
                node.style.overflowAnchor = 'none'
                pendingRestore.current = () => {
                    if (tail) node.scrollTop = Math.max(0, node.scrollHeight - node.clientHeight)
                    else if (anchor) {
                        const target = document.getElementById(anchor.id)
                            ?? document.getElementById(getConversationMessageAnchorId(anchor.id))
                        if (target && node.contains(target)) {
                            node.scrollTop += target.getBoundingClientRect().top
                                - node.getBoundingClientRect().top - anchor.topOffset
                        }
                    }
                    node.style.overflowAnchor = previousOverflowAnchor
                }
                setWindowState({ owner, ids: next })
                schedule()
            } else if (deferred) schedule()
        }
    }, [owner, entries, mountedIds, heights, followsTail, viewport, schedule])

    useEffect(() => {
        const node = viewport()
        if (!node) return
        // Admission is deferred beyond the seed commit and initial scroll positioning.
        const first = requestAnimationFrame(schedule)
        const request = (event: Event) => {
            event.preventDefault()
            reveal.current?.complete(false)
            const detail = (event as CustomEvent<RevealRequest>).detail
            if (!entries.some((entry) => entry.id === detail.id)) {
                detail.complete(false)
                reveal.current = null
                return
            }
            reveal.current = detail
            schedule()
        }
        const cancelReveal = () => {
            reveal.current?.complete(false)
            reveal.current = null
        }
        const onKeyDown = (event: KeyboardEvent) => {
            if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(event.key)) cancelReveal()
        }
        node.addEventListener('scroll', schedule, { passive: true })
        node.addEventListener('wheel', cancelReveal, { passive: true })
        node.addEventListener('touchstart', cancelReveal, { passive: true })
        node.addEventListener('keydown', onKeyDown)
        node.addEventListener(REVEAL_EVENT, request)
        window.addEventListener('resize', schedule)
        const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule)
        observer?.observe(node)
        for (const element of node.querySelectorAll<HTMLElement>('[data-thread-entry-id]:not([data-hapi-offscreen-placeholder])')) observer?.observe(element)
        const ids = new Set(entries.map((entry) => entry.id))
        for (const id of heights.keys()) if (!ids.has(id)) heights.delete(id)
        return () => {
            cancelAnimationFrame(first)
            if (frame.current !== null) cancelAnimationFrame(frame.current)
            frame.current = null
            observer?.disconnect()
            node.removeEventListener('scroll', schedule)
            node.removeEventListener('wheel', cancelReveal)
            node.removeEventListener('touchstart', cancelReveal)
            node.removeEventListener('keydown', onKeyDown)
            node.removeEventListener(REVEAL_EVENT, request)
            window.removeEventListener('resize', schedule)
        }
    }, [entries, mountedIds, heights, viewport, schedule])
    useEffect(() => () => {
        reveal.current?.complete(false)
        reveal.current = null
        pendingRestore.current?.()
    }, [owner])

    return { mountedIds, heights }
}
