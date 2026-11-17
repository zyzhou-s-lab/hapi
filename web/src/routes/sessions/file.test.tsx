import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '@/lib/i18n-context'
import { ToastProvider } from '@/lib/toast-context'
import { formatFileMetadata } from '@/lib/file-metadata'
import { encodeBase64 } from '@/lib/utils'
import FilePage from './file'

const goBackMock = vi.fn()
const copyMock = vi.hoisted(() => vi.fn())
const searchMock = vi.hoisted(() => ({
    path: '',
    staged: undefined as boolean | undefined,
    scope: undefined as 'working' | 'staged' | 'unstaged' | 'branch' | undefined,
    baseRef: undefined as string | undefined,
}))
const getGitDiffFileMock = vi.hoisted(() => vi.fn(async () => ({ success: true, stdout: '' })))

const sampleMarkdown = '# Heading\n\n| Col A | Col B |\n| --- | --- |\n| one | two |'
const filePath = 'docs/README.md'
const encodedPath = encodeBase64(filePath)
const encodedContent = encodeBase64(sampleMarkdown)
const fileSize = 1024
const fileModified = 1_784_175_060_000

vi.mock('@tanstack/react-router', () => ({
    useParams: () => ({ sessionId: 'session-1' }),
    useSearch: () => searchMock,
}))

vi.mock('@/lib/app-context', () => ({
    useAppContext: () => ({
        api: {
            getGitDiffFile: getGitDiffFileMock,
            readSessionFile: vi.fn(async () => ({
                success: true,
                content: encodedContent,
                size: fileSize,
                modified: fileModified,
            })),
        },
    }),
}))

vi.mock('@/hooks/useAppGoBack', () => ({
    useAppGoBack: () => goBackMock,
}))

vi.mock('@/hooks/useCopyToClipboard', () => ({
    useCopyToClipboard: () => ({
        copied: false,
        copy: copyMock,
    }),
}))

vi.mock('@/lib/shiki', () => ({
    langAlias: { md: 'markdown' },
    useShikiHighlighter: (content: string) => content,
}))
vi.mock('@/components/MarkdownRenderer', () => ({
    MarkdownRenderer: (props: { content: string }) => (
        <div data-testid="markdown-preview">{props.content}</div>
    ),
}))

vi.mock('@/components/FileMarkdownView', () => ({
    FileMarkdownView: (props: { content: string }) => (
        <div data-testid="markdown-preview">{props.content}</div>
    ),
}))

function renderWithProviders() {
    const queryClient = new QueryClient({
        defaultOptions: {
            queries: { retry: false },
        },
    })
    return render(
        <QueryClientProvider client={queryClient}>
            <I18nProvider>
                <ToastProvider>
                    <FilePage />
                </ToastProvider>
            </I18nProvider>
        </QueryClientProvider>
    )
}

describe('FilePage markdown preview', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        window.localStorage.clear()
        window.sessionStorage.clear()
        searchMock.path = encodedPath
        searchMock.staged = undefined
        searchMock.scope = undefined
        searchMock.baseRef = undefined
    })

    it('renders markdown preview by default and toggles to source', async () => {
        renderWithProviders()

        await waitFor(() => {
            expect(screen.getByTestId('markdown-preview')).toHaveTextContent('# Heading')
        })
        expect(screen.getByText(formatFileMetadata(fileSize, fileModified, 'en')!)).toBeInTheDocument()
        expect(screen.getAllByText(filePath)).toHaveLength(1)
        const previewCopyButton = screen.getByTitle('Copy file content')
        fireEvent.click(previewCopyButton)
        expect(copyMock).toHaveBeenCalledWith(sampleMarkdown)
        expect(screen.getByRole('button', { name: 'Preview' })).toHaveClass('opacity-80')

        fireEvent.click(screen.getByRole('button', { name: 'Raw' }))

        await waitFor(() => {
            expect(screen.getByTestId('file-raw-pre')).toHaveTextContent('# Heading')
        })
        const sourceCopyButton = screen.getByTitle('Copy file content')
        copyMock.mockClear()
        fireEvent.click(sourceCopyButton)
        expect(copyMock).toHaveBeenCalledWith(sampleMarkdown)
        expect(screen.queryByTestId('markdown-preview')).not.toBeInTheDocument()

        fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
        await waitFor(() => {
            expect(screen.getByTestId('markdown-preview')).toBeInTheDocument()
        })
    })

    it('preserves the file preview scroll position across route remounts', async () => {
        const firstRender = renderWithProviders()

        await waitFor(() => {
            expect(screen.getByTestId('markdown-preview')).toBeInTheDocument()
        })
        const firstScrollRegion = document.querySelector('[data-hapi-file-scroll="true"]') as HTMLElement
        expect(firstScrollRegion).not.toBeNull()
        firstScrollRegion.scrollTop = 123
        firstRender.unmount()

        renderWithProviders()
        await waitFor(() => {
            expect(screen.getByTestId('markdown-preview')).toBeInTheDocument()
        })
        const secondScrollRegion = document.querySelector('[data-hapi-file-scroll="true"]') as HTMLElement
        expect(secondScrollRegion.scrollTop).toBe(123)
    })

    it('uses the exact scoped comparison for the diff and scroll identity', async () => {
        searchMock.scope = 'branch'
        searchMock.baseRef = 'origin/main'

        const firstRender = renderWithProviders()

        await waitFor(() => {
            expect(getGitDiffFileMock).toHaveBeenCalledWith(
                'session-1',
                filePath,
                undefined,
                { scope: 'branch', baseRef: 'origin/main' }
            )
        })

        const scrollRegion = document.querySelector('[data-hapi-file-scroll="true"]') as HTMLElement
        scrollRegion.scrollTop = 77
        firstRender.unmount()

        expect(Object.keys(sessionStorage).some((key) => key.includes(':branch:origin/main'))).toBe(true)
    })
})
