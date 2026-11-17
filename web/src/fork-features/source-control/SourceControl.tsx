import * as Popover from '@radix-ui/react-popover'
import { useNavigate } from '@tanstack/react-router'
import { useRef, useState } from 'react'
import type { GitChange, GitScope } from '@hapi/protocol/sourceControl'
import type { ApiClient } from '@/api/client'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { useSessions } from '@/hooks/queries/useSessions'
import { useNarrowViewport } from '@/hooks/useNarrowViewport'
import { formatGitStatusError } from '@/lib/files-i18n'
import { PRESERVE_SESSION_SIDEBAR_SCROLL } from '@/lib/sessionNavigation'
import { useTranslation } from '@/lib/use-translation'
import type { Session } from '@/types/api'
import { getGitActionBlock, getPrimaryGitAction } from './actions'
import { useGitChat } from './GitChatContext'
import { buildGitPreparation, type GitChatAction } from './gitChat'
import { useGitRepository } from './useGitRepository'
import { useGitScope } from './useGitScope'
import './sourceControl.css'

const row = 'git-control-row flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-[var(--app-subtle-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)] disabled:cursor-not-allowed disabled:opacity-50'
const field = 'git-control-row min-w-0 rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]'
const actions: GitChatAction[] = ['commit', 'push', 'pull', 'pr', 'commit-push', 'commit-push-pr']

function BranchIcon() {
    return <svg aria-hidden="true" className="h-3.5 w-3.5 shrink-0" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"><circle cx="5" cy="3.5" r="1.7" /><circle cx="5" cy="12.5" r="1.7" /><circle cx="11" cy="5.5" r="1.7" /><path d="M5 5.2v5.6m6-3.6c0 2-2 3-6 3" /></svg>
}

function ChangeTotals({ files }: { files: GitChange[] }) {
    const added = files.reduce((sum, file) => sum + (file.additions ?? 0), 0)
    const deleted = files.reduce((sum, file) => sum + (file.deletions ?? 0), 0)
    const unknown = files.some(file => file.additions === null || file.deletions === null)
    return <span className="inline-flex shrink-0 items-center gap-1 font-mono text-[11px] tabular-nums">{added > 0 ? <span className="text-[var(--app-badge-success-text)]">+{added}</span> : null}{deleted > 0 ? <span className="text-[var(--app-badge-error-text)]">−{deleted}</span> : null}{unknown ? <span className="text-[var(--app-hint)]">?</span> : null}</span>
}

export function SourceControl(props: { api: ApiClient; session: Session; backgroundTaskCount?: number }) {
    const { t } = useTranslation()
    const chat = useGitChat()
    const pendingRef = useRef(false)
    const [pending, setPending] = useState(false)
    const [sendError, setSendError] = useState<string | null>(null)
    const navigate = useNavigate()
    const narrow = useNarrowViewport()
    const triggerRef = useRef<HTMLButtonElement>(null)
    const [open, setOpen] = useState(false)
    const [search, setSearch] = useState('')
    const { scope, baseRef, setScope, setBaseRef } = useGitScope(props.session.id)
    const { repository: repo, isLoading, error, refetch } = useGitRepository(props.session.active ? props.api : null, props.session.id, scope, baseRef)
    const { sessions } = useSessions(open ? props.api : null)
    const busy = props.session.thinking || (props.backgroundTaskCount ?? 0) > 0
        || Object.keys(props.session.agentState?.requests ?? {}).length > 0
    const chatDisabled = !chat || chat.disabled || pending
    const primary = repo ? getPrimaryGitAction(repo) : null
    const changed = repo?.files.length ?? 0
    const close = () => { setOpen(false); setSearch('') }
    const openAction = async (action: GitChatAction) => {
        if (!repo || !chat || chatDisabled || busy || pendingRef.current) return
        pendingRef.current = true
        setPending(true)
        setSendError(null)
        try {
            if (await chat.send(buildGitPreparation(action, repo))) close()
            else setSendError(t('sourceControl.chat.sendFailed'))
        } catch (cause) {
            setSendError(cause instanceof Error ? cause.message : t('sourceControl.chat.sendFailed'))
        } finally {
            pendingRef.current = false
            setPending(false)
        }
    }
    const viewChanges = (path?: string, nextScope: GitScope = scope) => {
        close()
        if (path) {
            void navigate({ to: '/sessions/$sessionId/file', params: { sessionId: props.session.id }, search: { path, scope: nextScope, baseRef }, ...PRESERVE_SESSION_SIDEBAR_SCROLL })
        } else {
            void navigate({ to: '/sessions/$sessionId/files', params: { sessionId: props.session.id }, search: { scope, baseRef }, ...PRESERVE_SESSION_SIDEBAR_SCROLL })
        }
    }
    const newWorkspace = (directory: string, ref?: string) => {
        close()
        void navigate({ to: '/sessions/new', search: { machineId: props.session.metadata?.machineId, directory, sessionType: ref ? 'worktree' : 'simple', worktreeStartRef: ref }, ...PRESERVE_SESSION_SIDEBAR_SCROLL })
    }
    const trigger = (
        <button ref={triggerRef} type="button" data-testid="statusbar-git-trigger" aria-label={t('sourceControl.title')} title={repo?.branch ?? props.session.metadata?.path} className="inline-flex min-h-6 min-w-0 items-center gap-1.5 rounded-md px-1 text-xs leading-4 text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]">
            <BranchIcon />
            <span className="max-w-[140px] truncate font-mono text-[11px]">{repo ? repo.branch ?? t('files.branch.detached') : 'Git'}</span>
            {repo ? <ChangeTotals files={repo.files} /> : null}
            {repo && changed > 0 ? <span className="font-mono text-[10px] tabular-nums">{changed}</span> : null}
        </button>
    )
    const body = (
        <div className="space-y-3 text-[var(--app-fg)]">
            {isLoading ? <p role="status" className="text-xs text-[var(--app-hint)]">{t('loading.git')}</p> : null}
            {!props.session.active ? <p role="status" className="text-xs text-[var(--app-hint)]">{t('sourceControl.block.offline')}</p> : null}
            {error ? <p role="alert" className="break-words text-xs text-[var(--app-badge-error-text)]">{formatGitStatusError(error, t)}</p> : null}
            {!repo && !isLoading && !error ? <p className="text-xs text-[var(--app-hint)]">{t('sourceControl.unavailable')}</p> : null}
            {repo ? (
                <>
                    <section aria-label={t('sourceControl.workspace')}>
                        <div className="flex items-center gap-2"><BranchIcon /><span className="min-w-0 break-all text-sm font-medium">{repo.branch ?? t('files.branch.detached')}</span></div>
                        <p className="mt-1 break-all font-mono text-[11px] leading-4 text-[var(--app-hint)]">{props.session.metadata?.path ?? repo.repoRoot}</p>
                        <details className="mt-1">
                            <summary className={`${row} cursor-pointer text-[var(--app-hint)]`}>{t('sourceControl.chooseWorkspace')}</summary>
                            <p className="px-2 py-1 text-[11px] leading-4 text-[var(--app-hint)]">{t('sourceControl.workspaceHint')}</p>
                            <input className={`${field} my-1 w-full`} aria-label={t('sourceControl.searchRefs')} placeholder={t('sourceControl.searchRefs')} value={search} onChange={event => setSearch(event.target.value)} />
                            <div className="max-h-48 overflow-y-auto">
                                {repo.worktrees.filter(worktree => `${worktree.path} ${worktree.branch ?? ''}`.toLowerCase().includes(search.toLowerCase())).map(worktree => {
                                    const target = sessions.find(session => session.id !== props.session.id && session.metadata?.machineId === props.session.metadata?.machineId && session.metadata?.path === worktree.path)
                                    const current = props.session.metadata?.path === worktree.path
                                    return <button key={worktree.path} type="button" className={row} disabled={current || !props.session.metadata?.machineId} onClick={() => {
                                        if (target) { close(); void navigate({ to: '/sessions/$sessionId', params: { sessionId: target.id }, ...PRESERVE_SESSION_SIDEBAR_SCROLL }) }
                                        else newWorkspace(worktree.path)
                                    }}><span className="min-w-0 flex-1"><span className="block truncate font-medium">{worktree.branch ?? t('files.branch.detached')}</span><span className="block truncate text-[10px] text-[var(--app-hint)]">{worktree.path}</span></span><span className="shrink-0 text-[10px] text-[var(--app-hint)]">{t(current ? 'sourceControl.current' : target ? 'sourceControl.openSession' : 'sourceControl.newSession')}</span></button>
                                })}
                                <div className="my-1 border-t border-[var(--app-border)]" />
                                {repo.refs.filter(ref => ref.name.toLowerCase().includes(search.toLowerCase())).map(ref => <button key={ref.name} type="button" className={row} disabled={!props.session.metadata?.machineId} onClick={() => newWorkspace(repo.repoRoot, ref.name)}><span className="min-w-0 flex-1 truncate font-mono">{ref.name}</span><span className="shrink-0 text-[10px] text-[var(--app-hint)]">{t(ref.remote ? 'sourceControl.remoteRef' : 'sourceControl.localRef')}</span></button>)}
                            </div>
                            <button type="button" className={`${row} mt-1 font-medium`} disabled={!props.session.metadata?.machineId} onClick={() => newWorkspace(repo.repoRoot, repo.branch ?? repo.head ?? 'HEAD')}>{t('sourceControl.newWorkspace')}</button>
                        </details>
                    </section>
                    <section aria-label={t('sourceControl.actions')} className="border-t border-[var(--app-border)] pt-3">
                        <div className="mb-2 flex items-center justify-between gap-2 text-[11px] text-[var(--app-hint)]"><span>{t('sourceControl.stagedCount', { n: repo.stagedFiles.length })} / {t('sourceControl.modifiedCount', { n: repo.unstagedFiles.length })}</span><span className="shrink-0 font-mono tabular-nums">↑{repo.ahead} ↓{repo.behind}</span></div>
                        <div className="flex rounded-md border border-[var(--app-border)]">
                            <button type="button" className={`${row} flex-1 font-medium`} disabled={chatDisabled || !primary || Boolean(getGitActionBlock(primary, repo, props.session.active, busy))} onClick={() => { if (primary && primary !== 'stage') void openAction(primary) }}>{primary ? t(`sourceControl.action.${primary}`) : t(repo.ahead > 0 && repo.behind > 0 ? 'sourceControl.block.diverged' : 'sourceControl.clean')}</button>
                            <details className="relative shrink-0 border-l border-[var(--app-border)]">
                                <summary className="git-control-row flex w-10 cursor-pointer list-none items-center justify-center rounded-r-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]" aria-label={t('sourceControl.actions')}><svg aria-hidden="true" className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="m4 6 4 4 4-4" /></svg></summary>
                                <div className="absolute right-0 z-10 mt-1 w-64 max-w-[calc(100vw-48px)] rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] p-1 shadow-lg">
                                    {actions.filter(action => !repo.pullRequest || (action !== 'pr' && action !== 'commit-push-pr')).map(action => {
                                        const block = getGitActionBlock(action, repo, props.session.active, busy)
                                        return <button key={action} type="button" className={`${row} flex-col items-start gap-0.5`} disabled={chatDisabled || Boolean(block)} onClick={() => { void openAction(action) }}><span>{t(`sourceControl.action.${action}`)}</span>{block ? <span className="text-[10px] font-normal text-[var(--app-hint)]">{t(`sourceControl.block.${block}`)}</span> : null}</button>
                                    })}
                                </div>
                            </details>
                        </div>
                        {sendError ? <p role="alert" className="mt-2 text-xs text-[var(--app-badge-error-text)]">{sendError}</p> : null}
                        {repo.blockedReason ? <p className="mt-2 text-[11px] text-[var(--app-hint)]">{repo.blockedReason}</p> : null}
                        {repo.pullRequest ? <a href={repo.pullRequest.url} target="_blank" rel="noreferrer" className={`${row} mt-1 text-[var(--app-link)]`}>{t('sourceControl.openPr', { n: repo.pullRequest.number })}</a> : null}
                    </section>
                </>
            ) : null}
            <section aria-label={t('files.tab.changes')} className="border-t border-[var(--app-border)] pt-3">
                <div className="flex flex-wrap items-center gap-2">
                    <select className={`${field} flex-1`} aria-label={t('sourceControl.scope')} value={scope} onChange={event => setScope(event.target.value as GitScope)}>
                        {(['working', 'staged', 'unstaged', 'branch'] as const).map(value => <option key={value} value={value}>{t(`sourceControl.scope.${value}`)}</option>)}
                    </select>
                    {scope === 'branch' ? <select className={`${field} w-full truncate`} aria-label={t('sourceControl.baseRef')} value={baseRef ?? ''} onChange={event => setBaseRef(event.target.value || undefined)}><option value="">{t('sourceControl.chooseBase')}</option>{baseRef && !repo?.refs.some(ref => ref.name === baseRef) ? <option value={baseRef}>{baseRef}</option> : null}{repo?.refs.map(ref => <option key={ref.name} value={ref.name}>{ref.name}</option>)}</select> : null}
                </div>
                {repo ? (
                    <>
                        <button type="button" className={`${row} mt-1 justify-between font-medium`} onClick={() => viewChanges()}><span>{t('sourceControl.changedCount', { n: changed })}</span><ChangeTotals files={repo.files} /></button>
                        <div className="max-h-48 overflow-y-auto">
                            {repo.files.slice(0, 6).map(file => <button key={file.path} type="button" className={row} onClick={() => viewChanges(file.path)}><span className="min-w-0 flex-1 truncate font-mono text-[11px]" title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}>{file.path}</span>{file.binary || file.untracked ? <span className="text-[10px] text-[var(--app-hint)]">{t(file.binary ? 'sourceControl.binary' : 'sourceControl.untracked')}</span> : <ChangeTotals files={[file]} />}</button>)}
                        </div>
                        {repo.files.length === 0 ? <p className="px-2 py-2 text-xs text-[var(--app-hint)]">{t('sourceControl.noScopeChanges')}</p> : null}
                        <button type="button" className={`${row} mt-1 justify-center bg-[var(--app-subtle-bg)] font-medium`} onClick={() => viewChanges()}>{t('sourceControl.viewChanges')}</button>
                    </>
                ) : null}
            </section>
            <button type="button" className={`${row} justify-center text-[var(--app-hint)]`} disabled={isLoading || !props.session.active} onClick={() => void refetch()}>{t('files.page.refresh')}</button>
        </div>
    )
    return (
        <>
            {narrow ? (
                <Dialog open={open} onOpenChange={setOpen}>
                    <DialogTrigger asChild>{trigger}</DialogTrigger>
                    <DialogContent className="bottom-0 left-0 right-0 top-auto max-h-[88dvh] w-full max-w-none translate-x-0 translate-y-0 overflow-y-auto rounded-b-none rounded-t-xl pb-[max(16px,env(safe-area-inset-bottom))]" closeButtonClassName="h-11 w-11">
                        <DialogHeader className="mb-4"><DialogTitle>{t('sourceControl.title')}</DialogTitle><DialogDescription>{t('sourceControl.panelHint')}</DialogDescription></DialogHeader>
                        {body}
                    </DialogContent>
                </Dialog>
            ) : (
                <Popover.Root open={open} onOpenChange={setOpen}>
                    <Popover.Trigger asChild>{trigger}</Popover.Trigger>
                    <Popover.Portal><Popover.Content side="top" align="start" sideOffset={8} collisionPadding={12} className="z-50 max-h-[min(80dvh,var(--radix-popover-content-available-height))] w-[336px] max-w-[calc(100vw-24px)] overflow-y-auto rounded-[10px] border border-[var(--app-border)] bg-[var(--app-bg)] p-3 shadow-lg" aria-label={t('sourceControl.title')}>{body}</Popover.Content></Popover.Portal>
                </Popover.Root>
            )}
        </>
    )
}
