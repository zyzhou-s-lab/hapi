import { useMemo, useState, type FormEvent } from 'react'
import { useNavigate } from '@tanstack/react-router'
import type {
    GitActionRequest,
    GitActionResponse,
    GitActionStep,
    GitChange,
    GitRepositoryStatus
} from '@hapi/protocol/sourceControl'
import type { ApiClient } from '@/api/client'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { PRESERVE_SESSION_SIDEBAR_SCROLL } from '@/lib/sessionNavigation'
import { useTranslation } from '@/lib/use-translation'
import { encodeBase64 } from '@/lib/utils'
import { getRepositoryDirtyFiles, isRepositoryDefaultBranch, supportsExtendedGitActions } from './actions'

export type GitDialogAction = 'commit' | 'commit-push' | 'commit-push-pr' | 'push' | 'pr' | 'push-pr'

export interface GitActionDialogsProps {
    api: ApiClient
    sessionId: string
    repo: GitRepositoryStatus
    action: GitDialogAction | null
    onClose: () => void
    onSuccess: (action: GitDialogAction, response: GitActionResponse) => void
    onMutated: () => Promise<unknown>
}

const fieldClass = 'w-full min-w-0 rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-2.5 py-1.5 text-sm text-[var(--app-fg)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]'

function formatLineNumber(value: number): string {
    return value.toLocaleString()
}

function FileStatSummary({ file }: { file: GitChange }) {
    const { t } = useTranslation()
    if (file.binary) {
        return <span className="text-[11px] text-[var(--app-hint)]">{t('sourceControl.binary')}</span>
    }
    if (file.additions === null || file.deletions === null) {
        return (
            <span className="text-[11px] text-[var(--app-hint)]">
                {file.untracked ? t('sourceControl.untracked') : '?'}
            </span>
        )
    }
    return (
        <span className="font-mono text-xs tabular-nums">
            <span className={file.additions > 0 ? 'text-[var(--app-badge-success-text)]' : 'text-[var(--app-hint)]'}>
                +{formatLineNumber(file.additions)}
            </span>
            <span className="text-[var(--app-hint)]"> / </span>
            <span className={file.deletions > 0 ? 'text-[var(--app-badge-error-text)]' : 'text-[var(--app-hint)]'}>
                -{formatLineNumber(file.deletions)}
            </span>
        </span>
    )
}

function GitActionDialogBody({
    api,
    sessionId,
    repo,
    dialogAction,
    onClose,
    onSuccess,
    onMutated
}: {
    api: ApiClient
    sessionId: string
    repo: GitRepositoryStatus
    dialogAction: GitDialogAction
    onClose: () => void
    onSuccess: (action: GitDialogAction, response: GitActionResponse) => void
    onMutated: () => Promise<unknown>
}) {
    const { t } = useTranslation()
    const navigate = useNavigate()
    const defaultBranch = isRepositoryDefaultBranch(repo)
    const extendedActions = supportsExtendedGitActions(repo)
    const dirtyFiles = useMemo(() => getRepositoryDirtyFiles(repo), [repo])
    const isLockedStaged = (file: GitChange) => !extendedActions && file.staged && !file.unstaged && !file.untracked
    const baseOptions = useMemo(() => {
        const names = new Set<string>()
        const preferred = repo.baseRef ?? repo.defaultBranch
        if (preferred) names.add(preferred)
        for (const ref of repo.refs) {
            if (ref.name !== repo.branch) names.add(ref.name)
        }
        return [...names]
    }, [repo.baseRef, repo.branch, repo.defaultBranch, repo.refs])

    const [excludedPaths, setExcludedPaths] = useState<ReadonlySet<string>>(() => new Set())
    const [editingFiles, setEditingFiles] = useState(false)
    const [message, setMessage] = useState('')
    const [baseRef, setBaseRef] = useState(() => repo.baseRef ?? repo.defaultBranch ?? baseOptions[0] ?? '')
    const [prTitle, setPrTitle] = useState('')
    const [prBody, setPrBody] = useState('')
    const [confirmDefault, setConfirmDefault] = useState(false)
    const [submitting, setSubmitting] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [steps, setSteps] = useState<GitActionStep[]>([])

    const isCommitAction = dialogAction === 'commit' || dialogAction === 'commit-push' || dialogAction === 'commit-push-pr'
    const includesPr = dialogAction === 'pr' || dialogAction === 'push-pr' || dialogAction === 'commit-push-pr'
    const needsDefaultConfirm = dialogAction === 'commit-push' && defaultBranch

    const selectedFiles = useMemo(
        () => dirtyFiles.filter((file) => !excludedPaths.has(file.path)),
        [dirtyFiles, excludedPaths]
    )
    const allSelected = excludedPaths.size === 0
    const noneSelected = selectedFiles.length === 0
    const selectedAdditions = selectedFiles.reduce((sum, file) => sum + (file.additions ?? 0), 0)
    const selectedDeletions = selectedFiles.reduce((sum, file) => sum + (file.deletions ?? 0), 0)

    const commitSubject = message.trim().split('\n')[0]?.trim() ?? ''
    const resolvedPrTitle = prTitle.trim() || (dialogAction === 'commit-push-pr' ? commitSubject : '')

    const canSubmit = !submitting
        && (!isCommitAction || (!noneSelected && message.trim().length > 0))
        && (!includesPr || (resolvedPrTitle.length > 0 && baseRef.trim().length > 0))
        && (!needsDefaultConfirm || confirmDefault)

    const toggleFile = (path: string) => {
        setExcludedPaths((prev) => {
            const next = new Set(prev)
            if (next.has(path)) next.delete(path)
            else next.add(path)
            return next
        })
    }

    const openFileDiff = (filePath: string) => {
        onClose()
        void navigate({
            to: '/sessions/$sessionId/file',
            params: { sessionId },
            search: { path: encodeBase64(filePath), scope: 'working' },
            ...PRESERVE_SESSION_SIDEBAR_SCROLL
        })
    }

    const submit = async (event?: FormEvent) => {
        event?.preventDefault()
        if (!canSubmit) return
        setSubmitting(true)
        setError(null)
        setSteps([])

        try {
            let priorSteps: GitActionStep[] = []
            let activeRepo = repo

            if (isCommitAction && !extendedActions) {
                const pathsToStage = selectedFiles
                    .filter((file) => !file.staged || file.unstaged || file.untracked)
                    .map((file) => file.path)
                if (pathsToStage.length > 0) {
                    const stageResponse = await api.runGitAction(sessionId, {
                        action: 'stage',
                        expectedHead: repo.head,
                        expectedBranch: repo.branch,
                        expectedIndexDigest: repo.indexDigest,
                        expectedWorktreeDigest: repo.worktreeDigest,
                        paths: pathsToStage
                    })
                    priorSteps = stageResponse.steps
                    setSteps(priorSteps)
                    if (!stageResponse.success) {
                        setError(stageResponse.error ?? t('sourceControl.failed'))
                        await onMutated()
                        return
                    }
                    const refreshed = await api.getGitRepository(sessionId, { scope: 'working' })
                    if (!refreshed.success || !refreshed.repository) {
                        setError(refreshed.error ?? t('sourceControl.failed'))
                        await onMutated()
                        return
                    }
                    activeRepo = refreshed.repository
                }
            }

            const request: GitActionRequest = {
                action: dialogAction,
                expectedHead: activeRepo.head,
                expectedBranch: activeRepo.branch,
                expectedIndexDigest: activeRepo.indexDigest,
                expectedWorktreeDigest: activeRepo.worktreeDigest,
                ...(isCommitAction
                    ? {
                        ...(extendedActions ? { paths: selectedFiles.map((file) => file.path) } : {}),
                        message: message.trim()
                    }
                    : {}),
                ...(repo.remote ? { remote: repo.remote } : {}),
                ...(includesPr
                    ? {
                        baseRef: baseRef.trim(),
                        title: resolvedPrTitle,
                        ...(prBody.trim() ? { body: prBody.trim() } : {})
                    }
                    : {}),
                ...(dialogAction === 'push' || (dialogAction === 'commit-push' && defaultBranch)
                    ? { confirmDefaultBranch: true }
                    : {})
            }

            const response = await api.runGitAction(sessionId, request)
            setSteps([...priorSteps, ...response.steps])
            await onMutated()
            if (response.success) {
                onSuccess(dialogAction, response)
                onClose()
            } else {
                setError(response.error ?? t('sourceControl.failed'))
            }
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : t('sourceControl.failed'))
            await onMutated()
        } finally {
            setSubmitting(false)
        }
    }

    const dialogTitleKey = dialogAction === 'push'
        ? 'sourceControl.dialog.pushDefaultTitle'
        : dialogAction === 'pr' || dialogAction === 'push-pr'
            ? 'sourceControl.dialog.prTitle'
            : dialogAction === 'commit-push'
                ? 'sourceControl.quick.commitPush'
                : dialogAction === 'commit-push-pr'
                    ? 'sourceControl.quick.commitPushPr'
                    : 'sourceControl.dialog.commitTitle'

    const dialogDescKey = dialogAction === 'push'
        ? 'sourceControl.dialog.pushDefaultDesc'
        : dialogAction === 'pr' || dialogAction === 'push-pr'
            ? 'sourceControl.dialog.prDesc'
            : 'sourceControl.dialog.commitDesc'

    const submitLabelKey = dialogAction === 'push'
        ? 'sourceControl.dialog.pushDefaultConfirm'
        : dialogAction === 'pr'
            ? 'sourceControl.menu.pr'
            : dialogAction === 'push-pr'
                ? 'sourceControl.quick.pushPr'
                : dialogAction === 'commit-push'
                    ? 'sourceControl.quick.commitPush'
                    : dialogAction === 'commit-push-pr'
                        ? 'sourceControl.quick.commitPushPr'
                        : 'sourceControl.menu.commit'

    return (
        <form className="space-y-4" onSubmit={(event) => { void submit(event) }}>
            <DialogHeader>
                <DialogTitle>{t(dialogTitleKey)}</DialogTitle>
                <DialogDescription>
                    {t(dialogDescKey, { branch: repo.branch ?? '' })}
                </DialogDescription>
            </DialogHeader>

            {isCommitAction ? (
                <div className="space-y-3 rounded-xl border border-[var(--app-border)] bg-[var(--app-secondary-bg)] p-3 text-xs">
                    <div className="flex items-center justify-between gap-2">
                        <span className="text-[var(--app-hint)]">{t('sourceControl.dialog.branch')}</span>
                        <div className="flex min-w-0 items-center gap-2">
                            <span className="truncate font-mono font-medium text-[var(--app-fg)]">
                                {repo.branch ?? t('files.branch.detached')}
                            </span>
                            {defaultBranch ? (
                                <span className="shrink-0 rounded bg-[var(--app-badge-warning-bg)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--app-badge-warning-text)]">
                                    {t('sourceControl.dialog.defaultBranch')}
                                </span>
                            ) : null}
                        </div>
                    </div>

                    <div className="space-y-1.5">
                        <div className="flex items-center justify-between gap-2">
                            <div className="flex items-center gap-2">
                                {editingFiles && dirtyFiles.length > 0 ? (
                                    <input
                                        type="checkbox"
                                        aria-label={t('sourceControl.dialog.includeAll')}
                                        checked={allSelected}
                                        onChange={() => {
                                            setExcludedPaths(
                                                allSelected
                                                    ? new Set(dirtyFiles.filter((file) => !isLockedStaged(file)).map((file) => file.path))
                                                    : new Set()
                                            )
                                        }}
                                        className="h-3.5 w-3.5 accent-[var(--app-button)]"
                                    />
                                ) : null}
                                <span className="text-[var(--app-hint)]">{t('sourceControl.dialog.files')}</span>
                                {!allSelected ? (
                                    <span className="text-[var(--app-hint)]">
                                        {t('sourceControl.dialog.selectedCount', {
                                            selected: selectedFiles.length,
                                            total: dirtyFiles.length
                                        })}
                                    </span>
                                ) : null}
                            </div>
                            {dirtyFiles.length > 0 ? (
                                <button
                                    type="button"
                                    className="rounded px-1.5 py-0.5 text-xs font-medium text-[var(--app-link)] hover:bg-[var(--app-subtle-bg)]"
                                    onClick={() => setEditingFiles((prev) => !prev)}
                                >
                                    {t(editingFiles ? 'sourceControl.dialog.done' : 'sourceControl.dialog.edit')}
                                </button>
                            ) : null}
                        </div>

                        {dirtyFiles.length === 0 ? (
                            <p className="py-1 font-medium text-[var(--app-hint)]">
                                {t('sourceControl.block.clean')}
                            </p>
                        ) : (
                            <>
                                <div className="max-h-44 space-y-0.5 overflow-y-auto rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] p-1">
                                    {dirtyFiles.map((file) => {
                                        const excluded = excludedPaths.has(file.path)
                                        return (
                                            <div
                                                key={file.path}
                                                className="flex items-center gap-2 rounded-md px-2 py-1 hover:bg-[var(--app-subtle-bg)]"
                                            >
                                                {editingFiles ? (
                                                    <input
                                                        type="checkbox"
                                                        aria-label={file.path}
                                                        checked={!excluded}
                                                        disabled={isLockedStaged(file)}
                                                        onChange={() => toggleFile(file.path)}
                                                        className="h-3.5 w-3.5 shrink-0 accent-[var(--app-button)]"
                                                    />
                                                ) : null}
                                                <button
                                                    type="button"
                                                    onClick={() => openFileDiff(file.path)}
                                                    className="flex min-w-0 flex-1 items-center justify-between gap-2 text-left"
                                                    title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
                                                >
                                                    <span
                                                        className={`min-w-0 flex-1 truncate font-mono text-[11px] ${
                                                            excluded ? 'text-[var(--app-hint)] line-through' : 'text-[var(--app-fg)]'
                                                        }`}
                                                    >
                                                        {file.path}
                                                    </span>
                                                    <span className="shrink-0">
                                                        {excluded ? (
                                                            <span className="text-[11px] text-[var(--app-hint)]">
                                                                {t('sourceControl.dialog.excluded')}
                                                            </span>
                                                        ) : (
                                                            <FileStatSummary file={file} />
                                                        )}
                                                    </span>
                                                </button>
                                            </div>
                                        )
                                    })}
                                </div>
                                <div className="flex justify-end font-mono text-xs tabular-nums">
                                    <span className="text-[var(--app-badge-success-text)]">
                                        +{formatLineNumber(selectedAdditions)}
                                    </span>
                                    <span className="mx-1 text-[var(--app-hint)]">/</span>
                                    <span className="text-[var(--app-badge-error-text)]">
                                        -{formatLineNumber(selectedDeletions)}
                                    </span>
                                </div>
                            </>
                        )}
                    </div>
                </div>
            ) : null}

            {isCommitAction ? (
                <div className="space-y-1">
                    <label htmlFor="git-commit-message" className="block text-xs font-medium text-[var(--app-fg)]">
                        {t('sourceControl.commitMessage')}
                    </label>
                    <textarea
                        id="git-commit-message"
                        value={message}
                        onChange={(event) => setMessage(event.target.value)}
                        onKeyDown={(event) => {
                            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && canSubmit) {
                                event.preventDefault()
                                void submit()
                            }
                        }}
                        rows={3}
                        disabled={submitting}
                        placeholder={t('sourceControl.dialog.commitMessagePlaceholder')}
                        className={`${fieldClass} resize-y`}
                        autoFocus
                    />
                </div>
            ) : null}

            {includesPr ? (
                <div className="space-y-3">
                    <div className="space-y-1">
                        <label htmlFor="git-pr-base" className="block text-xs font-medium text-[var(--app-fg)]">
                            {t('sourceControl.baseRef')}
                        </label>
                        <select
                            id="git-pr-base"
                            value={baseRef}
                            onChange={(event) => setBaseRef(event.target.value)}
                            disabled={submitting}
                            className={fieldClass}
                        >
                            {baseOptions.length === 0 ? (
                                <option value="">{t('sourceControl.chooseBase')}</option>
                            ) : null}
                            {baseOptions.map((option) => (
                                <option key={option} value={option}>{option}</option>
                            ))}
                        </select>
                    </div>
                    <div className="space-y-1">
                        <label htmlFor="git-pr-title" className="block text-xs font-medium text-[var(--app-fg)]">
                            {t('sourceControl.prTitle')}
                        </label>
                        <input
                            id="git-pr-title"
                            type="text"
                            value={prTitle}
                            onChange={(event) => setPrTitle(event.target.value)}
                            disabled={submitting}
                            placeholder={dialogAction === 'commit-push-pr' && commitSubject
                                ? commitSubject
                                : t('sourceControl.dialog.prTitlePlaceholder')}
                            className={fieldClass}
                            autoFocus={!isCommitAction}
                        />
                    </div>
                    <div className="space-y-1">
                        <label htmlFor="git-pr-body" className="block text-xs font-medium text-[var(--app-fg)]">
                            {t('sourceControl.prBody')}
                        </label>
                        <textarea
                            id="git-pr-body"
                            value={prBody}
                            onChange={(event) => setPrBody(event.target.value)}
                            rows={3}
                            disabled={submitting}
                            className={`${fieldClass} resize-y`}
                        />
                    </div>
                </div>
            ) : null}

            {needsDefaultConfirm ? (
                <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-[var(--app-badge-warning-border)] bg-[var(--app-badge-warning-bg)] p-2.5 text-xs text-[var(--app-fg)]">
                    <input
                        type="checkbox"
                        checked={confirmDefault}
                        onChange={(event) => setConfirmDefault(event.target.checked)}
                        disabled={submitting}
                        className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-[var(--app-button)]"
                    />
                    <span>{t('sourceControl.defaultConfirm', { branch: repo.branch ?? '' })}</span>
                </label>
            ) : null}

            {steps.length > 0 ? (
                <div className="space-y-1 rounded-lg border border-[var(--app-border)] bg-[var(--app-secondary-bg)] p-2.5 text-xs">
                    <div className="font-medium text-[var(--app-fg)]">{t('sourceControl.results')}</div>
                    {steps.map((step, index) => (
                        <div key={`${step.action}-${index}`} className="flex items-center justify-between gap-2 text-[var(--app-hint)]">
                            <span className="font-mono">{step.action}</span>
                            <span className={step.success ? 'text-[var(--app-badge-success-text)]' : 'text-[var(--app-badge-error-text)]'}>
                                {t(step.success ? 'sourceControl.succeeded' : 'sourceControl.failed')}
                            </span>
                        </div>
                    ))}
                </div>
            ) : null}

            {error ? (
                <p role="alert" className="break-words rounded-lg bg-[var(--app-badge-error-bg)] px-3 py-2 text-xs text-[var(--app-badge-error-text)]">
                    {error}
                </p>
            ) : null}

            <div className="flex flex-wrap justify-end gap-2 pt-1">
                <Button type="button" variant="outline" size="sm" disabled={submitting} onClick={onClose}>
                    {t('button.cancel')}
                </Button>
                <Button type="submit" size="sm" disabled={!canSubmit}>
                    {submitting ? t('sourceControl.running') : t(submitLabelKey, { branch: repo.branch ?? '' })}
                </Button>
            </div>
        </form>
    )
}

export function GitActionDialogs(props: GitActionDialogsProps) {
    return (
        <Dialog open={props.action !== null} onOpenChange={(open) => { if (!open) props.onClose() }}>
            <DialogContent className="max-h-[88dvh] max-w-md overflow-y-auto">
                {props.action ? (
                    <GitActionDialogBody
                        key={`${props.sessionId}:${props.action}`}
                        api={props.api}
                        sessionId={props.sessionId}
                        repo={props.repo}
                        dialogAction={props.action}
                        onClose={props.onClose}
                        onSuccess={props.onSuccess}
                        onMutated={props.onMutated}
                    />
                ) : null}
            </DialogContent>
        </Dialog>
    )
}
