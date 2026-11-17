import { Link } from '@tanstack/react-router'
import { useAppContext } from '@/lib/app-context'
import { useTranslation } from '@/lib/use-translation'

export function SidebarFooterSettings() {
    const { user } = useAppContext()
    const { t } = useTranslation()
    const name = user.username || t('settings.title')
    const initial = typeof Intl.Segmenter === 'function'
        ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(name)[Symbol.iterator]().next().value?.segment
        : Array.from(name)[0]

    return (
        <div className="shrink-0 border-t border-[var(--app-divider)] p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
            <Link
                to="/settings"
                aria-label={t('settings.title')}
                title={t('settings.title')}
                className="flex min-h-11 w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-[var(--app-subtle-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
            >
                <span aria-hidden="true" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-[var(--app-subtle-bg)] font-medium text-[var(--app-fg)]">{initial?.toUpperCase()}</span>
                <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium text-[var(--app-fg)]">{name}</span>
                    {user.defaultNamespace ? <span className="block truncate text-xs text-[var(--app-hint)]">{user.defaultNamespace}</span> : null}
                </span>
                <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4 shrink-0 text-[var(--app-hint)]">
                    <path d="m9.5 3-.5 2-2 .9-1.9-.6-2.5 4.4 1.4 1.4v2.2l-1.4 1.4 2.5 4.4 1.9-.6 2 .9.5 2h5l.5-2 2-.9 1.9.6 2.5-4.4-1.4-1.4v-2.2l1.4-1.4-2.5-4.4-1.9.6-2-.9-.5-2z" />
                    <circle cx="12" cy="12" r="3" />
                </svg>
            </Link>
        </div>
    )
}
