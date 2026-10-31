import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '@/lib/i18n-context'
import SessionConfigPage from './config'

const mocks = vi.hoisted(() => ({
    navigate: vi.fn(),
    header: null as null | { configActive?: boolean; onToggleConfig?: () => void },
    getSessionConfig: vi.fn(),
    getSessionConfigItem: vi.fn(),
    setSessionConfigItemEnabled: vi.fn(),
}))

vi.mock('@tanstack/react-router', () => ({
    useNavigate: () => mocks.navigate,
    useParams: () => ({ sessionId: 'session-1' }),
}))

vi.mock('@/lib/app-context', () => ({
    useAppContext: () => ({
        api: {
            getSessionConfig: mocks.getSessionConfig,
            getSessionConfigItem: mocks.getSessionConfigItem,
            setSessionConfigItemEnabled: mocks.setSessionConfigItemEnabled,
        },
        titleSuggestionAvailable: false,
    }),
}))

vi.mock('@/components/FileMarkdownView', () => ({
    FileMarkdownView: (props: { content: string }) => <div>{props.content}</div>,
}))
vi.mock('@/hooks/useAppGoBack', () => ({
    useAppGoBack: () => vi.fn(),
}))

vi.mock('@/lib/composer-draft-transfer', () => ({
    transferComposerDraftThenNavigate: vi.fn(),
}))

vi.mock('@/hooks/queries/useSession', () => ({
    useSession: () => ({
        session: {
            id: 'session-1',
            active: true,
            metadata: { path: '/work' },
        },
    }),
}))

vi.mock('@/components/SessionHeader', () => ({
    SessionHeader: (props: { configActive?: boolean; onToggleConfig?: () => void }) => {
        mocks.header = props
        return <button type="button" onClick={props.onToggleConfig}>config</button>
    },
}))

function renderPage() {
    return render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
            <I18nProvider>
                <SessionConfigPage />
            </I18nProvider>
        </QueryClientProvider>
    )
}

describe('SessionConfigPage', () => {
    beforeEach(() => {
        mocks.navigate.mockClear()
        mocks.header = null
        mocks.getSessionConfig.mockReset()
        mocks.getSessionConfigItem.mockReset()
        mocks.setSessionConfigItemEnabled.mockReset()
    })

    it('renders a live config response and hides urls and tokens', async () => {
        mocks.getSessionConfig.mockResolvedValue({
            success: true,
            mcp: {
                kind: 'servers',
                servers: [
                    { name: 'hapi', source: 'injected' },
                    { name: 'http://127.0.0.1:9/?token=abc', source: 'user' },
                ],
            },
            hooks: {
                availability: 'listed',
                items: [{
                    event: 'PreToolUse',
                    matcher: 'Bash',
                    source: 'user',
                    commandName: 'my-hook',
                }],
            },
            skills: { items: [] },
        })

        renderPage()

        expect(await screen.findByRole('heading', { name: 'MCP' })).toBeTruthy()
        expect(screen.getByRole('heading', { name: 'Skills' })).toBeTruthy()
        expect(screen.getByRole('heading', { name: 'Hooks' })).toBeTruthy()
        expect(screen.getByText('hapi')).toBeTruthy()
        expect(screen.getByText('Injected')).toBeTruthy()
        expect(screen.getByText('PreToolUse')).toBeTruthy()
        expect(screen.getByText('Bash · my-hook')).toBeTruthy()
        expect(screen.getByText('None')).toBeTruthy()
        expect(screen.getAllByText('This agent does not honor a per-item switch, so turning it off here would not stop it.').length).toBeGreaterThan(0)
        expect(screen.getAllByText('Injected, system, tool, and plugin items cannot be changed here.').length).toBeGreaterThan(0)
        expect(screen.queryByText(/127\.0\.0\.1/)).toBeNull()
        expect(screen.queryByText(/token/i)).toBeNull()
        expect(mocks.header?.configActive).toBe(true)

        fireEvent.click(screen.getByRole('button', { name: 'config' }))
        expect(mocks.navigate).toHaveBeenCalledWith(expect.objectContaining({
            to: '/sessions/$sessionId',
            params: { sessionId: 'session-1' },
        }))
    })

    it('shows why the runner is offline and retries', async () => {
        mocks.getSessionConfig
            .mockResolvedValueOnce({ success: false, error: 'RPC handler not registered: session-1:listSessionConfig' })
            .mockResolvedValueOnce({
                success: true,
                mcp: { kind: 'servers', servers: [{ name: 'hapi', source: 'injected' }] },
                skills: { items: [], catalogUnavailable: false },
                hooks: { availability: 'listed', items: [] },
            })
        renderPage()
        expect(await screen.findByRole('alert')).toHaveTextContent('Runner is offline and the config could not be read.')
        expect(screen.queryByRole('heading', { name: 'MCP' })).toBeNull()

        fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
        expect(await screen.findByRole('heading', { name: 'MCP' })).toBeTruthy()
        expect(screen.queryByRole('alert')).toBeNull()
    })

    it('shows a truncated reason without an absolute path', async () => {
        mocks.getSessionConfig.mockResolvedValue({
            success: false,
            error: 'failed to read /Users/dev/project/.mcp.json',
        })
        renderPage()
        const alert = await screen.findByRole('alert')
        expect(alert).toHaveTextContent('Could not read session config: failed to read')
        expect(alert.textContent).not.toContain('/Users/')
    })

    it('shows unavailable when the runner error is empty', async () => {
        mocks.getSessionConfig.mockResolvedValue({ success: false, error: '' })
        renderPage()
        expect(await screen.findByRole('alert')).toHaveTextContent('Unavailable')
        expect(screen.queryByText(/Failed to read/)).toBeNull()
    })

    it('opens a skill, locks an injected switch, and returns to the list', async () => {
        mocks.getSessionConfig.mockResolvedValue({
            success: true,
            mcp: { kind: 'servers', servers: [{ name: 'hapi', source: 'injected' }] },
            skills: { items: [{ name: 'docs', source: 'user', description: 'Read docs' }] },
            hooks: { availability: 'listed', items: [] },
        })
        mocks.getSessionConfigItem.mockResolvedValue({
            success: true,
            kind: 'skill',
            name: 'docs',
            source: 'user',
            enabled: true,
            mutable: true,
            markdown: '# Docs\n\nHello',
            truncated: false,
        })
        renderPage()
        expect(await screen.findByRole('switch', { name: 'Enable hapi' })).toBeDisabled()
        fireEvent.click(screen.getByRole('button', { name: /^docs/ }))
        expect(await screen.findByText(/# Docs/)).toBeTruthy()
        expect(screen.getAllByText('This agent does not honor a per-item switch, so turning it off here would not stop it.')).toHaveLength(1)
        expect(screen.queryByText('Changes apply the next time you start a session or restart the agent.')).toBeNull()
        expect(screen.queryByText('Injected, system, tool, and plugin items cannot be changed here.')).toBeNull()
        fireEvent.click(screen.getByRole('button', { name: 'Back to list' }))
        expect(await screen.findByRole('heading', { name: 'MCP' })).toBeTruthy()
    })

    it('shows a redacted hook script from the live detail', async () => {
        mocks.getSessionConfig.mockResolvedValue({
            success: true,
            mcp: { kind: 'servers', servers: [] },
            skills: { items: [] },
            hooks: { availability: 'listed', items: [{ event: 'PreToolUse', matcher: 'Bash', source: 'user', commandName: 'my-hook' }] },
        })
        mocks.getSessionConfigItem.mockResolvedValue({
            success: true,
            kind: 'hook',
            event: 'PreToolUse',
            matcher: 'Bash',
            commandName: 'my-hook',
            source: 'user',
            enabled: true,
            mutable: true,
            script: 'run --token=***',
            truncated: false,
        })
        renderPage()
        fireEvent.click(await screen.findByRole('button', { name: /PreToolUse/ }))
        expect(await screen.findByText('run --token=***')).toBeTruthy()
        expect(screen.getAllByText('This agent does not honor a per-item switch, so turning it off here would not stop it.')).toHaveLength(1)
        expect(screen.queryByText('Changes apply the next time you start a session or restart the agent.')).toBeNull()
        expect(screen.queryByText('Injected, system, tool, and plugin items cannot be changed here.')).toBeNull()
        expect(screen.queryByText(/127\.0\.0\.1/)).toBeNull()
    })

    it('shows the injected lock reason once', async () => {
        mocks.getSessionConfig.mockResolvedValue({
            success: true,
            mcp: { kind: 'servers', servers: [{ name: 'hapi', source: 'injected' }] },
            skills: { items: [] },
            hooks: { availability: 'listed', items: [] },
        })
        mocks.getSessionConfigItem.mockResolvedValue({
            success: true,
            kind: 'mcp',
            name: 'hapi',
            source: 'injected',
            enabled: true,
            mutable: false,
            tools: [],
        })
        renderPage()
        fireEvent.click(await screen.findByRole('button', { name: /hapi/ }))
        expect(await screen.findAllByText('Injected, system, tool, and plugin items cannot be changed here.')).toHaveLength(1)
        expect(screen.queryByText('Changes apply the next time you start a session or restart the agent.')).toBeNull()
    })

    it('disables retry while a refetch is in flight', async () => {
        let release: (value: unknown) => void = () => undefined
        mocks.getSessionConfig
            .mockResolvedValueOnce({ success: false, error: 'RPC handler not registered: session-1:listSessionConfig' })
            .mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
        renderPage()
        fireEvent.click(await screen.findByRole('button', { name: 'Retry' }))
        await waitFor(() => expect(screen.getByRole('button', { name: 'Retry' })).toBeDisabled())
        release({ success: false, error: 'RPC handler not registered: session-1:listSessionConfig' })
        await waitFor(() => expect(screen.getByRole('button', { name: 'Retry' })).not.toBeDisabled())
    })

    it('opens a prompt without a switch and shows the truncation note', async () => {
        mocks.getSessionConfig.mockResolvedValue({
            success: true,
            mcp: { kind: 'servers', servers: [] },
            skills: { items: [] },
            hooks: { availability: 'listed', items: [] },
            prompts: {
                system: {
                    availability: 'listed',
                    note: 'claude-builtin',
                    items: [{ id: 'sys', role: 'system', scope: 'injected', title: 'append-system-prompt', hasText: true }],
                },
                user: {
                    availability: 'listed',
                    items: [{
                        id: 'claude',
                        role: 'user',
                        scope: 'project',
                        title: 'CLAUDE.md',
                        pathLabel: 'CLAUDE.md',
                        preview: 'Use bun.',
                        load: 'path',
                        match: 'src/**/*.ts',
                        hasText: true,
                    }],
                },
            },
        })
        mocks.getSessionConfigItem.mockResolvedValue({
            success: true,
            kind: 'prompt',
            id: 'claude',
            title: 'CLAUDE.md',
            markdown: '# Project\n\nUse bun.',
            truncated: true,
            note: 'no-import',
        })
        renderPage()
        expect(await screen.findByRole('heading', { name: 'System prompt' })).toBeTruthy()
        expect(screen.getByRole('heading', { name: 'User prompt' })).toBeTruthy()
        expect(screen.getByText('Does not include Claude Code’s built-in system prompt.')).toBeTruthy()
        expect(screen.getByText('Loads for matching paths · src/**/*.ts')).toBeTruthy()
        expect(screen.queryByRole('switch', { name: 'Enable CLAUDE.md' })).toBeNull()
        fireEvent.click(screen.getByRole('button', { name: /CLAUDE.md/ }))
        expect(await screen.findByText('Showing the first part only.')).toBeTruthy()
        expect(screen.getByText('@import lines are not expanded.')).toBeTruthy()
        expect(screen.getByText(/# Project/)).toBeTruthy()
        expect(screen.queryByRole('switch')).toBeNull()
    })
})
