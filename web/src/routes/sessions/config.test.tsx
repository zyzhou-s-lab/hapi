import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '@/lib/i18n-context'
import SessionConfigPage from './config'

const mocks = vi.hoisted(() => ({
    navigate: vi.fn(),
    header: null as null | { configActive?: boolean; onToggleConfig?: () => void },
}))

vi.mock('@tanstack/react-router', () => ({
    useNavigate: () => mocks.navigate,
    useParams: () => ({ sessionId: 'session-1' }),
}))

vi.mock('@/lib/app-context', () => ({
    useAppContext: () => ({ api: { getSkills: vi.fn() }, titleSuggestionAvailable: false }),
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
            active: false,
            metadata: {
                path: '/work',
                sessionInventory: {
                    reportedAt: 1,
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
                },
            },
        },
    }),
}))

vi.mock('@/components/SessionHeader', () => ({
    SessionHeader: (props: { configActive?: boolean; onToggleConfig?: () => void }) => {
        mocks.header = props
        return <button type="button" onClick={props.onToggleConfig}>config</button>
    },
}))

describe('SessionConfigPage', () => {
    beforeEach(() => {
        mocks.navigate.mockClear()
        mocks.header = null
    })

    it('renders reported names and hides urls and tokens', () => {
        render(
            <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
                <I18nProvider>
                    <SessionConfigPage />
                </I18nProvider>
            </QueryClientProvider>
        )

        expect(mocks.header?.configActive).toBe(true)
        expect(screen.getByRole('heading', { name: 'MCP' })).toBeTruthy()
        expect(screen.getByRole('heading', { name: 'Skills' })).toBeTruthy()
        expect(screen.getByRole('heading', { name: 'Hooks' })).toBeTruthy()
        expect(screen.getByText('hapi')).toBeTruthy()
        expect(screen.getByText('Injected')).toBeTruthy()
        expect(screen.getByText('PreToolUse')).toBeTruthy()
        expect(screen.getByText('Bash · my-hook')).toBeTruthy()
        expect(screen.getByText('Session offline')).toBeTruthy()
        expect(screen.queryByText(/127\.0\.0\.1/)).toBeNull()
        expect(screen.queryByText(/token/i)).toBeNull()

        fireEvent.click(screen.getByRole('button', { name: 'config' }))
        expect(mocks.navigate).toHaveBeenCalledWith(expect.objectContaining({
            to: '/sessions/$sessionId',
            params: { sessionId: 'session-1' },
        }))
    })
})
