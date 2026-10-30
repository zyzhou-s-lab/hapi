import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { useNavigate } from '@tanstack/react-router'
import type { SessionSummary } from '@/types/api'
import { useAppContext } from '@/lib/app-context'
import { useTranslation } from '@/lib/use-translation'
import { getSessionTitle } from '@/lib/sessionTitle'
import { getSessionLastSeenAt, useSessionLastSeenVersion } from '@/lib/sessionLastSeen'
import { getSessionListSelectionNavigation, PRESERVE_SESSION_SIDEBAR_SCROLL } from '@/lib/sessionNavigation'
import { cn } from '@/lib/utils'
import { useLongPress } from '@/hooks/useLongPress'
import { usePlatform } from '@/hooks/usePlatform'
import { safeCopyToClipboard } from '@/lib/clipboard'
import { buildSessionReferenceText } from '@/lib/sessionReference'
import { useToast } from '@/lib/toast-context'
import { TabSessionDialog, type TabSessionDialogKind } from './TabSessionDialogs'
import { sessionDirectoryGroupKey } from '@/lib/sessionDirectoryGroup'
import {
    MAX_SESSION_TABS,
    adoptLegacyTabs,
    allTabIds,
    applyToGroup,
    closeOtherTabs,
    closeTabInDirectory,
    closeTabsToRight,
    confirmedDeletedIds,
    getSessionTabsSnapshot,
    moveTab,
    openTabInDirectory,
    pruneDeletedTabs,
    rehomeTabs,
    tabsMissingFromFirstList,
    togglePinTab,
    updateSessionTabs,
    useSessionTabsState,
} from './sessionTabsStore'
import { canCloseOpenTab, isEditableTarget, isTerminalTarget, matchTabShortcut } from './tabShortcuts'
import './sessionTabs.css'

/** 标签按 hub + 账号分开存：同一浏览器切账号不会串。 */
export function useSessionTabsScope(): string {
    const { baseUrl, user } = useAppContext()
    return `${baseUrl}|${user.id}`
}

function directoryKeyOf(selectedSessionId: string | null, sessions: readonly SessionSummary[]): string | null {
    if (!selectedSessionId) return null
    const session = sessions.find(item => item.id === selectedSessionId)
    return session ? sessionDirectoryGroupKey(session) : null
}

/** 正在看的会话用它所在目录；总览（没有选中会话，或会话还没出现在列表里）用上次那个目录。 */
function visibleSessionDirectoryKey(
    selectedSessionId: string | null,
    sessions: readonly SessionSummary[],
    activeDirectoryKey: string | null,
): string | null {
    return directoryKeyOf(selectedSessionId, sessions) ?? activeDirectoryKey
}

/**
 * 打开当前会话并放进它所在目录的标签。`loaded` 必须是一次成功的、未过滤的会话列表（含归档）。
 * 第一次成功的列表会丢掉已经不在列表里的标签（所有窗口都关着时被删掉的会话），
 * 但本窗口刚打开、列表还没跟上的 id 留着。之后只丢掉从这份列表里消失的。
 * 未加载完、侧栏过滤、归档隐藏都不会删标签。
 */
export function useSessionTabsSync(selectedSessionId: string | null, sessions: SessionSummary[], loaded: boolean): void {
    const scope = useSessionTabsScope()
    const { t } = useTranslation()
    const { addToast } = useToast()
    const baseline = useRef<{ scope: string; ids: Set<string> } | null>(null)
    const openedThisWindow = useRef<{ scope: string; ids: Set<string> } | null>(null)
    const directoryKey = directoryKeyOf(selectedSessionId, sessions)
    const groups = useSessionTabsState(scope)
    const visibleKey = visibleSessionDirectoryKey(selectedSessionId, sessions, groups.activeDirectoryKey)
    const visibleTabs = visibleKey ? groups.groups[visibleKey] ?? [] : []

    useEffect(() => {
        if (!selectedSessionId || !directoryKey) return
        if (openedThisWindow.current?.scope !== scope) openedThisWindow.current = { scope, ids: new Set() }
        openedThisWindow.current.ids.add(selectedSessionId)
        const result = openTabInDirectory(getSessionTabsSnapshot(scope), directoryKey, selectedSessionId, Date.now())
        if (result.state !== getSessionTabsSnapshot(scope)) updateSessionTabs(scope, () => result.state)
        if (result.rejected !== 'pinned-full') return
        // StrictMode 会马上清掉第一次 effect。延后到下一个任务，开发模式只提示一次。
        const timer = window.setTimeout(() => {
            addToast({
                title: t('tabs.pinnedFull.title'),
                body: t('tabs.pinnedFull.body', { count: MAX_SESSION_TABS }),
                sessionId: selectedSessionId,
                url: window.location.href,
                variant: 'warning',
            })
        }, 0)
        return () => window.clearTimeout(timer)
    }, [scope, selectedSessionId, directoryKey, addToast, t])

    useEffect(() => {
        if (!loaded) return
        const current = new Set(sessions.map(session => session.id))
        const directoryById = new Map(sessions.map(session => [session.id, sessionDirectoryGroupKey(session)]))
        updateSessionTabs(scope, state => {
            const previous = baseline.current?.scope === scope ? baseline.current.ids : null
            const opened = openedThisWindow.current?.scope === scope ? openedThisWindow.current.ids : new Set<string>()
            const deleted = previous
                ? confirmedDeletedIds(previous, current)
                : tabsMissingFromFirstList(allTabIds(state), current, opened)
            baseline.current = { scope, ids: current }
            return rehomeTabs(adoptLegacyTabs(pruneDeletedTabs(state, deleted), directoryById), directoryById)
        })
    }, [scope, loaded, sessions])

    useSessionTabShortcuts(scope, selectedSessionId, visibleKey, visibleTabs)
}

/** 关掉一个标签；关的是当前会话时跳到同一目录里的相邻标签，没有就回会话首页。 */
function closeSessionTab(
    scope: string,
    directoryKey: string | null,
    id: string,
    selectedSessionId: string | null,
    go: (id: string | null) => void,
): void {
    let neighbor: string | null = null
    updateSessionTabs(scope, state => {
        const result = closeTabInDirectory(state, directoryKey, id)
        neighbor = result.neighbor
        return result.state
    })
    if (id === selectedSessionId) go(neighbor)
}

/** 见 matchTabShortcut。没有可关的会话标签时不 preventDefault，PWA 独立窗口才能用 Ctrl/⌘+W 关窗口。 */
function useSessionTabShortcuts(
    scope: string,
    selectedSessionId: string | null,
    directoryKey: string | null,
    tabs: readonly { id: string }[],
): void {
    const navigate = useNavigate()
    const latest = useRef({ selectedSessionId, directoryKey, tabs })
    latest.current = { selectedSessionId, directoryKey, tabs }
    useEffect(() => {
        const go = (id: string | null) => {
            if (id) navigate(getSessionListSelectionNavigation(id))
            else navigate({ to: '/sessions', ...PRESERVE_SESSION_SIDEBAR_SCROLL })
        }
        const onKeyDown = (event: KeyboardEvent) => {
            const shortcut = matchTabShortcut(event)
            if (!shortcut || event.defaultPrevented || isTerminalTarget(event.target)) return
            // Alt/⌥ 在输入框里是在打 ∑、† 或 AltGr 字符，不关标签、不新建。
            if (event.altKey && !event.ctrlKey && !event.metaKey && isEditableTarget(event.target)) return
            if (shortcut === 'new') {
                event.preventDefault()
                navigate({ to: '/sessions/new', ...PRESERVE_SESSION_SIDEBAR_SCROLL })
                return
            }
            const { selectedSessionId: current, directoryKey: dir, tabs: open } = latest.current
            if (!current || !canCloseOpenTab(current, open.map(tab => tab.id))) return
            event.preventDefault()
            closeSessionTab(scope, dir, current, current, go)
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
    }, [navigate, scope])
}

export function useHasSessionTabs(selectedSessionId: string | null, sessions: SessionSummary[]): boolean {
    const groups = useSessionTabsState(useSessionTabsScope())
    const key = visibleSessionDirectoryKey(selectedSessionId, sessions, groups.activeDirectoryKey)
    return key != null && (groups.groups[key]?.length ?? 0) > 0
}

type Menu = { id: string; x: number; y: number } | null
type OpenDialog = { id: string; kind: TabSessionDialogKind } | null
type MenuItem = { key: string; label: string; run: () => void; danger?: boolean }

export function SessionTabsBar(props: {
    sessions: SessionSummary[]
    selectedSessionId: string | null
    machineLabel: (session: SessionSummary) => string
    /** 固定在最左，回到会话列表（窄屏）或取消选中（桌面）。本 fork 没有工作总览。 */
    home?: { active: boolean; onOpen: () => void }
}) {
    const { t } = useTranslation()
    const navigate = useNavigate()
    const scope = useSessionTabsScope()
    const { api } = useAppContext()
    const { haptic } = usePlatform()
    const { addToast } = useToast()
    const groups = useSessionTabsState(scope)
    const visibleKey = visibleSessionDirectoryKey(props.selectedSessionId, props.sessions, groups.activeDirectoryKey)
    const tabs = visibleKey ? groups.groups[visibleKey] ?? [] : []
    // 已读水位存在 localStorage。不订阅的话，标已读/未读不会让蓝点刷新。
    useSessionLastSeenVersion()
    const [menu, setMenu] = useState<Menu>(null)
    const [dialog, setDialog] = useState<OpenDialog>(null)
    const [dragging, setDragging] = useState<string | null>(null)
    const scroller = useRef<HTMLDivElement>(null)
    const byId = useMemo(() => new Map(props.sessions.map(session => [session.id, session])), [props.sessions])

    useEffect(() => {
        if (!props.selectedSessionId || !scroller.current) return
        const element = scroller.current.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(props.selectedSessionId)}"]`)
        element?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    }, [props.selectedSessionId, tabs.length])

    useEffect(() => {
        if (!menu) return
        const close = () => setMenu(null)
        // pointerdown rather than click: the click that ends a touch long-press
        // would otherwise close the menu that long-press just opened.
        const onPointerDown = (event: PointerEvent) => {
            const target = event.target as Element | null
            if (!target?.closest?.('[data-tab-menu]')) close()
        }
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') close()
        }
        window.addEventListener('pointerdown', onPointerDown, true)
        window.addEventListener('keydown', onKeyDown)
        window.addEventListener('scroll', close, true)
        return () => {
            window.removeEventListener('pointerdown', onPointerDown, true)
            window.removeEventListener('keydown', onKeyDown)
            window.removeEventListener('scroll', close, true)
        }
    }, [menu])

    if (tabs.length === 0) return null

    const go = (id: string | null) => {
        if (id) navigate(getSessionListSelectionNavigation(id))
        else navigate({ to: '/sessions', ...PRESERVE_SESSION_SIDEBAR_SCROLL })
    }
    const close = (id: string) => closeSessionTab(scope, visibleKey, id, props.selectedSessionId, go)
    const onAuxClick = (event: ReactMouseEvent, id: string) => {
        if (event.button === 1) {
            event.preventDefault()
            close(id)
        }
    }

    const menuSession = menu ? byId.get(menu.id) : undefined
    // Actions on the tab's session: the same ones the session list offers on long-press,
    // minus work-line classification (this fork has no work overview).
    const sessionItems: MenuItem[] = menu && menuSession ? [
        { key: 'rename', label: t('session.action.rename'), run: () => setDialog({ id: menu.id, kind: 'rename' }) },
        {
            key: 'reference',
            label: t('session.action.copyReference'),
            run: () => {
                const title = getSessionTitle(menuSession) || t('tabs.untitled')
                void safeCopyToClipboard(buildSessionReferenceText(title, menuSession.id)).then(
                    () => {
                        haptic.notification('success')
                        addToast({ title: t('tabs.referenceCopied'), body: title, sessionId: menuSession.id, url: window.location.href, durationMs: 2500 })
                    },
                    () => haptic.notification('error')
                )
            }
        },
        ...(menuSession.active ? [{ key: 'archive', label: t('session.action.archive'), danger: true, run: () => setDialog({ id: menu.id, kind: 'archive' }) }] : [])
    ] : []
    const tabItems: MenuItem[] = menu ? [
        { key: 'pin', label: tabs.find(tab => tab.id === menu.id)?.pinned ? t('tabs.unpin') : t('tabs.pin'), run: () => updateSessionTabs(scope, state => applyToGroup(state, visibleKey, list => togglePinTab(list, menu.id))) },
        { key: 'close', label: t('tabs.close'), run: () => close(menu.id) },
        { key: 'others', label: t('tabs.closeOthers'), run: () => { updateSessionTabs(scope, state => applyToGroup(state, visibleKey, list => closeOtherTabs(list, menu.id))); if (props.selectedSessionId !== menu.id) go(menu.id) } },
        {
            key: 'right', label: t('tabs.closeRight'), run: () => {
                const index = tabs.findIndex(tab => tab.id === menu.id)
                const selectedIndex = tabs.findIndex(tab => tab.id === props.selectedSessionId)
                updateSessionTabs(scope, state => applyToGroup(state, visibleKey, list => closeTabsToRight(list, menu.id)))
                if (selectedIndex > index && !tabs[selectedIndex]?.pinned) go(menu.id)
            }
        }
    ] : []
    const dialogSession = dialog ? byId.get(dialog.id) : undefined

    return (
        <div className="session-tabs-bar flex shrink-0 items-end border-b border-[var(--app-divider)] bg-[var(--app-secondary-bg)] pt-[env(safe-area-inset-top)]" role="tablist" aria-label={t('tabs.label')}>
            {props.home ? (
                <div className="shrink-0 pl-1.5 pt-1.5">
                    <div
                        role="tab"
                        aria-selected={props.home.active}
                        tabIndex={0}
                        data-testid="session-tab-home"
                        title={t('tabs.home')}
                        aria-label={t('tabs.home')}
                        onClick={props.home.onOpen}
                        onKeyDown={event => { if (event.key === 'Enter') props.home?.onOpen() }}
                        className={cn(
                            'session-tab flex h-8 cursor-pointer select-none items-center gap-1.5 rounded-t-lg px-2.5 text-xs transition-colors',
                            props.home.active
                                ? 'bg-[var(--app-bg)] font-medium text-[var(--app-fg)] shadow-[0_-1px_0_var(--app-border),1px_0_0_var(--app-border),-1px_0_0_var(--app-border)]'
                                : 'text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]'
                        )}
                    >
                        <HomeGlyph className="h-3.5 w-3.5 shrink-0" />
                        <span className="hidden split:inline">{t('tabs.home')}</span>
                    </div>
                </div>
            ) : null}
            <div ref={scroller} className="session-tabs-scroll flex min-w-0 flex-1 items-end gap-0.5 overflow-x-auto px-1.5 pt-1.5">
                {tabs.map(tab => {
                    const session = byId.get(tab.id)
                    const active = tab.id === props.selectedSessionId
                    const title = session ? getSessionTitle(session) || t('tabs.untitled') : t('tabs.loading')
                    return (
                        <SessionTab
                            key={tab.id}
                            id={tab.id}
                            pinned={Boolean(tab.pinned)}
                            session={session}
                            active={active}
                            title={title}
                            tooltip={session ? `${title} · ${props.machineLabel(session)}` : title}
                            unread={!!session && !active && session.updatedAt > getSessionLastSeenAt(session.id)}
                            dragging={dragging === tab.id}
                            closeLabel={t('tabs.close')}
                            closeTitle={t('tabs.closeShortcut')}
                            onOpen={() => go(tab.id)}
                            onClose={() => close(tab.id)}
                            onAuxClick={event => onAuxClick(event, tab.id)}
                            onMenu={point => setMenu({ id: tab.id, x: point.x, y: point.y })}
                            onDragStart={() => setDragging(tab.id)}
                            canDropHere={Boolean(dragging && dragging !== tab.id)}
                            onDrop={() => { if (dragging) updateSessionTabs(scope, state => applyToGroup(state, visibleKey, list => moveTab(list, dragging, tab.id))); setDragging(null) }}
                            onDragEnd={() => setDragging(null)}
                        />
                    )
                })}
            </div>
            {menu ? (
                <div
                    data-tab-menu
                    data-testid="session-tab-menu"
                    role="menu"
                    className="fixed z-50 min-w-[180px] rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] py-1 text-xs shadow-lg"
                    style={{
                        left: Math.max(8, Math.min(menu.x, window.innerWidth - 196)),
                        top: Math.max(8, Math.min(menu.y + 4, window.innerHeight - 320))
                    }}
                >
                    {sessionItems.length > 0 ? (
                        <>
                            <div className="px-3 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--app-hint)]">{t('tabs.menu.session')}</div>
                            {sessionItems.map(item => <TabMenuButton key={item.key} item={item} onDone={() => setMenu(null)} />)}
                            <div className="my-1 border-t border-[var(--app-divider)]" />
                        </>
                    ) : null}
                    {tabItems.map(item => <TabMenuButton key={item.key} item={item} onDone={() => setMenu(null)} />)}
                </div>
            ) : null}
            {dialog && dialogSession ? (
                <TabSessionDialog api={api} kind={dialog.kind} session={dialogSession} onClose={() => setDialog(null)} />
            ) : null}
        </div>
    )
}

function TabMenuButton(props: { item: MenuItem; onDone: () => void }) {
    return (
        <button
            type="button"
            role="menuitem"
            data-testid={`session-tab-menu-${props.item.key}`}
            className={cn('block w-full px-3 py-1.5 text-left hover:bg-[var(--app-subtle-bg)]', props.item.danger && 'text-[var(--app-badge-error-text)]')}
            onClick={() => { props.item.run(); props.onDone() }}
        >
            {props.item.label}
        </button>
    )
}

/**
 * One tab. Right-click (desktop) and long-press (touch) open the tab menu. The
 * long-press uses the touch-only mode, so mouse clicks and HTML5 drag-to-reorder
 * keep their native behaviour and the click that ends a long touch is swallowed.
 */
function SessionTab(props: {
    id: string
    pinned: boolean
    session: SessionSummary | undefined
    active: boolean
    title: string
    tooltip: string
    unread: boolean
    dragging: boolean
    closeLabel: string
    closeTitle: string
    onOpen: () => void
    onClose: () => void
    onAuxClick: (event: ReactMouseEvent) => void
    onMenu: (point: { x: number; y: number }) => void
    onDragStart: () => void
    canDropHere: boolean
    onDrop: () => void
    onDragEnd: () => void
}) {
    const { haptic } = usePlatform()
    const longPress = useLongPress({
        interaction: 'touch-only-native-click',
        threshold: 500,
        onLongPress: point => {
            haptic.impact('medium')
            props.onMenu(point)
        },
        onClick: props.onOpen
    })
    const pending = props.session?.pendingRequestsCount ?? 0
    return (
        <div
            data-tab-id={props.id}
            role="tab"
            aria-selected={props.active}
            aria-haspopup="menu"
            tabIndex={0}
            draggable
            title={props.tooltip}
            onClick={longPress.onClick}
            onTouchStart={longPress.onTouchStart}
            onTouchEnd={longPress.onTouchEnd}
            onTouchMove={longPress.onTouchMove}
            onTouchCancel={longPress.onTouchCancel}
            onKeyDown={event => {
                if (event.key === 'Enter') props.onOpen()
                if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
                    event.preventDefault()
                    const rect = event.currentTarget.getBoundingClientRect()
                    props.onMenu({ x: rect.left, y: rect.bottom })
                }
            }}
            onAuxClick={props.onAuxClick}
            onMouseDown={event => { if (event.button === 1) event.preventDefault() }}
            onContextMenu={event => {
                event.preventDefault()
                props.onMenu({ x: event.clientX, y: event.clientY })
            }}
            onDragStart={event => { props.onDragStart(); event.dataTransfer.effectAllowed = 'move' }}
            onDragOver={event => { if (props.canDropHere) event.preventDefault() }}
            onDrop={event => { event.preventDefault(); props.onDrop() }}
            onDragEnd={props.onDragEnd}
            style={{ WebkitTouchCallout: 'none' }}
            className={cn(
                'session-tab group relative flex h-8 shrink-0 cursor-pointer select-none items-center gap-1.5 rounded-t-lg pl-2.5 pr-1 text-xs transition-colors',
                props.pinned ? 'max-w-[120px]' : 'max-w-[200px] split:max-w-[220px]',
                props.active
                    ? 'bg-[var(--app-bg)] font-medium text-[var(--app-fg)] shadow-[0_-1px_0_var(--app-border),1px_0_0_var(--app-border),-1px_0_0_var(--app-border)]'
                    : 'text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]',
                props.dragging && 'opacity-50'
            )}
        >
            {props.pinned ? <PinGlyph className="h-3 w-3 shrink-0" /> : null}
            <StatusDot session={props.session} unread={props.unread} />
            <span className="min-w-0 truncate">{props.title}</span>
            {pending > 0 ? <span className="shrink-0 rounded-full bg-[var(--app-badge-error-bg)] px-1.5 text-[10px] font-semibold text-[var(--app-badge-error-text)]">{pending}</span> : null}
            <button
                type="button"
                aria-label={props.closeLabel}
                title={props.closeTitle}
                onClick={event => { event.stopPropagation(); props.onClose() }}
                onTouchStart={event => event.stopPropagation()}
                className={cn(
                    'flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]',
                    props.active ? 'opacity-100' : 'opacity-60 split:opacity-0 split:group-hover:opacity-100'
                )}
            >
                ×
            </button>
        </div>
    )
}

function StatusDot(props: { session: SessionSummary | undefined; unread: boolean }) {
    const session = props.session
    if (session?.thinking) return <span className="session-tab-thinking h-2 w-2 shrink-0 rounded-full bg-[#22c55e]" />
    if (session?.active) return <span className="h-2 w-2 shrink-0 rounded-full bg-[#22c55e]" />
    if (props.unread) return <span className="h-2 w-2 shrink-0 rounded-full bg-[#3b82f6]" />
    return <span className="h-2 w-2 shrink-0 rounded-full border border-[var(--app-border)]" />
}

function HomeGlyph(props: { className?: string }) {
    return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={props.className}>
            <path d="M3 10.5 12 3l9 7.5" />
            <path d="M5 9.5V21h5v-6h4v6h5V9.5" />
        </svg>
    )
}

function PinGlyph(props: { className?: string }) {
    return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={props.className}>
            <path d="M12 17v5" />
            <path d="M9 10.76V6h6v4.76l2 2.24v2H7v-2z" />
            <path d="M8 2h8" />
        </svg>
    )
}
