import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import { SidebarShell } from './SidebarShell'

let desktop = true
let mediaEvents: EventTarget

beforeEach(() => {
    desktop = true
    mediaEvents = new EventTarget()
    localStorage.removeItem('hapi-sidebar-collapsed')
    vi.spyOn(window, 'matchMedia').mockImplementation(query => ({
        get matches() { return desktop },
        media: query,
        onchange: null,
        addEventListener: mediaEvents.addEventListener.bind(mediaEvents),
        removeEventListener: mediaEvents.removeEventListener.bind(mediaEvents),
        addListener() {},
        removeListener() {},
        dispatchEvent: () => false,
    }))
})

afterEach(() => {
    cleanup()
    localStorage.removeItem('hapi-sidebar-collapsed')
    localStorage.removeItem('hapi-sidebar-width')
    vi.restoreAllMocks()
})

function mountShell() {
    return render(
        <I18nProvider>
            <SidebarShell
                sidebar={<button type="button">Session row</button>}
                footer={<a href="/settings">Settings</a>}
                mobileListVisible
                hasSessionTabs={false}
                onNewSession={() => {}}
                renderHeader={controls => <header>{controls}</header>}
            >
                <textarea aria-label="Composer" />
                <div contentEditable suppressContentEditableWarning data-testid="editor">Rich text</div>
                <div className="xterm"><button type="button">Terminal target</button></div>
            </SidebarShell>
        </I18nProvider>
    )
}

function shortcut(target: HTMLElement, options: KeyboardEventInit = {}) {
    return fireEvent.keyDown(target, { key: 'b', ctrlKey: true, ...options })
}

describe('SidebarShell', () => {
    it('remembers collapse across remounts without discarding the saved resize width', () => {
        localStorage.setItem('hapi-sidebar-width', '510')
        const view = mountShell()
        fireEvent.click(screen.getByRole('button', { name: 'Collapse sidebar' }))
        expect(screen.getByRole('button', { name: 'Expand sidebar' })).toHaveAttribute('aria-expanded', 'false')
        view.unmount()
        mountShell()
        fireEvent.click(screen.getByRole('button', { name: 'Expand sidebar' }))
        expect(screen.getByRole('button', { name: 'Collapse sidebar' })).toHaveAttribute('aria-expanded', 'true')
        expect(localStorage.getItem('hapi-sidebar-width')).toBe('510')
        localStorage.removeItem('hapi-sidebar-width')
    })

    it('moves focus out of the sidebar before a keyboard collapse', () => {
        mountShell()
        const row = screen.getByRole('button', { name: 'Session row' })
        row.focus()
        expect(shortcut(row)).toBe(false)
        expect(screen.getByRole('button', { name: 'Expand sidebar' })).toHaveFocus()
        expect(shortcut(document.activeElement as HTMLElement, { ctrlKey: false, metaKey: true })).toBe(false)
        expect(screen.getByRole('button', { name: 'Collapse sidebar' })).toHaveFocus()
    })

    it('immediately excludes collapsed content and restores the mounted controls after reversal', () => {
        mountShell()
        const row = screen.getByRole('button', { name: 'Session row' })
        const settings = screen.getByRole('link', { name: 'Settings' })
        fireEvent.click(screen.getByRole('button', { name: 'Collapse sidebar' }))
        expect(screen.queryByRole('button', { name: 'Session row' })).toBeNull()
        expect(screen.queryByRole('link', { name: 'Settings' })).toBeNull()
        const newSession = screen.getByRole('button', { name: 'New Session' })
        newSession.focus()
        expect(shortcut(newSession)).toBe(false)
        expect(screen.getByRole('button', { name: 'Collapse sidebar' })).toHaveFocus()
        expect(screen.getByRole('button', { name: 'Session row' })).toBe(row)
        expect(screen.getByRole('link', { name: 'Settings' })).toBe(settings)
        expect(screen.queryByRole('button', { name: 'New Session' })).toBeNull()
    })

    it('hands phone-list focus to the restore control when the desktop sidebar is hidden', () => {
        localStorage.setItem('hapi-sidebar-collapsed', 'true')
        desktop = false
        mountShell()
        const row = screen.getByRole('button', { name: 'Session row' })
        row.focus()
        row.blur()
        desktop = true
        act(() => mediaEvents.dispatchEvent(Object.assign(new Event('change'), { matches: true })))
        expect(screen.getByRole('button', { name: 'Expand sidebar' })).toHaveFocus()
        expect(screen.queryByRole('button', { name: 'Session row' })).toBeNull()
        desktop = false
        act(() => mediaEvents.dispatchEvent(Object.assign(new Event('change'), { matches: false })))
        expect(screen.getByRole('button', { name: 'Session row' })).toBe(row)
    })

    it('does not move focus from the main pane when crossing the desktop breakpoint', () => {
        localStorage.setItem('hapi-sidebar-collapsed', 'true')
        desktop = false
        mountShell()
        const composer = screen.getByRole('textbox', { name: 'Composer' })
        composer.focus()
        desktop = true
        act(() => mediaEvents.dispatchEvent(Object.assign(new Event('change'), { matches: true })))
        expect(composer).toHaveFocus()
    })

    it('leaves composer, rich-text, terminal, and dialog shortcuts with their owners', () => {
        mountShell()
        const textarea = screen.getByRole('textbox', { name: 'Composer' })
        const editor = screen.getByTestId('editor')
        const terminal = screen.getByRole('button', { name: 'Terminal target' })
        for (const target of [textarea, editor, terminal]) {
            expect(shortcut(target)).toBe(true)
        }
        const dialog = document.createElement('div')
        dialog.setAttribute('role', 'dialog')
        document.body.append(dialog)
        expect(shortcut(document.body)).toBe(true)
        dialog.remove()
        expect(screen.getByRole('button', { name: 'Collapse sidebar' })).toHaveAttribute('aria-expanded', 'true')
        expect(shortcut(document.body)).toBe(false)
    })

    it('does not toggle for composition, repeats, modified chords, or consumed events', () => {
        mountShell()
        expect(shortcut(document.body, { isComposing: true })).toBe(true)
        expect(shortcut(document.body, { repeat: true })).toBe(true)
        expect(shortcut(document.body, { shiftKey: true })).toBe(true)
        expect(shortcut(document.body, { altKey: true })).toBe(true)
        const consume = (event: KeyboardEvent) => event.preventDefault()
        document.addEventListener('keydown', consume)
        expect(shortcut(document.body)).toBe(false)
        document.removeEventListener('keydown', consume)
        expect(screen.getByRole('button', { name: 'Collapse sidebar' })).toHaveAttribute('aria-expanded', 'true')
    })

    it('does not claim the desktop shortcut on phones', () => {
        desktop = false
        mountShell()
        expect(shortcut(document.body)).toBe(true)
        desktop = true
        expect(shortcut(document.body)).toBe(false)
        expect(screen.getByRole('button', { name: 'Expand sidebar' })).toHaveAttribute('aria-expanded', 'false')
    })
})
