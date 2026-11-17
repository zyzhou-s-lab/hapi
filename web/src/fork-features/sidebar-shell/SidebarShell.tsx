import { useCallback, useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { useSidebarResize } from '@/hooks/useSidebarResize'
import { useTranslation } from '@/lib/use-translation'
import { isEditableTarget, isTerminalTarget } from '@/fork-features/session-tabs/tabShortcuts'
import { useSidebarCollapse } from './useSidebarCollapse'
import './sidebarShell.css'

// Keep aligned with Tailwind's split breakpoint and sidebarShell.css's resize cap.
const DESKTOP_QUERY = '(min-width: 920px)'

export function SidebarShell(props: {
    sidebar: ReactNode
    footer: ReactNode
    mobileListVisible: boolean
    hasSessionTabs: boolean
    renderHeader: (controls: ReactNode) => ReactNode
    onNewSession: () => void
    children: ReactNode
}) {
    const { t } = useTranslation()
    const resize = useSidebarResize()
    const { collapsed, toggle } = useSidebarCollapse()
    const sidebarId = useId()
    const paneRef = useRef<HTMLDivElement>(null)
    const triggerRef = useRef<HTMLButtonElement>(null)
    const newSessionRef = useRef<HTMLSpanElement>(null)
    const [desktop, setDesktop] = useState(() => window.matchMedia(DESKTOP_QUERY).matches)
    const [motionEnabled, setMotionEnabled] = useState(false)

    const toggleSidebar = useCallback(() => {
        if (paneRef.current?.contains(document.activeElement) || newSessionRef.current?.contains(document.activeElement)) {
            triggerRef.current?.focus()
        }
        setMotionEnabled(true)
        toggle()
    }, [toggle])

    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.defaultPrevented || event.repeat || event.isComposing || event.shiftKey || event.altKey
                || event.getModifierState('AltGraph') || !(event.ctrlKey || event.metaKey)
                || event.key.toLowerCase() !== 'b' || !window.matchMedia(DESKTOP_QUERY).matches) return
            if (isEditableTarget(event.target) || isTerminalTarget(event.target)) return
            if (document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"]:not([hidden]), dialog[open]')) return
            event.preventDefault()
            toggleSidebar()
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
    }, [toggleSidebar])

    useEffect(() => {
        // CSS handles the breakpoint; mirror it only for accessibility and focus.
        const media = window.matchMedia(DESKTOP_QUERY)
        let focusedInSidebar = paneRef.current?.contains(document.activeElement) ?? false
        const rememberFocus = (event: FocusEvent) => {
            // Hiding the phone list can blur its descendant before the media event.
            if (event.target === document.body) return
            focusedInSidebar = event.target instanceof Node && Boolean(paneRef.current?.contains(event.target))
        }
        const onDesktopChange = (event: MediaQueryListEvent) => {
            if (event.matches && collapsed && focusedInSidebar) triggerRef.current?.focus()
            setDesktop(event.matches)
            setMotionEnabled(false)
        }
        const onViewportResize = () => setMotionEnabled(false)
        document.addEventListener('focusin', rememberFocus)
        media.addEventListener('change', onDesktopChange)
        window.addEventListener('resize', onViewportResize)
        return () => {
            document.removeEventListener('focusin', rememberFocus)
            media.removeEventListener('change', onDesktopChange)
            window.removeEventListener('resize', onViewportResize)
        }
    }, [collapsed])

    const label = t(collapsed ? 'sessions.sidebar.expand' : 'sessions.sidebar.collapse')
    const controls = (
        <div className="hidden shrink-0 items-center self-center border-r border-[var(--app-divider)] px-1.5 split:flex">
            <button
                ref={triggerRef}
                type="button"
                onClick={toggleSidebar}
                aria-label={label}
                title={`${label} (Ctrl/⌘+B)`}
                aria-expanded={!collapsed}
                aria-controls={sidebarId}
                aria-keyshortcuts="Control+b Meta+b"
                className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
            >
                <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
                    <path className="fork-sidebar-toggle-fill" d="M5 3h4v18H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" fill="currentColor" stroke="none" />
                    <rect x="3" y="3" width="18" height="18" rx="2" />
                    <path d="M9 3v18" />
                    <path className="fork-sidebar-toggle-arrow" d="m16 9-3 3 3 3" />
                </svg>
            </button>
            <span ref={newSessionRef} className="fork-sidebar-new-session" inert={!collapsed} aria-hidden={!collapsed || undefined}>
                <button
                    type="button"
                    onClick={props.onNewSession}
                    aria-label={t('sessions.new')}
                    title={t('sessions.new')}
                    className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--app-link)] transition-colors hover:bg-[var(--app-subtle-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
                >
                    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" className="h-4 w-4"><path d="M12 5v14M5 12h14" /></svg>
                </button>
            </span>
        </div>
    )

    return (
        <div
            className="fork-sidebar-shell flex h-full min-h-0"
            data-sidebar-collapsed={collapsed || undefined}
            data-sidebar-motion={motionEnabled || undefined}
            data-sidebar-dragging={resize.isDragging || undefined}
        >
            <div
                ref={paneRef}
                id={sidebarId}
                className={`fork-sidebar-pane ${props.mobileListVisible ? 'flex' : 'hidden split:flex'} w-full shrink-0 flex-col bg-[var(--app-bg)]`}
                style={{ '--sidebar-w': `${resize.width}px` } as CSSProperties}
                inert={desktop && collapsed}
                aria-hidden={desktop && collapsed || undefined}
            >
                <div className="fork-sidebar-content flex min-h-0 flex-1 flex-col">
                    <div className="flex min-h-0 flex-1 flex-col pt-[env(safe-area-inset-top)]">{props.sidebar}</div>
                    {props.footer}
                </div>
            </div>
            <div
                className="fork-sidebar-resize sidebar-resize-handle hidden shrink-0 split:block"
                data-dragging={resize.isDragging || undefined}
                onPointerDown={event => {
                    // A fractional transition width is not a valid resize baseline.
                    if (paneRef.current?.getAnimations?.().some(animation => animation.playState === 'running')) return
                    resize.onPointerDown(event)
                }}
            />
            <div data-session-tabs={props.hasSessionTabs || undefined} className={`${props.mobileListVisible ? 'hidden split:flex' : 'flex'} min-w-0 flex-1 flex-col bg-[var(--app-bg)]`}>
                {props.renderHeader(controls)}
                <div className="min-h-0 flex-1">{props.children}</div>
            </div>
        </div>
    )
}
