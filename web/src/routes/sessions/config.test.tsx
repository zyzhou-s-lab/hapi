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
        expect(screen.getByText('No skills configured')).toBeTruthy()
        expect(screen.getByText('This agent does not honor a per-item switch, so turning it off here would not stop it.')).toBeTruthy()
        expect(screen.getByText('Injected, system, tool, and plugin items cannot be changed here.')).toBeTruthy()
        expect(screen.queryByText('Changes apply the next time you start a session or restart the agent.')).toBeNull()
        expect(screen.queryByText('Tool names, not servers')).toBeNull()
        expect(screen.queryByText(/127\.0\.0\.1/)).toBeNull()
        expect(screen.queryByText(/token/i)).toBeNull()
        expect(mocks.header?.configActive).toBe(true)

        fireEvent.click(screen.getByRole('button', { name: 'config' }))
        expect(mocks.navigate).toHaveBeenCalledWith(expect.objectContaining({
            to: '/sessions/$sessionId',
            params: { sessionId: 'session-1' },
        }))
    })

    it('labels loaded MCP servers and explains an empty section', async () => {
        mocks.getSessionConfig.mockResolvedValue({
            success: true,
            mcp: {
                kind: 'servers',
                servers: [
                    { name: 'notion', source: 'user', loaded: true },
                    { name: 'idle', source: 'user', loaded: false },
                ],
            },
            skills: { items: [] },
            hooks: { availability: 'listed', items: [] },
            prompts: {
                system: { availability: 'none', items: [] },
                user: { availability: 'none', items: [] },
            },
        })
        renderPage()
        expect(await screen.findByText('Loaded')).toBeTruthy()
        expect(screen.getByText('Not loaded')).toBeTruthy()
        expect(screen.getByText('No skills configured')).toBeTruthy()
        expect(screen.getByText('No hooks configured')).toBeTruthy()
        expect(screen.getByText('No system prompt')).toBeTruthy()
        expect(screen.getByText('No user prompt')).toBeTruthy()
        expect(screen.queryByText('未配置 MCP')).toBeNull()
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

    it('keeps a file-less skill and injected server on the list', async () => {
        mocks.getSessionConfig.mockResolvedValue({
            success: true,
            mcp: { kind: 'servers', servers: [{ name: 'hapi', source: 'injected' }] },
            skills: { items: [{ name: 'docs', source: 'user', description: 'Read docs' }] },
            hooks: { availability: 'listed', items: [] },
        })
        renderPage()
        const locked = await screen.findByRole('switch', { name: 'Enable hapi' })
        expect(locked).toBeDisabled()
        expect(locked.getAttribute('title')).toContain('cannot be changed')
        expect(screen.getByText('Applies to new sessions, for every session.')).toBeTruthy()
        expect(screen.queryByRole('button', { name: /^docs/ })).toBeNull()
        expect(screen.queryByRole('button', { name: /^hapi/ })).toBeNull()
        expect(screen.getByText('docs')).toBeTruthy()
        expect(screen.queryByText('›')).toBeNull()
    })

    it('opens a hook settings file and its script without an in-page detail', async () => {
        mocks.getSessionConfig.mockResolvedValue({
            success: true,
            mcp: { kind: 'servers', servers: [{ name: 'docs', source: 'user', filePath: '.mcp.json', line: 4 }] },
            skills: { items: [] },
            hooks: {
                availability: 'listed',
                items: [{ event: 'PreToolUse', matcher: 'Bash', source: 'user', commandName: 'my-hook', filePath: '.claude/settings.json', line: 12, scriptPath: 'hooks/my-hook.sh' }],
            },
        })
        renderPage()
        fireEvent.click(await screen.findByRole('button', { name: /PreToolUse/ }))
        expect(mocks.navigate).toHaveBeenCalledWith(expect.objectContaining({
            to: '/sessions/$sessionId/file',
            search: expect.objectContaining({ origin: 'config', line: 12 }),
        }))
        fireEvent.click(screen.getByRole('button', { name: 'Script' }))
        expect(mocks.navigate).toHaveBeenLastCalledWith(expect.objectContaining({
            to: '/sessions/$sessionId/file',
            search: expect.objectContaining({ origin: 'config' }),
        }))
        fireEvent.click(screen.getByRole('button', { name: /^docs/ }))
        expect(mocks.navigate).toHaveBeenLastCalledWith(expect.objectContaining({
            search: expect.objectContaining({ origin: 'config', line: 4 }),
        }))
        expect(screen.queryByText('Back to list')).toBeNull()
    })

    it('shows the injected lock on the switch and does not open a file-less prompt', async () => {
        mocks.getSessionConfig.mockResolvedValue({
            success: true,
            mcp: { kind: 'servers', servers: [{ name: 'hapi', source: 'injected' }] },
            skills: { items: [] },
            hooks: { availability: 'listed', items: [] },
            prompts: {
                system: {
                    availability: 'listed',
                    items: [{ id: 'sys', role: 'system', scope: 'injected', title: 'append-system-prompt', preview: 'Use the title tool.', hasText: true }],
                },
                user: {
                    availability: 'listed',
                    items: [{
                        id: 'local',
                        role: 'user',
                        scope: 'project',
                        title: 'CLAUDE.md',
                        pathLabel: 'CLAUDE.md',
                        preview: 'Use bun.',
                        filePath: 'CLAUDE.md',
                        hasText: true,
                    }],
                },
            },
        })
        renderPage()
        const locked = await screen.findByRole('switch', { name: 'Enable hapi' })
        expect(locked.getAttribute('title')).toContain('cannot be changed')
        expect(screen.getByText('Use the title tool.')).toBeTruthy()
        expect(screen.queryByRole('button', { name: /append-system-prompt|追加/ })).toBeNull()
        expect(screen.queryByText('›')).toBeTruthy()
        fireEvent.click(screen.getByRole('button', { name: /^CLAUDE\.md/ }))
        expect(mocks.navigate).toHaveBeenCalledWith(expect.objectContaining({
            to: '/sessions/$sessionId/file',
            params: { sessionId: 'session-1' },
            search: expect.objectContaining({ origin: 'config', path: expect.any(String) }),
        }))
    })

    it('toggles a user skill, explains a locked skill, and shows a write failure', async () => {
        mocks.getSessionConfig.mockResolvedValue({
            success: true,
            mcp: { kind: 'servers', servers: [] },
            skills: {
                items: [
                    { name: 'agent-browser', source: 'user', description: 'Drive a browser' },
                    { name: 'bundled', source: 'system', description: 'Built in' },
                ],
            },
            hooks: { availability: 'listed', items: [] },
        })
        mocks.setSessionConfigItemEnabled.mockResolvedValueOnce({ success: false, error: 'disk full' })
        renderPage()
        const userSwitch = await screen.findByRole('switch', { name: 'Enable agent-browser' })
        const lockedSwitch = screen.getByRole('switch', { name: 'Enable bundled' })
        expect(userSwitch).toBeEnabled()
        expect(lockedSwitch).toBeDisabled()
        expect(screen.getAllByText('Applies to new sessions, for every session.')).toHaveLength(1)
        expect(screen.getByText('Injected, system, tool, and plugin items cannot be changed here.')).toBeTruthy()

        expect(mocks.setSessionConfigItemEnabled).not.toHaveBeenCalled()


        fireEvent.click(userSwitch)
        expect(await screen.findByRole('alert')).toHaveTextContent('Could not update the switch: disk full')
        expect(mocks.setSessionConfigItemEnabled).toHaveBeenCalledWith('session-1', {
            kind: 'skill',
            name: 'agent-browser',
            source: 'user',
        }, false)
    })

})
