import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams, useSearch } from '@tanstack/react-router'
import { PRESERVE_SESSION_SIDEBAR_SCROLL } from '@/lib/sessionNavigation'
import type { FileSearchItem, GitChange, GitRef, GitScope } from '@/types/api'
import { FileIcon } from '@/components/FileIcon'
import { DirectoryTree } from '@/components/SessionFiles/DirectoryTree'
import { SessionHeader } from '@/components/SessionHeader'
import { LoadingState } from '@/components/LoadingState'
import { useAppContext } from '@/lib/app-context'
import { useAppGoBack } from '@/hooks/useAppGoBack'
import { useGitRepository } from '@/fork-features/source-control/useGitRepository'
import { useGitScope } from '@/fork-features/source-control/useGitScope'
import { useSession } from '@/hooks/queries/useSession'
import { useSessionFileSearch } from '@/hooks/queries/useSessionFileSearch'
import {
    formatFileSearchError,
    formatGitStatusError,
    getDetachedBranchLabel,
    getProjectRootLabel,
} from '@/lib/files-i18n'
import { encodeBase64 } from '@/lib/utils'
import { queryKeys } from '@/lib/query-keys'
import { transferComposerDraftThenNavigate } from '@/lib/composer-draft-transfer'
import { formatFileMetadata } from '@/lib/file-metadata'
import { useQueryClient } from '@tanstack/react-query'
import { useTranslation } from '@/lib/use-translation'
import * as Popover from '@radix-ui/react-popover'
import { CheckIcon, CloseIcon } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { SessionReadBanner } from '@/components/SessionReadBanner'
import {
    DEFAULT_DIRECTORY_SORT,
    type DirectorySort,
    type DirectorySortDirection,
    type DirectorySortField,
    sortFileSearchItems,
} from '@/lib/directory-sort'

function RefreshIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <path d="M21 12a9 9 0 1 1-3-6.7" />
            <polyline points="21 3 21 9 15 9" />
        </svg>
    )
}

function SortIcon() {
    return (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 6h13" /><path d="M3 12h9" /><path d="M3 18h5" />
            <path d="m17 15 3 3 3-3" /><path d="M20 18V6" />
        </svg>
    )
}

const DIRECTORY_SORT_STORAGE_KEY = 'hapi-directory-sort'

function readDirectorySort(): DirectorySort {
    try {
        const value = JSON.parse(localStorage.getItem(DIRECTORY_SORT_STORAGE_KEY) ?? '') as Partial<DirectorySort>
        if (['name', 'modified', 'size'].includes(value.field ?? '') && ['asc', 'desc'].includes(value.direction ?? '')) {
            return value as DirectorySort
        }
    } catch {
        // Use the default when storage is unavailable or invalid.
    }
    return DEFAULT_DIRECTORY_SORT
}

function DirectorySortMenu(props: { sort: DirectorySort; onChange: (sort: DirectorySort) => void; embedded?: boolean }) {
    const { t } = useTranslation()
    const fields: Array<{ value: DirectorySortField; label: string }> = [
        { value: 'name', label: t('files.sort.name') },
        { value: 'modified', label: t('files.sort.modified') },
        { value: 'size', label: t('files.sort.size') },
    ]
    const directions: Array<{ value: DirectorySortDirection; label: string }> = props.sort.field === 'name'
        ? [{ value: 'asc', label: t('files.sort.nameAsc') }, { value: 'desc', label: t('files.sort.nameDesc') }]
        : props.sort.field === 'modified'
            ? [{ value: 'asc', label: t('files.sort.oldest') }, { value: 'desc', label: t('files.sort.newest') }]
            : [{ value: 'asc', label: t('files.sort.smallest') }, { value: 'desc', label: t('files.sort.largest') }]
    const optionClass = 'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-[var(--app-subtle-bg)]'

    return (
        <Popover.Root>
            <Popover.Trigger asChild>
                <button
                    type="button"
                    className={props.embedded
                        ? 'flex w-10 shrink-0 self-stretch items-center justify-center rounded-r-md rounded-l-sm text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]'
                        : 'flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]'}
                    title={t('files.sort.title')}
                    aria-label={t('files.sort.title')}
                >
                    <SortIcon />
                </button>
            </Popover.Trigger>
            <Popover.Portal>
                <Popover.Content side="bottom" align="end" sideOffset={6} collisionPadding={8} className="z-50 w-48 rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] p-2 shadow-lg">
                    <div className="px-2 pb-1 text-xs font-semibold text-[var(--app-hint)]">{t('files.sort.by')}</div>
                    {fields.map((field) => (
                        <button key={field.value} type="button" className={optionClass} onClick={() => props.onChange({ field: field.value, direction: props.sort.direction })}>
                            <span className="flex h-4 w-4 items-center justify-center">{props.sort.field === field.value ? <CheckIcon className="h-3.5 w-3.5" /> : null}</span>
                            {field.label}
                        </button>
                    ))}
                    <div className="my-1 border-t border-[var(--app-divider)]" />
                    {directions.map((direction) => (
                        <button key={direction.value} type="button" className={optionClass} onClick={() => props.onChange({ ...props.sort, direction: direction.value })}>
                            <span className="flex h-4 w-4 items-center justify-center">{props.sort.direction === direction.value ? <CheckIcon className="h-3.5 w-3.5" /> : null}</span>
                            {direction.label}
                        </button>
                    ))}
                </Popover.Content>
            </Popover.Portal>
        </Popover.Root>
    )
}

function SearchIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
    )
}

function GitBranchIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <line x1="6" y1="3" x2="6" y2="15" />
            <circle cx="6" cy="18" r="3" />
            <circle cx="18" cy="6" r="3" />
            <path d="M18 9a9 9 0 0 1-9 9" />
        </svg>
    )
}

function FolderIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="22"
            height="22"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
        </svg>
    )
}

function statusBadge(status: string): { label: string; color: string } {
    const normalized = status.trim().toLowerCase()
    const letter = normalized.charAt(0).toUpperCase()
    if (normalized.startsWith('add') || letter === 'A') {
        return { label: 'A', color: 'var(--app-git-staged-color)' }
    }
    if (normalized.startsWith('del') || letter === 'D') {
        return { label: 'D', color: 'var(--app-git-deleted-color)' }
    }
    if (normalized.startsWith('ren') || normalized.startsWith('cop') || letter === 'R' || letter === 'C') {
        return { label: 'R', color: 'var(--app-git-renamed-color)' }
    }
    if (normalized.startsWith('untrack') || letter === '?') {
        return { label: '?', color: 'var(--app-git-untracked-color)' }
    }
    if (normalized.startsWith('conflict') || normalized.startsWith('unmerged') || letter === 'U') {
        return { label: 'U', color: 'var(--app-git-deleted-color)' }
    }
    return { label: letter || 'M', color: 'var(--app-git-unstaged-color)' }
}

function StatusBadge(props: { status: string }) {
    const { label, color } = useMemo(() => statusBadge(props.status), [props.status])

    return (
        <span
            className="inline-flex items-center justify-center rounded border px-1.5 py-0.5 text-[10px] font-semibold"
            style={{ color, borderColor: color }}
        >
            {label}
        </span>
    )
}

function LineChanges(props: { added: number | null; removed: number | null; binary: boolean }) {
    const { t } = useTranslation()
    if (props.binary) {
        return <span className="text-[11px] text-[var(--app-hint)]">{t('sourceControl.binary')}</span>
    }
    if (props.added === null || props.removed === null) {
        return <span className="text-[11px] font-mono text-[var(--app-hint)]" title={t('sourceControl.unknownLines')}>?</span>
    }
    if (!props.added && !props.removed) return null

    return (
        <span className="flex items-center gap-1 text-[11px] font-mono">
            {props.added ? (
                <span className="text-[var(--app-diff-added-text)]">+{props.added}</span>
            ) : null}
            {props.removed ? (
                <span className="text-[var(--app-diff-removed-text)]">-{props.removed}</span>
            ) : null}
        </span>
    )
}

function GitChangeRow(props: {
    file: GitChange
    onOpen: () => void
    showDivider: boolean
}) {
    const { t } = useTranslation()
    const fileName = props.file.path.split('/').pop() || props.file.path
    const directory = props.file.path.split('/').slice(0, -1).join('/')
    const subtitle = props.file.oldPath
        ? `${props.file.oldPath} → ${props.file.path}`
        : getProjectRootLabel(directory, t)

    return (
        <button
            type="button"
            onClick={props.onOpen}
            className={`flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-[var(--app-subtle-bg)] transition-colors ${props.showDivider ? 'border-b border-[var(--app-divider)]' : ''}`}
        >
            <FileIcon fileName={fileName} size={22} />
            <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate font-medium">{fileName}</span>
                    {props.file.staged ? (
                        <span
                            className="shrink-0 rounded border border-[var(--app-git-staged-color)] px-1 text-[10px] font-semibold text-[var(--app-git-staged-color)]"
                            title={t('sourceControl.scope.staged')}
                        >S</span>
                    ) : null}
                    {props.file.unstaged ? (
                        <span
                            className="shrink-0 rounded border border-[var(--app-git-unstaged-color)] px-1 text-[10px] font-semibold text-[var(--app-git-unstaged-color)]"
                            title={t('sourceControl.scope.unstaged')}
                        >U</span>
                    ) : null}
                    {props.file.untracked ? (
                        <span className="shrink-0 text-[10px] font-semibold text-[var(--app-git-untracked-color)]">
                            {t('sourceControl.untracked')}
                        </span>
                    ) : null}
                </div>
                <div className="truncate text-xs text-[var(--app-hint)]">{subtitle}</div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
                <LineChanges added={props.file.additions} removed={props.file.deletions} binary={props.file.binary} />
                <StatusBadge status={props.file.status} />
            </div>
        </button>
    )
}

function GitScopePicker(props: {
    scope: GitScope
    baseRef?: string
    refs: GitRef[]
    defaultBranch: string | null
    onScopeChange: (scope: GitScope) => void
    onBaseRefChange: (baseRef: string | undefined) => void
}) {
    const { t } = useTranslation()
    const selectedBaseRef = props.baseRef ?? ''
    const refNames = props.refs.map((ref) => ref.name)
    const baseRefOptions = selectedBaseRef && !refNames.includes(selectedBaseRef)
        ? [selectedBaseRef, ...refNames]
        : refNames

    return (
        <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1.5 text-xs text-[var(--app-hint)]">
                <span>{t('sourceControl.scope')}</span>
                <select
                    value={props.scope}
                    onChange={(event) => props.onScopeChange(event.target.value as GitScope)}
                    className="h-9 rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-2 text-xs text-[var(--app-fg)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
                >
                    <option value="working">{t('sourceControl.scope.working')}</option>
                    <option value="staged">{t('sourceControl.scope.staged')}</option>
                    <option value="unstaged">{t('sourceControl.scope.unstaged')}</option>
                    <option value="branch">{t('sourceControl.scope.branch')}</option>
                </select>
            </label>
            {props.scope === 'branch' ? (
                <label className="flex min-w-0 items-center gap-1.5 text-xs text-[var(--app-hint)]">
                    <span>{t('sourceControl.baseRef')}</span>
                    <select
                        value={selectedBaseRef}
                        onChange={(event) => props.onBaseRefChange(event.target.value || undefined)}
                        className="h-9 min-w-0 max-w-[220px] rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-2 text-xs text-[var(--app-fg)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
                    >
                        <option value="">{t('sourceControl.chooseBase')}{props.defaultBranch ? ` (${props.defaultBranch})` : ''}</option>
                        {baseRefOptions.map((name) => (
                            <option key={name} value={name}>{name}</option>
                        ))}
                    </select>
                </label>
            ) : null}
        </div>
    )
}

function SearchResultRow(props: {
    file: FileSearchItem
    onOpen: () => void
    showDivider: boolean
}) {
    const { locale } = useTranslation()
    const metadata = formatFileMetadata(props.file.size, props.file.modified, locale)
    const icon = props.file.fileType === 'file'
        ? <FileIcon fileName={props.file.fileName} size={22} />
        : <FolderIcon className="text-[var(--app-link)]" />

    return (
        <button
            type="button"
            onClick={props.onOpen}
            className={`flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-[var(--app-subtle-bg)] transition-colors ${props.showDivider ? 'border-b border-[var(--app-divider)]' : ''}`}
        >
            {icon}
            <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{props.file.fullPath}</div>
                {metadata ? <div className="text-xs text-[var(--app-hint)]">{metadata}</div> : null}
            </div>
        </button>
    )
}

function FileListSkeleton(props: { label: string; rows?: number }) {
    const titleWidths = ['w-1/3', 'w-1/2', 'w-2/3', 'w-2/5', 'w-3/5']
    const subtitleWidths = ['w-1/2', 'w-2/3', 'w-3/4', 'w-1/3']
    const rows = props.rows ?? 6

    return (
        <div className="p-3 animate-pulse space-y-3" role="status" aria-live="polite">
            <span className="sr-only">{props.label}</span>
            {Array.from({ length: rows }).map((_, index) => (
                <div key={`skeleton-row-${index}`} className="flex items-center gap-3">
                    <div className="h-6 w-6 rounded bg-[var(--app-subtle-bg)]" />
                    <div className="flex-1 space-y-2">
                        <div className={`h-3 ${titleWidths[index % titleWidths.length]} rounded bg-[var(--app-subtle-bg)]`} />
                        <div className={`h-2 ${subtitleWidths[index % subtitleWidths.length]} rounded bg-[var(--app-subtle-bg)]`} />
                    </div>
                </div>
            ))}
        </div>
    )
}

const SCROLL_KEY_PREFIX = 'hapi-dir-scroll-'

export default function FilesPage() {
    const { api, titleSuggestionAvailable = false } = useAppContext()
    const { t, locale } = useTranslation()
    const navigate = useNavigate()
    const queryClient = useQueryClient()
    const goBack = useAppGoBack()
    const { sessionId } = useParams({ from: '/sessions/$sessionId/files' })
    const search = useSearch({ from: '/sessions/$sessionId/files' })
    const { session } = useSession(api, sessionId)
    const scrollRef = useRef<HTMLDivElement>(null)

    const initialTab = search.tab === 'directories' ? 'directories' : 'changes'
    const [activeTab, setActiveTab] = useState<'changes' | 'directories'>(initialTab)
    const [directorySort, setDirectorySort] = useState<DirectorySort>(readDirectorySort)
    const searchQuery = search.query ?? ''

    const setSearchQuery = useCallback((query: string) => {
        navigate({
            to: '/sessions/$sessionId/files',
            params: { sessionId },
            search: {
                ...(activeTab === 'directories' ? { tab: 'directories' as const } : {}),
                ...(query ? { query } : {}),
            },
            replace: true,
            ...PRESERVE_SESSION_SIDEBAR_SCROLL,
        })
    }, [activeTab, navigate, sessionId])

    useEffect(() => {
        try {
            localStorage.setItem(DIRECTORY_SORT_STORAGE_KEY, JSON.stringify(directorySort))
        } catch {
            // Sorting still works when storage is unavailable.
        }
    }, [directorySort])

    useEffect(() => {
        const el = scrollRef.current
        if (!el) return
        const key = `${SCROLL_KEY_PREFIX}${sessionId}:${activeTab}`
        try {
            const saved = sessionStorage.getItem(key)
            if (saved !== null) el.scrollTop = Number(saved)
        } catch {
            // ignore
        }
        return () => {
            try {
                sessionStorage.setItem(key, String(el.scrollTop))
            } catch {
                // ignore
            }
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeTab, sessionId])

    const {
        scope: persistedScope,
        baseRef: persistedBaseRef,
        setScope,
        setBaseRef
    } = useGitScope(sessionId)
    const scope = search.scope ?? persistedScope
    const baseRef = search.baseRef ?? persistedBaseRef
    const effectiveBaseRef = scope === 'branch' ? baseRef : undefined
    const {
        repository,
        error: gitError,
        isLoading: gitLoading,
        refetch: refetchGit
    } = useGitRepository(api, sessionId, scope, effectiveBaseRef)

    useEffect(() => {
        if (search.scope) setScope(search.scope)
        if (search.baseRef) setBaseRef(search.baseRef)
    }, [search.baseRef, search.scope, setBaseRef, setScope])

    const shouldSearch = Boolean(searchQuery)

    const searchResults = useSessionFileSearch(api, sessionId, searchQuery, {
        enabled: shouldSearch
    })
    const sortedSearchResults = useMemo(
        () => sortFileSearchItems(searchResults.files, directorySort, locale),
        [directorySort, locale, searchResults.files]
    )

    const handleOpenFile = useCallback((path: string, nextScope?: GitScope, nextBaseRef?: string) => {
        const fileSearch = {
            path: encodeBase64(path),
            ...(nextScope ? { scope: nextScope } : {}),
            ...(nextScope && nextBaseRef ? { baseRef: nextBaseRef } : {}),
            ...(activeTab === 'directories' ? { tab: 'directories' as const } : {}),
            ...(searchQuery ? { query: searchQuery } : {}),
        }
        navigate({
            to: '/sessions/$sessionId/file',
            params: { sessionId },
            search: fileSearch,
            ...PRESERVE_SESSION_SIDEBAR_SCROLL,
        })
    }, [activeTab, navigate, searchQuery, sessionId])

    const navigateFilesScope = useCallback((nextScope: GitScope, nextBaseRef: string | undefined) => {
        navigate({
            to: '/sessions/$sessionId/files',
            params: { sessionId },
            search: {
                ...(activeTab === 'directories' ? { tab: 'directories' as const } : {}),
                ...(searchQuery ? { query: searchQuery } : {}),
                scope: nextScope,
                ...(nextScope === 'branch' && nextBaseRef ? { baseRef: nextBaseRef } : {}),
            },
            replace: true,
            ...PRESERVE_SESSION_SIDEBAR_SCROLL,
        })
    }, [activeTab, navigate, searchQuery, sessionId])

    const handleScopeChange = useCallback((nextScope: GitScope) => {
        setScope(nextScope)
        navigateFilesScope(nextScope, baseRef)
    }, [baseRef, navigateFilesScope, setScope])

    const handleBaseRefChange = useCallback((nextBaseRef: string | undefined) => {
        setBaseRef(nextBaseRef)
        navigateFilesScope('branch', nextBaseRef)
    }, [navigateFilesScope, setBaseRef])

    const branchLabel = getDetachedBranchLabel(repository?.branch, t)
    const changedFiles = repository?.files ?? []
    const stagedCount = repository?.stagedFiles.length ?? 0
    const unstagedCount = repository?.unstagedFiles.length ?? 0
    const resolvedBaseRef = baseRef ?? repository?.baseRef ?? undefined
    const gitErrorMessage = useMemo(
        () => {
            const detail = gitError ?? repository?.blockedReason
            return detail ? formatGitStatusError(detail, t) : null
        },
        [gitError, repository?.blockedReason, t]
    )
    const showGitErrorBanner = Boolean(gitErrorMessage)
    const searchErrorMessage = useMemo(
        () => (searchResults.error ? formatFileSearchError(searchResults.error, t) : null),
        [searchResults.error, t]
    )
    const rootLabel = useMemo(() => {
        const base = session?.metadata?.path ?? sessionId
        const parts = base.split(/[/\\]/).filter(Boolean)
        return parts.length ? parts[parts.length - 1] : base
    }, [session?.metadata?.path, sessionId])

    const handleRefresh = useCallback(() => {
        if (searchQuery) {
            void queryClient.invalidateQueries({
                queryKey: queryKeys.sessionFiles(sessionId, searchQuery)
            })
            return
        }

        if (activeTab === 'directories') {
            void queryClient.invalidateQueries({
                queryKey: ['session-directory', sessionId]
            })
            return
        }

        void refetchGit()
    }, [activeTab, queryClient, refetchGit, searchQuery, sessionId])

    const handleTabChange = useCallback((nextTab: 'changes' | 'directories') => {
        setActiveTab(nextTab)
        navigate({
            to: '/sessions/$sessionId/files',
            params: { sessionId },
            search: {
                ...(nextTab === 'directories' ? { tab: nextTab } : {}),
                ...(searchQuery ? { query: searchQuery } : {}),
            },
            replace: true,
            ...PRESERVE_SESSION_SIDEBAR_SCROLL,
        })
    }, [navigate, searchQuery, sessionId])

    const handleToggleFiles = useCallback(() => {
        navigate({
            to: '/sessions/$sessionId',
            params: { sessionId },
            ...PRESERVE_SESSION_SIDEBAR_SCROLL,
        })
    }, [navigate, sessionId])

    const handleToggleConfig = useCallback(() => {
        navigate({
            to: '/sessions/$sessionId/config',
            params: { sessionId },
            ...PRESERVE_SESSION_SIDEBAR_SCROLL,
        })
    }, [navigate, sessionId])

    const handleToggleOutline = useCallback(() => {
        navigate({
            to: '/sessions/$sessionId',
            params: { sessionId },
            search: { outline: true },
            ...PRESERVE_SESSION_SIDEBAR_SCROLL,
        })
    }, [navigate, sessionId])

    if (!session) {
        return (
            <div className="flex flex-1 items-center justify-center p-4">
                <LoadingState label={t('loading.files')} className="text-sm" />
            </div>
        )
    }

    return (
        <div className="flex h-full min-h-0 flex-col">
            <SessionHeader
                session={session}
                onBack={goBack}
                onToggleFiles={session.metadata?.path ? handleToggleFiles : undefined}
                filesActive={true}
                onToggleOutline={handleToggleOutline}
                outlineActive={false}
                onToggleConfig={handleToggleConfig}
                configActive={false}
                api={api}
                titleSuggestionAvailable={titleSuggestionAvailable}
                onSessionDeleted={goBack}
                onSessionReopened={async (newSessionId) => {
                    await transferComposerDraftThenNavigate(
                        session.id,
                        newSessionId,
                        () => navigate({
                            to: '/sessions/$sessionId/files',
                            params: { sessionId: newSessionId },
                            replace: true,
                            ...PRESERVE_SESSION_SIDEBAR_SCROLL,
                        }),
                    )
                }}
            />

            <div className="bg-[var(--app-bg)]">
                <div className="mx-auto flex w-full max-w-content items-center gap-2 border-b border-[var(--app-border)] p-3">
                    <div className="relative min-w-0 flex-1">
                        <SearchIcon className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--app-hint)]" />
                        <input
                            value={searchQuery}
                            onChange={(event) => setSearchQuery(event.target.value)}
                            placeholder={t('files.page.searchPlaceholder')}
                            className="h-9 w-full rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] py-2 pl-9 pr-20 text-sm text-[var(--app-fg)] outline-none placeholder:text-[var(--app-hint)] focus:border-[var(--app-link)] focus:ring-1 focus:ring-[var(--app-link)]"
                            autoCapitalize="none"
                            autoCorrect="off"
                        />
                        {searchQuery ? (
                            <button
                                type="button"
                                onClick={() => setSearchQuery('')}
                                className="absolute inset-y-0 right-10 flex items-center rounded p-0.5 text-[var(--app-hint)] hover:text-[var(--app-fg)]"
                                title={t('sessions.search.clear')}
                                aria-label={t('sessions.search.clear')}
                            >
                                <CloseIcon className="h-3.5 w-3.5" />
                            </button>
                        ) : null}
                        {activeTab === 'directories' || searchQuery ? (
                            <div className="absolute inset-y-0 right-0 flex items-stretch">
                                <DirectorySortMenu sort={directorySort} onChange={setDirectorySort} embedded />
                            </div>
                        ) : null}
                    </div>
                    <Button
                        variant="outline"
                        type="button"
                        onClick={handleRefresh}
                        className="h-9 w-9 shrink-0 px-0"
                        title={t('files.page.refreshFilesystem')}
                        aria-label={t('files.page.refreshFilesystem')}
                    >
                        <RefreshIcon />
                    </Button>
                </div>
            </div>

            <div className="bg-[var(--app-bg)] border-b border-[var(--app-divider)]" role="tablist">
                <div className="mx-auto w-full max-w-content grid grid-cols-2">
                    <button
                        type="button"
                        role="tab"
                        aria-selected={activeTab === 'changes'}
                        onClick={() => handleTabChange('changes')}
                        className={`relative py-3 text-center text-sm font-semibold transition-colors hover:bg-[var(--app-subtle-bg)] ${activeTab === 'changes' ? 'text-[var(--app-fg)]' : 'text-[var(--app-hint)]'}`}
                    >
                        {t('files.tab.changes')}
                        <span
                            className={`absolute bottom-0 left-1/2 h-0.5 w-10 -translate-x-1/2 rounded-full ${activeTab === 'changes' ? 'bg-[var(--app-link)]' : 'bg-transparent'}`}
                        />
                    </button>
                    <button
                        type="button"
                        role="tab"
                        aria-selected={activeTab === 'directories'}
                        onClick={() => handleTabChange('directories')}
                        className={`relative py-3 text-center text-sm font-semibold transition-colors hover:bg-[var(--app-subtle-bg)] ${activeTab === 'directories' ? 'text-[var(--app-fg)]' : 'text-[var(--app-hint)]'}`}
                    >
                        {t('files.tab.directories')}
                        <span
                            className={`absolute bottom-0 left-1/2 h-0.5 w-10 -translate-x-1/2 rounded-full ${activeTab === 'directories' ? 'bg-[var(--app-link)]' : 'bg-transparent'}`}
                        />
                    </button>
                </div>
            </div>

            {!gitLoading && repository && !searchQuery && activeTab === 'changes' ? (
                <div className="bg-[var(--app-bg)]">
                    <div className="mx-auto w-full max-w-content space-y-2 px-3 py-2 border-b border-[var(--app-divider)]">
                        <div className="flex flex-wrap items-center gap-2 text-sm">
                            <GitBranchIcon className="text-[var(--app-hint)]" />
                            <span className="font-semibold">{branchLabel}</span>
                            {repository.ahead > 0 ? (
                                <span className="text-xs font-mono text-[var(--app-hint)]">↑{repository.ahead}</span>
                            ) : null}
                            {repository.behind > 0 ? (
                                <span className="text-xs font-mono text-[var(--app-hint)]">↓{repository.behind}</span>
                            ) : null}
                            <span className="text-xs text-[var(--app-hint)]">
                                {t('sourceControl.changedCount', { n: changedFiles.length })}
                            </span>
                        </div>
                        <div className="flex flex-wrap items-center gap-3 text-xs text-[var(--app-hint)]">
                            {stagedCount > 0 ? <span>{t('sourceControl.stagedCount', { n: stagedCount })}</span> : null}
                            {unstagedCount > 0 ? <span>{t('sourceControl.modifiedCount', { n: unstagedCount })}</span> : null}
                            {!session.active ? <span>{t('sourceControl.block.offline')}</span> : null}
                        </div>
                        <GitScopePicker
                            scope={scope}
                            baseRef={resolvedBaseRef}
                            refs={repository.refs}
                            defaultBranch={repository.defaultBranch}
                            onScopeChange={handleScopeChange}
                            onBaseRefChange={handleBaseRefChange}
                        />
                    </div>
                </div>
            ) : null}

            <div
                ref={scrollRef}
                data-hapi-session-files-scroll="true"
                className="app-scroll-y flex-1 min-h-0"
            >
                <div className="mx-auto w-full max-w-content">
                    {showGitErrorBanner && activeTab === 'changes' && gitErrorMessage ? (
                        <SessionReadBanner message={gitErrorMessage} />
                    ) : null}
                    {shouldSearch ? (
                        searchResults.isLoading ? (
                            <FileListSkeleton label={t('loading.files')} />
                        ) : searchResults.error ? (
                            <div className="p-6 text-sm text-[var(--app-hint)]">{searchErrorMessage}</div>
                        ) : searchResults.files.length === 0 ? (
                            <div className="p-6 text-sm text-[var(--app-hint)]">
                                {t('files.search.empty')}
                            </div>
                        ) : (
                            <div className="border-t border-[var(--app-divider)]">
                                {sortedSearchResults.map((file, index) => (
                                    <SearchResultRow
                                        key={file.fullPath}
                                        file={file}
                                        onOpen={() => handleOpenFile(file.fullPath)}
                                        showDivider={index < sortedSearchResults.length - 1}
                                    />
                                ))}
                            </div>
                        )
                    ) : activeTab === 'directories' ? (
                        <DirectoryTree
                            key={sessionId}
                            api={api}
                            sessionId={sessionId}
                            rootLabel={rootLabel}
                            onOpenFile={(path) => handleOpenFile(path)}
                            sort={directorySort}
                        />
                    ) : gitLoading ? (
                        <FileListSkeleton label={t('loading.git')} />
                    ) : (
                        <div>
                            {changedFiles.length === 0 ? (
                                <div className="p-6 text-sm text-[var(--app-hint)]">
                                    {repository ? t('sourceControl.noScopeChanges') : t('files.changes.empty.unavailable')}
                                </div>
                            ) : (
                                <div className="border-t border-[var(--app-divider)]">
                                    {changedFiles.map((file, index) => (
                                        <GitChangeRow
                                            key={file.path}
                                            file={file}
                                            onOpen={() => handleOpenFile(
                                                file.path,
                                                scope,
                                                scope === 'branch' ? resolvedBaseRef : undefined
                                            )}
                                            showDivider={index < changedFiles.length - 1}
                                        />
                                    ))}
                                </div>
                            )}
                        </div>
                    )}
                </div>
            </div>
        </div>
    )
}
