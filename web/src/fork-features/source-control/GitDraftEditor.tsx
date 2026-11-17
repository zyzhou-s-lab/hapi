import type { CodeHeaderProps, SyntaxHighlighterProps } from '@assistant-ui/react-markdown'
import { useTranslation } from '@/lib/use-translation'
import { EMPTY_GIT_REVIEW, useGitChat } from './GitChatContext'
import { composeGitFollowUp } from './gitChat'

const button = 'min-h-11 rounded-md px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)] disabled:cursor-not-allowed disabled:opacity-50'

export function GitDraftHeader(_props: CodeHeaderProps) {
    const { t } = useTranslation()
    return <div className="rounded-t-xl bg-[var(--app-secondary-bg)] px-3 pt-3 text-sm font-medium">{t('sourceControl.chat.draft')}</div>
}

export function GitDraftEditor({ code }: Pick<SyntaxHighlighterProps, 'code'>) {
    const chat = useGitChat()
    const { t } = useTranslation()
    const prepared = composeGitFollowUp(code, chat?.preparation ?? null)
    const { edited, cancelled, sent, pendingText, error } = chat?.reviews.get(code) ?? EMPTY_GIT_REVIEW
    const pending = pendingText !== null
    const value = edited ?? pendingText ?? prepared ?? ''
    const disabled = !chat || chat.disabled || pending || !prepared || !value.trim()

    const send = async () => {
        if (disabled || sent) return
        await chat.sendReview(code, value, t('sourceControl.chat.sendFailed'))
    }

    if (sent || cancelled || (!prepared && !pending)) {
        return <div className="space-y-2 rounded-b-xl bg-[var(--app-secondary-bg)] p-3">
            <pre className="m-0 whitespace-pre-wrap break-words text-sm" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{sent ?? edited ?? prepared ?? code}</pre>
            {sent ? <p role="status" className="text-xs text-[var(--app-hint)]">{t('sourceControl.chat.sent')}</p> : null}
            {cancelled && prepared ? <button type="button" className={`${button} border border-[var(--app-border)]`} onClick={() => chat?.updateReview(code, { cancelled: false })}>{t('sourceControl.chat.edit')}</button> : null}
        </div>
    }

    return <form className="space-y-3 rounded-b-xl bg-[var(--app-secondary-bg)] p-3" onSubmit={event => { event.preventDefault(); void send() }}>
        <p className="m-0 text-xs text-[var(--app-hint)]">{t('sourceControl.chat.hint')}</p>
        <textarea aria-label={t('sourceControl.chat.draft')} value={value} onChange={event => chat?.updateReview(code, { edited: event.target.value })} readOnly={chat?.disabled || pending} rows={12} className="block min-h-44 w-full min-w-0 resize-y rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] p-3 text-sm leading-relaxed text-[var(--app-fg)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]" />
        {error ? <p role="alert" className="text-sm text-[var(--app-badge-error-text)]">{error}</p> : null}
        <div className="flex flex-wrap justify-end gap-2">
            <button type="button" disabled={pending} className={`${button} text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)]`} onClick={() => chat?.updateReview(code, { cancelled: true })}>{t('sourceControl.chat.cancel')}</button>
            <button type="submit" disabled={disabled} className={`${button} bg-[var(--app-fg)] text-[var(--app-bg)]`}>{t(pending ? 'sourceControl.chat.sending' : 'sourceControl.chat.send')}</button>
        </div>
    </form>
}
