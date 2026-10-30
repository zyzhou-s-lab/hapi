import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '@/lib/i18n-context'
import SessionConfigPage from './config'

const mocks = vi.hoisted(() => ({
    navigate: vi.fn(),
    header: null as null | { configActive?: boolean; onToggleConfig?: () => void },
    getSessionConfig: vi.fn(),
}))

vi.mock('@tanstack/react-router', () => ({
    useNavigate: () => mocks.navigate,
    useParams: () => ({ sessionId: 'session-1' }),
}))

vi.mock('@/lib/app-context', () => ({
    useAppContext: () => ({
        api: { getSessionConfig: mocks.getSessionConfig },
        titleSuggestionAvailable: false,
    }),
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
        expect(screen.queryByText(/127\.0\.0\.1/)).toBeNull()
        expect(screen.queryByText(/token/i)).toBeNull()
        expect(mocks.header?.configActive).toBe(true)

        fireEvent.click(screen.getByRole('button', { name: 'config' }))
        expect(mocks.navigate).toHaveBeenCalledWith(expect.objectContaining({
            to: '/sessions/$sessionId',
            params: { sessionId: 'session-1' },
        }))
    })

    it('shows unavailable when the runner cannot answer', async () => {
        mocks.getSessionConfig.mockResolvedValue({ success: false, error: 'handler-not-registered' })
        renderPage()
        expect(await screen.findByText('Unavailable')).toBeTruthy()
        expect(screen.queryByRole('heading', { name: 'MCP' })).toBeNull()
    })
})
