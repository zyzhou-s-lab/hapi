import { ComposerPrimitive } from '@assistant-ui/react'
import * as Popover from '@radix-ui/react-popover'
import type { ConversationStatus } from '@/realtime/types'
import { useTranslation } from '@/lib/use-translation'
import { ScheduleIcon } from '@/components/icons'
import { ScheduleTimePicker } from './ScheduleTimePicker'
import type { PendingSchedule } from './ScheduleTimePicker'
import { useFue } from '@/lib/use-fue'
import { FueCallout, FueDot } from '@/components/Fue'
import { getContextBudgetTokens } from '@/chat/modelConfig'
import { Children, isValidElement, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement, type ReactNode, type Ref } from 'react'
import { createPortal } from 'react-dom'
import { useComposerToolbarLayout, type ComposerToolbarItemId, type ComposerToolbarLayout } from '@/hooks/useComposerToolbarLayout'
import { useNarrowViewport } from '@/hooks/useNarrowViewport'
import type { ComposerSendIntent } from '@/lib/messageDelivery'
function ToolbarItemSlot(props: { item: ComposerToolbarItemId; children: ReactNode }) {
    return <>{props.children}</>
}

const OVERFLOW_MENU_ITEMS: Record<ComposerToolbarItemId, boolean> = {
    attachment: true,
    terminal: true,
    schedule: true,
    voiceMic: true,
    settings: false,
    expand: false,
    model: false,
    effort: false,
    abort: false,
    switch: false,
    scratchlist: false,
}

function isOverflowMenuItem(item: ComposerToolbarItemId): boolean {
    return OVERFLOW_MENU_ITEMS[item]
}

function MoreIcon() {
    return (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <circle cx="5" cy="12" r="1.6" />
            <circle cx="12" cy="12" r="1.6" />
            <circle cx="19" cy="12" r="1.6" />
        </svg>
    )
}

function placeComposerMoreMenu(anchor: DOMRect, menu: DOMRect): { top: number; left: number } {
    const margin = 8
    const gap = 8
    let top = anchor.top - menu.height - gap
    if (top < margin) top = Math.min(anchor.bottom + gap, window.innerHeight - menu.height - margin)
    let left = anchor.left
    if (left + menu.width > window.innerWidth - margin) left = window.innerWidth - margin - menu.width
    if (left < margin) left = margin
    return { top, left }
}

function ComposerMoreMenu(props: { children: ReactNode }) {
    const { t } = useTranslation()
    const [open, setOpen] = useState(false)
    const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
    const buttonRef = useRef<HTMLButtonElement>(null)
    const menuRef = useRef<HTMLDivElement>(null)
    useEffect(() => {
        if (!open) return
        const close = (event: PointerEvent) => {
            const target = event.target
            if (!(target instanceof Node)) return
            if (buttonRef.current?.contains(target) || menuRef.current?.contains(target)) return
            setOpen(false)
        }
        document.addEventListener('pointerdown', close)
        return () => document.removeEventListener('pointerdown', close)
    }, [open])
    useLayoutEffect(() => {
        if (!open) {
            setPos(null)
            return
        }
        const place = () => {
            const anchor = buttonRef.current?.getBoundingClientRect()
            const menu = menuRef.current?.getBoundingClientRect()
            if (!anchor || !menu) return
            setPos(placeComposerMoreMenu(anchor, menu))
        }
        place()
        window.addEventListener('resize', place)
        window.addEventListener('scroll', place, true)
        return () => {
            window.removeEventListener('resize', place)
            window.removeEventListener('scroll', place, true)
        }
    }, [open])
    return (
        <div className="relative shrink-0">
            <button
                ref={buttonRef}
                type="button"
                data-testid="composer-more"
                aria-expanded={open}
                aria-haspopup="menu"
                aria-label={t('composer.more')}
                className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--app-fg)]/60 transition-colors hover:bg-[var(--app-bg)] hover:text-[var(--app-fg)]"
                onClick={() => setOpen((value) => !value)}
            >
                <MoreIcon />
            </button>
            {typeof document !== 'undefined' ? createPortal(
                <div
                    ref={menuRef}
                    role="menu"
                    hidden={!open}
                    data-testid="composer-more-menu"
                    className="composer-more-menu fixed z-[80] flex min-w-48 flex-col gap-1 rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] p-1 shadow-lg"
                    style={open ? (pos ? { top: pos.top, left: pos.left } : { visibility: 'hidden' }) : undefined}
                    onClick={(event) => {
                        const target = event.target
                        if (target instanceof Element && target.closest('button')) setOpen(false)
                    }}
                >
                    {props.children}
                </div>,
                document.body,
            ) : null}
        </div>
    )
}

function OrderedToolbarItems(props: { layout: ComposerToolbarLayout; children: ReactNode }) {
    const slots = Children.toArray(props.children).filter(
        (child): child is ReactElement<{ item: ComposerToolbarItemId; children: ReactNode }> => isValidElement(child),
    )
    const slotsByItem = new Map(slots.map((slot) => [slot.props.item, slot]))
    const renderItems = (items: ComposerToolbarItemId[]) => items.map((item) => {
        const slot = slotsByItem.get(item)
        if (!slot || slot.props.children == null) return null
        return <div key={item} className="shrink-0">{slot}</div>
    })
    const placed = [...props.layout.left, ...props.layout.right]
    const strip = placed.filter((item) => !isOverflowMenuItem(item))
    const menu = placed.filter((item) => isOverflowMenuItem(item))
    const stripNodes = props.layout.mode === 'split'
        ? <>{renderItems(props.layout.left.filter((item) => !isOverflowMenuItem(item)))}<span className="flex-1" aria-hidden="true" />{renderItems(props.layout.right.filter((item) => !isOverflowMenuItem(item)))}</>
        : <>{renderItems(strip)}</>

    return (
        <>
            {stripNodes}
            {menu.length > 0 ? <ComposerMoreMenu>{renderItems(menu)}</ComposerMoreMenu> : null}
        </>
    )
}

export function getComposerToolbarJustifyContent(
    mode: ComposerToolbarLayout['mode'],
): 'safe center' | 'safe end' | 'flex-start' {
    return mode === 'center'
        ? 'safe center'
        : mode === 'right'
            ? 'safe end'
            : 'flex-start'
}

function ChevronIcon() {
    return <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M2.5 3.75L5 6.25L7.5 3.75" /></svg>
}

function VoiceAssistantIcon() {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            {/* 三条声波线，代表语音助手的输出 */}
            <path d="M12 6v12" />
            <path d="M8 9v6" />
            <path d="M16 9v6" />
            <path d="M4 11v2" />
            <path d="M20 11v2" />
        </svg>
    )
}

function SpeakerIcon(props: { muted?: boolean }) {
    if (props.muted) {
        // Speaker with X (muted)
        return (
            <svg
                xmlns="http://www.w3.org/2000/svg"
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
            >
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                <line x1="22" y1="9" x2="16" y2="15" />
                <line x1="16" y1="9" x2="22" y2="15" />
            </svg>
        )
    }

    // Speaker with sound waves
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
            <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
            <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
        </svg>
    )
}

function SettingsIcon() {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
    )
}

function SwitchToRemoteIcon() {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <rect x="5" y="2" width="14" height="20" rx="2" ry="2" />
            <line x1="12" y1="18" x2="12.01" y2="18" />
        </svg>
    )
}

function TerminalIcon() {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <rect x="3" y="4" width="18" height="16" rx="2" ry="2" />
            <polyline points="7 9 10 12 7 15" />
            <line x1="12" y1="15" x2="17" y2="15" />
        </svg>
    )
}

function AttachmentIcon() {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <path d="M21.44 11.05l-8.49 8.49a5.5 5.5 0 0 1-7.78-7.78l8.49-8.49a3.5 3.5 0 0 1 4.95 4.95l-8.49 8.49a1.5 1.5 0 0 1-2.12-2.12l7.78-7.78" />
        </svg>
    )
}

function PlusIcon() {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <path d="M12 5v14M5 12h14" />
        </svg>
    )
}

function formatTokenCountCompact(value: number): string {
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
    if (value >= 1_000) return `${Math.round(value / 1_000)}k`
    return String(value)
}

function ContextUsageRingButton(props: {
    contextSize: number
    contextCacheRead?: number
    contextWindow?: number | null
    contextModel?: string | null
    model?: string | null
    agentFlavor?: string | null
}) {
    const { t } = useTranslation()
    const details = useMemo(() => {
        const heuristicModel = props.contextModel ?? props.model
        const maxContextSize = props.contextWindow ?? getContextBudgetTokens(heuristicModel, props.agentFlavor)
        const cacheRead = props.contextCacheRead && props.contextCacheRead > 0
            ? formatTokenCountCompact(props.contextCacheRead)
            : null
        const used = formatTokenCountCompact(props.contextSize)
        if (!maxContextSize) {
            return {
                cacheRead,
                used,
                usedPercentage: null as number | null,
                remaining: null as string | null,
                remainingPercentage: null as number | null,
                toneClass: 'text-[var(--app-hint)]',
            }
        }
        const rawPercent = (props.contextSize / maxContextSize) * 100
        const usedPercentage = Math.min(100, Math.max(0, Math.round(rawPercent)))
        const remainingPercentage = 100 - usedPercentage
        const toneClass = rawPercent >= 90
            ? 'text-[var(--app-badge-error-text)]'
            : rawPercent >= 70
                ? 'text-[var(--app-badge-warning-text)]'
                : 'text-[var(--app-hint)]'
        return {
            cacheRead,
            used,
            usedPercentage,
            remaining: formatTokenCountCompact(Math.max(0, maxContextSize - props.contextSize)),
            remainingPercentage,
            toneClass,
        }
    }, [props.contextSize, props.contextCacheRead, props.contextWindow, props.contextModel, props.model, props.agentFlavor])

    const radius = 5.5
    const circumference = 2 * Math.PI * radius
    const pct = details.usedPercentage ?? 20
    const dashOffset = circumference * (1 - Math.min(100, Math.max(0, pct)) / 100)

    return (
        <Popover.Root>
            <Popover.Trigger asChild>
                <button
                    type="button"
                    data-testid="composer-context-ring"
                    aria-label={t('misc.contextDetails')}
                    title={t('misc.contextDetails')}
                    className={`inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-full px-2 text-[11px] font-medium outline-none transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] focus-visible:ring-1 focus-visible:ring-[var(--app-link)] ${details.toneClass}`}
                >
                    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" className="shrink-0">
                        <circle
                            cx="7"
                            cy="7"
                            r={radius}
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.6"
                            className="opacity-20"
                        />
                        <circle
                            cx="7"
                            cy="7"
                            r={radius}
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.6"
                            strokeDasharray={circumference}
                            strokeDashoffset={dashOffset}
                            strokeLinecap="round"
                            className="origin-center -rotate-90 transition-all"
                        />
                    </svg>
                    <span className="font-mono text-[11px]">
                        {details.usedPercentage !== null ? `${details.usedPercentage}%` : details.used}
                    </span>
                </button>
            </Popover.Trigger>
            <Popover.Portal>
                <Popover.Content
                    side="top"
                    align="end"
                    sideOffset={6}
                    collisionPadding={8}
                    className="z-50 rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-2 shadow-lg"
                >
                    <div className="flex max-w-[min(22rem,calc(100vw-1rem))] flex-col gap-1 text-xs leading-tight text-[var(--app-fg)]">
                        {details.cacheRead ? (
                            <span className="break-words">
                                {t('misc.contextCache', { value: details.cacheRead })}
                            </span>
                        ) : null}
                        <span className="break-words">
                            {details.usedPercentage === null
                                ? t('misc.contextUsedTokens', { value: details.used })
                                : t('misc.contextUsed', {
                                    value: details.used,
                                    percent: details.usedPercentage,
                                })}
                        </span>
                        {details.remaining && details.remainingPercentage !== null ? (
                            <span className="break-words">
                                {t('misc.contextRemaining', {
                                    value: details.remaining,
                                    percent: details.remainingPercentage,
                                })}
                            </span>
                        ) : null}
                    </div>
                </Popover.Content>
            </Popover.Portal>
        </Popover.Root>
    )
}

function ComposerExpandIcon(props: { expanded: boolean }) {
    return props.expanded ? (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <path d="M8 3v5H3" />
            <path d="m3 3 5 5" />
            <path d="M16 3v5h5" />
            <path d="m21 3-5 5" />
            <path d="M8 21v-5H3" />
            <path d="m3 21 5-5" />
            <path d="M16 21v-5h5" />
            <path d="m21 21-5-5" />
        </svg>
    ) : (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <path d="M8 3H3v5" />
            <path d="m3 3 5 5" />
            <path d="M16 3h5v5" />
            <path d="m21 3-5 5" />
            <path d="M8 21H3v-5" />
            <path d="m3 21 5-5" />
            <path d="M16 21h5v-5" />
            <path d="m21 21-5-5" />
        </svg>
    )
}

export function ComposerExpandButton(props: {
    expanded: boolean
    onToggle: () => void
}) {
    const { t } = useTranslation()
    const label = props.expanded ? t('composer.collapse') : t('composer.expand')

    return (
        <button
            type="button"
            aria-label={label}
            title={label}
            aria-pressed={props.expanded}
            className={`flex h-8 w-8 items-center justify-center rounded-full transition-colors ${
                props.expanded
                    ? 'bg-[var(--app-bg)] text-[var(--app-link)]'
                    : 'text-[var(--app-fg)]/60 hover:bg-[var(--app-bg)] hover:text-[var(--app-fg)]'
            }`}
            onClick={props.onToggle}
        >
            <ComposerExpandIcon expanded={props.expanded} />
        </button>
    )
}

function AbortIcon(props: { spinning: boolean }) {
    if (props.spinning) {
        return (
            <svg
                className="animate-spin"
                xmlns="http://www.w3.org/2000/svg"
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
            >
                <circle cx="12" cy="12" r="10" strokeOpacity="0.25" />
                <path d="M12 2a10 10 0 0 1 10 10" strokeOpacity="0.75" />
            </svg>
        )
    }

    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 16 16"
            fill="currentColor"
        >
            <path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Zm4-2.5a.5.5 0 0 1 .5-.5h4a.5.5 0 0 1 .5.5v4a.5.5 0 0 1-.5.5h-4a.5.5 0 0 1-.5-.5v-4Z" />
        </svg>
    )
}

function SendIcon() {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <line x1="12" y1="19" x2="12" y2="5" />
            <polyline points="5 12 12 5 19 12" />
        </svg>
    )
}

function ScratchlistToggleIcon() {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <g transform="translate(0.5 -0.5)">
                <path d="M3.5 2.5h6L12.5 5.5v8a1 1 0 0 1-1 1h-8a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1Z" />
                <path d="M9.5 2.5v3h3M5 8.5h6M5 11h4" />
            </g>
        </svg>
    )
}

export function ComposerToolbarItemPreview(props: { item: ComposerToolbarItemId; label: string }) {
    const icon = (() => {
        switch (props.item) {
            case 'attachment': return <AttachmentIcon />
            case 'settings': return <SettingsIcon />
            case 'expand': return <ComposerExpandIcon expanded={false} />
            case 'terminal': return <TerminalIcon />
            case 'abort': return <AbortIcon spinning={false} />
            case 'switch': return <SwitchToRemoteIcon />
            case 'voiceMic': return <SpeakerIcon />
            case 'scratchlist': return <ScratchlistToggleIcon />
            case 'schedule': return <ScheduleIcon className="h-[18px] w-[18px]" />
            case 'model':
            case 'effort':
                return <><span className="max-w-24 truncate text-xs font-medium">{props.label}</span><ChevronIcon /></>
        }
    })()
    const isTextControl = props.item === 'model' || props.item === 'effort'
    return (
        <span
            className={`flex h-8 items-center justify-center rounded-full text-[var(--app-fg)]/60 ${isTextControl ? 'gap-1 px-3' : 'w-8'}`}
            aria-hidden="true"
        >
            {icon}
        </span>
    )
}

export function ComposerSendButtonPreview() {
    return <span className="flex h-10 w-10 items-center justify-center rounded-full bg-[var(--app-button)] text-[var(--app-button-text)]" aria-hidden="true"><SendIcon /></span>
}

/**
 * ScratchlistToggleButton — composer affordance for toggling scratchlist mode,
 * wrapped in the generic FUE (First-User Experience) primitive so a new
 * operator sees a pulsing dot + a one-time explainer popover the first time
 * they encounter the feature; once they engage with it, the dot disappears
 * for good and the entry counter takes over.
 *
 * The FUE wiring here is the canonical example for future features: the
 * pattern is "wrap the affordance in useFue + FueDot, conditionally render
 * FueCallout while engaging". See web/src/lib/use-fue.ts for the contract.
 */
function ScratchlistToggleButton(props: {
    scratchlistMode: boolean
    scratchlistCount: number
    onScratchlistToggle: () => void
    controlsDisabled?: boolean
}) {
    const { t } = useTranslation()
    const fue = useFue('scratchlist-toggle')
    const buttonRef = useRef<HTMLButtonElement>(null)

    const showFueDot = fue.status !== 'acknowledged'
    // Counter and FUE dot are mutually exclusive (see FueDot doc comment).
    // Onboarding signal beats inventory signal: the user can't read the
    // counter as "you have N items" until they understand the feature.
    const showCounter = !showFueDot && props.scratchlistCount > 0

    return (
        <>
            <button
                ref={buttonRef}
                type="button"
                aria-label={t('scratchlist.toggleAriaLabel')}
                title={t('scratchlist.toggleTooltip')}
                aria-pressed={props.scratchlistMode ? true : false}
                disabled={props.controlsDisabled}
                onClick={() => {
                    fue.engage()
                    props.onScratchlistToggle()
                }}
                className={`relative flex h-8 w-8 items-center justify-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                    props.scratchlistMode
                        ? 'bg-[var(--app-badge-warning-text)] text-[var(--app-bg)] hover:opacity-90'
                        : 'text-[var(--app-fg)]/60 hover:bg-[var(--app-bg)] hover:text-[var(--app-fg)]'
                }`}
            >
                <ScratchlistToggleIcon />
                {showFueDot ? (
                    <FueDot
                        pulsing={fue.status === 'unseen'}
                        ariaLabel={t('fue.newFeatureDot')}
                    />
                ) : null}
                {showCounter ? (
                    <span
                        aria-hidden="true"
                        className="absolute -top-0.5 -right-0.5 min-w-[12px] h-3 px-[3px] flex items-center justify-center rounded-full bg-[var(--app-badge-warning-text)] text-[var(--app-bg)] text-[8px] font-semibold leading-none tabular-nums shadow-sm"
                    >
                        {props.scratchlistCount > 99 ? '99+' : props.scratchlistCount}
                    </span>
                ) : null}
            </button>
            {fue.status === 'engaging' ? (
                <FueCallout
                    title={t('scratchlist.fueTitle')}
                    body={t('scratchlist.fueBody')}
                    onDismiss={fue.dismiss}
                    dismissLabel={t('fue.gotIt')}
                    closeAriaLabel={t('fue.closeAriaLabel')}
                    anchorRef={buttonRef}
                />
            ) : null}
        </>
    )
}

function StopIcon() {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="currentColor"
        >
            <rect x="6" y="6" width="12" height="12" rx="2" />
        </svg>
    )
}

function LoadingIcon() {
    return (
        <svg
            className="animate-spin"
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
        >
            <circle cx="12" cy="12" r="10" strokeOpacity="0.25" />
            <path d="M12 2a10 10 0 0 1 10 10" strokeOpacity="0.75" />
        </svg>
    )
}

export function UnifiedButton(props: {
    canSend: boolean
    voiceStatus: ConversationStatus
    voiceEnabled: boolean
    controlsDisabled: boolean
    onSend: (intent?: ComposerSendIntent) => void
    onVoiceToggle: () => void
    voiceLabel?: string
    /**
     * When true, the send button repaints amber and the aria-label
     * announces "Send to scratchlist" instead of "Send message". The
     * actual routing happens in SessionChat's wrapped onSend - the
     * button itself is content-agnostic.
     *
     * Caller MUST compute this from the actual routing decision (mode
     * AND no-pending-schedule). Attachments in scratchlist mode still
     * route to scratchlist. If the toggle is on but a pending schedule
     * would fall back to chat, the button must look like a normal chat send.
     */
    routesToScratchlist?: boolean
}) {
    const { t } = useTranslation()

    const isConnecting = props.voiceStatus === 'connecting'
    const isConnected = props.voiceStatus === 'connected'
    const isVoiceActive = isConnecting || isConnected
    const hasText = props.canSend
    const routesToScratchlist = props.routesToScratchlist ?? false

    const handleClick = () => {
        if (isVoiceActive) {
            props.onVoiceToggle() // Stop voice
        } else if (hasText) {
            props.onSend('default') // Send message (or scratchlist add — wrapper decides)
        } else if (props.voiceEnabled && !routesToScratchlist) {
            props.onVoiceToggle() // Start voice (suppressed in scratchlist mode)
        }
    }

    let icon: React.ReactNode
    let className: string
    let ariaLabel: string

    if (isConnecting) {
        icon = <LoadingIcon />
        className = 'bg-[var(--app-button)] text-[var(--app-button-text)] hover:opacity-90'
        ariaLabel = t('voice.connecting')
    } else if (isConnected) {
        icon = <StopIcon />
        className = 'bg-[var(--app-button)] text-[var(--app-button-text)] hover:opacity-90'
        ariaLabel = t('composer.stop')
    } else if (routesToScratchlist) {
        // Warning token marks a scratchlist send so it stays distinct from chat send.
        // Single visual signal carries the "this goes to the scratchlist"
        // contract; without it, the modal state is invisible to the user.
        icon = <SendIcon />
        className = 'bg-[var(--app-badge-warning-text)] text-[var(--app-bg)] hover:opacity-90'
        ariaLabel = t('scratchlist.sendToScratchlist')
    } else if (hasText) {
        icon = <SendIcon />
        className = 'bg-[var(--app-button)] text-[var(--app-button-text)] hover:opacity-90'
        ariaLabel = t('composer.send')
    } else if (props.voiceEnabled) {
        icon = <VoiceAssistantIcon />
        className = 'bg-[var(--app-button)] text-[var(--app-button-text)] hover:opacity-90'
        ariaLabel = props.voiceLabel ?? t('composer.voice')
    } else {
        icon = <SendIcon />
        className = 'bg-[var(--app-hint)] text-[var(--app-bg)]'
        ariaLabel = t('composer.send')
    }

    // When the submission routes to scratchlist the send button is the
    // only path that does anything useful, so it must be enabled whenever
    // there is text - we deliberately do NOT fall back to voice-toggle-on-
    // empty-text. (When attachments / schedule force a chat fallback the
    // normal chat-send disable rules apply.)
    const isDisabled = props.controlsDisabled || (
        routesToScratchlist
            ? !hasText
            : !hasText && !props.voiceEnabled && !isVoiceActive
    )

    return (
        <button
            type="button"
            onClick={handleClick}
            disabled={isDisabled}
            aria-label={ariaLabel}
            title={ariaLabel}
            className={`ml-1 flex h-8 w-8 items-center justify-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
        >
            {icon}
        </button>
    )
}

export function DictationButton(props: {
    enabled: boolean
    canSend: boolean
    voiceEnabled: boolean
    voiceStatus: ConversationStatus
    controlsDisabled: boolean
    onVoiceToggle: () => void
}) {
    const { t } = useTranslation()
    if (
        !props.enabled
        || !props.canSend
        || !props.voiceEnabled
        || props.voiceStatus === 'connecting'
        || props.voiceStatus === 'connected'
    ) return null

    return (
        <button
            type="button"
            onClick={props.onVoiceToggle}
            disabled={props.controlsDisabled}
            aria-label={t('composer.dictate')}
            title={t('composer.dictate')}
            className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--app-fg)]/60 transition-colors hover:bg-[var(--app-bg)] hover:text-[var(--app-fg)] disabled:cursor-not-allowed disabled:opacity-50"
        >
            <VoiceAssistantIcon />
        </button>
    )
}

export function ComposerButtons(props: {
    canSend: boolean
    controlsDisabled: boolean
    showSettingsButton: boolean
    settingsButtonRef?: Ref<HTMLButtonElement>
    settingsDisabled?: boolean
    onSettingsToggle: () => void
    expanded: boolean
    onExpandedToggle: () => void
    showTerminalButton: boolean
    terminalDisabled: boolean
    terminalLabel: string
    onTerminal: () => void
    showAbortButton: boolean
    abortDisabled: boolean
    isAborting: boolean
    onAbort: () => void
    showSwitchButton: boolean
    switchDisabled: boolean
    isSwitching: boolean
    onSwitch: () => void
    voiceEnabled: boolean
    dictationEnabled?: boolean
    voiceStatus: ConversationStatus
    voiceMicMuted?: boolean
    onVoiceToggle: () => void
    onVoiceMicToggle?: () => void
    onSend: (intent?: ComposerSendIntent) => void
    pendingSchedule?: PendingSchedule | null
    onSchedule?: (pending: PendingSchedule) => void
    onClearSchedule?: () => void
    // The backend rejects scheduled-send + attachment combinations (the per-CLI
    // upload directory is torn down before a mature emit could read the files).
    // The composer must surface that constraint at UI time so the user never
    // builds a submission the hub will reject — see hub/web/routes/messages.ts.
    hasAttachments?: boolean
    // Generic model/effort value buttons
    modelValueLabel?: string
    modelValueButtonRef?: Ref<HTMLButtonElement>
    modelValueDisabled?: boolean
    modelValueOpen?: boolean
    onModelValueToggle?: () => void
    effortValueLabel?: string
    effortValueButtonRef?: Ref<HTMLButtonElement>
    effortValueDisabled?: boolean
    effortValueOpen?: boolean
    onEffortValueToggle?: () => void
    // Scratchlist drawer toggle. When `onScratchlistToggle` is provided, a
    // notepad icon appears next to the schedule-send icon. Click toggles
    // composer-send-routing between chat and scratchlist; SessionChat owns
    // the actual routing decision via its wrapped onSend.
    scratchlistMode?: boolean
    scratchlistCount?: number
    onScratchlistToggle?: () => void
    inlineLeadingSlot?: HTMLElement | null
    inlineTrailingSlot?: HTMLElement | null
    contextSize?: number
    contextCacheRead?: number
    contextWindow?: number | null
    contextModel?: string | null
    model?: string | null
    agentFlavor?: string | null
}) {
    const { t } = useTranslation()
    const { layout } = useComposerToolbarLayout()
    const isNarrowViewport = useNarrowViewport()
    // Narrow viewports collapse the model/effort value buttons into the settings
    // sheet, so the gear must stay reachable even when a persisted layout hides
    // it (otherwise no session-settings trigger remains). Wide layouts keep
    // honoring the user's hidden choice.
    const effectiveLayout: ComposerToolbarLayout = isNarrowViewport && layout.hidden.includes('settings')
        ? {
            ...layout,
            hidden: layout.hidden.filter((item) => item !== 'settings'),
            left: [...layout.left, 'settings'],
        }
        : layout
    const isVoiceConnected = props.voiceStatus === 'connected'
    const [showSchedulePicker, setShowSchedulePicker] = useState(false)
    const [scheduleAnchor, setScheduleAnchor] = useState<{ top: number; left: number; right: number; bottom: number; width: number; height: number } | null>(null)
    const scheduleButtonRef = useRef<HTMLButtonElement>(null)

    const hasSchedule = props.pendingSchedule != null
    const hasAttachments = props.hasAttachments ?? false
    const toolbarJustifyContent = getComposerToolbarJustifyContent(layout.mode)
    const isExternalSplitMode = Boolean(props.inlineLeadingSlot && props.inlineTrailingSlot)

    const settingsNode = props.showSettingsButton ? (
        <button
            ref={props.settingsButtonRef}
            type="button"
            aria-label={t('composer.settings')}
            title={t('composer.settings')}
            className="settings-button flex h-8 w-8 items-center justify-center rounded-full text-[var(--app-fg)]/60 transition-colors hover:bg-[var(--app-bg)] hover:text-[var(--app-fg)]"
            onClick={props.onSettingsToggle}
            disabled={props.settingsDisabled ?? props.controlsDisabled}
        >
            <SettingsIcon />
        </button>
    ) : null

    const expandNode = (
        <ComposerExpandButton
            expanded={props.expanded}
            onToggle={props.onExpandedToggle}
        />
    )

    const modelNode = props.modelValueLabel ? (
        <button
            ref={props.modelValueButtonRef}
            type="button"
            aria-label={props.modelValueLabel}
            title={props.modelValueLabel}
            className={`flex h-8 items-center gap-1 rounded-full px-3 text-xs font-medium transition-colors ${
                props.modelValueOpen
                    ? 'bg-[var(--app-secondary-bg)] text-[var(--app-link)]'
                    : 'text-[var(--app-fg)]/60 hover:bg-[var(--app-bg)] hover:text-[var(--app-fg)]'
            }`}
            onClick={props.onModelValueToggle}
            disabled={props.modelValueDisabled}
        >
            {props.modelValueLabel}
            <ChevronIcon />
        </button>
    ) : null

    const effortNode = props.effortValueLabel ? (
        <button
            ref={props.effortValueButtonRef}
            type="button"
            aria-label={props.effortValueLabel}
            title={props.effortValueLabel}
            className={`flex h-8 items-center gap-1 rounded-full px-3 text-xs font-medium transition-colors ${
                props.effortValueOpen
                    ? 'bg-[var(--app-secondary-bg)] text-[var(--app-link)]'
                    : 'text-[var(--app-fg)]/60 hover:bg-[var(--app-bg)] hover:text-[var(--app-fg)]'
            }`}
            onClick={props.onEffortValueToggle}
            disabled={props.effortValueDisabled}
        >
            {props.effortValueLabel}
            <ChevronIcon />
        </button>
    ) : null

    const terminalNode = props.showTerminalButton ? (
        <button
            type="button"
            aria-label={props.terminalLabel}
            title={props.terminalLabel}
            className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--app-fg)]/60 transition-colors hover:bg-[var(--app-bg)] hover:text-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
            onClick={props.onTerminal}
            disabled={props.terminalDisabled}
        >
            <TerminalIcon />
            <span className="composer-more-label">{props.terminalLabel}</span>
        </button>
    ) : null

    const abortNode = props.showAbortButton ? (
        <button
            type="button"
            aria-label={t('composer.abort')}
            title={t('composer.abort')}
            disabled={props.abortDisabled}
            className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--app-fg)]/60 transition-colors hover:bg-[var(--app-bg)] hover:text-[var(--app-badge-error-text)] disabled:cursor-not-allowed disabled:opacity-50"
            onClick={props.onAbort}
        >
            <AbortIcon spinning={props.isAborting} />
        </button>
    ) : null

    const switchNode = props.showSwitchButton ? (
        <button
            type="button"
            aria-label={t('composer.switchRemote')}
            title={t('composer.switchRemote')}
            disabled={props.switchDisabled}
            className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--app-fg)]/60 transition-colors hover:bg-[var(--app-bg)] hover:text-[var(--app-link)] disabled:cursor-not-allowed disabled:opacity-50"
            onClick={props.onSwitch}
        >
            <SwitchToRemoteIcon />
        </button>
    ) : null

    const voiceMicNode = isVoiceConnected && props.onVoiceMicToggle ? (
        <button
            type="button"
            aria-label={props.voiceMicMuted ? t('voice.unmute') : t('voice.mute')}
            title={props.voiceMicMuted ? t('voice.unmute') : t('voice.mute')}
            className={`flex h-8 w-8 items-center justify-center rounded-full transition-colors ${
                props.voiceMicMuted
                    ? 'bg-[var(--app-secondary-bg)] text-[var(--app-fg)] hover:bg-[var(--app-border)]'
                    : 'text-[var(--app-fg)]/60 hover:bg-[var(--app-bg)] hover:text-[var(--app-fg)]'
            }`}
            onClick={props.onVoiceMicToggle}
        >
            <SpeakerIcon muted={props.voiceMicMuted} />
            <span className="composer-more-label">{props.voiceMicMuted ? t('voice.unmute') : t('voice.mute')}</span>
        </button>
    ) : null

    const scratchlistNode = props.onScratchlistToggle ? (
        <div>
            <ScratchlistToggleButton
                scratchlistMode={props.scratchlistMode ?? false}
                scratchlistCount={props.scratchlistCount ?? 0}
                onScratchlistToggle={props.onScratchlistToggle}
                controlsDisabled={props.controlsDisabled}
            />
        </div>
    ) : null

    const scheduleNode = props.onSchedule ? (
        <div>
            <button
                ref={scheduleButtonRef}
                type="button"
                aria-label={t('composer.scheduleSend')}
                title={t('composer.scheduleSend')}
                disabled={props.controlsDisabled || hasAttachments}
                onClick={() => {
                    if (hasSchedule && props.onClearSchedule) {
                        props.onClearSchedule()
                        return
                    }
                    const rect = scheduleButtonRef.current?.getBoundingClientRect()
                    if (rect) {
                        setScheduleAnchor({ top: rect.top, left: rect.left, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height })
                    }
                    setShowSchedulePicker((v) => !v)
                }}
                className={`flex h-8 w-8 items-center justify-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                    hasSchedule
                        ? 'bg-[var(--app-button)] text-[var(--app-button-text)] hover:opacity-90'
                        : 'text-[var(--app-fg)]/60 hover:bg-[var(--app-bg)] hover:text-[var(--app-fg)]'
                }`}
            >
                <ScheduleIcon className="h-[18px] w-[18px]" />
                <span className="composer-more-label">{t('composer.scheduleSend')}</span>
            </button>
            {showSchedulePicker && (
                <ScheduleTimePicker
                    anchorRef={scheduleButtonRef}
                    fallbackAnchor={scheduleAnchor}
                    onSchedule={(pending) => {
                        props.onSchedule!(pending)
                        setShowSchedulePicker(false)
                    }}
                    onClose={() => setShowSchedulePicker(false)}
                    pendingSchedule={props.pendingSchedule}
                />
            )}
        </div>
    ) : null

    const primaryActionsCluster = (
        <>
            <DictationButton
                enabled={props.dictationEnabled ?? false}
                canSend={props.canSend}
                voiceEnabled={props.voiceEnabled}
                voiceStatus={props.voiceStatus}
                controlsDisabled={props.controlsDisabled}
                onVoiceToggle={props.onVoiceToggle}
            />

            <UnifiedButton
                canSend={props.canSend}
                voiceStatus={props.voiceStatus}
                voiceEnabled={props.voiceEnabled}
                controlsDisabled={props.controlsDisabled}
                onSend={props.onSend}
                onVoiceToggle={props.onVoiceToggle}
                voiceLabel={props.dictationEnabled ? t('composer.dictate') : undefined}
                routesToScratchlist={
                    (props.scratchlistMode ?? false)
                    && props.pendingSchedule == null
                }
            />
        </>
    )

    if (isExternalSplitMode && props.inlineLeadingSlot && props.inlineTrailingSlot) {
        const showSettingsInLeft = Boolean(
            settingsNode && (!effectiveLayout.hidden.includes('settings') || isNarrowViewport),
        )
        const showModelInLeft = Boolean(modelNode && !effectiveLayout.hidden.includes('model'))
        const showEffortInLeft = Boolean(effortNode && !effectiveLayout.hidden.includes('effort'))
        const showTerminalInRight = Boolean(terminalNode && !effectiveLayout.hidden.includes('terminal'))
        const showScratchlistInRight = Boolean(scratchlistNode && !effectiveLayout.hidden.includes('scratchlist'))
        const showScheduleInRight = Boolean(scheduleNode && !effectiveLayout.hidden.includes('schedule'))
        const showExpandInRight = !effectiveLayout.hidden.includes('expand')
        const showContextRing = props.contextSize !== undefined && props.agentFlavor !== 'cursor'

        return (
            <>
                {createPortal(
                    <ComposerPrimitive.AddAttachment
                        aria-label={t('composer.attach')}
                        title={t('composer.attach')}
                        disabled={props.controlsDisabled || hasSchedule}
                        data-testid="composer-attach-plus"
                        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--app-subtle-bg)] text-[var(--app-fg)]/75 transition-colors hover:bg-[var(--app-border)] hover:text-[var(--app-fg)] disabled:cursor-not-allowed disabled:opacity-50"
                    >
                        <PlusIcon />
                    </ComposerPrimitive.AddAttachment>,
                    props.inlineLeadingSlot,
                )}
                {createPortal(
                    <>
                        {voiceMicNode}
                        {abortNode}
                        {switchNode}
                        {primaryActionsCluster}
                    </>,
                    props.inlineTrailingSlot,
                )}
                <div
                    data-testid="composer-external-bar"
                    className="mt-1.5 flex shrink-0 items-center justify-between gap-2 px-1"
                >
                    <div
                        data-testid="composer-toolbar-items"
                        className="flex min-w-0 flex-1 items-center gap-1"
                    >
                        {showSettingsInLeft ? <div className="shrink-0">{settingsNode}</div> : null}
                        {showModelInLeft ? <div className="shrink-0">{modelNode}</div> : null}
                        {showEffortInLeft ? <div className="shrink-0">{effortNode}</div> : null}
                    </div>
                    <div
                        data-testid="composer-external-right"
                        className="flex shrink-0 items-center gap-1"
                    >
                        {showTerminalInRight ? <div className="shrink-0">{terminalNode}</div> : null}
                        {showScratchlistInRight ? <div className="shrink-0">{scratchlistNode}</div> : null}
                        {showScheduleInRight ? <div className="shrink-0">{scheduleNode}</div> : null}
                        {showExpandInRight ? <div className="shrink-0">{expandNode}</div> : null}
                        {showContextRing ? (
                            <>
                                <span aria-hidden="true" className="mx-0.5 h-3.5 w-px bg-[var(--app-border)]" />
                                <ContextUsageRingButton
                                    contextSize={props.contextSize!}
                                    contextCacheRead={props.contextCacheRead}
                                    contextWindow={props.contextWindow}
                                    contextModel={props.contextModel}
                                    model={props.model}
                                    agentFlavor={props.agentFlavor}
                                />
                            </>
                        ) : null}
                    </div>
                </div>
            </>
        )
    }

    return (
        <div className="flex shrink-0 items-center gap-1 px-2 pb-2">
            <div
                data-testid="composer-toolbar-items"
                className="flex min-w-0 flex-1 items-center gap-1"
                style={{ justifyContent: toolbarJustifyContent }}
            >
                <OrderedToolbarItems layout={effectiveLayout}>
                <ToolbarItemSlot item="attachment">
                <ComposerPrimitive.AddAttachment
                    aria-label={t('composer.attach')}
                    title={t('composer.attach')}
                    disabled={props.controlsDisabled || hasSchedule}
                    className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--app-fg)]/60 transition-colors hover:bg-[var(--app-bg)] hover:text-[var(--app-fg)] disabled:cursor-not-allowed disabled:opacity-50"
                >
                    <AttachmentIcon />
                    <span className="composer-more-label">{t('composer.attach')}</span>
                </ComposerPrimitive.AddAttachment>
                </ToolbarItemSlot>

                <ToolbarItemSlot item="settings">{settingsNode}</ToolbarItemSlot>
                <ToolbarItemSlot item="expand">{expandNode}</ToolbarItemSlot>
                <ToolbarItemSlot item="model">{modelNode}</ToolbarItemSlot>
                <ToolbarItemSlot item="effort">{effortNode}</ToolbarItemSlot>
                <ToolbarItemSlot item="terminal">{terminalNode}</ToolbarItemSlot>
                <ToolbarItemSlot item="abort">{abortNode}</ToolbarItemSlot>
                <ToolbarItemSlot item="switch">{switchNode}</ToolbarItemSlot>
                <ToolbarItemSlot item="voiceMic">{voiceMicNode}</ToolbarItemSlot>
                <ToolbarItemSlot item="scratchlist">{scratchlistNode}</ToolbarItemSlot>
                <ToolbarItemSlot item="schedule">{scheduleNode}</ToolbarItemSlot>
                </OrderedToolbarItems>
            </div>

            {primaryActionsCluster}
        </div>
    )
}
