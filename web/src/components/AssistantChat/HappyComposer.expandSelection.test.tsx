import { readFileSync } from 'node:fs'
import {
    AssistantRuntimeProvider,
    type ChatModelAdapter,
    useLocalRuntime,
} from '@assistant-ui/react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Ref } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { HappyComposer } from './HappyComposer'

vi.mock('@/components/AssistantChat/ComposerButtons', () => ({
    ComposerButtons: (props: {
        expanded: boolean
        onExpandedToggle: () => void
        showSettingsButton: boolean
        settingsButtonRef?: Ref<HTMLButtonElement>
        onSettingsToggle: () => void
    }) => (
        <div>
            <button
                type="button"
                aria-label={props.expanded ? 'Collapse message editor' : 'Expand message editor'}
                onClick={props.onExpandedToggle}
            />
            {props.showSettingsButton ? (
                <button
                    ref={props.settingsButtonRef}
                    type="button"
                    aria-label="Composer settings"
                    onClick={props.onSettingsToggle}
                />
            ) : null}
        </div>
    ),
}))

vi.mock('@/components/AssistantChat/StatusBar', () => ({
    shouldShowComposerStatusBar: () => true,
    StatusBar: () => null,
}))
vi.mock('@/hooks/useComposerDraft', () => ({
    useComposerDraft: () => ({ sessionId: undefined, complete: true, restoredAny: false, hasStoredAttachments: false }),
}))
const pwaState = vi.hoisted(() => ({
    isStandalone: false,
    isIOS: false,
}))

vi.mock('@/hooks/usePlatform', () => ({
    usePlatform: () => ({
        isTelegram: false,
        isTouch: false,
        haptic: {
            impact: () => {},
            notification: () => {},
            selection: () => {},
        },
    }),
}))
vi.mock('@/hooks/usePWAInstall', () => ({
    usePWAInstall: () => ({
        installState: 'idle',
        canInstall: false,
        canInstallIOS: false,
        isStandalone: pwaState.isStandalone,
        isIOS: pwaState.isIOS,
        promptInstall: async () => false,
        dismissInstall: () => {},
    }),
}))
vi.mock('@/lib/use-translation', () => ({
    useTranslation: () => ({
        t: (key: string) => key === 'misc.typeAMessage' ? 'Type a message' : key,
    }),
}))

const adapter: ChatModelAdapter = {
    async *run() {},
}

function TestRuntime(props: { withSettings?: boolean; onExpandedChange?: (expanded: boolean) => void }) {
    const runtime = useLocalRuntime(adapter)
    return (
        <AssistantRuntimeProvider runtime={runtime}>
            <HappyComposer
                agentFlavor={props.withSettings ? 'claude' : undefined}
                onPermissionModeChange={props.withSettings ? () => {} : undefined}
                onExpandedChange={props.onExpandedChange}
            />
            {props.withSettings ? (
                <button
                    type="button"
                    aria-label="Outside action"
                    onPointerDown={(event) => event.stopPropagation()}
                />
            ) : null}
        </AssistantRuntimeProvider>
    )
}

describe('HappyComposer plain-text expansion', () => {
    beforeEach(() => {
        pwaState.isStandalone = false
        pwaState.isIOS = false
        localStorage.clear()
        localStorage.setItem('hapi.composer.richMentions', '0')
    })

    it('preserves draft text and selection across expand and collapse', async () => {
        render(<TestRuntime />)

        const draft = 'A long draft with a selection in the middle that must survive both editor layout changes.'
        const collapsedInput = screen.getByRole('textbox') as HTMLTextAreaElement
        fireEvent.change(collapsedInput, { target: { value: draft } })
        collapsedInput.setSelectionRange(12, 36, 'forward')

        fireEvent.click(screen.getByRole('button', { name: 'Expand message editor' }))

        await waitFor(() => {
            expect(screen.getByRole('button', { name: 'Collapse message editor' })).toBeInTheDocument()
            const expandedInput = screen.getByRole('textbox') as HTMLTextAreaElement
            expect(expandedInput).not.toBe(collapsedInput)
            expect(expandedInput.value).toBe(draft)
            expect(expandedInput.selectionStart).toBe(12)
            expect(expandedInput.selectionEnd).toBe(36)
            expect(expandedInput.selectionDirection).toBe('forward')
            expect(document.activeElement).toBe(expandedInput)
        })

        const expandedInput = screen.getByRole('textbox') as HTMLTextAreaElement
        expandedInput.setSelectionRange(42, 67, 'backward')
        fireEvent.click(screen.getByRole('button', { name: 'Collapse message editor' }))

        await waitFor(() => {
            expect(screen.getByRole('button', { name: 'Expand message editor' })).toBeInTheDocument()
            const nextCollapsedInput = screen.getByRole('textbox') as HTMLTextAreaElement
            expect(nextCollapsedInput).not.toBe(expandedInput)
            expect(nextCollapsedInput.value).toBe(draft)
            expect(nextCollapsedInput.selectionStart).toBe(42)
            expect(nextCollapsedInput.selectionEnd).toBe(67)
            expect(nextCollapsedInput.selectionDirection).toBe('backward')
            expect(document.activeElement).toBe(nextCollapsedInput)
        })
    })

    it('floats the collapsed composer and keeps the expanded shell solid', () => {
        const onExpandedChange = vi.fn()
        render(<TestRuntime withSettings onExpandedChange={onExpandedChange} />)

        const shell = screen.getByTestId('composer-shell')
        const frame = screen.getByTestId('composer-frame')
        expect(shell).toHaveAttribute('data-floating', 'true')
        expect(shell).not.toHaveAttribute('data-expanded')
        expect(shell.className).toContain('composer-floating-shell')
        expect(shell.className).not.toContain('bg-[var(--app-bg)]')
        expect(frame.className).toContain('composer-floating-frame')
        expect(frame.className).toContain('backdrop-blur-md')
        expect(frame.className).not.toContain('rounded-[20px]')

        fireEvent.click(screen.getByRole('button', { name: 'Composer settings' }))
        expect(screen.getByText('misc.permissionMode').closest('div.absolute')?.className).toContain('bottom-[100%]')
        fireEvent.click(screen.getByRole('button', { name: 'Composer settings' }))

        fireEvent.click(screen.getByRole('button', { name: 'Expand message editor' }))

        expect(onExpandedChange).toHaveBeenCalledWith(true)
        expect(shell).toHaveAttribute('data-expanded', 'true')
        expect(shell).not.toHaveAttribute('data-floating')
        expect(shell.className).toContain('bg-[var(--app-bg)]')
        expect(shell.className).toContain('sm:absolute')
        expect(shell.className).toContain('sm:inset-0')
        expect(shell.className).not.toContain('composer-floating-shell')
        expect(frame.className).toContain('rounded-[20px]')
        expect(frame.className).toContain('bg-[var(--app-secondary-bg)]')
        expect(frame.className).not.toContain('composer-floating-frame')

        fireEvent.click(screen.getByRole('button', { name: 'Composer settings' }))
        expect(screen.getByText('misc.permissionMode').closest('div.absolute')?.className).toContain('bottom-12')
    })

    it('counts the bottom safe area once, and not at all on iOS PWA', () => {
        const css = readFileSync('src/index.css', 'utf8')
        const base = css.match(/\.composer-floating-shell \{[^}]+\}/)?.[0] ?? ''
        const ios = css.match(/\.composer-floating-shell-ios-pwa \{[^}]+\}/)?.[0] ?? ''
        expect(base.match(/safe-area-inset-bottom/g)).toHaveLength(1)
        expect(ios).toContain('padding-bottom: 0.5rem')
        expect(ios).not.toContain('safe-area')

        pwaState.isIOS = true
        pwaState.isStandalone = true
        render(<TestRuntime />)
        const shell = screen.getByTestId('composer-shell')
        expect(shell.className).toBe('composer-floating-shell composer-floating-shell-ios-pwa')
        expect(shell.className).not.toContain('pb-0')
        expect(shell.className).not.toContain('pb-3')

        fireEvent.click(screen.getByRole('button', { name: 'Expand message editor' }))
        expect(shell.className).toContain('pb-0')
        expect(shell.className).not.toContain('pb-3')
        expect(shell.className).not.toContain('composer-floating-shell')
        expect(shell.className).not.toContain('safe-area-inset-bottom')
    })

    it('closes settings when clicking outside while preserving inside and trigger interactions', () => {
        render(<TestRuntime withSettings />)

        const settingsButton = screen.getByRole('button', { name: 'Composer settings' })
        fireEvent.click(settingsButton)

        const panelLabel = screen.getByText('misc.permissionMode')
        fireEvent.pointerDown(panelLabel)
        expect(screen.getByText('misc.permissionMode')).toBeInTheDocument()

        fireEvent.pointerDown(settingsButton)
        expect(screen.getByText('misc.permissionMode')).toBeInTheDocument()

        fireEvent.click(settingsButton)
        expect(screen.queryByText('misc.permissionMode')).not.toBeInTheDocument()

        fireEvent.click(settingsButton)
        expect(screen.getByText('misc.permissionMode')).toBeInTheDocument()

        fireEvent.pointerDown(screen.getByRole('textbox'))
        expect(screen.queryByText('misc.permissionMode')).not.toBeInTheDocument()

        fireEvent.click(settingsButton)
        expect(screen.getByText('misc.permissionMode')).toBeInTheDocument()

        fireEvent.pointerDown(screen.getByRole('button', { name: 'Outside action' }))
        expect(screen.queryByText('misc.permissionMode')).not.toBeInTheDocument()
    })
})
