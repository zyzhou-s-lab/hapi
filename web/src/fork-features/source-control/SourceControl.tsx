import * as Popover from '@radix-ui/react-popover'
import { useNavigate } from '@tanstack/react-router'
import { useEffect, useMemo, useRef, useState } from 'react'
import type {
    GitActionRequest,
    GitActionResponse,
    GitChangesSummary,
    GitPullRequest,
    GitRepositoryStatus
} from '@hapi/protocol/sourceControl'
import type { ApiClient } from '@/api/client'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { useSessions } from '@/hooks/queries/useSessions'
import { useNarrowViewport } from '@/hooks/useNarrowViewport'
import { formatGitStatusError } from '@/lib/files-i18n'
import { PRESERVE_SESSION_SIDEBAR_SCROLL } from '@/lib/sessionNavigation'
import { useTranslation } from '@/lib/use-translation'
import type { Session } from '@/types/api'
import {
    buildGitMenuItems,
    getGitActionBlock,
    hasTrackedDirtyChanges,
    resolveQuickGitAction,
    splitRemoteRef,
    supportsExtendedGitActions,
    type GitQuickIcon
} from './actions'
import { GitActionDialogs, type GitDialogAction } from './GitActionDialogs'
import { useGitRepository } from './useGitRepository'
import './sourceControl.css'

const rowSurface = 'git-control-row flex w-full min-w-0 items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] font-medium transition-colors hover:bg-[var(--app-subtle-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)] disabled:cursor-not-allowed disabled:opacity-50'
const SUCCESS_VISIBLE_MS = 8_000

function BranchIcon({ className = 'h-4 w-4 shrink-0' }: { className?: string }) {
    return (
        <svg aria-hidden="true" className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="5" cy="3.5" r="1.7" />
            <circle cx="5" cy="12.5" r="1.7" />
            <circle cx="11" cy="5.5" r="1.7" />
            <path d="M5 5.2v5.6m6-3.6c0 2-2 3-6 3" />
        </svg>
    )
}

function ChevronDownIcon({ className = 'h-4 w-4 shrink-0' }: { className?: string }) {
    return (
        <svg aria-hidden="true" className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="m4 6 4 4 4-4" />
        </svg>
    )
}

function FileDiffIcon({ className = 'h-4 w-4 shrink-0' }: { className?: string }) {
    return (
        <svg aria-hidden="true" className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 1.8h5.2L12.5 5v9.2a.8.8 0 0 1-.8.8H4a.8.8 0 0 1-.8-.8V2.6a.8.8 0 0 1 .8-.8Z" />
            <path d="M9 1.8V5h3.5" />
            <path d="M6.2 8.2h3.6M8 6.4V10M6.2 12h3.6" />
        </svg>
    )
}

function ActionIcon({ icon, className = 'h-4 w-4 shrink-0' }: { icon: GitQuickIcon; className?: string }) {
    if (icon === 'commit') {
        return (
            <svg aria-hidden="true" className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
                <circle cx="8" cy="8" r="2.5" />
                <path d="M1.5 8h4M10.5 8h4" />
            </svg>
        )
    }
    if (icon === 'push') {
        return (
            <svg aria-hidden="true" className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                <path d="M8 10.5V4m0 0L5.5 6.5M8 4l2.5 2.5" />
                <path d="M3 11.5v1.3a.7.7 0 0 0 .7.7h8.6a.7.7 0 0 0 .7-.7v-1.3" />
            </svg>
        )
    }
    if (icon === 'pull') {
        return (
            <svg aria-hidden="true" className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                <path d="M8 3.5V10m0 0L5.5 7.5M8 10l2.5-2.5" />
                <path d="M3 11.5v1.3a.7.7 0 0 0 .7.7h8.6a.7.7 0 0 0 .7-.7v-1.3" />
            </svg>
        )
    }
    if (icon === 'sync') {
        return (
            <svg aria-hidden="true" className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                <path d="M13 8a5 5 0 0 1-8.5 3.5M3 8a5 5 0 0 1 8.5-3.5" />
                <path d="M11.5 2.5v2.5H9M4.5 13.5V11H7" />
            </svg>
        )
    }
    return (
        <svg aria-hidden="true" className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="4.5" cy="3.5" r="1.5" />
            <circle cx="4.5" cy="12.5" r="1.5" />
            <circle cx="11.5" cy="12.5" r="1.5" />
            <path d="M4.5 5v6M11.5 11V6.5a2 2 0 0 0-2-2H8" />
            <path d="M9.5 3 8 4.5 9.5 6" />
        </svg>
    )
}

function PullRequestStateIcon({ pr }: { pr: GitPullRequest }) {
    if (pr.state === 'merged') {
        return (
            <svg aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-purple-600 dark:text-purple-400" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="4.5" cy="3.5" r="1.6" />
                <circle cx="4.5" cy="12.5" r="1.6" />
                <circle cx="11.5" cy="11.5" r="1.6" />
                <path d="M4.5 5.1v5.8M11.5 9.9V8a3.5 3.5 0 0 0-3.5-3.5H6.1" />
            </svg>
        )
    }
    if (pr.state === 'closed') {
        return (
            <svg aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-rose-600 dark:text-rose-400" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="4.5" cy="3.5" r="1.6" />
                <circle cx="4.5" cy="12.5" r="1.6" />
                <circle cx="11.5" cy="12.5" r="1.6" />
                <path d="M4.5 5.1v5.8M11.5 10.9V7.5M10 3.2l3 3m0-3-3 3" />
            </svg>
        )
    }
    if (pr.isDraft) {
        return (
            <svg aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-[var(--app-hint)]" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="4.5" cy="3.5" r="1.6" />
                <circle cx="4.5" cy="12.5" r="1.6" />
                <circle cx="11.5" cy="12.5" r="1.6" />
                <path d="M4.5 5.1v5.8M11.5 10.9V9M11.5 6.5h.01M11.5 4h.01" />
            </svg>
        )
    }
    return (
        <svg aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="4.5" cy="3.5" r="1.6" />
            <circle cx="4.5" cy="12.5" r="1.6" />
            <circle cx="11.5" cy="12.5" r="1.6" />
            <path d="M4.5 5.1v5.8M11.5 10.9V6a2 2 0 0 0-2-2H8" />
            <path d="M9.5 2.5 8 4l1.5 1.5" />
        </svg>
    )
}

function ChecksStatusIcon({ checks, label }: { checks: NonNullable<GitPullRequest['checks']>; label: string }) {
    if (checks === 'passing') {
        return (
            <span role="img" aria-label={label} title={label} className="inline-flex shrink-0 items-center text-emerald-600 dark:text-emerald-400">
                <svg aria-hidden="true" className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="8" cy="8" r="6" />
                    <path d="m5.5 8.1 1.7 1.7 3.3-3.6" />
                </svg>
            </span>
        )
    }
    if (checks === 'failing') {
        return (
            <span role="img" aria-label={label} title={label} className="inline-flex shrink-0 items-center text-rose-600 dark:text-rose-400">
                <svg aria-hidden="true" className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="8" cy="8" r="6" />
                    <path d="m6 6 4 4m0-4-4 4" />
                </svg>
            </span>
        )
    }
    return (
        <span role="img" aria-label={label} title={label} className="inline-flex shrink-0 items-center text-amber-500">
            <svg aria-hidden="true" className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="8" cy="8" r="6" />
                <path d="M8 4.8V8l2 1.4" />
            </svg>
        </span>
    )
}

function InlineCheckIcon() {
    return (
        <svg aria-hidden="true" className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="m3.5 8.2 3 3 6-6.5" />
        </svg>
    )
}

function InlineSpinnerIcon() {
    return (
        <svg aria-hidden="true" className="h-4 w-4 shrink-0 animate-spin text-[var(--app-hint)]" viewBox="0 0 16 16" fill="none">
            <circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeOpacity="0.25" strokeWidth="1.5" />
            <path d="M13.5 8A5.5 5.5 0 0 0 8 2.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
    )
}

function resolveChangesSummary(repo: GitRepositoryStatus): GitChangesSummary {
    if (repo.changesSummary) return repo.changesSummary
    const insertions = repo.files.reduce((sum, file) => sum + (file.additions ?? 0), 0)
    const deletions = repo.files.reduce((sum, file) => sum + (file.deletions ?? 0), 0)
    const unknown = repo.files.some((file) => !file.binary && (file.additions === null || file.deletions === null))
    return {
        insertions,
        deletions,
        baseRef: !repo.dirty && (repo.branchChangedFiles ?? 0) > 0 ? repo.baseRef : null,
        ...(unknown ? { unknown: true } : {})
    }
}

function getDefaultLocalName(repo: GitRepositoryStatus): string | null {
    if (!repo.defaultBranch) return null
    const remotes = repo.remotes ?? (repo.remote ? [repo.remote] : [])
    for (const remote of [...remotes].sort((a, b) => b.length - a.length)) {
        if (repo.defaultBranch.startsWith(`${remote}/`)) {
            return repo.defaultBranch.slice(remote.length + 1)
        }
    }
    return repo.defaultBranch
}

function successKeyForAction(action: GitDialogAction | GitActionRequest['action'], response?: GitActionResponse): string {
    if (action === 'pull') return 'sourceControl.success.pulled'
    if (action === 'push') return 'sourceControl.success.pushed'
    if (action === 'pr' || action === 'push-pr' || action === 'commit-push-pr' || response?.pullRequestUrl) {
        return 'sourceControl.success.pr'
    }
    if (action === 'commit-push') return 'sourceControl.success.pushed'
    if (action === 'checkout') return 'sourceControl.success.switched'
    if (action === 'create-branch') return 'sourceControl.success.createdBranch'
    return 'sourceControl.success.committed'
}

export function SourceControl(props: { api: ApiClient; session: Session; backgroundTaskCount?: number }) {
    const { t } = useTranslation()
    const navigate = useNavigate()
    const narrow = useNarrowViewport()
    const triggerRef = useRef<HTMLButtonElement>(null)
    const [open, setOpen] = useState(false)
    const [branchPickerOpen, setBranchPickerOpen] = useState(false)
    const [actionsMenuOpen, setActionsMenuOpen] = useState(false)
    const [dialogAction, setDialogAction] = useState<GitDialogAction | null>(null)
    const [search, setSearch] = useState('')
    const [runningAction, setRunningAction] = useState<{ labelKey: string; startedAtMs: number } | null>(null)
    const [nowMs, setNowMs] = useState(() => Date.now())
    const [inlineSuccess, setInlineSuccess] = useState<{ title: string; scopeKey: string } | null>(null)
    const [actionError, setActionError] = useState<string | null>(null)

    const { repository: repo, isLoading, error, refetch } = useGitRepository(
        props.session.active ? props.api : null,
        props.session.id,
        'working'
    )
    const { sessions } = useSessions(open && branchPickerOpen ? props.api : null)

    const busy = props.session.thinking
        || (props.backgroundTaskCount ?? 0) > 0
        || Object.keys(props.session.agentState?.requests ?? {}).length > 0
        || runningAction !== null

    const scopeKey = `${props.session.id}:${repo?.branch ?? ''}:${repo?.head ?? ''}`

    useEffect(() => {
        if (!runningAction) return
        setNowMs(Date.now())
        const interval = setInterval(() => setNowMs(Date.now()), 1000)
        return () => clearInterval(interval)
    }, [runningAction])

    useEffect(() => {
        if (!inlineSuccess) return
        const timer = setTimeout(() => setInlineSuccess(null), SUCCESS_VISIBLE_MS)
        return () => clearTimeout(timer)
    }, [inlineSuccess])

    const handleOpenChange = (nextOpen: boolean) => {
        setOpen(nextOpen)
        if (nextOpen && props.session.active) {
            void refetch()
        }
        if (!nextOpen) {
            setBranchPickerOpen(false)
            setActionsMenuOpen(false)
            setSearch('')
            setActionError(null)
        }
    }

    const closeAll = () => {
        setOpen(false)
        setBranchPickerOpen(false)
        setActionsMenuOpen(false)
        setSearch('')
        setActionError(null)
    }

    const newWorkspace = (directory: string, ref?: string) => {
        closeAll()
        void navigate({
            to: '/sessions/new',
            search: {
                machineId: props.session.metadata?.machineId,
                directory,
                sessionType: ref ? 'worktree' : 'simple',
                worktreeStartRef: ref
            },
            ...PRESERVE_SESSION_SIDEBAR_SCROLL
        })
    }

    const viewAllChanges = () => {
        closeAll()
        if (repo && !repo.dirty && (repo.branchChangedFiles ?? 0) > 0 && repo.baseRef) {
            void navigate({
                to: '/sessions/$sessionId/files',
                params: { sessionId: props.session.id },
                search: { scope: 'branch', baseRef: repo.baseRef },
                ...PRESERVE_SESSION_SIDEBAR_SCROLL
            })
            return
        }
        void navigate({
            to: '/sessions/$sessionId/files',
            params: { sessionId: props.session.id },
            search: { scope: 'working' },
            ...PRESERVE_SESSION_SIDEBAR_SCROLL
        })
    }

    const runDirectAction = async (
        input: Omit<GitActionRequest, 'expectedHead' | 'expectedBranch' | 'expectedIndexDigest' | 'expectedWorktreeDigest'>
    ) => {
        if (!repo || !props.session.active || busy) return
        const block = getGitActionBlock(input.action, repo, props.session.active, busy)
        if (block) {
            setActionError(t(`sourceControl.block.${block}`))
            return
        }
        const labelKey = input.action === 'pull'
            ? 'sourceControl.running.pull'
            : input.action === 'push'
                ? 'sourceControl.running.push'
                : input.action === 'checkout'
                    ? 'sourceControl.running.checkout'
                    : 'sourceControl.running.createBranch'
        setRunningAction({ labelKey, startedAtMs: Date.now() })
        setActionError(null)
        setInlineSuccess(null)
        setBranchPickerOpen(false)
        setActionsMenuOpen(false)

        try {
            const response = await props.api.runGitAction(props.session.id, {
                ...input,
                expectedHead: repo.head,
                expectedBranch: repo.branch,
                expectedIndexDigest: repo.indexDigest,
                expectedWorktreeDigest: repo.worktreeDigest,
                ...(repo.remote && !input.remote ? { remote: repo.remote } : {})
            })
            const updated = await refetch()
            if (response.success) {
                const nextScopeKey = `${props.session.id}:${updated?.branch ?? response.branch ?? repo.branch ?? ''}:${updated?.head ?? response.head ?? repo.head ?? ''}`
                setInlineSuccess({
                    title: t(successKeyForAction(input.action, response)),
                    scopeKey: nextScopeKey
                })
            } else {
                setActionError(response.error ?? t('sourceControl.failed'))
            }
        } catch (cause) {
            setActionError(cause instanceof Error ? cause.message : t('sourceControl.failed'))
            await refetch()
        } finally {
            setRunningAction(null)
        }
    }

    const openActionDialog = (action: GitDialogAction) => {
        setActionsMenuOpen(false)
        setBranchPickerOpen(false)
        setActionError(null)
        setOpen(false)
        setDialogAction(action)
    }

    const summary = repo ? resolveChangesSummary(repo) : null
    const extendedActions = repo ? supportsExtendedGitActions(repo) : false
    const quick = repo ? resolveQuickGitAction(repo, props.session.active, busy) : null
    const menuItems = repo ? buildGitMenuItems(repo, props.session.active, busy) : []
    const trackedDirty = repo ? hasTrackedDirtyChanges(repo) : false
    const visibleInlineSuccess = inlineSuccess && inlineSuccess.scopeKey === scopeKey ? inlineSuccess : null

    const worktreeBranches = useMemo(() => {
        const set = new Set<string>()
        for (const wt of repo?.worktrees ?? []) {
            if (wt.branch) set.add(wt.branch)
        }
        return set
    }, [repo?.worktrees])

    const localBranchNames = useMemo(() => {
        const set = new Set<string>(worktreeBranches)
        for (const ref of repo?.refs ?? []) {
            if (!ref.remote) set.add(ref.name)
        }
        return set
    }, [repo?.refs, worktreeBranches])

    const defaultLocalName = repo ? getDefaultLocalName(repo) : null
    const normalizedSearch = search.trim().toLowerCase()
    const matchingWorktrees = useMemo(() => {
        if (!repo) return []
        return repo.worktrees.filter((wt) => (
            `${wt.branch ?? ''} ${wt.path}`.toLowerCase().includes(normalizedSearch)
        ))
    }, [normalizedSearch, repo])

    const matchingRefs = useMemo(() => {
        if (!repo) return []
        const remotesCount = repo.remotes?.length ?? (repo.remote ? 1 : 0)
        return repo.refs.filter((ref) => {
            if (!ref.name.toLowerCase().includes(normalizedSearch)) return false
            if (!ref.remote) return !worktreeBranches.has(ref.name)
            if (normalizedSearch.length === 0) {
                const parsed = splitRemoteRef(ref.name, repo)
                if (parsed && localBranchNames.has(parsed.branch)) {
                    const isPrimaryTracking = ref.name === repo.upstream
                        || remotesCount <= 1
                        || (repo.remote !== null && parsed.remote === repo.remote)
                    if (isPrimaryTracking) return false
                }
            }
            return true
        })
    }, [localBranchNames, normalizedSearch, repo, worktreeBranches])

    const sanitizedNewBranch = search.trim().replace(/\s+/g, '-')
    const canOfferCreateBranch = Boolean(
        repo
        && extendedActions
        && sanitizedNewBranch.length > 0
        && !worktreeBranches.has(sanitizedNewBranch)
        && !repo.refs.some((ref) => ref.name === sanitizedNewBranch)
    )

    const trigger = (
        <button
            ref={triggerRef}
            type="button"
            data-testid="statusbar-git-trigger"
            aria-label={t('sourceControl.title')}
            title={repo?.branch ?? props.session.metadata?.path}
            className="inline-flex min-h-6 min-w-0 items-center gap-1.5 rounded-md px-1 text-xs leading-4 text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
        >
            <BranchIcon className="h-3.5 w-3.5 shrink-0" />
            <span className="max-w-[140px] truncate font-mono text-[11px]">
                {repo ? (repo.branch ?? t('files.branch.detached')) : 'Git'}
            </span>
            {repo?.pullRequest ? (
                <span className="shrink-0 font-mono text-[10px] text-[var(--app-hint)] tabular-nums">
                    #{repo.pullRequest.number}
                </span>
            ) : null}
            {summary && (summary.insertions > 0 || summary.deletions > 0) ? (
                <span className="inline-flex shrink-0 items-center gap-1 font-mono text-[11px] tabular-nums">
                    {summary.insertions > 0 ? (
                        <span className="text-[var(--app-badge-success-text)]">+{summary.insertions}</span>
                    ) : null}
                    {summary.deletions > 0 ? (
                        <span className="text-[var(--app-badge-error-text)]">−{summary.deletions}</span>
                    ) : null}
                </span>
            ) : null}
        </button>
    )

    const branchPickerList = repo ? (
        <div className="space-y-1.5">
            <input
                type="search"
                className="w-full min-w-0 rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-2.5 py-1.5 text-xs text-[var(--app-fg)] outline-none placeholder:text-[var(--app-hint)] focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
                aria-label={t('sourceControl.searchRefs')}
                placeholder={t('sourceControl.searchRefs')}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                autoFocus={!narrow}
            />
            <div className="max-h-56 space-y-0.5 overflow-y-auto">
                {matchingWorktrees.map((worktree) => {
                    const current = props.session.metadata?.path === worktree.path
                    const target = sessions.find((session) => (
                        session.id !== props.session.id
                        && session.metadata?.machineId === props.session.metadata?.machineId
                        && session.metadata?.path === worktree.path
                    ))
                    const badgeKey = current
                        ? 'sourceControl.current'
                        : target
                            ? 'sourceControl.openSession'
                            : 'sourceControl.worktreeBadge'
                    return (
                        <button
                            key={worktree.path}
                            type="button"
                            disabled={current || !props.session.metadata?.machineId}
                            title={worktree.path}
                            className={`${rowSurface} h-7 justify-between gap-2 px-2 text-xs`}
                            onClick={() => {
                                if (target) {
                                    closeAll()
                                    void navigate({
                                        to: '/sessions/$sessionId',
                                        params: { sessionId: target.id },
                                        ...PRESERVE_SESSION_SIDEBAR_SCROLL
                                    })
                                } else {
                                    newWorkspace(worktree.path)
                                }
                            }}
                        >
                            <span className="min-w-0 flex-1 truncate">
                                {worktree.branch ?? t('files.branch.detached')}
                            </span>
                            <span className="shrink-0 text-[11px] font-normal text-[var(--app-hint)]">
                                {t(badgeKey)}
                            </span>
                        </button>
                    )
                })}

                {matchingRefs.map((ref) => {
                    const badgeKey = !ref.remote && defaultLocalName && ref.name === defaultLocalName
                        ? 'sourceControl.defaultBadge'
                        : ref.remote
                            ? 'sourceControl.remoteRef'
                            : 'sourceControl.localRef'
                    const parsedRemote = ref.remote ? splitRemoteRef(ref.name, repo) : null
                    const targetAlreadyCheckedOut = parsedRemote !== null && worktreeBranches.has(parsedRemote.branch)
                    const canSwitchRef = extendedActions && props.session.active && !busy && !trackedDirty && !targetAlreadyCheckedOut
                    return (
                        <div key={ref.name} className="flex items-center gap-1">
                            <button
                                type="button"
                                disabled={!props.session.metadata?.machineId}
                                className={`${rowSurface} h-7 flex-1 justify-between gap-2 px-2 text-xs`}
                                onClick={() => newWorkspace(repo.repoRoot, ref.name)}
                            >
                                <span className="min-w-0 flex-1 truncate font-mono">{ref.name}</span>
                                <span className="shrink-0 text-[11px] font-normal text-[var(--app-hint)]">
                                    {t(badgeKey)}
                                </span>
                            </button>
                            {canSwitchRef ? (
                                <button
                                    type="button"
                                    aria-label={t('sourceControl.switchToRef', { ref: ref.name })}
                                    title={t('sourceControl.switchToRef', { ref: ref.name })}
                                    className="git-control-row shrink-0 rounded-md px-1.5 py-1 text-[11px] font-medium text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
                                    onClick={() => { void runDirectAction({ action: 'checkout', targetRef: ref.name }) }}
                                >
                                    {t('sourceControl.switchBranch')}
                                </button>
                            ) : null}
                        </div>
                    )
                })}

                {canOfferCreateBranch ? (
                    <button
                        type="button"
                        disabled={!props.session.active || busy}
                        className={`${rowSurface} h-7 px-2 text-xs text-[var(--app-link)]`}
                        onClick={() => { void runDirectAction({ action: 'create-branch', targetRef: sanitizedNewBranch }) }}
                    >
                        <span className="min-w-0 flex-1 truncate">
                            {t('sourceControl.createBranch', { branch: sanitizedNewBranch })}
                        </span>
                    </button>
                ) : null}

                {matchingWorktrees.length === 0 && matchingRefs.length === 0 && !canOfferCreateBranch ? (
                    <p className="px-2 py-2 text-xs text-[var(--app-hint)]">{t('sourceControl.noRefs')}</p>
                ) : null}
            </div>

            <div className="border-t border-[var(--app-border)] pt-1">
                <button
                    type="button"
                    disabled={!props.session.metadata?.machineId}
                    className={`${rowSurface} h-7 px-2 text-xs`}
                    onClick={() => newWorkspace(repo.repoRoot, repo.branch ?? repo.head ?? 'HEAD')}
                >
                    <span className="truncate">{t('sourceControl.newWorkspace')}</span>
                </button>
            </div>
        </div>
    ) : null

    const actionsMenuList = repo ? (
        <div className="space-y-0.5">
            {menuItems.map((item) => {
                const disabledReason = item.disabled && item.block ? t(`sourceControl.block.${item.block}`) : undefined
                return (
                    <button
                        key={item.id}
                        type="button"
                        disabled={item.disabled}
                        title={disabledReason}
                        className={`${rowSurface} h-8 px-2.5`}
                        onClick={() => {
                            if (item.opensDialog && item.action) {
                                openActionDialog(item.action as GitDialogAction)
                            } else if (item.action === 'pull' || item.action === 'push') {
                                void runDirectAction({ action: item.action })
                            }
                        }}
                    >
                        <ActionIcon icon={item.icon} className="h-4 w-4 shrink-0 text-[var(--app-hint)]" />
                        <span className="min-w-0 flex-1 truncate">{t(item.labelKey)}</span>
                    </button>
                )
            })}
        </div>
    ) : null

    const pr = repo?.pullRequest ?? null
    const prStateKey = pr?.isDraft
        ? 'sourceControl.prState.draft'
        : pr?.state === 'merged'
            ? 'sourceControl.prState.merged'
            : pr?.state === 'closed'
                ? 'sourceControl.prState.closed'
                : 'sourceControl.prState.open'
    const prChecksKey = pr?.checks === 'passing'
        ? 'sourceControl.checks.passing'
        : pr?.checks === 'failing'
            ? 'sourceControl.checks.failing'
            : pr?.checks === 'pending'
                ? 'sourceControl.checks.pending'
                : null
    const prTooltip = pr
        ? [
            `#${pr.number}: ${pr.title}`,
            t(prStateKey),
            pr.baseRefName && pr.headRefName ? `${pr.baseRefName} ← ${pr.headRefName}` : null,
            prChecksKey ? t(prChecksKey) : null
        ].filter(Boolean).join(' · ')
        : undefined

    const quickDisabledReason = quick?.disabled && quick.block ? t(`sourceControl.block.${quick.block}`) : undefined
    const elapsedSec = runningAction ? Math.max(0, Math.floor((nowMs - runningAction.startedAtMs) / 1000)) : 0

    const body = (
        <div className="flex flex-col text-[var(--app-fg)]">
            {isLoading && !repo ? <p role="status" className="px-2.5 py-2 text-xs text-[var(--app-hint)]">{t('loading.git')}</p> : null}
            {!props.session.active && !repo ? <p role="status" className="px-2.5 py-2 text-xs text-[var(--app-hint)]">{t('sourceControl.block.offline')}</p> : null}
            {error && !repo ? <p role="alert" className="break-words px-2.5 py-2 text-xs text-[var(--app-badge-error-text)]">{formatGitStatusError(error, t)}</p> : null}
            {!repo && !isLoading && !error && props.session.active ? (
                <p className="px-2.5 py-2 text-xs text-[var(--app-hint)]">{t('sourceControl.unavailable')}</p>
            ) : null}

            {repo ? (
                <>
                    {/* Row 1: Branch / Worktree selector */}
                    {narrow ? (
                        <div>
                            <button
                                type="button"
                                aria-expanded={branchPickerOpen}
                                className={`${rowSurface} h-11 justify-between`}
                                onClick={() => {
                                    setBranchPickerOpen((prev) => !prev)
                                    setActionsMenuOpen(false)
                                }}
                            >
                                <span className="flex min-w-0 items-center gap-2.5">
                                    <BranchIcon className="h-4 w-4 shrink-0 text-[var(--app-hint)]" />
                                    <span className="min-w-0 truncate">{repo.branch ?? t('files.branch.detached')}</span>
                                </span>
                                <ChevronDownIcon className="h-4 w-4 shrink-0 text-[var(--app-hint)]" />
                            </button>
                            {branchPickerOpen ? (
                                <div className="mt-1 rounded-xl border border-[var(--app-border)] bg-[var(--app-secondary-bg)] p-2">
                                    {branchPickerList}
                                </div>
                            ) : null}
                        </div>
                    ) : (
                        <Popover.Root open={branchPickerOpen} onOpenChange={(next) => { setBranchPickerOpen(next); if (!next) setSearch('') }}>
                            <Popover.Trigger asChild>
                                <button
                                    type="button"
                                    aria-label={repo.branch ?? t('files.branch.detached')}
                                    className="group/branch git-control-row flex h-8 w-full min-w-0 items-center rounded-lg text-left text-[13px] font-medium transition-colors hover:bg-[var(--app-subtle-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)] data-[state=open]:bg-[var(--app-subtle-bg)]"
                                >
                                    <span className="flex min-w-0 flex-1 items-center gap-2.5 px-2.5">
                                        <BranchIcon className="h-4 w-4 shrink-0 text-[var(--app-hint)]" />
                                        <span className="min-w-0 flex-1 truncate">{repo.branch ?? t('files.branch.detached')}</span>
                                    </span>
                                    <span
                                        aria-hidden="true"
                                        className="h-4 w-px shrink-0 bg-transparent transition-colors group-hover/branch:bg-[var(--app-border)] group-data-[state=open]/branch:bg-[var(--app-border)]"
                                    />
                                    <span className="flex h-8 w-8 shrink-0 items-center justify-center">
                                        <ChevronDownIcon className="h-4 w-4 text-[var(--app-hint)]" />
                                    </span>
                                </button>
                            </Popover.Trigger>
                            <Popover.Portal>
                                <Popover.Content
                                    side="bottom"
                                    align="start"
                                    sideOffset={4}
                                    collisionPadding={12}
                                    className="z-[60] w-[var(--radix-popover-trigger-width)] min-w-[264px] max-w-[calc(100vw-24px)] rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] p-2 shadow-lg"
                                >
                                    {branchPickerList}
                                </Popover.Content>
                            </Popover.Portal>
                        </Popover.Root>
                    )}

                    {/* Row 2: Pull request */}
                    {pr ? (
                        <div className="pb-0.5">
                            <a
                                href={pr.url}
                                target="_blank"
                                rel="noreferrer"
                                title={prTooltip}
                                className="flex w-full min-w-0 items-start gap-2.5 rounded-lg px-2.5 pb-0.5 pt-1.5 text-left transition-colors hover:bg-[var(--app-subtle-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
                            >
                                <PullRequestStateIcon pr={pr} />
                                <span className="line-clamp-2 min-w-0 flex-1 text-[13px] font-medium leading-[18px] text-[var(--app-fg)]">
                                    {pr.title}
                                </span>
                            </a>
                            <div className="flex h-5 min-w-0 items-center gap-2 pl-9 pr-2.5 text-xs text-[var(--app-hint)]">
                                <span className="shrink-0 tabular-nums">#{pr.number}</span>
                                {pr.checks && prChecksKey ? (
                                    <ChecksStatusIcon checks={pr.checks} label={t(prChecksKey)} />
                                ) : null}
                            </div>
                        </div>
                    ) : null}

                    {/* Row 3: Smart Git action split row */}
                    {runningAction ? (
                        <div role="status" className="git-control-row flex h-8 w-full items-center gap-2.5 rounded-lg bg-[var(--app-subtle-bg)] px-2.5 text-[13px] font-medium">
                            <InlineSpinnerIcon />
                            <span className="min-w-0 flex-1 truncate">{t(runningAction.labelKey)}</span>
                            <span className="shrink-0 font-mono text-[11px] font-normal tabular-nums text-[var(--app-hint)]">
                                {elapsedSec}s
                            </span>
                        </div>
                    ) : visibleInlineSuccess ? (
                        <div role="status" className="git-control-row flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-[13px] font-medium">
                            <InlineCheckIcon />
                            <span className="min-w-0 flex-1 truncate">{visibleInlineSuccess.title}</span>
                        </div>
                    ) : quick ? (
                        <div>
                            <div className="group/git-split flex w-full items-center rounded-lg transition-colors hover:bg-[var(--app-subtle-bg)]">
                                <span className="flex min-w-0 flex-1" title={quickDisabledReason ?? t(quick.labelKey)}>
                                    <button
                                        type="button"
                                        disabled={quick.disabled}
                                        className="git-control-row flex h-8 w-full min-w-0 items-center gap-2.5 rounded-l-lg px-2.5 text-left text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)] disabled:cursor-not-allowed disabled:text-[var(--app-hint)] disabled:opacity-75"
                                        onClick={() => {
                                            setInlineSuccess(null)
                                            setActionError(null)
                                            if (quick.opensDialog && quick.action) {
                                                openActionDialog(quick.action as GitDialogAction)
                                            } else if (quick.action === 'pull' || quick.action === 'push') {
                                                void runDirectAction({ action: quick.action })
                                            }
                                        }}
                                    >
                                        <ActionIcon icon={quick.icon} className="h-4 w-4 shrink-0 text-[var(--app-hint)]" />
                                        <span className="min-w-0 flex-1 truncate">{t(quick.labelKey)}</span>
                                    </button>
                                </span>
                                <span
                                    aria-hidden="true"
                                    className="h-4 w-px shrink-0 bg-transparent transition-colors group-hover/git-split:bg-[var(--app-border)] group-has-[[data-state=open]]/git-split:bg-[var(--app-border)]"
                                />
                                {narrow ? (
                                    <button
                                        type="button"
                                        aria-label={t('sourceControl.actions')}
                                        aria-expanded={actionsMenuOpen}
                                        disabled={menuItems.length === 0}
                                        className="git-control-row flex h-8 w-10 shrink-0 items-center justify-center rounded-r-lg text-[var(--app-hint)] transition-colors hover:text-[var(--app-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)] disabled:cursor-not-allowed disabled:opacity-50"
                                        onClick={() => {
                                            const next = !actionsMenuOpen
                                            setActionsMenuOpen(next)
                                            setBranchPickerOpen(false)
                                            if (next && props.session.active) void refetch()
                                        }}
                                    >
                                        <ChevronDownIcon className="h-4 w-4" />
                                    </button>
                                ) : (
                                    <Popover.Root
                                        open={actionsMenuOpen}
                                        onOpenChange={(next) => {
                                            setActionsMenuOpen(next)
                                            if (next && props.session.active) void refetch()
                                        }}
                                    >
                                        <Popover.Trigger asChild>
                                            <button
                                                type="button"
                                                aria-label={t('sourceControl.actions')}
                                                disabled={menuItems.length === 0}
                                                className="git-control-row flex h-8 w-8 shrink-0 items-center justify-center rounded-r-lg text-[var(--app-hint)] transition-colors hover:text-[var(--app-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)] disabled:cursor-not-allowed disabled:opacity-50"
                                            >
                                                <ChevronDownIcon className="h-4 w-4" />
                                            </button>
                                        </Popover.Trigger>
                                        <Popover.Portal>
                                            <Popover.Content
                                                side="bottom"
                                                align="end"
                                                sideOffset={4}
                                                collisionPadding={12}
                                                className="z-[60] w-56 max-w-[calc(100vw-24px)] rounded-xl border border-[var(--app-border)] bg-[var(--app-bg)] p-1 shadow-lg"
                                            >
                                                {actionsMenuList}
                                            </Popover.Content>
                                        </Popover.Portal>
                                    </Popover.Root>
                                )}
                            </div>
                            {narrow && actionsMenuOpen ? (
                                <div className="mt-1 rounded-xl border border-[var(--app-border)] bg-[var(--app-secondary-bg)] p-1">
                                    {actionsMenuList}
                                </div>
                            ) : null}
                        </div>
                    ) : null}

                    {actionError ? (
                        <p role="alert" className="mx-1.5 my-1 break-words rounded-md bg-[var(--app-badge-error-bg)] px-2 py-1 text-xs text-[var(--app-badge-error-text)]">
                            {actionError}
                        </p>
                    ) : null}

                    {/* Row 4: Changes summary row */}
                    {summary ? (
                        <button
                            type="button"
                            className={`${rowSurface} h-8`}
                            onClick={viewAllChanges}
                        >
                            <FileDiffIcon className="h-4 w-4 shrink-0 text-[var(--app-hint)]" />
                            <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
                                <span className="shrink-0">{t('sourceControl.changes')}</span>
                                <span className="min-w-0 truncate font-normal text-[var(--app-hint)]">
                                    {summary.baseRef
                                        ? t('sourceControl.vsRef', { ref: summary.baseRef })
                                        : t('sourceControl.uncommitted')}
                                </span>
                                <span className="ml-auto flex shrink-0 items-baseline gap-2 pl-2 font-mono text-xs font-normal tabular-nums">
                                    <span className={summary.insertions > 0 ? 'text-[var(--app-badge-success-text)]' : 'text-[var(--app-hint)]'}>
                                        +{summary.insertions.toLocaleString()}
                                    </span>
                                    <span className={summary.deletions > 0 ? 'text-[var(--app-badge-error-text)]' : 'text-[var(--app-hint)]'}>
                                        -{summary.deletions.toLocaleString()}
                                    </span>
                                    {summary.unknown ? <span className="text-[var(--app-hint)]">?</span> : null}
                                </span>
                            </span>
                        </button>
                    ) : null}
                </>
            ) : null}
        </div>
    )

    return (
        <>
            {narrow ? (
                <Dialog open={open} onOpenChange={handleOpenChange}>
                    <DialogTrigger asChild>{trigger}</DialogTrigger>
                    <DialogContent
                        className="bottom-0 left-0 right-0 top-auto max-h-[88dvh] w-full max-w-none translate-x-0 translate-y-0 overflow-y-auto rounded-b-none rounded-t-xl p-3 pb-[max(16px,env(safe-area-inset-bottom))]"
                        closeButtonClassName="h-11 w-11"
                    >
                        <DialogHeader className="mb-2">
                            <DialogTitle>{t('sourceControl.title')}</DialogTitle>
                            <DialogDescription className="sr-only">{t('sourceControl.panelHint')}</DialogDescription>
                        </DialogHeader>
                        {body}
                    </DialogContent>
                </Dialog>
            ) : (
                <Popover.Root open={open} onOpenChange={handleOpenChange}>
                    <Popover.Trigger asChild>{trigger}</Popover.Trigger>
                    <Popover.Portal>
                        <Popover.Content
                            side="top"
                            align="start"
                            sideOffset={8}
                            collisionPadding={12}
                            className="z-50 max-h-[min(80dvh,var(--radix-popover-content-available-height))] w-[296px] max-w-[calc(100vw-24px)] overflow-y-auto rounded-2xl border border-[var(--app-border)] bg-[var(--app-bg)] p-1.5 shadow-lg"
                            aria-label={t('sourceControl.title')}
                        >
                            {body}
                        </Popover.Content>
                    </Popover.Portal>
                </Popover.Root>
            )}

            {repo ? (
                <GitActionDialogs
                    api={props.api}
                    sessionId={props.session.id}
                    repo={repo}
                    action={dialogAction}
                    onClose={() => setDialogAction(null)}
                    onMutated={refetch}
                    onSuccess={(completedAction, response) => {
                        const nextScopeKey = `${props.session.id}:${response.branch ?? repo.branch ?? ''}:${response.head ?? repo.head ?? ''}`
                        setInlineSuccess({
                            title: t(successKeyForAction(completedAction, response)),
                            scopeKey: nextScopeKey
                        })
                    }}
                />
            ) : null}
        </>
    )
}
