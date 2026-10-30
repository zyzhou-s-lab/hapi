import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionSummary } from '@/types/api'

const mocks = vi.hoisted(() => ({
    navigate: vi.fn(),
    renameSession: vi.fn(async () => {}),
    archiveSession: vi.fn(async () => {}),
    copy: vi.fn(async () => {}),
    addToast: vi.fn()
}))

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => mocks.navigate }))
vi.mock('@/lib/app-context', () => ({
    useAppContext: () => ({ baseUrl: 'https://hub.test', user: { id: 1, role: 'admin' }, api: {}, token: 't' })
}))
vi.mock('@/lib/use-translation', () => ({
    useTranslation: () => ({ t: (key: string, params?: Record<string, unknown>) => (params?.name ? `${key}:${String(params.name)}` : key) })
}))
vi.mock('@/hooks/usePlatform', () => ({
    usePlatform: () => ({ haptic: { impact: vi.fn(), notification: vi.fn(), selection: vi.fn() } })
}))
vi.mock('@/lib/toast-context', () => ({ useToast: () => ({ addToast: mocks.addToast }) }))
vi.mock('@/lib/clipboard', () => ({ safeCopyToClipboard: mocks.copy }))
vi.mock('@/hooks/mutations/useSessionActions', () => ({
    useSessionActions: () => ({ renameSession: mocks.renameSession, archiveSession: mocks.archiveSession, isPending: false })
}))

import { SessionTabsBar } from './SessionTabsBar'
import { __resetSessionTabsForTests, openTab, updateSessionTabs } from './sessionTabsStore'

const SCOPE = 'https://hub.test|1'

function session(id: string, name: string, active: boolean): SessionSummary {
    return {
        id,
        active,
        thinking: false,
        updatedAt: 1,
        pendingRequestsCount: 0,
        metadata: { name, path: '/p', flavor: 'claude', machineId: 'm1' }
    } as unknown as SessionSummary
}

function renderBar(sessions: SessionSummary[], home?: { active: boolean; onOpen: () => void }) {
    for (const s of sessions) updateSessionTabs(SCOPE, state => openTab(state, s.id, Date.now()))
    return render(<SessionTabsBar sessions={sessions} selectedSessionId={sessions[0]!.id} machineLabel={() => '天选6pro'} home={home} />)
}

function tab(id: string): HTMLElement {
    const element = document.querySelector<HTMLElement>(`[data-tab-id="${id}"]`)
    if (!element) throw new Error(`tab ${id} not rendered`)
    return element
}

describe('SessionTabsBar tab menu', () => {
    beforeEach(() => {
        // jsdom has no layout: the bar scrolls the active tab into view.
        Element.prototype.scrollIntoView = vi.fn()
        localStorage.clear()
        __resetSessionTabsForTests()
        for (const fn of [mocks.navigate, mocks.renameSession, mocks.archiveSession, mocks.copy, mocks.addToast]) fn.mockClear()
    })
    afterEach(() => {
        vi.useRealTimers()
    })

    it('right-click shows the session actions above the tab actions', () => {
        renderBar([session('s1', '准备京张AI创新带参赛方案', true), session('s2', '另一个', false)])
        fireEvent.contextMenu(tab('s1'), { clientX: 40, clientY: 30 })

        const keys = [...screen.getByTestId('session-tab-menu').querySelectorAll('[role=menuitem]')]
            .map(item => item.getAttribute('data-testid')?.replace('session-tab-menu-', ''))
        expect(keys).toEqual(['rename', 'reference', 'archive', 'pin', 'close', 'others', 'right'])
    })

    it('hides archive for an inactive session and does not offer work-line classification', () => {
        renderBar([session('s1', '已结束的会话', false)])
        fireEvent.contextMenu(tab('s1'), { clientX: 40, clientY: 30 })
        expect(screen.queryByTestId('session-tab-menu-archive')).toBeNull()
        expect(screen.queryByTestId('session-tab-menu-classify')).toBeNull()
        expect(screen.getByTestId('session-tab-menu-rename')).toBeInTheDocument()
    })

    it('opens the menu on a touch long-press without navigating', () => {
        vi.useFakeTimers()
        renderBar([session('s1', '准备京张AI创新带参赛方案', true), session('s2', '另一个', false)])
        const target = tab('s2')
        fireEvent.touchStart(target, { touches: [{ clientX: 120, clientY: 20 }] })
        act(() => { vi.advanceTimersByTime(550) })
        fireEvent.touchEnd(target)
        fireEvent.click(target, { detail: 1 })

        expect(screen.getByTestId('session-tab-menu')).toBeInTheDocument()
        expect(mocks.navigate).not.toHaveBeenCalled()
    })

    it('a short tap still opens the tab', () => {
        renderBar([session('s1', '准备京张AI创新带参赛方案', true), session('s2', '另一个', false)])
        fireEvent.click(tab('s2'), { detail: 1 })
        expect(mocks.navigate).toHaveBeenCalledWith({
            to: '/sessions/$sessionId',
            params: { sessionId: 's2' },
            resetScroll: false
        })
        expect(screen.queryByTestId('session-tab-menu')).toBeNull()
    })

    it('keeps a fixed home tab that returns to the session index', () => {
        const onOpen = vi.fn()
        renderBar([session('s1', '准备京张AI创新带参赛方案', true)], { active: false, onOpen })
        const home = screen.getByTestId('session-tab-home')
        expect(home).toHaveAttribute('aria-selected', 'false')
        fireEvent.click(home)
        expect(onOpen).toHaveBeenCalledOnce()
        expect(home.querySelector('button')).toBeNull()
    })

    it('renames the session from the tab menu', async () => {
        renderBar([session('s1', '旧标题', true)])
        fireEvent.contextMenu(tab('s1'), { clientX: 40, clientY: 30 })
        fireEvent.click(screen.getByTestId('session-tab-menu-rename'))
        expect(screen.queryByTestId('session-tab-menu')).toBeNull()

        const input = await screen.findByDisplayValue('旧标题')
        fireEvent.change(input, { target: { value: '新标题' } })
        fireEvent.submit(input.closest('form')!)
        await waitFor(() => expect(mocks.renameSession).toHaveBeenCalledWith('新标题'))
    })

    it('copies a session reference and confirms it', async () => {
        renderBar([session('s1', '准备京张AI创新带参赛方案', true)])
        fireEvent.contextMenu(tab('s1'), { clientX: 40, clientY: 30 })
        fireEvent.click(screen.getByTestId('session-tab-menu-reference'))
        await waitFor(() => expect(mocks.addToast).toHaveBeenCalled())
        expect(mocks.copy).toHaveBeenCalledWith(expect.stringContaining('/sessions/s1'))
    })

    it('archives after confirmation', async () => {
        renderBar([session('s1', '准备京张AI创新带参赛方案', true)])
        fireEvent.contextMenu(tab('s1'), { clientX: 40, clientY: 30 })
        fireEvent.click(screen.getByTestId('session-tab-menu-archive'))
        fireEvent.click(await screen.findByRole('button', { name: 'dialog.archive.confirm' }))
        await waitFor(() => expect(mocks.archiveSession).toHaveBeenCalled())
    })
})
