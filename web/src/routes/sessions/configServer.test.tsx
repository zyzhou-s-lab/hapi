import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '@/lib/i18n-context'
import SessionConfigServerPage from './configServer'

const mocks = vi.hoisted(() => ({
    navigate: vi.fn(),
    back: vi.fn(),
    search: { name: 'docs', source: 'user' } as { name: string; source: string },
    getSessionConfig: vi.fn(),
}))

vi.mock('@tanstack/react-router', () => ({
    useNavigate: () => mocks.navigate,
    useParams: () => ({ sessionId: 'session-1' }),
    useSearch: () => mocks.search,
}))

vi.mock('@/lib/app-context', () => ({
    useAppContext: () => ({
        api: { getSessionConfig: mocks.getSessionConfig },
        titleSuggestionAvailable: false,
    }),
}))

vi.mock('@/hooks/useAppGoBack', () => ({
    useAppGoBack: () => mocks.back,
}))

vi.mock('@/hooks/queries/useSession', () => ({
    useSession: () => ({
        session: { id: 'session-1', active: true, metadata: { path: '/work', flavor: 'omp' } },
    }),
}))

vi.mock('@/components/SessionHeader', () => ({
    SessionHeader: (props: { onBack?: () => void }) => (
        <button type="button" onClick={props.onBack}>back</button>
    ),
}))

function renderPage() {
    return render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
            <I18nProvider>
                <SessionConfigServerPage />
            </I18nProvider>
        </QueryClientProvider>,
    )
}

describe('SessionConfigServerPage', () => {
    beforeEach(() => {
        mocks.navigate.mockClear()
        mocks.back.mockClear()
        mocks.search = { name: 'docs', source: 'user' }
        mocks.getSessionConfig.mockReset()
    })

    it('shows the server, its redacted tools, and opens the config file', async () => {
        mocks.getSessionConfig.mockResolvedValue({
            success: true,
            mcp: {
                kind: 'servers',
                servers: [{
                    name: 'docs',
                    source: 'user',
                    filePath: '/custom/runner/.omp/agent/mcp.json',
                    pathLabel: '~/.omp/agent/mcp.json',
                    line: 4,
                    loaded: true,
                    toolsTruncated: true,
                    tools: [{ name: 'ping', description: 'bearer ***' }],
                }],
            },
        })
        renderPage()
        expect(await screen.findByRole('heading', { name: 'docs' })).toBeTruthy()
        expect(screen.getByText('Loaded')).toBeTruthy()
        expect(screen.getByText('User')).toBeTruthy()
        expect(screen.getByText('1+ tools')).toBeTruthy()
        expect(screen.getByText('Showing the first part only.')).toBeTruthy()
        expect(screen.getByText('ping')).toBeTruthy()
        expect(screen.getByText('bearer ***')).toBeTruthy()
        fireEvent.click(screen.getByRole('button', { name: '~/.omp/agent/mcp.json' }))
        expect(mocks.navigate).toHaveBeenCalledWith(expect.objectContaining({
            to: '/sessions/$sessionId/file',
            search: expect.objectContaining({ origin: 'mcp', mcpName: 'docs', mcpSource: 'user', line: 4 }),
        }))
        fireEvent.click(screen.getByRole('button', { name: 'back' }))
        expect(mocks.back).toHaveBeenCalled()
    })

    it('asks for a check when the project server has not been probed', async () => {
        mocks.search = { name: 'pending', source: 'project' }
        mocks.getSessionConfig.mockResolvedValue({
            success: true,
            mcp: { kind: 'servers', servers: [{ name: 'pending', source: 'project', filePath: '.mcp.json' }] },
        })
        renderPage()
        expect(await screen.findByText('Tools appear after a check')).toBeTruthy()
        expect(screen.getByRole('button', { name: 'Check' })).toBeTruthy()
        expect(screen.queryByText('ping')).toBeNull()
    })
})
